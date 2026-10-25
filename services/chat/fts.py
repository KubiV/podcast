"""Český fulltext (SQLite FTS5): odhad kořene slov, stop slova, sestavení dotazu a správa indexu."""

import re
import unicodedata
from typing import Any

from services.chat.storage import get_chroma_client, get_db_connection, sanitize_project_name


def clean_czech_stem(token: str) -> str:
    """Jednoduchý a deterministický odhad kořene slova pro české pádové koncovky."""
    endings = [
        "ovými",
        "ových",
        "ovému",
        "ového",
        "ovaný",
        "ovaná",
        "ované",
        "ující",
        "ických",
        "ickému",
        "ického",
        "ická",
        "ické",
        "ický",
        "ami",
        "ata",
        "ech",
        "ich",
        "ích",
        "ého",
        "ému",
        "ých",
        "ové",
        "ovi",
        "em",
        "ou",
        "am",
        "ám",
        "um",
        "ům",
        "im",
        "ím",
        "es",
        "e",
        "a",
        "u",
        "y",
        "i",
        "o",
    ]
    norm = "".join(c for c in unicodedata.normalize("NFD", token.lower()) if unicodedata.category(c) != "Mn")
    for end in endings:
        if norm.endswith(end) and len(norm) - len(end) >= 3:
            return token[: len(norm) - len(end)]
    return token[:-1] if len(token) > 3 else token


CZECH_STOP_WORDS = {
    "a",
    "i",
    "v",
    "s",
    "z",
    "o",
    "u",
    "k",
    "se",
    "si",
    "je",
    "jsou",
    "to",
    "ten",
    "ta",
    "toho",
    "jak",
    "jake",
    "jaké",
    "jaka",
    "jaká",
    "jaky",
    "jaký",
    "jakou",
    "kter",
    "ktere",
    "které",
    "ktera",
    "která",
    "ktery",
    "který",
    "kterou",
    "ma",
    "má",
    "maji",
    "mají",
    "mit",
    "mít",
    "co",
    "kdo",
    "kde",
    "kdy",
    "proc",
    "proč",
    "pro",
    "pri",
    "při",
    "podle",
    "pred",
    "před",
    "po",
    "nebo",
    "ani",
    "ale",
    "byl",
    "byla",
    "bylo",
    "byli",
    "tento",
    "tato",
    "toto",
    "mezi",
    "jako",
}


def build_czech_fts_query(user_query: str) -> str:
    """Připraví optimalizovaný FTS5 dotaz s prefixovým vyhledáváním a lékařskými synonymy."""
    cleaned = re.sub(r"[^\w\s]", " ", user_query)
    tokens = [w.strip() for w in cleaned.split() if w.strip()]
    terms: list[str] = []

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
    chunks: list[dict[str, Any]],
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


def delete_chunks_from_fts(project_id: str, source: str | None = None):
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
