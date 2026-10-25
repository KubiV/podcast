"""
Export a import projektu do/z balíčku .medproj (ZIP): zdrojové soubory, plánovač, vektory ChromaDB,
SQLite záznamy (FTS + chat) a vygenerované výstupy. HTTP vrstva (upload, limity, odpovědi) zůstává v routers/projects.py.
"""

import json
import os
import re
import shutil
import zipfile
from datetime import datetime
from typing import Any

from fastapi import HTTPException

from core import uploads as upload_limits
from core.authz import require_project_access
from core.clients import get_chroma_client
from core.config import AUDIO_DIR, FLASHCARDS_DIR, NOTES_DIR, PLANNER_FILENAME, TESTS_DIR, UPLOAD_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.uploads import is_within
from core.utils import sanitize_name

ALLOWED_IMPORT_SOURCE_EXTS = (".pdf", ".docx", ".pptx", ".txt")
ALLOWED_IMPORT_OUTPUT_EXTS = {
    "notes": (".md",),
    "flashcards": (".json",),
    "tests": (".json",),
    "audio": (".mp3", ".mp4", ".srt"),
}


def max_import_bytes() -> int:
    return upload_limits.MAX_IMPORT_ARCHIVE_BYTES


def _imported_output_name(zip_name: str, orig_proj: str, final_proj: str, kind: str) -> str | None:
    """Bezpečný název výstupu z archivu (přejmenovaný na cílový projekt), nebo None pro nepovolený typ."""
    fname = os.path.basename(zip_name)
    if not fname.lower().endswith(ALLOWED_IMPORT_OUTPUT_EXTS[kind]):
        return None
    rest = fname[len(orig_proj) + 1 :] if fname.startswith(f"{orig_proj}_") else fname
    return safe_filename(f"{final_proj}_{rest}") or None


def cleanup_temp_file(path: str):
    """Pomocná funkce pro bezpečné smazání dočasného souboru po odeslání odpovědi."""
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception as e:
        print(f"[main] Notice: Nelze smazat dočasný soubor {path}: {e}")


def get_export_info(safe_proj: str, proj_dir: str) -> dict[str, Any]:
    """Statistiky a souhrn dat projektu před exportem (projekt musí existovat)."""
    # 1. Zdrojové soubory
    source_files = []
    source_bytes = 0
    has_planner = False
    questions_count = 0

    for root, _, files in os.walk(proj_dir):
        for f in files:
            if f.startswith("."):
                continue
            fp = os.path.join(root, f)
            sz = os.path.getsize(fp)
            if f == PLANNER_FILENAME:
                has_planner = True
                try:
                    with open(fp, encoding="utf-8") as pf:
                        pdata = json.load(pf)
                        questions_count = len(pdata.get("questions") or [])
                except Exception:
                    pass
            else:
                source_files.append({"name": f, "size": sz})
                source_bytes += sz

    # 2. Vektorové chunky v ChromaDB
    chunks_count = 0
    try:
        col = get_chroma_client().get_collection(f"proj_{safe_proj}")
        chunks_count = col.count()
    except Exception:
        chunks_count = 0

    # 3. Vygenerované soubory
    notes_count = (
        len([f for f in os.listdir(NOTES_DIR) if f.startswith(f"{safe_proj}_")]) if os.path.exists(NOTES_DIR) else 0
    )
    cards_count = (
        len([f for f in os.listdir(FLASHCARDS_DIR) if f.startswith(f"{safe_proj}_") and f.endswith(".json")])
        if os.path.exists(FLASHCARDS_DIR)
        else 0
    )
    tests_count = (
        len([f for f in os.listdir(TESTS_DIR) if f.startswith(f"{safe_proj}_") and f.endswith(".json")])
        if os.path.exists(TESTS_DIR)
        else 0
    )

    audio_files = []
    audio_bytes = 0
    if os.path.exists(AUDIO_DIR):
        for f in os.listdir(AUDIO_DIR):
            if f.startswith(f"{safe_proj}_"):
                sz = os.path.getsize(os.path.join(AUDIO_DIR, f))
                audio_files.append({"name": f, "size": sz})
                audio_bytes += sz

    # 4. Chat zprávy a vlákna
    chat_threads_count = 0
    chat_messages_count = 0
    try:
        from chat_service import get_db_connection

        with get_db_connection() as conn:
            r1 = conn.execute("SELECT COUNT(*) FROM chat_threads WHERE project_id = ?", (safe_proj,)).fetchone()
            chat_threads_count = r1[0] if r1 else 0
            r2 = conn.execute("SELECT COUNT(*) FROM chat_messages WHERE project_id = ?", (safe_proj,)).fetchone()
            chat_messages_count = r2[0] if r2 else 0
    except Exception:
        pass

    return {
        "project": safe_proj,
        "source_files": source_files,
        "source_files_count": len(source_files),
        "source_bytes": source_bytes,
        "chunks_count": chunks_count,
        "has_exam_planner": has_planner,
        "questions_count": questions_count,
        "notes_count": notes_count,
        "flashcards_count": cards_count,
        "tests_count": tests_count,
        "audio_count": len(audio_files),
        "audio_bytes": audio_bytes,
        "chat_threads_count": chat_threads_count,
        "chat_messages_count": chat_messages_count,
    }


def build_export_archive(
    tmp_export_path: str,
    safe_proj: str,
    proj_dir: str,
    include_audio: bool,
    include_chat: bool,
    include_outputs: bool,
    include_progress: bool,
) -> None:
    """Zapíše balíček .medproj projektu do `tmp_export_path`."""
    manifest = {
        "version": 1,
        "format": "medproj",
        "app_name": "AI MedStudio",
        "project_name": safe_proj,
        "exported_at": datetime.now().isoformat(),
        "include_audio": include_audio,
        "include_chat": include_chat,
        "include_outputs": include_outputs,
        "stats": {
            "source_files": [],
            "source_files_count": 0,
            "chunks_count": 0,
            "has_embeddings": False,
            "questions_count": 0,
            "notes_count": 0,
            "flashcards_count": 0,
            "tests_count": 0,
            "audio_count": 0,
            "chat_threads_count": 0,
            "chat_messages_count": 0,
        },
    }

    with zipfile.ZipFile(tmp_export_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        # 1. Zdrojové soubory a plánovač
        source_files_list = []
        for root, _, files in os.walk(proj_dir):
            for f in files:
                if f.startswith("."):
                    continue
                full_p = os.path.join(root, f)
                rel_p = os.path.relpath(full_p, proj_dir)

                if f == PLANNER_FILENAME:
                    try:
                        with open(full_p, encoding="utf-8") as pf:
                            pdata = json.load(pf)
                            manifest["stats"]["questions_count"] = len(pdata.get("questions") or [])

                            if not include_progress and "questions" in pdata:
                                for q in pdata.get("questions", []):
                                    q["status"] = "To do"
                                    q["completedDate"] = None
                                    q["grade"] = ""
                                    q["note"] = ""
                                    if "notesStatus" in q:
                                        q["notesStatus"] = "To do"
                                    if "cardsStatus" in q:
                                        q["cardsStatus"] = "To do"

                        zf.writestr(f"uploads/{rel_p}", json.dumps(pdata, ensure_ascii=False, indent=2).encode("utf-8"))
                    except Exception:
                        zf.write(full_p, f"uploads/{rel_p}")
                else:
                    zf.write(full_p, f"uploads/{rel_p}")
                    source_files_list.append(rel_p)
        manifest["stats"]["source_files"] = source_files_list
        manifest["stats"]["source_files_count"] = len(source_files_list)

        # 2. Vektory a embeddingy z ChromaDB
        col_name = f"proj_{safe_proj}"
        chroma_dump = {
            "collection_name": col_name,
            "total_chunks": 0,
            "ids": [],
            "documents": [],
            "metadatas": [],
            "embeddings": [],
        }
        try:
            col = get_chroma_client().get_collection(col_name)
            count = col.count()
            chroma_dump["total_chunks"] = count
            manifest["stats"]["chunks_count"] = count
            batch_size = 1000
            for offset in range(0, count, batch_size):
                part = col.get(limit=batch_size, offset=offset, include=["embeddings", "documents", "metadatas"])
                if part and part.get("ids"):
                    chroma_dump["ids"].extend(part["ids"])
                    chroma_dump["documents"].extend(part.get("documents") or [])
                    chroma_dump["metadatas"].extend(part.get("metadatas") or [])
                    embs = part.get("embeddings")
                    if embs is not None:
                        if hasattr(embs, "tolist"):
                            embs = embs.tolist()
                        elif isinstance(embs, list) and len(embs) > 0 and hasattr(embs[0], "tolist"):
                            embs = [e.tolist() for e in embs]
                        chroma_dump["embeddings"].extend(embs)
            if chroma_dump["embeddings"]:
                manifest["stats"]["has_embeddings"] = True
        except Exception as e:
            print(f"[export] Chroma collection get notice: {e}")

        zf.writestr("chroma_vectors.json", json.dumps(chroma_dump))

        # 3. SQLite záznamy (FTS5 BM25 index + chat)
        from chat_service import export_project_sqlite_data

        db_data = export_project_sqlite_data(safe_proj)
        if not include_chat:
            db_data["chat_threads"] = []
            db_data["chat_messages"] = []
        manifest["stats"]["chat_threads_count"] = len(db_data.get("chat_threads") or [])
        manifest["stats"]["chat_messages_count"] = len(db_data.get("chat_messages") or [])
        zf.writestr("database.json", json.dumps(db_data))

        # 4. Vygenerované studijní výstupy (poznámky, kartičky, testy)
        if include_outputs:
            notes_c = 0
            if os.path.exists(NOTES_DIR):
                for fn in os.listdir(NOTES_DIR):
                    if fn.startswith(f"{safe_proj}_"):
                        zf.write(os.path.join(NOTES_DIR, fn), f"generated/notes/{fn}")
                        notes_c += 1
            manifest["stats"]["notes_count"] = notes_c

            fc_c = 0
            if os.path.exists(FLASHCARDS_DIR):
                for fn in os.listdir(FLASHCARDS_DIR):
                    if fn.startswith(f"{safe_proj}_"):
                        zf.write(os.path.join(FLASHCARDS_DIR, fn), f"generated/flashcards/{fn}")
                        fc_c += 1
            manifest["stats"]["flashcards_count"] = fc_c

            test_c = 0
            if os.path.exists(TESTS_DIR):
                for fn in os.listdir(TESTS_DIR):
                    if fn.startswith(f"{safe_proj}_"):
                        zf.write(os.path.join(TESTS_DIR, fn), f"generated/tests/{fn}")
                        test_c += 1
            manifest["stats"]["tests_count"] = test_c

        # 5. Audio soubory
        if include_audio and os.path.exists(AUDIO_DIR):
            audio_c = 0
            for fn in os.listdir(AUDIO_DIR):
                if fn.startswith(f"{safe_proj}_"):
                    zf.write(os.path.join(AUDIO_DIR, fn), f"generated/audio/{fn}")
                    audio_c += 1
            manifest["stats"]["audio_count"] = audio_c

        # 6. Manifest
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))


def inspect_archive(zf: zipfile.ZipFile, filename: str) -> dict[str, Any]:
    """Souhrn obsahu balíčku pro potvrzení importu uživatelem (archiv je už ověřený)."""
    namelist = zf.namelist()
    manifest = {}
    if "manifest.json" in namelist:
        try:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        except Exception:
            pass

    raw_proj_name = manifest.get("project_name") or os.path.splitext(filename)[0]
    safe_proj = sanitize_name(raw_proj_name) or "Importovany_projekt"

    exists = os.path.exists(os.path.join(UPLOAD_DIR, safe_proj))
    suggested_name = safe_proj
    if exists:
        counter = 2
        while os.path.exists(os.path.join(UPLOAD_DIR, f"{safe_proj}_{counter}")):
            counter += 1
        suggested_name = f"{safe_proj}_{counter}"

    # Spočítáme položky v archivu, pokud chybí v manifestu
    has_vectors = "chroma_vectors.json" in namelist
    source_files_in_zip = [
        n[len("uploads/") :]
        for n in namelist
        if n.startswith("uploads/") and not n.endswith("/") and not n.endswith(PLANNER_FILENAME)
    ]
    notes_in_zip = len([n for n in namelist if n.startswith("generated/notes/") and not n.endswith("/")])
    cards_in_zip = len([n for n in namelist if n.startswith("generated/flashcards/") and not n.endswith("/")])
    tests_in_zip = len([n for n in namelist if n.startswith("generated/tests/") and not n.endswith("/")])
    audio_in_zip = len([n for n in namelist if n.startswith("generated/audio/") and not n.endswith("/")])

    stats = manifest.get("stats") or {}
    if "chunks_count" not in stats and has_vectors:
        try:
            cdata = json.loads(zf.read("chroma_vectors.json").decode("utf-8"))
            stats["chunks_count"] = cdata.get("total_chunks") or len(cdata.get("ids") or [])
        except Exception:
            stats["chunks_count"] = 0

    return {
        "status": "ok",
        "filename": filename,
        "project_name": safe_proj,
        "suggested_name": suggested_name,
        "exists": exists,
        "has_vectors": has_vectors,
        "chunks_count": stats.get("chunks_count", 0),
        "source_files": stats.get("source_files") or source_files_in_zip,
        "source_files_count": stats.get("source_files_count", len(source_files_in_zip)),
        "has_exam_planner": stats.get("has_exam_planner", f"uploads/{PLANNER_FILENAME}" in namelist),
        "questions_count": stats.get("questions_count", 0),
        "notes_count": stats.get("notes_count", notes_in_zip),
        "flashcards_count": stats.get("flashcards_count", cards_in_zip),
        "tests_count": stats.get("tests_count", tests_in_zip),
        "audio_count": stats.get("audio_count", audio_in_zip),
        "exported_at": manifest.get("exported_at"),
    }


async def import_archive(
    zf: zipfile.ZipFile,
    filename: str,
    project_name: str | None,
    overwrite: bool,
    include_chat: bool,
    include_outputs: bool,
    include_audio: bool,
) -> dict[str, Any]:
    """
    Naimportuje ověřený archiv. Cílový projekt vyplývá z obsahu archivu, proto se oprávnění
    (require_project_access) kontroluje až zde.
    """
    namelist = set(zf.namelist())
    manifest = {}
    if "manifest.json" in namelist:
        try:
            manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        except Exception:
            pass

    orig_proj = sanitize_name(manifest.get("project_name") or os.path.splitext(filename)[0])
    final_proj = sanitize_name(project_name or orig_proj)

    if not final_proj:
        raise HTTPException(status_code=400, detail="Neplatný název cílového projektu.")

    target_dir = os.path.join(UPLOAD_DIR, final_proj)
    require_project_access(final_proj, write=True)
    # Kopie pod jiným názvem než v balíčku (typicky na stejném serveru) dostane nová ID vláken a chunků
    new_ids = final_proj != orig_proj
    if os.path.exists(target_dir):
        if not overwrite:
            raise HTTPException(
                status_code=409,
                detail=f"Projekt '{final_proj}' již existuje. Zvolte jiný název nebo zaškrtněte možnost přepsat existující projekt.",
            )
        # Vyčištění stávajícího projektu před přepsáním
        try:
            get_chroma_client().delete_collection(name=f"proj_{final_proj}")
        except Exception:
            pass
        from chat_service import delete_project_records

        delete_project_records(final_proj)
        shutil.rmtree(target_dir, ignore_errors=True)

    os.makedirs(target_dir, exist_ok=True)
    await send_log(f"📥 Zahajuji import projektu '{final_proj}'...")

    # 1. Extrakce zdrojových souborů z uploads/
    imported_source_files = []
    skipped_files = []
    for n in namelist:
        if n.startswith("uploads/") and not n.endswith("/"):
            rel_p = n[len("uploads/") :]
            base_name = os.path.basename(rel_p)
            if base_name != PLANNER_FILENAME and not base_name.lower().endswith(ALLOWED_IMPORT_SOURCE_EXTS):
                skipped_files.append(rel_p)
                continue
            dest_p = os.path.abspath(os.path.join(target_dir, rel_p))
            if not is_within(target_dir, dest_p):
                skipped_files.append(rel_p)
                continue
            os.makedirs(os.path.dirname(dest_p), exist_ok=True)
            with zf.open(n) as sf, open(dest_p, "wb") as df:
                shutil.copyfileobj(sf, df)

            if os.path.basename(dest_p) == PLANNER_FILENAME:
                try:
                    with open(dest_p, encoding="utf-8") as pf:
                        pdata = json.load(pf)
                    if isinstance(pdata, dict):
                        pdata["project"] = final_proj
                        with open(dest_p, "w", encoding="utf-8") as pf:
                            json.dump(pdata, pf, ensure_ascii=False, indent=2)
                except Exception as pe:
                    print(f"[import] Planner project rename notice: {pe}")
            else:
                imported_source_files.append(rel_p)

    # 2. Obnova ChromaDB vektorů a embeddingů
    imported_chunks = 0
    if "chroma_vectors.json" in namelist:
        try:
            cdata = json.loads(zf.read("chroma_vectors.json").decode("utf-8"))
            col_name = f"proj_{final_proj}"
            target_col = get_chroma_client().get_or_create_collection(name=col_name)
            ids = cdata.get("ids") or []
            docs = cdata.get("documents") or []
            metas = cdata.get("metadatas") or []
            embs = cdata.get("embeddings") or []

            total = len(ids)
            batch_size = 500
            for i in range(0, total, batch_size):
                b_ids = ids[i : i + batch_size]
                if new_ids:
                    from chat_service import imported_chunk_id

                    b_ids = [imported_chunk_id(cid, final_proj) for cid in b_ids]
                b_docs = docs[i : i + batch_size]
                b_metas = metas[i : i + batch_size]
                b_embs = embs[i : i + batch_size] if (embs and len(embs) == total) else None
                if b_embs:
                    target_col.upsert(ids=b_ids, documents=b_docs, metadatas=b_metas, embeddings=b_embs)
                else:
                    target_col.upsert(ids=b_ids, documents=b_docs, metadatas=b_metas)
            imported_chunks = total
            await send_log(
                f"🧠 Úspěšně načteno {imported_chunks} vektorových chunků do ChromaDB (kolekce: {col_name})."
            )
        except Exception as ce:
            print(f"[import] ChromaDB vectors error: {ce}")
            await send_log(f"⚠️ Varování: Selhalo načtení některých vektorů z ChromaDB: {ce}")

    # 3. Obnova SQLite záznamů (FTS5 BM25 a chat)
    if "database.json" in namelist:
        try:
            db_data = json.loads(zf.read("database.json").decode("utf-8"))
            if not include_chat:
                db_data["chat_threads"] = []
                db_data["chat_messages"] = []
            from chat_service import import_project_sqlite_data

            import_project_sqlite_data(final_proj, db_data, overwrite=overwrite, new_ids=new_ids)
        except Exception as dbe:
            print(f"[import] SQLite import error: {dbe}")

    # Pojistka: Synchronizace FTS s ChromaDB
    try:
        from chat_service import sync_project_fts

        sync_project_fts(final_proj)
    except Exception as se:
        print(f"[import] sync_project_fts notice: {se}")

    # 4. Obnova studijních výstupů (poznámky, kartičky, testy)
    imported_outputs = {"notes": 0, "flashcards": 0, "tests": 0, "audio": 0}
    if include_outputs:
        for n in namelist:
            if n.startswith("generated/notes/") and not n.endswith("/"):
                new_fname = _imported_output_name(n, orig_proj, final_proj, "notes")
                if not new_fname:
                    skipped_files.append(n)
                    continue
                dest = safe_join(NOTES_DIR, new_fname)
                text = zf.read(n).decode("utf-8", errors="replace")
                text = re.sub(
                    r"<!-- METADATA\s*({.*?})\s*-->",
                    lambda m: (
                        f"<!-- METADATA\n{json.dumps({**json.loads(m.group(1)), 'project': final_proj}, ensure_ascii=False)}\n-->"
                    ),
                    text,
                    count=1,
                    flags=re.DOTALL,
                )
                with open(dest, "w", encoding="utf-8") as f:
                    f.write(text)
                imported_outputs["notes"] += 1

            elif n.startswith("generated/flashcards/") and not n.endswith("/"):
                new_fname = _imported_output_name(n, orig_proj, final_proj, "flashcards")
                if not new_fname:
                    skipped_files.append(n)
                    continue
                dest = safe_join(FLASHCARDS_DIR, new_fname)
                try:
                    fc_data = json.loads(zf.read(n).decode("utf-8"))
                    if isinstance(fc_data, dict):
                        fc_data["project"] = final_proj
                    with open(dest, "w", encoding="utf-8") as f:
                        json.dump(fc_data, f, ensure_ascii=False, indent=2)
                except Exception:
                    with zf.open(n) as sf, open(dest, "wb") as df:
                        shutil.copyfileobj(sf, df)
                imported_outputs["flashcards"] += 1

            elif n.startswith("generated/tests/") and not n.endswith("/"):
                new_fname = _imported_output_name(n, orig_proj, final_proj, "tests")
                if not new_fname:
                    skipped_files.append(n)
                    continue
                dest = safe_join(TESTS_DIR, new_fname)
                try:
                    t_data = json.loads(zf.read(n).decode("utf-8"))
                    if isinstance(t_data, dict):
                        t_data["project"] = final_proj
                        t_data["filename"] = new_fname
                    with open(dest, "w", encoding="utf-8") as f:
                        json.dump(t_data, f, ensure_ascii=False, indent=2)
                except Exception:
                    with zf.open(n) as sf, open(dest, "wb") as df:
                        shutil.copyfileobj(sf, df)
                imported_outputs["tests"] += 1

    if include_audio:
        for n in namelist:
            if n.startswith("generated/audio/") and not n.endswith("/"):
                new_fname = _imported_output_name(n, orig_proj, final_proj, "audio")
                if not new_fname:
                    skipped_files.append(n)
                    continue
                dest = safe_join(AUDIO_DIR, new_fname)
                with zf.open(n) as sf, open(dest, "wb") as df:
                    shutil.copyfileobj(sf, df)
                imported_outputs["audio"] += 1

    if skipped_files:
        await send_log(f"⚠️ Import přeskočil {len(skipped_files)} nepovolených nebo neplatných souborů z balíčku.")
    await send_log(
        f"🎉 Projekt '{final_proj}' byl úspěšně importován (včetně {len(imported_source_files)} podkladů a {imported_chunks} vektorových chunků)."
    )

    return {
        "status": "success",
        "project": final_proj,
        "source_files": imported_source_files,
        "source_files_count": len(imported_source_files),
        "chunks_count": imported_chunks,
        "outputs": imported_outputs,
        "message": f"Projekt '{final_proj}' byl úspěšně importován.",
    }
