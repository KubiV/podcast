"""Hybridní vyhledávání kontextu pro chat a RAG (ChromaDB dense + SQLite FTS5 BM25)."""

from typing import Any

from services.chat.fts import build_czech_fts_query, sync_project_fts
from services.chat.storage import get_chroma_client, get_db_connection, sanitize_project_name

# --- HYBRIDNÍ RAG RETRIEVAL & GROUNDING (CHROMADB + SQLITE FTS5 BM25) ---


async def retrieve_chat_context(project_id: str, query: str, n_results: int = 15, return_raw: bool = False) -> Any:
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
    dense_ids: list[str] = []
    try:
        actual_dense_n = min(max(30, n_results * 2), count)
        dense_results = collection.query(query_texts=[query], n_results=actual_dense_n)
        if dense_results and dense_results.get("ids") and dense_results["ids"]:
            dense_ids = dense_results["ids"][0]
    except Exception as e:
        print(f"[chat_service] Dense query error: {e}")

    # 3. Sparse vyhledávání přes SQLite FTS5 (BM25)
    sparse_ids: list[str] = []
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
    rrf_scores: dict[str, float] = {}
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
    chunks_data: dict[str, dict[str, Any]] = {}
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
    unique_sources: list[dict[str, Any]] = []
    source_to_id: dict[str, int] = {}
    labeled_chunks: list[str] = []
    raw_chunks: list[str] = []

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
