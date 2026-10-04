# ==============================================================================
# AI MedStudio – Autentizační a uživatelská služba (AuthService)
# ==============================================================================
# Zabezpečená správa uživatelů, relací a schvalování přístupů:
# - SQLite perzistence v USER_DATA_DIR (uchovává se i po restartu Dockeru)
# - PBKDF2-HMAC-SHA256 hashování hesel s unikátní solí (NIST doporučení)
# - Bezpečné relace (Session tokens s volitelným "Zůstat přihlášený" na 30 dní)
# - Řízení registrací (ON/OFF) a schvalování/odmítání nových účtů administrátorem
# ==============================================================================

import hashlib
import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple


class AuthService:
    _instance: Optional["AuthService"] = None

    def __init__(self, data_dir: str):
        AuthService._instance = self
        self.data_dir = data_dir
        os.makedirs(self.data_dir, exist_ok=True)
        self.db_path = os.path.join(self.data_dir, "auth.db")
        self._init_db()

    @classmethod
    def get_instance(cls) -> Optional["AuthService"]:
        return cls._instance

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path, timeout=15.0) as conn:
            conn.execute("PRAGMA journal_mode=WAL;")
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # Tabulka uživatelů
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE COLLATE NOCASE NOT NULL,
                    email TEXT COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'user',     -- 'admin' | 'user'
                    status TEXT NOT NULL DEFAULT 'pending', -- 'approved' | 'pending' | 'rejected' | 'disabled'
                    created_at TEXT NOT NULL,
                    last_login TEXT
                )
            """)

            # Tabulka aktivních relací (Sessions)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    remember_me INTEGER NOT NULL DEFAULT 0,
                    user_agent TEXT,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            """)

            # Tabulka globálních nastavení autentizace
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS auth_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

            # Tabulka osobních API klíčů uživatelů (pro režim BYOK / per-user)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_api_keys (
                    user_id INTEGER PRIMARY KEY,
                    gemini_api_key TEXT,
                    openai_api_key TEXT,
                    elevenlabs_api_key TEXT,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            """)

            # Tabulka vlastnictví projektů (pro režim privátních oddělených projektů)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS project_ownership (
                    project_id TEXT PRIMARY KEY COLLATE NOCASE,
                    owner_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
                )
            """)

            # Výchozí nastavení: registrace povoleny, účty vyžadují schválení, hosté výchoze vypnuti
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('allow_registration', '1')")
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('require_approval', '1')")
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('allow_guest', '0')")
            # Sdílení API klíčů: 1 = centrální klíče od admina pro celou aplikaci, 0 = každý uživatel má vlastní
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('shared_api_keys', '1')")
            # Sdílení projektů: 1 = všechny projekty sdíleny všemi, 0 = každý uživatel má svůj privátní prostor
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('shared_projects', '1')")

            conn.commit()

    # --------------------------------------------------------------------------
    # Hashování a ověření hesel
    # --------------------------------------------------------------------------
    @staticmethod
    def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
        if not salt:
            salt = secrets.token_hex(16)
        key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations=200_000)
        return key.hex(), salt

    @staticmethod
    def verify_password(password: str, password_hash: str, salt: str) -> bool:
        key, _ = AuthService.hash_password(password, salt)
        return secrets.compare_digest(key, password_hash)

    # --------------------------------------------------------------------------
    # Zjištění stavu systému (první spuštění)
    # --------------------------------------------------------------------------
    def get_user_count(self) -> int:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM users")
            return cursor.fetchone()[0]

    def needs_setup(self) -> bool:
        """Vrací True, pokud v databázi ještě neexistuje žádný uživatel."""
        return self.get_user_count() == 0

    def is_registration_allowed(self) -> bool:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM auth_settings WHERE key = 'allow_registration'")
            row = cursor.fetchone()
            return row is not None and row[0] == "1"

    def set_registration_allowed(self, allowed: bool) -> None:
        val = "1" if allowed else "0"
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO auth_settings (key, value) VALUES ('allow_registration', ?)", (val,))
            conn.commit()

    def is_guest_allowed(self) -> bool:
        """Vrací True, pokud je povolen režim nepřihlášeného hosta (pozorovatel)."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM auth_settings WHERE key = 'allow_guest'")
            row = cursor.fetchone()
            return row is not None and row[0] == "1"

    def set_guest_allowed(self, allowed: bool) -> None:
        val = "1" if allowed else "0"
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO auth_settings (key, value) VALUES ('allow_guest', ?)", (val,))
            conn.commit()

    def is_shared_api_keys(self) -> bool:
        """Vrací True, pokud celá aplikace sdílí jedny centrální API klíče od administrátora."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM auth_settings WHERE key = 'shared_api_keys'")
            row = cursor.fetchone()
            return row is None or row[0] == "1"

    def set_shared_api_keys(self, shared: bool) -> None:
        val = "1" if shared else "0"
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO auth_settings (key, value) VALUES ('shared_api_keys', ?)", (val,))
            conn.commit()

    def is_shared_projects(self) -> bool:
        """Vrací True, pokud všichni uživatelé sdílejí všechny projekty napříč aplikací."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM auth_settings WHERE key = 'shared_projects'")
            row = cursor.fetchone()
            return row is None or row[0] == "1"

    def set_shared_projects(self, shared: bool) -> None:
        val = "1" if shared else "0"
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO auth_settings (key, value) VALUES ('shared_projects', ?)", (val,))
            conn.commit()

    # --------------------------------------------------------------------------
    # Osobní API klíče uživatelů (BYOK)
    # --------------------------------------------------------------------------
    def get_user_api_keys(self, user_id: int) -> dict[str, str]:
        """Vrátí osobní API klíče uživatele."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT gemini_api_key, openai_api_key, elevenlabs_api_key
                FROM user_api_keys
                WHERE user_id = ?
            """,
                (user_id,),
            )
            row = cursor.fetchone()
            if not row:
                return {"gemini_api_key": "", "openai_api_key": "", "elevenlabs_api_key": ""}
            return {
                "gemini_api_key": row["gemini_api_key"] or "",
                "openai_api_key": row["openai_api_key"] or "",
                "elevenlabs_api_key": row["elevenlabs_api_key"] or "",
            }

    def save_user_api_keys(
        self,
        user_id: int,
        gemini_api_key: str | None = None,
        openai_api_key: str | None = None,
        elevenlabs_api_key: str | None = None,
    ) -> None:
        """Uloží nebo aktualizuje osobní API klíče uživatele."""
        current = self.get_user_api_keys(user_id)
        g_key = (gemini_api_key if gemini_api_key is not None else current.get("gemini_api_key", "")).strip()
        o_key = (openai_api_key if openai_api_key is not None else current.get("openai_api_key", "")).strip()
        e_key = (
            elevenlabs_api_key if elevenlabs_api_key is not None else current.get("elevenlabs_api_key", "")
        ).strip()
        now = datetime.now().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO user_api_keys (user_id, gemini_api_key, openai_api_key, elevenlabs_api_key, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    gemini_api_key = excluded.gemini_api_key,
                    openai_api_key = excluded.openai_api_key,
                    elevenlabs_api_key = excluded.elevenlabs_api_key,
                    updated_at = excluded.updated_at
            """,
                (user_id, g_key, o_key, e_key, now),
            )
            conn.commit()

    # --------------------------------------------------------------------------
    # Vlastnictví projektů (pro privátní oddělené projekty)
    # --------------------------------------------------------------------------
    def set_project_owner(self, project_id: str, owner_id: int) -> None:
        now = datetime.now().isoformat()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO project_ownership (project_id, owner_id, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    owner_id = excluded.owner_id
            """,
                (project_id, owner_id, now),
            )
            conn.commit()

    def get_project_owner(self, project_id: str) -> int | None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT owner_id FROM project_ownership WHERE project_id = ? COLLATE NOCASE", (project_id,))
            row = cursor.fetchone()
            return row["owner_id"] if row else None

    def get_project_owner_username(self, project_id: str) -> str | None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT u.username
                FROM project_ownership po
                JOIN users u ON po.owner_id = u.id
                WHERE po.project_id = ? COLLATE NOCASE
            """,
                (project_id,),
            )
            row = cursor.fetchone()
            return row["username"] if row else None

    def list_user_projects(self, user_id: int) -> list[str]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT project_id FROM project_ownership
                WHERE owner_id = ?
                ORDER BY project_id ASC
            """,
                (user_id,),
            )
            return [r["project_id"] for r in cursor.fetchall()]

    def delete_project_owner(self, project_id: str) -> None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM project_ownership WHERE project_id = ? COLLATE NOCASE", (project_id,))
            conn.commit()

    def rename_project_owner(self, old_name: str, new_name: str) -> None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE project_ownership SET project_id = ? WHERE project_id = ? COLLATE NOCASE", (new_name, old_name)
            )
            conn.commit()

    def ensure_existing_projects_owned(self, existing_projects: list[str], default_owner_id: int = 1) -> None:
        """Přiřadí dosud neregistrované složky projektů na disku primárnímu administrátorovi."""
        now = datetime.now().isoformat()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            for proj in existing_projects:
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO project_ownership (project_id, owner_id, created_at)
                    VALUES (?, ?, ?)
                """,
                    (proj, default_owner_id, now),
                )
            conn.commit()

    # --------------------------------------------------------------------------
    # Registrace a tvorba účtů
    # --------------------------------------------------------------------------
    def create_initial_admin(
        self, username: str, password: str, email: str | None = None
    ) -> tuple[dict[str, Any] | None, str | None]:
        """Vytvoří primární administrátorský účet (povolen pouze při prvním spuštění)."""
        if not self.needs_setup():
            return None, "Administrátorský účet již byl vytvořen. Další registrace podléhají běžnému schválení."

        username = username.strip()
        if len(username) < 3:
            return None, "Uživatelské jméno musí mít alespoň 3 znaky."
        if len(password) < 6:
            return None, "Heslo musí mít alespoň 6 znaků."

        pwd_hash, salt = self.hash_password(password)
        now = datetime.now().isoformat()

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO users (username, email, password_hash, salt, role, status, created_at, last_login)
                VALUES (?, ?, ?, ?, 'admin', 'approved', ?, ?)
            """,
                (username, (email.strip() if email else None), pwd_hash, salt, now, now),
            )
            user_id = cursor.lastrowid
            conn.commit()

        return {
            "id": user_id,
            "username": username,
            "email": email,
            "role": "admin",
            "status": "approved",
            "created_at": now,
        }, None

    def register_user(
        self, username: str, password: str, email: str | None = None
    ) -> tuple[dict[str, Any] | None, str | None]:
        """Zaregistruje nového uživatele (pokud je registrace povolena). Účet začíná ve stavu 'pending'."""
        if not self.is_registration_allowed():
            return None, "Registrace nových účtů je v současnosti administrátorem vypnuta."

        username = username.strip()
        if len(username) < 3:
            return None, "Uživatelské jméno musí mít alespoň 3 znaky."
        if len(password) < 6:
            return None, "Heslo musí mít alespoň 6 znaků."

        pwd_hash, salt = self.hash_password(password)
        now = datetime.now().isoformat()

        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO users (username, email, password_hash, salt, role, status, created_at)
                    VALUES (?, ?, ?, ?, 'user', 'pending', ?)
                """,
                    (username, (email.strip() if email else None), pwd_hash, salt, now),
                )
                user_id = cursor.lastrowid
                conn.commit()

            return {
                "id": user_id,
                "username": username,
                "email": email,
                "role": "user",
                "status": "pending",
                "created_at": now,
            }, None
        except sqlite3.IntegrityError:
            return None, f"Uživatel se jménem '{username}' již existuje. Zvolte prosím jiné jméno."

    # --------------------------------------------------------------------------
    # Přihlašování a ověření
    # --------------------------------------------------------------------------
    def authenticate(self, username_or_email: str, password: str) -> tuple[dict[str, Any] | None, str]:
        """
        Ověří přihlašovací údaje.
        Vrací (user_dict, "ok") nebo (None, chybová_zpráva).
        """
        query_val = username_or_email.strip()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, username, email, password_hash, salt, role, status, created_at, last_login
                FROM users
                WHERE username = ? OR email = ?
            """,
                (query_val, query_val),
            )
            row = cursor.fetchone()

        if not row:
            return None, "Nesprávné uživatelské jméno nebo heslo."

        if not self.verify_password(password, row["password_hash"], row["salt"]):
            return None, "Nesprávné uživatelské jméno nebo heslo."

        status = row["status"]
        if status == "pending":
            return (
                None,
                "Váš účet čeká na schválení administrátorem serveru. Jakmile bude schválen, budete se moci přihlásit.",
            )
        elif status == "rejected":
            return None, "Vaše žádost o registraci byla administrátorem zamítnuta."
        elif status == "disabled":
            return None, "Váš účet byl zablokován. Kontaktujte administrátora."
        elif status != "approved":
            return None, "Účet není aktivní."

        # Aktualizace času posledního přihlášení
        now = datetime.now().isoformat()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET last_login = ? WHERE id = ?", (now, row["id"]))
            conn.commit()

        return {
            "id": row["id"],
            "username": row["username"],
            "email": row["email"],
            "role": row["role"],
            "status": row["status"],
            "created_at": row["created_at"],
            "last_login": now,
        }, "ok"

    # --------------------------------------------------------------------------
    # Správa relací (Sessions)
    # --------------------------------------------------------------------------
    def create_session(self, user_id: int, remember_me: bool = False, user_agent: str = "") -> tuple[str, datetime]:
        """Vytvoří novou relaci. Pokud remember_me=True, platí 30 dní, jinak 1 den."""
        token = secrets.token_urlsafe(48)
        now = datetime.now()
        duration = timedelta(days=30) if remember_me else timedelta(days=1)
        expires_at = now + duration

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO sessions (token, user_id, created_at, expires_at, remember_me, user_agent)
                VALUES (?, ?, ?, ?, ?, ?)
            """,
                (token, user_id, now.isoformat(), expires_at.isoformat(), 1 if remember_me else 0, user_agent[:255]),
            )
            conn.commit()

        return token, expires_at

    def validate_session(self, token: str | None) -> dict[str, Any] | None:
        """Ověří session token. Vrací data uživatele, nebo None pokud je neplatný/expirovaný."""
        if not token:
            return None

        now_str = datetime.now().isoformat()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT u.id, u.username, u.email, u.role, u.status, u.created_at, u.last_login, s.expires_at, s.remember_me
                FROM sessions s
                JOIN users u ON s.user_id = u.id
                WHERE s.token = ?
            """,
                (token,),
            )
            row = cursor.fetchone()

            if not row:
                return None

            # Kontrola expirace
            if row["expires_at"] < now_str:
                cursor.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                return None

            # Kontrola, zda je uživatel stále aktivní
            if row["status"] != "approved":
                cursor.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                return None

            return {
                "id": row["id"],
                "username": row["username"],
                "email": row["email"],
                "role": row["role"],
                "status": row["status"],
                "created_at": row["created_at"],
                "last_login": row["last_login"],
                "remember_me": bool(row["remember_me"]),
            }

    def revoke_session(self, token: str) -> None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()

    def revoke_user_sessions(self, user_id: int) -> None:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            conn.commit()

    # --------------------------------------------------------------------------
    # Správa uživatelů a žádostí (Admin funkce)
    # --------------------------------------------------------------------------
    def list_users(self) -> list[dict[str, Any]]:
        """Vrátí seznam všech uživatelů se základními údaji."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, username, email, role, status, created_at, last_login
                FROM users
                ORDER BY
                    CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                    id ASC
            """)
            return [dict(row) for row in cursor.fetchall()]

    def get_user_by_id(self, user_id: int) -> dict[str, Any] | None:
        """Vrátí údaje uživatele podle ID."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, username, email, role, status, created_at, last_login
                FROM users
                WHERE id = ?
            """,
                (user_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def list_pending_requests(self) -> list[dict[str, Any]]:
        """Vrátí čekající žádosti o schválení."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, username, email, role, status, created_at
                FROM users
                WHERE status = 'pending'
                ORDER BY id ASC
            """)
            return [dict(row) for row in cursor.fetchall()]

    def approve_user(self, user_id: int, role: str = "user") -> bool:
        """Schválí uživatele a přiřadí mu roli ('user' nebo 'viewer')."""
        if role not in ("user", "viewer", "admin"):
            role = "user"
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE users SET status = 'approved', role = ? WHERE id = ? AND status = 'pending'", (role, user_id)
            )
            conn.commit()
            return cursor.rowcount > 0

    def change_user_role(self, user_id: int, new_role: str, current_admin_id: int) -> tuple[bool, str]:
        """Změní roli existujícího uživatele ('admin', 'user', 'viewer')."""
        if new_role not in ("admin", "user", "viewer"):
            return False, "Neplatná uživatelská role."

        if user_id == current_admin_id and new_role != "admin":
            return False, "Nemůžete odebrat roli administrátora svému vlastnímu účtu."

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET role = ? WHERE id = ?", (new_role, user_id))
            conn.commit()
            if cursor.rowcount > 0:
                role_label = (
                    "Administrátor" if new_role == "admin" else ("Uživatel" if new_role == "user" else "Pozorovatel")
                )
                return True, f"Role byla úspěšně změněna na: {role_label}"
            return False, "Uživatel nebyl nalezen."

    def reject_user(self, user_id: int) -> bool:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET status = 'rejected' WHERE id = ? AND status = 'pending'", (user_id,))
            conn.commit()
            return cursor.rowcount > 0

    def toggle_user_active(self, user_id: int, current_admin_id: int) -> tuple[bool, str, str | None]:
        """Aktivuje/deaktivuje účet uživatele. Brání administrátorovi zablokovat sám sebe."""
        if user_id == current_admin_id:
            return False, "Nemůžete zablokovat svůj vlastní administrátorský účet.", None

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT status, role FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            if not row:
                return False, "Uživatel nebyl nalezen.", None

            new_status = "disabled" if row["status"] == "approved" else "approved"
            cursor.execute("UPDATE users SET status = ? WHERE id = ?", (new_status, user_id))

            # Pokud uživatele blokujeme, zneplatníme jeho aktivní relace
            if new_status == "disabled":
                cursor.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

            conn.commit()
            action_label = "zablokován" if new_status == "disabled" else "odblokován"
            return True, f"Účet uživatele byl úspěšně {action_label}.", new_status

    def delete_user(self, user_id: int, current_admin_id: int) -> tuple[bool, str]:
        """Smaže uživatele. Brání administrátorovi smazat sám sebe."""
        if user_id == current_admin_id:
            return False, "Nemůžete smazat svůj vlastní administrátorský účet."

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
            conn.commit()
            if cursor.rowcount > 0:
                return True, "Uživatel byl úspěšně smazán."
            return False, "Uživatel nebyl nalezen."

    def get_auth_summary(self) -> dict[str, Any]:
        """Vrátí celkový přehled pro nastavení."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM users")
            total = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM users WHERE status = 'pending'")
            pending = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM users WHERE status = 'approved'")
            approved = cursor.fetchone()[0]

        return {
            "total_users": total,
            "pending_requests": pending,
            "approved_users": approved,
            "allow_registration": self.is_registration_allowed(),
            "allow_guest": self.is_guest_allowed(),
            "shared_api_keys": self.is_shared_api_keys(),
            "shared_projects": self.is_shared_projects(),
        }
