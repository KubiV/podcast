import os
import sys
import sqlite3
import json
import asyncio
import re
import uuid
import unicodedata
from datetime import datetime
from typing import Any, AsyncGenerator, List, Dict, Optional
from google import genai
from google.genai import types
from dotenv import load_dotenv
import chromadb

load_dotenv()


def get_user_data_dir() -> str:
    """Vrací absolutní cestu k perzistentní složce s uživatelskými daty aplikace."""
    if "AIMEDSTUDIO_DATA_DIR" in os.environ and os.environ["AIMEDSTUDIO_DATA_DIR"]:
        return os.environ["AIMEDSTUDIO_DATA_DIR"]
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        portable_data_dir = os.path.join(exe_dir, "data")
        if os.path.exists(portable_data_dir):
            return portable_data_dir
        return os.path.expanduser("~/Documents/AIMedStudio")
    return os.path.dirname(os.path.abspath(__file__))


USER_DATA_DIR = get_user_data_dir()
os.makedirs(USER_DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(USER_DATA_DIR, "chat_history.db")
CHROMA_DIR = os.path.join(USER_DATA_DIR, "chroma_db")
os.makedirs(CHROMA_DIR, exist_ok=True)

# Lazy-initialized clients
_chroma_client = None
_ai_client = None


def get_chroma_client() -> chromadb.PersistentClient:
    global _chroma_client
    if _chroma_client is None:
        try:
            import main
            if hasattr(main, "chroma_client") and main.chroma_client is not None:
                _chroma_client = main.chroma_client
                return _chroma_client
        except Exception:
            pass
        _chroma_client = chromadb.PersistentClient(path=CHROMA_DIR)
    return _chroma_client


def get_gemini_api_key() -> str:
    """Načte Google Gemini API klíč z uživatelské konfigurace (BYOK) nebo ze systémových proměnných."""
    config_file = os.path.join(get_user_data_dir(), "user_config.json")
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                key = (cfg.get("gemini_api_key") or "").strip()
                if key:
                    return key
        except Exception:
            pass
    return (os.getenv("GEMINI_API_KEY") or "").strip()


def get_ai_client() -> genai.Client:
    """Vrací inicializovaného klienta Gemini se zadaným API klíčem."""
    global _ai_client
    current_key = get_gemini_api_key()
    if not current_key:
        raise ValueError(
            "Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a zadejte svůj API klíč."
        )
    cached_key = getattr(_ai_client, "_cached_api_key", None) if _ai_client else None
    if _ai_client is None or cached_key != current_key:
        _ai_client = genai.Client(api_key=current_key)
        setattr(_ai_client, "_cached_api_key", current_key)
    return _ai_client


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
    return re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip())


# --- SPRÁVA CHATOVÝCH VLÁKEN (THREADS / SESSIONS) ---

def generate_thread_id() -> str:
    return f"thread_{uuid.uuid4().hex[:12]}"


def create_thread(
    project_id: str,
    title: Optional[str] = None,
    thread_id: Optional[str] = None,
) -> Dict[str, Any]:
    safe_proj = sanitize_project_name(project_id)
    t_id = thread_id or generate_thread_id()
    t_title = (title or "Nová konverzace").strip()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_db_connection() as conn:
        conn.execute(
            """
            INSERT INTO chat_threads (id, project_id, title, is_pinned, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title
            """,
            (t_id, safe_proj, t_title, now_str, now_str),
        )
        conn.commit()
    return {
        "id": t_id,
        "project_id": safe_proj,
        "title": t_title,
        "is_pinned": False,
        "created_at": now_str,
        "updated_at": now_str,
        "message_count": 0,
        "last_snippet": "",
        "last_role": "",
    }


def get_thread(thread_id: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            SELECT t.id, t.project_id, t.title, t.is_pinned, t.created_at, t.updated_at,
                   COUNT(m.id) as message_count
            FROM chat_threads t
            LEFT JOIN chat_messages m ON m.thread_id = t.id
            WHERE t.id = ?
            GROUP BY t.id
            """,
            (thread_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "project_id": row["project_id"],
            "title": row["title"],
            "is_pinned": bool(row["is_pinned"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "message_count": row["message_count"],
        }


def list_threads(
    project_id: Optional[str] = None,
    search_query: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    safe_proj = sanitize_project_name(project_id) if project_id and project_id != "__all__" else None
    query_parts = [
        """
        SELECT t.id, t.project_id, t.title, t.is_pinned, t.created_at, t.updated_at,
               COUNT(m.id) AS message_count,
               (
                   SELECT m2.content FROM chat_messages m2 
                   WHERE m2.thread_id = t.id 
                   ORDER BY m2.id DESC LIMIT 1
               ) AS last_content,
               (
                   SELECT m3.role FROM chat_messages m3 
                   WHERE m3.thread_id = t.id 
                   ORDER BY m3.id DESC LIMIT 1
               ) AS last_role
        FROM chat_threads t
        LEFT JOIN chat_messages m ON m.thread_id = t.id
        WHERE 1=1
        """
    ]
    params: List[Any] = []

    if safe_proj:
        query_parts.append("AND t.project_id = ?")
        params.append(safe_proj)

    clean_search = (search_query or "").strip()
    if clean_search:
        # Hledáme v názvu vlákna NEBO v obsahu libovolné zprávy daného vlákna
        query_parts.append(
            """
            AND (
                t.title LIKE ? OR
                EXISTS (
                    SELECT 1 FROM chat_messages sm 
                    WHERE sm.thread_id = t.id AND sm.content LIKE ?
                )
            )
            """
        )
        like_term = f"%{clean_search}%"
        params.extend([like_term, like_term])

    query_parts.append("GROUP BY t.id")
    query_parts.append("ORDER BY t.is_pinned DESC, t.updated_at DESC, t.id DESC")
    query_parts.append(f"LIMIT {int(limit)}")

    sql = "\n".join(query_parts)

    with get_db_connection() as conn:
        cursor = conn.execute(sql, params)
        rows = cursor.fetchall()
        threads = []
        for r in rows:
            last_content = r["last_content"] or ""
            snippet = last_content.strip().replace("\n", " ")[:90]
            if len(last_content.strip()) > 90:
                snippet += "..."
            threads.append(
                {
                    "id": r["id"],
                    "project_id": r["project_id"],
                    "title": r["title"],
                    "is_pinned": bool(r["is_pinned"]),
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                    "message_count": r["message_count"],
                    "last_snippet": snippet,
                    "last_role": r["last_role"] or "",
                }
            )
        return threads


def update_thread(
    thread_id: str,
    title: Optional[str] = None,
    is_pinned: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        updates = []
        params = []
        if title is not None:
            updates.append("title = ?")
            params.append(title.strip())
        if is_pinned is not None:
            updates.append("is_pinned = ?")
            params.append(1 if is_pinned else 0)
        if not updates:
            return get_thread(thread_id)

        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(thread_id)
        sql = f"UPDATE chat_threads SET {', '.join(updates)} WHERE id = ?"
        conn.execute(sql, params)
        conn.commit()
    return get_thread(thread_id)


def toggle_thread_pin(thread_id: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        conn.execute(
            """
            UPDATE chat_threads 
            SET is_pinned = CASE WHEN is_pinned = 1 THEN 0 ELSE 1 END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (thread_id,),
        )
        conn.commit()
    return get_thread(thread_id)


def delete_thread(thread_id: str) -> bool:
    with get_db_connection() as conn:
        conn.execute("DELETE FROM chat_messages WHERE thread_id = ?", (thread_id,))
        conn.execute("DELETE FROM chat_threads WHERE id = ?", (thread_id,))
        conn.commit()
    return True


def get_thread_messages(thread_id: str, limit: int = 200) -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            SELECT id, project_id, thread_id, role, content, sources_json, created_at
            FROM chat_messages
            WHERE thread_id = ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (thread_id, limit),
        )
        rows = cursor.fetchall()
        messages = []
        for r in rows:
            sources = []
            if r["sources_json"]:
                try:
                    sources = json.loads(r["sources_json"])
                except Exception:
                    sources = []
            messages.append(
                {
                    "id": r["id"],
                    "project_id": r["project_id"],
                    "thread_id": r["thread_id"],
                    "role": r["role"],
                    "content": r["content"],
                    "sources": sources,
                    "created_at": r["created_at"],
                }
            )
        return messages


# --- SPRÁVA ZPRÁV V CHATU (PROJEKT & VLÁKNO) ---

def get_project_messages(project_id: str, limit: int = 50, thread_id: Optional[str] = None) -> List[Dict[str, Any]]:
    if thread_id:
        return get_thread_messages(thread_id, limit=limit)

    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            SELECT id, project_id, thread_id, role, content, sources_json, created_at
            FROM chat_messages
            WHERE project_id = ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (safe_proj, limit),
        )
        rows = cursor.fetchall()
        messages = []
        for r in rows:
            sources = []
            if r["sources_json"]:
                try:
                    sources = json.loads(r["sources_json"])
                except Exception:
                    sources = []
            messages.append(
                {
                    "id": r["id"],
                    "project_id": r["project_id"],
                    "thread_id": r["thread_id"],
                    "role": r["role"],
                    "content": r["content"],
                    "sources": sources,
                    "created_at": r["created_at"],
                }
            )
        return messages


def save_message(
    project_id: str,
    role: str,
    content: str,
    sources: Optional[List[Dict[str, Any]]] = None,
    thread_id: Optional[str] = None,
) -> int:
    safe_proj = sanitize_project_name(project_id)
    sources_str = json.dumps(sources, ensure_ascii=False) if sources else None
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO chat_messages (project_id, thread_id, role, content, sources_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (safe_proj, thread_id, role, content, sources_str),
        )
        msg_id = cursor.lastrowid

        if thread_id:
            conn.execute(
                "UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (thread_id,),
            )
            # Pokud je to zpráva uživatele a název vlákna je "Nová konverzace", automaticky ho pojmenujeme
            if role == "user":
                t_cur = conn.execute("SELECT title FROM chat_threads WHERE id = ?", (thread_id,))
                t_row = t_cur.fetchone()
                if t_row and (t_row["title"] == "Nová konverzace" or not t_row["title"].strip()):
                    clean_title = content.strip().replace("\n", " ")[:60]
                    if len(content.strip()) > 60:
                        clean_title += "..."
                    conn.execute(
                        "UPDATE chat_threads SET title = ? WHERE id = ?",
                        (clean_title, thread_id),
                    )

        conn.commit()
        return msg_id


def clear_project_messages(project_id: str) -> bool:
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (safe_proj,))
        conn.commit()
    return True


def delete_project_records(project_id: str) -> None:
    """Kompletně smaže všechny záznamy projektu z databáze SQLite (chat, vlákna, lekce, FTS i metadata chunků)."""
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM lessons WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM project_chunks_fts WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM project_chunks_meta WHERE project_id = ?", (safe_proj,))
        conn.commit()


def rename_project_records(old_project_id: str, new_project_id: str) -> None:
    """Přejmenuje vazby projektu ve všech tabulkách SQLite."""
    old_proj = sanitize_project_name(old_project_id)
    new_proj = sanitize_project_name(new_project_id)
    with get_db_connection() as conn:
        conn.execute("UPDATE chat_messages SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.execute("UPDATE chat_threads SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.execute("UPDATE lessons SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.execute("UPDATE project_chunks_meta SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.execute("UPDATE project_chunks_fts SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.commit()


def export_thread_chat_markdown(thread_id: str) -> str:
    thread = get_thread(thread_id)
    title = thread["title"] if thread else f"Konverzace {thread_id}"
    proj = thread["project_id"] if thread else ""
    messages = get_thread_messages(thread_id, limit=500)
    lines = [
        f"# {title}",
        f"*Projekt: {proj} | Vygenerováno: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*",
        "",
        "---",
        "",
    ]
    for msg in messages:
        role_label = "👤 Uživatel" if msg["role"] == "user" else "🤖 Asistent (Grounded)"
        lines.append(f"### {role_label} *({msg['created_at']})*")
        lines.append("")
        lines.append(msg["content"])
        lines.append("")
        if msg.get("sources"):
            lines.append("**Citované zdroje:**")
            for s in msg["sources"]:
                lines.append(f"- `[{s.get('id', '?')}]` {s.get('filename', 'Neznámý soubor')}")
            lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


def export_project_chat_markdown(project_id: str, thread_id: Optional[str] = None) -> str:
    if thread_id:
        return export_thread_chat_markdown(thread_id)

    messages = get_project_messages(project_id, limit=200)
    lines = [
        f"# Export chatu – Projekt: {project_id}",
        f"*Vygenerováno: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*",
        "",
        "---",
        "",
    ]
    for msg in messages:
        role_label = "👤 Uživatel" if msg["role"] == "user" else "🤖 Asistent (Grounded)"
        lines.append(f"### {role_label} *({msg['created_at']})*")
        lines.append("")
        lines.append(msg["content"])
        lines.append("")
        if msg.get("sources"):
            lines.append("**Citované zdroje:**")
            for s in msg["sources"]:
                lines.append(f"- `[{s.get('id', '?')}]` {s.get('filename', 'Neznámý soubor')}")
            lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


# --- SPRÁVA VÝUKOVÝCH LEKCÍ (LESSONS) ---

def save_or_update_lesson(
    project_id: str,
    title: str,
    target_language: str,
    markdown_content: str,
    lecture_script: str,
    audio_filename: str,
    audio_url: str,
    chapters: Optional[List[Dict[str, Any]]] = None,
    status: str = "completed",
) -> int:
    safe_proj = sanitize_project_name(project_id)
    chapters_str = json.dumps(chapters or [], ensure_ascii=False)
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO lessons (
                project_id, title, target_language, markdown_content,
                lecture_script, audio_filename, audio_url, chapters_json, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                title = excluded.title,
                target_language = excluded.target_language,
                markdown_content = excluded.markdown_content,
                lecture_script = excluded.lecture_script,
                audio_filename = excluded.audio_filename,
                audio_url = excluded.audio_url,
                chapters_json = excluded.chapters_json,
                status = excluded.status,
                created_at = CURRENT_TIMESTAMP
            """,
            (
                safe_proj,
                title,
                target_language,
                markdown_content,
                lecture_script,
                audio_filename,
                audio_url,
                chapters_str,
                status,
            ),
        )
        conn.commit()
        return cursor.lastrowid


def get_lesson(project_id: str) -> Optional[Dict[str, Any]]:
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            SELECT id, project_id, title, target_language, markdown_content,
                   lecture_script, audio_filename, audio_url, chapters_json, status, created_at
            FROM lessons
            WHERE project_id = ?
            """,
            (safe_proj,),
        )
        r = cursor.fetchone()
        if not r:
            return None
        chapters = []
        if r["chapters_json"]:
            try:
                chapters = json.loads(r["chapters_json"])
            except Exception:
                chapters = []
        return {
            "id": r["id"],
            "project_id": r["project_id"],
            "title": r["title"],
            "target_language": r["target_language"],
            "markdown_content": r["markdown_content"],
            "lecture_script": r["lecture_script"],
            "audio_filename": r["audio_filename"],
            "audio_url": r["audio_url"],
            "chapters": chapters,
            "status": r["status"],
            "created_at": r["created_at"],
        }


def list_lessons() -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            SELECT id, project_id, title, target_language, audio_filename,
                   audio_url, chapters_json, status, created_at
            FROM lessons
            ORDER BY id DESC
            """
        )
        rows = cursor.fetchall()
        lessons = []
        for r in rows:
            chapters = []
            if r["chapters_json"]:
                try:
                    chapters = json.loads(r["chapters_json"])
                except Exception:
                    chapters = []
            lessons.append(
                {
                    "id": r["id"],
                    "project_id": r["project_id"],
                    "title": r["title"],
                    "target_language": r["target_language"],
                    "audio_filename": r["audio_filename"],
                    "audio_url": r["audio_url"],
                    "chapters_count": len(chapters),
                    "status": r["status"],
                    "created_at": r["created_at"],
                }
            )
        return lessons


def delete_lesson(project_id: str) -> bool:
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        conn.execute("DELETE FROM lessons WHERE project_id = ?", (safe_proj,))
        conn.commit()
    return True


# --- HYBRIDNÍ RAG RETRIEVAL & GROUNDING (CHROMADB + SQLITE FTS5 BM25) ---

def clean_czech_stem(token: str) -> str:
    """Jednoduchý a deterministický odhad kořene slova pro české pádové koncovky."""
    endings = [
        "ovými", "ových", "ovému", "ového", "ovaný", "ovaná", "ované",
        "ující", "ických", "ickému", "ického", "ická", "ické", "ický",
        "ami", "ata", "ech", "ich", "ích", "ého", "ému", "ých", "ové",
        "ovi", "em", "ou", "am", "ám", "um", "ům", "im", "ím", "es",
        "e", "a", "u", "y", "i", "o"
    ]
    norm = "".join(c for c in unicodedata.normalize("NFD", token.lower()) if unicodedata.category(c) != "Mn")
    for end in endings:
        if norm.endswith(end) and len(norm) - len(end) >= 3:
            return token[:len(norm) - len(end)]
    return token[:-1] if len(token) > 3 else token


CZECH_STOP_WORDS = {
    "a", "i", "v", "s", "z", "o", "u", "k", "se", "si", "je", "jsou", "to", "ten", "ta", "toho",
    "jak", "jake", "jaké", "jaka", "jaká", "jaky", "jaký", "jakou", "kter", "ktere", "které",
    "ktera", "která", "ktery", "který", "kterou", "ma", "má", "maji", "mají", "mit", "mít",
    "co", "kdo", "kde", "kdy", "proc", "proč", "pro", "pri", "při", "podle", "pred", "před", "po",
    "nebo", "ani", "ale", "byl", "byla", "bylo", "byli", "tento", "tato", "toto", "mezi", "jako"
}


def build_czech_fts_query(user_query: str) -> str:
    """Připraví optimalizovaný FTS5 dotaz s prefixovým vyhledáváním a lékařskými synonymy."""
    cleaned = re.sub(r"[^\w\s]", " ", user_query)
    tokens = [w.strip() for w in cleaned.split() if w.strip()]
    terms: List[str] = []

    for t in tokens:
        t_norm = "".join(c for c in unicodedata.normalize("NFD", t.lower()) if unicodedata.category(c) != "Mn")
        if len(t_norm) < 3 or t_norm in CZECH_STOP_WORDS:
            continue

        # Přidáme přesný token
        terms.append(t)

        # Přidáme kmen s prefixovou hvězdičkou
        stem = clean_czech_stem(t)
        if len(stem) >= 3 and stem.lower() != t.lower():
            terms.append(f"{stem}*")
        elif len(t) >= 4:
            terms.append(f"{t[:3]}*")

        # Lékařská rozšíření a ekvivalenty
        if "jod" in t_norm:
            terms.extend(["radiojod*", "jodov*"])
        elif "hypert" in t_norm or "tyreo" in t_norm:
            terms.extend(["tyreotox*", "strum*"])

    if not terms:
        return ""

    unique_terms = list(dict.fromkeys(terms))
    return " OR ".join(unique_terms)


def index_chunks_to_fts(
    project_id: str,
    chunks: List[Dict[str, Any]],
):
    """Hromadně uloží chunky do SQLite FTS5 indexu pro hybridní vyhledávání."""
    if not chunks:
        return
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        for c in chunks:
            chunk_id = c.get("id") or f"{c.get('source', 'doc')}_{c.get('chunk_index', 0)}"
            source = c.get("source", "Neznámý dokument")
            page = str(c.get("page", "1"))
            content = c.get("document") or c.get("content") or ""
            if not content.strip():
                continue
            try:
                conn.execute(
                    """
                    INSERT INTO project_chunks_meta (chunk_id, project_id, source, page)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(chunk_id) DO UPDATE SET
                        source = excluded.source,
                        page = excluded.page
                    """,
                    (chunk_id, safe_proj, source, page),
                )
                conn.execute(
                    """
                    DELETE FROM project_chunks_fts 
                    WHERE project_id = ? AND chunk_id = ?
                    """,
                    (safe_proj, chunk_id),
                )
                conn.execute(
                    """
                    INSERT INTO project_chunks_fts (project_id, chunk_id, source, page, content)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (safe_proj, chunk_id, source, page, content),
                )
            except Exception as e:
                print(f"[chat_service] Error inserting FTS chunk {chunk_id}: {e}")
        conn.commit()


def delete_chunks_from_fts(project_id: str, source: Optional[str] = None):
    """Smaže záznamy projektu (nebo konkrétního souboru) z FTS5 indexu."""
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        if source:
            conn.execute(
                "DELETE FROM project_chunks_fts WHERE project_id = ? AND source = ?",
                (safe_proj, source),
            )
            conn.execute(
                "DELETE FROM project_chunks_meta WHERE project_id = ? AND source = ?",
                (safe_proj, source),
            )
        else:
            conn.execute(
                "DELETE FROM project_chunks_fts WHERE project_id = ?",
                (safe_proj,),
            )
            conn.execute(
                "DELETE FROM project_chunks_meta WHERE project_id = ?",
                (safe_proj,),
            )
        conn.commit()


def sync_project_fts(project_id: str) -> int:
    """Zkontroluje synchronizaci mezi ChromaDB a SQLite FTS5 a chybějící chunky automaticky dotáhne."""
    safe_proj = sanitize_project_name(project_id)
    chroma = get_chroma_client()
    collection_name = f"proj_{safe_proj}"
    try:
        col = chroma.get_collection(name=collection_name)
    except Exception:
        return 0

    chroma_count = col.count()
    if chroma_count == 0:
        return 0

    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) as cnt FROM project_chunks_meta WHERE project_id = ?",
            (safe_proj,),
        ).fetchone()
        fts_count = row["cnt"] if row else 0

    if fts_count >= chroma_count:
        return fts_count

    data = col.get()
    if not data or not data.get("ids"):
        return 0

    with get_db_connection() as conn:
        existing_rows = conn.execute(
            "SELECT chunk_id FROM project_chunks_meta WHERE project_id = ?",
            (safe_proj,),
        ).fetchall()
        existing_ids = {r["chunk_id"] for r in existing_rows}

    to_index = []
    for cid, doc, meta in zip(data["ids"], data["documents"], data["metadatas"]):
        if cid not in existing_ids:
            meta_dict = meta if isinstance(meta, dict) else {}
            to_index.append(
                {
                    "id": cid,
                    "document": doc,
                    "source": meta_dict.get("source", "Neznámý dokument"),
                    "page": str(meta_dict.get("page", "1")),
                }
            )

    if to_index:
        index_chunks_to_fts(safe_proj, to_index)

    return chroma_count


async def retrieve_chat_context(
    project_id: str, query: str, n_results: int = 15, return_raw: bool = False
) -> Any:
    """Vyhledá nejrelevantnější pasáže pomocí hybridního vyhledávání (ChromaDB dense + SQLite FTS5 BM25 s RRF fúzí)."""
    safe_proj = sanitize_project_name(project_id)
    collection_name = f"proj_{safe_proj}"
    chroma = get_chroma_client()

    # 1. Zajištění synchronizace s FTS5 indexem
    try:
        sync_project_fts(safe_proj)
    except Exception as e:
        print(f"[chat_service] sync_project_fts error: {e}")

    try:
        collection = chroma.get_collection(name=collection_name)
        count = collection.count()
    except Exception:
        count = 0
        collection = None

    if count == 0:
        if return_raw:
            return "", [], ""
        return "", []

    # 2. Dense vyhledávání přes ChromaDB
    dense_ids: List[str] = []
    try:
        actual_dense_n = min(max(30, n_results * 2), count)
        dense_results = collection.query(query_texts=[query], n_results=actual_dense_n)
        if dense_results and dense_results.get("ids") and dense_results["ids"]:
            dense_ids = dense_results["ids"][0]
    except Exception as e:
        print(f"[chat_service] Dense query error: {e}")

    # 3. Sparse vyhledávání přes SQLite FTS5 (BM25)
    sparse_ids: List[str] = []
    fts_query = build_czech_fts_query(query)
    if fts_query:
        try:
            with get_db_connection() as conn:
                cur = conn.execute(
                    """
                    SELECT chunk_id, bm25(project_chunks_fts) as score
                    FROM project_chunks_fts
                    WHERE project_id = ? AND project_chunks_fts MATCH ?
                    ORDER BY score ASC
                    LIMIT 40
                    """,
                    (safe_proj, fts_query),
                )
                sparse_ids = [r["chunk_id"] for r in cur.fetchall()]
        except Exception as e:
            print(f"[chat_service] Sparse query error for '{fts_query}': {e}")
            try:
                simple_query = " OR ".join([f'"{w}"' for w in query.split() if len(w) >= 3])
                if simple_query:
                    with get_db_connection() as conn:
                        cur = conn.execute(
                            """
                            SELECT chunk_id, bm25(project_chunks_fts) as score
                            FROM project_chunks_fts
                            WHERE project_id = ? AND project_chunks_fts MATCH ?
                            ORDER BY score ASC
                            LIMIT 30
                            """,
                            (safe_proj, simple_query),
                        )
                        sparse_ids = [r["chunk_id"] for r in cur.fetchall()]
            except Exception:
                pass

    # 4. Reciprocal Rank Fusion (RRF)
    rrf_scores: Dict[str, float] = {}
    k = 60.0
    for rank, cid in enumerate(dense_ids):
        rrf_scores[cid] = rrf_scores.get(cid, 0.0) + (1.0 / (k + rank + 1.0))

    for rank, cid in enumerate(sparse_ids):
        # 2.0x váha pro přesná klíčová slova v českém odborném textu
        rrf_scores[cid] = rrf_scores.get(cid, 0.0) + (2.0 / (k + rank + 1.0))

    if not rrf_scores:
        if return_raw:
            return "", [], ""
        return "", []

    top_chunk_ids = sorted(rrf_scores.keys(), key=lambda x: rrf_scores[x], reverse=True)[:n_results]

    # 5. Načtení obsahu a metadat chunků z SQLite FTS5 (bleskové)
    chunks_data: Dict[str, Dict[str, Any]] = {}
    try:
        with get_db_connection() as conn:
            placeholders = ",".join("?" * len(top_chunk_ids))
            cur = conn.execute(
                f"""
                SELECT chunk_id, source, page, content
                FROM project_chunks_fts
                WHERE project_id = ? AND chunk_id IN ({placeholders})
                """,
                [safe_proj] + top_chunk_ids,
            )
            for r in cur.fetchall():
                chunks_data[r["chunk_id"]] = {
                    "source": r["source"],
                    "page": r["page"],
                    "content": r["content"],
                }
    except Exception as e:
        print(f"[chat_service] Error loading chunk data from FTS: {e}")

    # Fallback na ChromaDB pro případně chybějící
    missing_ids = [cid for cid in top_chunk_ids if cid not in chunks_data]
    if missing_ids and collection:
        try:
            chroma_docs = collection.get(ids=missing_ids)
            if chroma_docs and chroma_docs.get("ids"):
                for cid, doc, meta in zip(chroma_docs["ids"], chroma_docs["documents"], chroma_docs["metadatas"]):
                    m = meta if isinstance(meta, dict) else {}
                    chunks_data[cid] = {
                        "source": m.get("source", "Neznámý dokument"),
                        "page": str(m.get("page", "1")),
                        "content": doc,
                    }
        except Exception:
            pass

    # 6. Sestavení kontextu a citací
    unique_sources: List[Dict[str, Any]] = []
    source_to_id: Dict[str, int] = {}
    labeled_chunks: List[str] = []
    raw_chunks: List[str] = []

    for rank, cid in enumerate(top_chunk_ids):
        data = chunks_data.get(cid)
        if not data:
            continue
        filename = data.get("source", "Neznámý dokument")
        doc_text = data.get("content", "")
        if filename not in source_to_id:
            src_id = len(unique_sources) + 1
            source_to_id[filename] = src_id
            snippet = doc_text[:250].replace("\n", " ").strip() + "..."
            unique_sources.append(
                {
                    "id": src_id,
                    "filename": filename,
                    "snippet": snippet,
                }
            )
        src_id = source_to_id[filename]
        page_val = data.get("page")
        page_label = f" | Strana {page_val}" if page_val else ""
        labeled_chunks.append(f"--- [ZDROJ {src_id}: {filename}{page_label}] ---\n{doc_text}")
        raw_chunks.append(doc_text)

    formatted_context = "\n\n".join(labeled_chunks)
    raw_context = "\n\n...[pokračování textu]...\n\n".join(raw_chunks)

    if return_raw:
        return formatted_context, unique_sources, raw_context
    return formatted_context, unique_sources


# --- STREAMING CHAT COMPLETIONS ---

def clean_leaked_thoughts(t: str) -> str:
    """Odstraní případné nechtěně uniklé myšlenkové bloky nebo scratchpad z textu odpovědi."""
    if not t:
        return ""
    # 1. Odstranění XML/HTML thought značek
    t = re.sub(r"<(thought|think)>[\s\S]*?</\1>", "", t, flags=re.IGNORECASE)
    t = re.sub(r"<(thought|think)>[\s\S]*?$", "", t, flags=re.IGNORECASE)
    # 2. Odstranění komentářových scratchpad bloků typu /* ... */
    t = re.sub(r"^\s*/\*[\s\S]*?\*/\s*", "", t)
    # 3. Odstranění všech úvodních draftů a checklistů (opakovaně, dokud nezačíná skutečný obsah)
    thought_prefix_pattern = re.compile(
        r"^\s*(?:/|/\*)?(?:\*?\*?(?:Strict grounding|Refine Citations|Check carefully|Chain of thought|Thinking process|Grounding check)[^\n]*[\s\S]*?(?:\n\n|\Z))",
        re.IGNORECASE,
    )
    prev = None
    while prev != t:
        prev = t
        t = thought_prefix_pattern.sub("", t)
    # 4. Odstranění zpětných apostrofů okolo citací: `[1, s. 286]` -> [1, s. 286]
    t = re.sub(r"`(\[(?:Zdroj\s*)?\d+(?:,\s*s(?:tr)?\.?\s*[^\]]+)?\])`", r"\1", t)
    # 5. Odstranění osiřelých zpětných apostrofů před hranatou závorkou: `[1, s. -> [1, s.
    t = re.sub(r"`(\[(?:Zdroj\s*)?\d+)", r"\1", t)
    return t.strip()


STRICT_GROUNDED_SYSTEM_PROMPT = """Jsi přísně ukotvený studijní a odborný asistent pro projekt: "{PROJECT}".
Tvým úkolem je zodpovídat dotazy uživatele VÝHRADNĚ a STRIKTNĚ na základě poskytnutých zdrojových materiálů z tohoto projektu s maximální faktickou a klinickou hloubkou.

ZÁVAZNÁ PRAVIDLA CHOVÁNÍ:
1. PŘÍSNÉ UKOTVENÍ V PODKLADECH: Odpovídej pouze s využitím faktů, dat, čísel, klasifikací a mechanismů uvedených v přiložených zdrojích. Nikdy si nevymýšlej ani nedoplňuj externí neověřené informace.
2. PŘIZNÁNÍ CHYBĚJÍCÍCH INFORMACÍ: Pokud poskytnuté podklady neobsahují dostatek informací k zodpovězení dotazu, VÝSLOVNĚ TO UVEĎ (např. "V nahraných materiálech k tomuto projektu tato informace není obsažena. K dispozici jsou pouze údaje o...").
3. GRANULÁRNÍ INLINE CITACE PER-FACTUM: U každého klíčového tvrzení, diagnostického kritéria, čísla či doporučení uveď bezprostředně referenci na citovaný zdroj ve formátu [X, s. Y] (kde X je ID zdroje a Y je číslo strany) nebo [X] (pokud strana chybí). ZÁKAZ souhrnného citování na konci odstavce. Nikdy nevkládej zpětné apostrofy (backticky ` ) okolo hranatých závorek citací.
4. PŘEHLEDNÉ STRUKTUROVÁNÍ A TABULKY (GFM): Používej tučné písmo pro klíčové termíny, odrážky pro výčty a validní GitHub Flavored Markdown tabulky s explicitními novými řádky a prázdnými řádky okolo pro srovnání či diferenciální diagnostiku. Pro matematické/laboratorní vzorce používej KaTeX ($...$).
5. ZACHOVÁNÍ JAZYKA: Odpovídej v jazyce uživatelova dotazu (typicky spisovná čeština se standardní odbornou terminologií).
6. SEZNAM POUŽITÝCH ZDROJŮ NA KONCI: Na samotný konec odpovědi přidej krátkou sekci "### 📚 Citované podklady" se seznamem souborů a stran, ze kterých odpověď čerpala.
7. PŘÍMÝ VÝSTUP BEZ INTERNÍHO MONOLOGU: Nikdy do své odpovědi nevypisuj žádný plán, úvahy, myšlenkový postup (chain-of-thought), kontrolní seznamy ani rekapitulaci těchto pravidel (např. "Strict grounding", "Refine Citations" apod.). Okamžitě a přímo začni samotnou finální věcnou odpovědí pro uživatele."""


async def stream_grounded_chat(
    project_id: str,
    user_message: str,
    model: str = "gemini-3.6-flash",
    custom_system_prompt: str = "",
    thread_id: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    """Generuje streamovanou SSE odpověď asistenta ukotvenou v materiálech projektu."""
    safe_proj = sanitize_project_name(project_id)
    ai = get_ai_client()

    # 0. Zajištění platného vlákna (thread_id)
    if not thread_id:
        new_thread = create_thread(safe_proj, title=user_message.strip()[:60])
        thread_id = new_thread["id"]
    else:
        existing = get_thread(thread_id)
        if not existing:
            create_thread(safe_proj, title=user_message.strip()[:60], thread_id=thread_id)

    # 1. RAG vyhledání kontextu
    context_text, sources = await retrieve_chat_context(safe_proj, user_message, n_results=15)

    # Odešleme událost se nalezenými zdroji
    sources_payload = {
        "type": "sources",
        "project": safe_proj,
        "thread_id": thread_id,
        "sources": sources,
    }
    yield f"event: sources\ndata: {json.dumps(sources_payload, ensure_ascii=False)}\n\n"

    # 2. Načtení předchozí historie konverzace v rámci tohoto vlákna (posledních 8 zpráv pro kontext)
    past_messages = get_thread_messages(thread_id, limit=8)

    # 3. Příprava systémové instrukce a promptu
    base_sys = custom_system_prompt.strip() if custom_system_prompt else STRICT_GROUNDED_SYSTEM_PROMPT
    system_instruction = base_sys.replace("{PROJECT}", safe_proj)

    # Sestavení zprávy s kontextem
    if context_text:
        sources_list_text = "\n".join([f"- [{s['id']}] {s['filename']}" for s in sources])
        prompt_content = (
            f"SEZNAM DOSTUPNÝCH PODKLADŮ PRO TENTO DOTAZ:\n{sources_list_text}\n\n"
            f"=== VÝPIS RELEVANTNÍCH ÚRYVKŮ ZE ZDROJŮ PROJEKTU ===\n"
            f"{context_text}\n"
            f"===================================================\n\n"
        )
    elif custom_system_prompt:
        prompt_content = (
            f"POZNÁMKA: V databázi materiálů projektu '{safe_proj}' nebyly nalezeny specifické úryvky pro tento dotaz. "
            "Využij poskytnutý kontext v systémovém promptu a své odborné znalosti k zodpovězení dotazu.\n\n"
        )
    else:
        prompt_content = (
            f"POZNÁMKA: V databázi materiálů projektu '{safe_proj}' nebyly nalezeny žádné textové úryvky "
            "nebo je projekt zatím prázdný. Upozorni uživatele, že nemá nahrané podklady.\n\n"
        )

    # Přidání předchozích zpráv z tohoto vlákna do kontextu
    if past_messages:
        prompt_content += "HISTORIE NEDÁVNÉ KONVERZACE V TOMTO CHATU:\n"
        for m in past_messages[-6:]:
            role_label = "Uživatel" if m["role"] == "user" else "Asistent"
            prompt_content += f"{role_label}: {m['content'][:800]}\n"
        prompt_content += "\n"

    prompt_content += f"AKTUÁLNÍ DOTAZ UŽIVATELE: {user_message}"

    # Uložíme uživatelskou zprávu
    save_message(safe_proj, role="user", content=user_message, thread_id=thread_id)

    full_response_text = ""
    try:
        # Použijeme streamované volání Gemini API s optimalizovanou konfigurací
        def generate_stream():
            config_params: dict[str, Any] = {
                "system_instruction": system_instruction,
                "temperature": 0.3,
                "max_output_tokens": 8192,
            }
            # Pro modely s reasoningem (Gemini 2.5 / 3.8 apod.) vypneme thinking tokeny v konverzačním chatu
            try:
                config_params["thinking_config"] = types.ThinkingConfig(
                    thinking_budget=0,
                    include_thoughts=False,
                )
                cfg = types.GenerateContentConfig(**config_params)
                return ai.models.generate_content_stream(
                    model=model,
                    contents=[prompt_content],
                    config=cfg,
                )
            except Exception:
                # Bezpečný fallback bez thinking_config pro starší modely
                config_params.pop("thinking_config", None)
                cfg = types.GenerateContentConfig(**config_params)
                return ai.models.generate_content_stream(
                    model=model,
                    contents=[prompt_content],
                    config=cfg,
                )

        # Zabalení do worker vlákna s asyncio Queue pro plynulý SSE stream bez blokování event loopu
        token_queue: asyncio.Queue[tuple[str, Optional[str]]] = asyncio.Queue()

        def stream_worker():
            try:
                stream = generate_stream()
                max_tokens_reached = False
                for chunk in stream:
                    # Detekce useknutí na limitu délky tokenů
                    if chunk.candidates:
                        cand = chunk.candidates[0]
                        fr = getattr(cand, "finish_reason", None)
                        if fr and (fr == types.FinishReason.MAX_TOKENS or "MAX_TOKENS" in str(fr)):
                            max_tokens_reached = True

                    # Bezpečný extrakt textu s vynecháním myšlenkových částí (thought == True)
                    text_delta = ""
                    if chunk.candidates and chunk.candidates[0].content and chunk.candidates[0].content.parts:
                        for part in chunk.candidates[0].content.parts:
                            if getattr(part, "thought", False):
                                continue
                            if part.text:
                                text_delta += part.text
                    elif chunk.text:
                        text_delta = chunk.text

                    if text_delta:
                        asyncio.run_coroutine_threadsafe(
                            token_queue.put(("token", text_delta)), loop
                        ).result()

                if max_tokens_reached:
                    trunc_notice = "\n\n*(⚠️ Odpověď dosáhla maximální povolené délky textu modelu. Pokud si přejete pokračovat, napište prosím „Pokračuj“.)*"
                    asyncio.run_coroutine_threadsafe(
                        token_queue.put(("token", trunc_notice)), loop
                    ).result()

                asyncio.run_coroutine_threadsafe(
                    token_queue.put(("end", None)), loop
                ).result()
            except Exception as e:
                asyncio.run_coroutine_threadsafe(
                    token_queue.put(("error", str(e))), loop
                ).result()

        loop = asyncio.get_running_loop()
        worker_task = asyncio.to_thread(stream_worker)
        asyncio.create_task(worker_task)

        stream_started = False
        initial_buffer = ""

        while True:
            evt_type, payload = await token_queue.get()
            if evt_type == "token" and payload:
                if not stream_started:
                    initial_buffer += payload
                    lower_buf = initial_buffer.lstrip().lower()
                    # Detekce, zda model nezačal vypisovat interní scratchpad nebo thought blok
                    if any(lower_buf.startswith(prefix) for prefix in (
                        "/strict grounding", "/*strict grounding", "*strict grounding",
                        "<thought>", "<think>", "/*", "strict grounding:", "refine citations:"
                    )):
                        cleaned_buf = clean_leaked_thoughts(initial_buffer)
                        if cleaned_buf:
                            stream_started = True
                            full_response_text += cleaned_buf
                            yield f"event: token\ndata: {json.dumps({'delta': cleaned_buf, 'text': cleaned_buf, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                            initial_buffer = ""
                        elif len(initial_buffer) > 3000:
                            stream_started = True
                            full_response_text += initial_buffer
                            yield f"event: token\ndata: {json.dumps({'delta': initial_buffer, 'text': initial_buffer, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                            initial_buffer = ""
                    else:
                        stream_started = True
                        full_response_text += initial_buffer
                        yield f"event: token\ndata: {json.dumps({'delta': initial_buffer, 'text': initial_buffer, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                        initial_buffer = ""
                else:
                    full_response_text += payload
                    yield f"event: token\ndata: {json.dumps({'delta': payload, 'text': payload, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
            elif evt_type == "end":
                if initial_buffer:
                    cleaned_buf = clean_leaked_thoughts(initial_buffer)
                    if cleaned_buf:
                        full_response_text += cleaned_buf
                        yield f"event: token\ndata: {json.dumps({'delta': cleaned_buf, 'text': cleaned_buf, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                break
            elif evt_type == "error":
                err_msg = payload or "Neznámá chyba při streamování"
                yield f"event: error\ndata: {json.dumps({'error': err_msg, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
                return

        # 4. Uložení odpovědi asistenta do SQLite (plně vyčištěný text)
        clean_full_text = clean_leaked_thoughts(full_response_text)
        msg_id = save_message(
            safe_proj,
            role="assistant",
            content=clean_full_text,
            sources=sources,
            thread_id=thread_id,
        )

        done_payload = {
            "type": "done",
            "thread_id": thread_id,
            "message_id": msg_id,
            "full_text": clean_full_text,
            "text": clean_full_text,
            "sources": sources,
        }
        yield f"event: done\ndata: {json.dumps(done_payload, ensure_ascii=False)}\n\n"

    except Exception as e:
        err_msg = str(e)
        yield f"event: error\ndata: {json.dumps({'error': err_msg, 'thread_id': thread_id}, ensure_ascii=False)}\n\n"
