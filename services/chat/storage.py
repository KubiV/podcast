"""Infrastruktura chatu: datové cesty, SQLite připojení, schéma a migrace; klienti ChromaDB a Gemini z core.clients."""

import os
import re
import sqlite3
import sys
from datetime import datetime

from dotenv import load_dotenv
from google import genai

from core import clients as core_clients

load_dotenv()


def get_user_data_dir() -> str:
    """Vrací absolutní cestu k perzistentní složce s uživatelskými daty aplikace."""
    if "AIMEDSTUDIO_DATA_DIR" in os.environ and os.environ["AIMEDSTUDIO_DATA_DIR"]:
        return os.path.abspath(os.environ["AIMEDSTUDIO_DATA_DIR"])
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        portable_data_dir = os.path.join(exe_dir, "data")
        if os.path.exists(portable_data_dir):
            return portable_data_dir
        return os.path.expanduser("~/Documents/AIMedStudio")
    # Zachováno chování původního services/chat_service.py: záložní složka services/ (viz nález A8 v auditu)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


USER_DATA_DIR = get_user_data_dir()
os.makedirs(USER_DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(USER_DATA_DIR, "chat_history.db")
CHROMA_DIR = os.path.join(USER_DATA_DIR, "chroma_db")
os.makedirs(CHROMA_DIR, exist_ok=True)

# Klienti ChromaDB a Gemini jsou sdílení s core.clients: jeden PersistentClient na proces (R5)
# a klíč Gemini podle režimu API klíčů včetně per-user BYOK (R4).
get_chroma_client = core_clients.get_chroma_client
get_gemini_api_key = core_clients.get_gemini_api_key


def get_ai_client() -> genai.Client:
    """Vrací klienta Gemini s klíčem aktuálního uživatele (sdílený klíč serveru nebo vlastní klíč – BYOK)."""
    if not get_gemini_api_key():
        raise ValueError(
            "Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a zadejte svůj API klíč."
        )
    return core_clients.get_gemini_client()


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    return conn


def migrate_legacy_messages(conn: sqlite3.Connection):
    """Migruje stávající zprávy bez thread_id do výchozího vlákna pro daný projekt."""
    try:
        cursor = conn.execute(
            """
            SELECT DISTINCT project_id
            FROM chat_messages
            WHERE thread_id IS NULL OR thread_id = ''
            """
        )
        unthreaded_projects = [row["project_id"] for row in cursor.fetchall()]
        for proj in unthreaded_projects:
            msg_cursor = conn.execute(
                """
                SELECT content, created_at
                FROM chat_messages
                WHERE project_id = ? AND role = 'user' AND (thread_id IS NULL OR thread_id = '')
                ORDER BY id ASC LIMIT 1
                """,
                (proj,),
            )
            first_msg = msg_cursor.fetchone()
            if first_msg and first_msg["content"]:
                first_text = first_msg["content"].strip().replace("\n", " ")
                title = first_text[:60] + ("..." if len(first_text) > 60 else "")
            else:
                title = f"Původní konverzace ({proj})"

            last_cursor = conn.execute(
                """
                SELECT created_at FROM chat_messages
                WHERE project_id = ? AND (thread_id IS NULL OR thread_id = '')
                ORDER BY id DESC LIMIT 1
                """,
                (proj,),
            )
            last_msg = last_cursor.fetchone()
            updated_at = last_msg["created_at"] if last_msg else datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            thread_id = f"thread_legacy_{re.sub(r'[^a-zA-Z0-9_-]', '_', proj.strip())}"

            conn.execute(
                """
                INSERT OR IGNORE INTO chat_threads (id, project_id, title, is_pinned, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?)
                """,
                (thread_id, proj, title, updated_at, updated_at),
            )
            conn.execute(
                """
                UPDATE chat_messages
                SET thread_id = ?
                WHERE project_id = ? AND (thread_id IS NULL OR thread_id = '')
                """,
                (thread_id, proj),
            )
        conn.commit()
    except Exception as e:
        print(f"[chat_service] Warning: Legacy message migration skipped or failed: {e}")


def init_db():
    """Vytvoří tabulky pro ukládání historie konverzací, vláken a lekcí, pokud neexistují."""
    with get_db_connection() as conn:
        # 1. Tabulka chatových vláken
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_threads (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                is_pinned INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_chat_threads_proj
            ON chat_threads(project_id, is_pinned DESC, updated_at DESC)
            """
        )

        # 2. Tabulka zpráv
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sources_json TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                thread_id TEXT
            )
            """
        )

        # Kontrola a migrace sloupce thread_id, pokud tabulka existovala dříve
        cursor = conn.execute("PRAGMA table_info(chat_messages)")
        cols = [col["name"] for col in cursor.fetchall()]
        if "thread_id" not in cols:
            conn.execute("ALTER TABLE chat_messages ADD COLUMN thread_id TEXT")

        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_chat_project
            ON chat_messages(project_id, created_at)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_chat_thread
            ON chat_messages(thread_id, created_at)
            """
        )

        # 3. Tabulka výukových lekcí
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lessons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                target_language TEXT NOT NULL,
                markdown_content TEXT NOT NULL,
                lecture_script TEXT NOT NULL,
                audio_filename TEXT NOT NULL,
                audio_url TEXT NOT NULL,
                chapters_json TEXT,
                status TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # 4. Tabulky pro hybridní full-textové vyhledávání (SQLite FTS5 + BM25)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_chunks_meta (
                chunk_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                source TEXT NOT NULL,
                page TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_chunks_meta_proj
            ON project_chunks_meta(project_id)
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS project_chunks_fts USING fts5(
                project_id UNINDEXED,
                chunk_id UNINDEXED,
                source UNINDEXED,
                page UNINDEXED,
                content,
                tokenize = 'unicode61 remove_diacritics 2'
            )
            """
        )
        conn.commit()

        # 5. Spustíme migraci starších zpráv
        migrate_legacy_messages(conn)


# Inicializujeme DB při importu
init_db()


def sanitize_project_name(name: str) -> str:
    """
    ID projektu v chatové DB (vlákna, FTS) a v názvech Chroma kolekcí – povoluje jen ASCII `[a-zA-Z0-9_-]`.

    Záměrně se liší od `core.utils.sanitize_name` (ID v uploads/), např. `Kardiologie_č` → `Kardiologie__`.
    Sjednocení by změnilo ID existujících dat, a proto vyžaduje migraci (nález R1 v docs/audit/AUDIT.md).
    """
    return re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip())
