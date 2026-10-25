"""Úložiště chatu v SQLite: vlákna, zprávy, záznamy projektu (export/import, přejmenování) a výukové lekce."""

import json
import uuid
from datetime import datetime
from typing import Any

from services.chat.storage import get_db_connection, sanitize_project_name

# --- SPRÁVA CHATOVÝCH VLÁKEN (THREADS / SESSIONS) ---


def generate_thread_id() -> str:
    return f"thread_{uuid.uuid4().hex[:12]}"


def create_thread(
    project_id: str,
    title: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
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


def get_thread(thread_id: str) -> dict[str, Any] | None:
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
    project_id: str | None = None,
    search_query: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
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
    params: list[Any] = []

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
    title: str | None = None,
    is_pinned: bool | None = None,
) -> dict[str, Any] | None:
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


def toggle_thread_pin(thread_id: str) -> dict[str, Any] | None:
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


def get_thread_messages(thread_id: str, limit: int = 200) -> list[dict[str, Any]]:
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


def get_project_messages(project_id: str, limit: int = 50, thread_id: str | None = None) -> list[dict[str, Any]]:
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
    sources: list[dict[str, Any]] | None = None,
    thread_id: str | None = None,
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
    """Kompletně smaže všechny záznamy projektu z databáze SQLite (chat, vlákna, FTS i metadata chunků)."""
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM project_chunks_fts WHERE project_id = ?", (safe_proj,))
        conn.execute("DELETE FROM project_chunks_meta WHERE project_id = ?", (safe_proj,))
        conn.commit()


def delete_lesson_records(lesson_id: str) -> None:
    """Kompletně smaže všechny záznamy výukové lekce z databáze SQLite (lekce, chat zprávy, vlákna, FTS i metadata chunků)."""
    safe_id = sanitize_project_name(lesson_id)
    with get_db_connection() as conn:
        conn.execute("DELETE FROM lessons WHERE project_id = ?", (safe_id,))
        conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (safe_id,))
        conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (safe_id,))
        conn.execute("DELETE FROM project_chunks_fts WHERE project_id = ?", (safe_id,))
        conn.execute("DELETE FROM project_chunks_meta WHERE project_id = ?", (safe_id,))
        conn.commit()


def rename_project_records(old_project_id: str, new_project_id: str) -> None:
    """Přejmenuje vazby projektu ve všech tabulkách SQLite."""
    old_proj = sanitize_project_name(old_project_id)
    new_proj = sanitize_project_name(new_project_id)
    with get_db_connection() as conn:
        conn.execute("UPDATE chat_messages SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.execute("UPDATE chat_threads SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.execute("UPDATE project_chunks_meta SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.execute("UPDATE project_chunks_fts SET project_id = ? WHERE project_id = ?", (new_proj, old_proj))
        conn.commit()


def export_project_sqlite_data(project_id: str) -> dict[str, Any]:
    """Vyexportuje všechny SQLite záznamy projektu (chunky, FTS, chatová vlákna a zprávy) do přenositelného slovníku."""
    safe_proj = sanitize_project_name(project_id)
    with get_db_connection() as conn:
        meta_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT chunk_id, source, page, created_at FROM project_chunks_meta WHERE project_id = ?",
                (safe_proj,),
            ).fetchall()
        ]
        fts_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT chunk_id, source, page, content FROM project_chunks_fts WHERE project_id = ?",
                (safe_proj,),
            ).fetchall()
        ]
        thread_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT id, title, is_pinned, created_at, updated_at FROM chat_threads WHERE project_id = ?",
                (safe_proj,),
            ).fetchall()
        ]
        msg_rows = [
            dict(r)
            for r in conn.execute(
                "SELECT role, content, sources_json, created_at, thread_id FROM chat_messages WHERE project_id = ?",
                (safe_proj,),
            ).fetchall()
        ]
    return {
        "project_chunks_meta": meta_rows,
        "project_chunks_fts": fts_rows,
        "chat_threads": thread_rows,
        "chat_messages": msg_rows,
    }


def imported_chunk_id(chunk_id: str, project_id: str) -> str:
    """
    ID chunku pro kopii projektu importovanou pod novým názvem. Původní ID (`{soubor}_chunk_{i}`) nejsou
    vázaná na projekt a `project_chunks_meta.chunk_id` je globální klíč – bez přemapování by kopie
    převzala metadata originálu. Stejnou funkci používá import vektorů do ChromaDB, aby ID seděla.
    """
    return f"{sanitize_project_name(project_id)}::{chunk_id}"


def import_project_sqlite_data(
    target_project_id: str, data: dict[str, Any], overwrite: bool = False, new_ids: bool = False
) -> dict[str, int]:
    """
    Naimportuje SQLite záznamy projektu (chunky, FTS, chatová vlákna a zprávy) pod cílovým project_id.

    `new_ids=True` (import kopie pod jiným názvem) přidělí vláknům nová ID a chunkům ID z `imported_chunk_id`,
    aby kopie na stejném serveru nepřepsala vlákna a FTS metadata originálu.
    """
    safe_proj = sanitize_project_name(target_project_id)
    thread_id_map: dict[str, str] = {}

    def map_thread_id(old_id: str | None) -> str | None:
        if not new_ids or not old_id:
            return old_id
        return thread_id_map.setdefault(old_id, generate_thread_id())

    def map_chunk_id(old_id: str) -> str:
        return imported_chunk_id(old_id, safe_proj) if new_ids else old_id

    with get_db_connection() as conn:
        if overwrite:
            conn.execute("DELETE FROM project_chunks_meta WHERE project_id = ?", (safe_proj,))
            conn.execute("DELETE FROM project_chunks_fts WHERE project_id = ?", (safe_proj,))
            conn.execute("DELETE FROM chat_threads WHERE project_id = ?", (safe_proj,))
            conn.execute("DELETE FROM chat_messages WHERE project_id = ?", (safe_proj,))

        # 1. Chat Threads
        threads = data.get("chat_threads") or []
        for t in threads:
            conn.execute(
                """
                INSERT OR REPLACE INTO chat_threads (id, project_id, title, is_pinned, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    map_thread_id(t["id"]),
                    safe_proj,
                    t.get("title", "Konverzace"),
                    t.get("is_pinned", 0),
                    t.get("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                    t.get("updated_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                ),
            )

        # 2. Chat Messages
        messages = data.get("chat_messages") or []
        for m in messages:
            conn.execute(
                """
                INSERT INTO chat_messages (project_id, role, content, sources_json, created_at, thread_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    safe_proj,
                    m.get("role", "user"),
                    m.get("content", ""),
                    m.get("sources_json"),
                    m.get("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                    map_thread_id(m.get("thread_id")),
                ),
            )

        # 3. Project Chunks Meta
        meta_chunks = data.get("project_chunks_meta") or []
        for c in meta_chunks:
            conn.execute(
                """
                INSERT OR REPLACE INTO project_chunks_meta (chunk_id, project_id, source, page, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    map_chunk_id(c["chunk_id"]),
                    safe_proj,
                    c.get("source", ""),
                    c.get("page", "1"),
                    c.get("created_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
                ),
            )

        # 4. Project Chunks FTS
        fts_chunks = data.get("project_chunks_fts") or []
        for f in fts_chunks:
            conn.execute(
                """
                INSERT INTO project_chunks_fts (project_id, chunk_id, source, page, content)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    safe_proj,
                    map_chunk_id(f["chunk_id"]),
                    f.get("source", ""),
                    f.get("page", "1"),
                    f.get("content", ""),
                ),
            )

        conn.commit()

    return {
        "threads": len(threads),
        "messages": len(messages),
        "meta_chunks": len(meta_chunks),
        "fts_chunks": len(fts_chunks),
    }


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


def export_project_chat_markdown(project_id: str, thread_id: str | None = None) -> str:
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
    chapters: list[dict[str, Any]] | None = None,
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


def get_lesson(project_id: str) -> dict[str, Any] | None:
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


def list_lessons() -> list[dict[str, Any]]:
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
