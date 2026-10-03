# ==============================================================================
# AI MedStudio – Autentizační a uživatelská služba (AuthService)
# ==============================================================================
# Zabezpečená správa uživatelů, relací a schvalování přístupů:
# - SQLite perzistence v USER_DATA_DIR (uchovává se i po restartu Dockeru)
# - PBKDF2-HMAC-SHA256 hashování hesel s unikátní solí (NIST doporučení)
# - Bezpečné relace (Session tokens s volitelným "Zůstat přihlášený" na 30 dní)
# - Řízení registrací (ON/OFF) a schvalování/odmítání nových účtů administrátorem
# ==============================================================================

import os
import sqlite3
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional, Tuple, List, Dict, Any


class AuthService:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        os.makedirs(self.data_dir, exist_ok=True)
        self.db_path = os.path.join(self.data_dir, "auth.db")
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_db(self) -> None:
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

            # Výchozí nastavení: registrace povoleny, účty vyžadují schválení, hosté výchoze vypnuti
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('allow_registration', '1')")
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('require_approval', '1')")
            cursor.execute("INSERT OR IGNORE INTO auth_settings (key, value) VALUES ('allow_guest', '0')")
            
            conn.commit()


    # --------------------------------------------------------------------------
    # Hashování a ověření hesel
    # --------------------------------------------------------------------------
    @staticmethod
    def hash_password(password: str, salt: Optional[str] = None) -> Tuple[str, str]:
        if not salt:
            salt = secrets.token_hex(16)
        key = hashlib.pbkdf2_hmac(
            'sha256',
            password.encode('utf-8'),
            salt.encode('utf-8'),
            iterations=200_000
        )
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
            return row is not None and row[0] == '1'

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
            return row is not None and row[0] == '1'

    def set_guest_allowed(self, allowed: bool) -> None:
        val = "1" if allowed else "0"
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO auth_settings (key, value) VALUES ('allow_guest', ?)", (val,))
            conn.commit()


    # --------------------------------------------------------------------------
    # Registrace a tvorba účtů
    # --------------------------------------------------------------------------
    def create_initial_admin(self, username: str, password: str, email: Optional[str] = None) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
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
            cursor.execute("""
                INSERT INTO users (username, email, password_hash, salt, role, status, created_at, last_login)
                VALUES (?, ?, ?, ?, 'admin', 'approved', ?, ?)
            """, (username, (email.strip() if email else None), pwd_hash, salt, now, now))
            user_id = cursor.lastrowid
            conn.commit()

        return {
            "id": user_id,
            "username": username,
            "email": email,
            "role": "admin",
            "status": "approved",
            "created_at": now
        }, None

    def register_user(self, username: str, password: str, email: Optional[str] = None) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
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
                cursor.execute("""
                    INSERT INTO users (username, email, password_hash, salt, role, status, created_at)
                    VALUES (?, ?, ?, ?, 'user', 'pending', ?)
                """, (username, (email.strip() if email else None), pwd_hash, salt, now))
                user_id = cursor.lastrowid
                conn.commit()

            return {
                "id": user_id,
                "username": username,
                "email": email,
                "role": "user",
                "status": "pending",
                "created_at": now
            }, None
        except sqlite3.IntegrityError:
            return None, f"Uživatel se jménem '{username}' již existuje. Zvolte prosím jiné jméno."

    # --------------------------------------------------------------------------
    # Přihlašování a ověření
    # --------------------------------------------------------------------------
    def authenticate(self, username_or_email: str, password: str) -> Tuple[Optional[Dict[str, Any]], str]:
        """
        Ověří přihlašovací údaje.
        Vrací (user_dict, "ok") nebo (None, chybová_zpráva).
        """
        query_val = username_or_email.strip()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, username, email, password_hash, salt, role, status, created_at, last_login
                FROM users
                WHERE username = ? OR email = ?
            """, (query_val, query_val))
            row = cursor.fetchone()

        if not row:
            return None, "Nesprávné uživatelské jméno nebo heslo."

        if not self.verify_password(password, row["password_hash"], row["salt"]):
            return None, "Nesprávné uživatelské jméno nebo heslo."

        status = row["status"]
        if status == "pending":
            return None, "Váš účet čeká na schválení administrátorem serveru. Jakmile bude schválen, budete se moci přihlásit."
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
            "last_login": now
        }, "ok"

    # --------------------------------------------------------------------------
    # Správa relací (Sessions)
    # --------------------------------------------------------------------------
    def create_session(self, user_id: int, remember_me: bool = False, user_agent: str = "") -> Tuple[str, datetime]:
        """Vytvoří novou relaci. Pokud remember_me=True, platí 30 dní, jinak 1 den."""
        token = secrets.token_urlsafe(48)
        now = datetime.now()
        duration = timedelta(days=30) if remember_me else timedelta(days=1)
        expires_at = now + duration

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO sessions (token, user_id, created_at, expires_at, remember_me, user_agent)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (token, user_id, now.isoformat(), expires_at.isoformat(), 1 if remember_me else 0, user_agent[:255]))
            conn.commit()

        return token, expires_at

    def validate_session(self, token: Optional[str]) -> Optional[Dict[str, Any]]:
        """Ověří session token. Vrací data uživatele, nebo None pokud je neplatný/expirovaný."""
        if not token:
            return None

        now_str = datetime.now().isoformat()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT u.id, u.username, u.email, u.role, u.status, u.created_at, u.last_login, s.expires_at, s.remember_me
                FROM sessions s
                JOIN users u ON s.user_id = u.id
                WHERE s.token = ?
            """, (token,))
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
                "remember_me": bool(row["remember_me"])
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
    def list_users(self) -> List[Dict[str, Any]]:
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

    def get_user_by_id(self, user_id: int) -> Optional[Dict[str, Any]]:
        """Vrátí údaje uživatele podle ID."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, username, email, role, status, created_at, last_login
                FROM users
                WHERE id = ?
            """, (user_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def list_pending_requests(self) -> List[Dict[str, Any]]:
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
            cursor.execute("UPDATE users SET status = 'approved', role = ? WHERE id = ? AND status = 'pending'", (role, user_id))
            conn.commit()
            return cursor.rowcount > 0

    def change_user_role(self, user_id: int, new_role: str, current_admin_id: int) -> Tuple[bool, str]:
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
                role_label = "Administrátor" if new_role == "admin" else ("Uživatel" if new_role == "user" else "Pozorovatel")
                return True, f"Role byla úspěšně změněna na: {role_label}"
            return False, "Uživatel nebyl nalezen."

    def reject_user(self, user_id: int) -> bool:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET status = 'rejected' WHERE id = ? AND status = 'pending'", (user_id,))
            conn.commit()
            return cursor.rowcount > 0

    def toggle_user_active(self, user_id: int, current_admin_id: int) -> Tuple[bool, str]:
        """Aktivuje/deaktivuje účet uživatele. Brání administrátorovi zablokovat sám sebe."""
        if user_id == current_admin_id:
            return False, "Nemůžete zablokovat svůj vlastní administrátorský účet."

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT status, role FROM users WHERE id = ?", (user_id,))
            row = cursor.fetchone()
            if not row:
                return False, "Uživatel nebyl nalezen."

            new_status = "disabled" if row["status"] == "approved" else "approved"
            cursor.execute("UPDATE users SET status = ? WHERE id = ?", (new_status, user_id))
            
            # Pokud uživatele blokujeme, zneplatníme jeho aktivní relace
            if new_status == "disabled":
                cursor.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

            conn.commit()
            return True, f"Stav uživatele byl změněn na: {new_status}"

    def delete_user(self, user_id: int, current_admin_id: int) -> Tuple[bool, str]:
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

    def get_auth_summary(self) -> Dict[str, Any]:
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
            "allow_guest": self.is_guest_allowed()
        }

