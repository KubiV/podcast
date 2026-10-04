import json
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime
from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from core.clients import get_chroma_client
from core.config import (
    AUDIO_DIR,
    FLASHCARDS_DIR,
    LESSONS_DIR,
    NOTES_DIR,
    PLANNER_FILENAME,
    TESTS_DIR,
    UPLOAD_DIR,
)
from core.context import current_user_var
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from services.auth_service import AuthService
from services.chat_service import list_lessons

router = APIRouter()


class _AuthServiceProxy:
    def __getattr__(self, name: str):
        srv = AuthService.get_instance()
        if not srv:
            raise RuntimeError("AuthService is not initialized")
        return getattr(srv, name)


auth_service = _AuthServiceProxy()


class _ChromaClientProxy:
    def __getattr__(self, name: str):
        return getattr(get_chroma_client(), name)


chroma_client = _ChromaClientProxy()


@router.get("/api/projects")
async def list_projects(request: Request):
    try:
        lesson_ids = {lesson.get("project_id") for lesson in list_lessons() if lesson.get("project_id")}
    except Exception:
        lesson_ids = set()

    all_projects = [
        d
        for d in os.listdir(UPLOAD_DIR)
        if os.path.isdir(os.path.join(UPLOAD_DIR, d))
        and not d.startswith("lekce_")
        and not d.startswith("lesson_")
        and not d.startswith(".")
        and d not in lesson_ids
    ]

    # Zajistíme, že všechny stávající složky mají v DB přiřazeného vlastníka (výchozí: admin id 1)
    auth_service.ensure_existing_projects_owned(all_projects, default_owner_id=1)

    user = getattr(request.state, "user", None) or current_user_var.get()
    is_shared = auth_service.is_shared_projects()

    if is_shared or not user:
        return {
            "projects": sorted(all_projects),
            "shared_projects": True,
            "is_admin": bool(user and user.get("role") == "admin"),
        }

    # Privátní režim projektů (každý uživatel má své vlastní)
    user_id = user.get("id", 1)
    is_admin = user.get("role") == "admin"
    is_viewer = user.get("role") == "viewer"

    if is_viewer:
        user_projs = all_projects
    else:
        owned_set = set(auth_service.list_user_projects(user_id))
        user_projs = [p for p in all_projects if p in owned_set]

    return {"projects": sorted(user_projs), "shared_projects": False, "is_admin": is_admin}


@router.post("/api/projects")
async def create_project(request: Request, payload: dict = Body(...)):
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Název projektu je prázdný.")
    safe_name = sanitize_name(name)
    os.makedirs(os.path.join(UPLOAD_DIR, safe_name), exist_ok=True)

    user = getattr(request.state, "user", None) or current_user_var.get()
    owner_id = user["id"] if user and user.get("id") and user["id"] > 0 else 1
    auth_service.set_project_owner(safe_name, owner_id)

    await send_log(f"📁 Nový projekt vytvořen: {safe_name}")
    return {"project": safe_name, "owner_id": owner_id}


@router.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, request: Request):
    """Kompletně smaže projekt včetně všech materiálů, ChromaDB vektorů, SQLite historie i výstupů."""
    safe_proj = sanitize_name(project_id)
    if not safe_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")

    user = getattr(request.state, "user", None) or current_user_var.get()
    if not auth_service.is_shared_projects() and user and user.get("role") != "admin":
        owner_id = auth_service.get_project_owner(safe_proj)
        if owner_id and owner_id != user.get("id"):
            raise HTTPException(status_code=403, detail="Nemáte oprávnění smazat cizí privátní projekt.")

    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nebyl nalezen.")

    # 1. Smazání složky projektu s materiály a plánovačem
    try:
        shutil.rmtree(proj_dir, ignore_errors=True)
    except Exception as e:
        print(f"⚠️ Chyba při mazání složky {proj_dir}: {e}")

    # 2. Smazání vektorové kolekce ChromaDB
    try:
        chroma_client.delete_collection(name=f"proj_{safe_proj}")
    except Exception:
        pass

    # 3. Smazání SQLite záznamů (FTS index, chat, lekce)
    try:
        from chat_service import delete_project_records

        delete_project_records(safe_proj)
    except Exception as e:
        print(f"⚠️ Chyba při mazání SQLite záznamů pro projekt {safe_proj}: {e}")

    # 4. Smazání vygenerovaných výstupů na disku
    deleted_counts = {"notes": 0, "flashcards": 0, "tests": 0, "audio": 0}

    for fname in os.listdir(NOTES_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(NOTES_DIR, fname))
                deleted_counts["notes"] += 1
            except Exception:
                pass

    for fname in os.listdir(FLASHCARDS_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(FLASHCARDS_DIR, fname))
                deleted_counts["flashcards"] += 1
            except Exception:
                pass

    for fname in os.listdir(TESTS_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(TESTS_DIR, fname))
                deleted_counts["tests"] += 1
            except Exception:
                pass

    for fname in os.listdir(AUDIO_DIR):
        if fname.startswith(f"{safe_proj}_"):
            try:
                os.remove(os.path.join(AUDIO_DIR, fname))
                deleted_counts["audio"] += 1
            except Exception:
                pass

    auth_service.delete_project_owner(safe_proj)
    await send_log(f"🗑️ Projekt '{safe_proj}' a veškerá jeho data byla úspěšně smazána.")
    return {"status": "deleted", "project": safe_proj, "deleted_outputs": deleted_counts}


@router.post("/api/projects/{project_id}/rename")
async def rename_project(project_id: str, request: Request, payload: dict = Body(...)):
    """Přejmenuje projekt, jeho složku, ChromaDB kolekci, SQLite vazby i generované soubory."""
    new_name = str(payload.get("new_name", "")).strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Nový název projektu nesmí být prázdný.")

    old_proj = sanitize_name(project_id)
    new_proj = sanitize_name(new_name)

    if not old_proj or not new_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")

    user = getattr(request.state, "user", None) or current_user_var.get()
    if not auth_service.is_shared_projects() and user and user.get("role") != "admin":
        owner_id = auth_service.get_project_owner(old_proj)
        if owner_id and owner_id != user.get("id"):
            raise HTTPException(status_code=403, detail="Nemáte oprávnění přejmenovat cizí privátní projekt.")

    if old_proj == new_proj:
        return {"status": "unchanged", "project": new_proj}

    old_dir = os.path.join(UPLOAD_DIR, old_proj)
    new_dir = os.path.join(UPLOAD_DIR, new_proj)

    if not os.path.exists(old_dir):
        raise HTTPException(status_code=404, detail=f"Původní projekt '{old_proj}' nebyl nalezen.")

    if os.path.exists(new_dir):
        raise HTTPException(status_code=400, detail=f"Projekt s názvem '{new_proj}' již existuje.")

    # 1. Přejmenování složky v uploads/
    os.rename(old_dir, new_dir)
    auth_service.rename_project_owner(old_proj, new_proj)

    # 2. Přejmenování v ChromaDB
    try:
        col = chroma_client.get_collection(f"proj_{old_proj}")
        col.modify(name=f"proj_{new_proj}")
    except Exception as e:
        print(f"⚠️ ChromaDB rename collection notice: {e}")

    # 3. Přejmenování v SQLite (chat, lekce, FTS)
    try:
        from chat_service import rename_project_records

        rename_project_records(old_proj, new_proj)
    except Exception as e:
        print(f"⚠️ Chyba při SQLite rename: {e}")

    # 4. Přejmenování v exam_planner.json
    planner_file = os.path.join(new_dir, "exam_planner.json")
    if os.path.exists(planner_file):
        try:
            with open(planner_file, encoding="utf-8") as f:
                pdata = json.load(f)
            if "project" in pdata:
                pdata["project"] = new_proj
            with open(planner_file, "w", encoding="utf-8") as f:
                json.dump(pdata, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # 5. Přejmenování generovaných souborů (notes, flashcards, tests, audio)
    for folder, is_test in [(NOTES_DIR, False), (FLASHCARDS_DIR, False), (TESTS_DIR, True), (AUDIO_DIR, False)]:
        if not os.path.exists(folder):
            continue
        for fname in os.listdir(folder):
            if fname.startswith(f"{old_proj}_"):
                rest = fname[len(old_proj) + 1 :]
                new_fname = f"{new_proj}_{rest}"
                old_fpath = os.path.join(folder, fname)
                new_fpath = os.path.join(folder, new_fname)
                try:
                    if is_test and fname.endswith(".json"):
                        try:
                            with open(old_fpath, encoding="utf-8") as jf:
                                jdata = json.load(jf)
                            jdata["project"] = new_proj
                            jdata["filename"] = new_fname
                            with open(new_fpath, "w", encoding="utf-8") as jf:
                                json.dump(jdata, jf, ensure_ascii=False, indent=2)
                            if old_fpath != new_fpath:
                                os.remove(old_fpath)
                        except Exception:
                            os.rename(old_fpath, new_fpath)
                    else:
                        os.rename(old_fpath, new_fpath)
                except Exception as e:
                    print(f"⚠️ Chyba při přejmenování souboru {fname}: {e}")

    await send_log(f"✏️ Projekt '{old_proj}' byl úspěšně přejmenován na '{new_proj}'.")
    return {"status": "renamed", "old_project": old_proj, "new_project": new_proj}


@router.post("/api/projects/{project_id}/clear-data")
async def clear_project_data(project_id: str, payload: dict = Body(...)):
    """Selektivní vyčištění generovaných dat projektu se zachováním nahraných zdrojových podkladů."""
    safe_proj = sanitize_name(project_id)
    if not safe_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")

    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nebyl nalezen.")

    clear_chat = payload.get("clear_chat", False)
    clear_notes = payload.get("clear_notes", False)
    clear_flashcards = payload.get("clear_flashcards", False)
    clear_tests = payload.get("clear_tests", False)
    clear_audio = payload.get("clear_audio", False)
    clear_questions = payload.get("clear_questions", False)

    cleared = []

    if clear_chat:
        from chat_service import clear_project_messages

        clear_project_messages(safe_proj)
        cleared.append("chat")

    if clear_notes:
        for f in os.listdir(NOTES_DIR):
            if f.startswith(f"{safe_proj}_"):
                try:
                    os.remove(os.path.join(NOTES_DIR, f))
                except Exception:
                    pass
        cleared.append("notes")

    if clear_flashcards:
        for f in os.listdir(FLASHCARDS_DIR):
            if f.startswith(f"{safe_proj}_"):
                try:
                    os.remove(os.path.join(FLASHCARDS_DIR, f))
                except Exception:
                    pass
        cleared.append("flashcards")

    if clear_tests:
        for f in os.listdir(TESTS_DIR):
            if f.startswith(f"{safe_proj}_"):
                try:
                    os.remove(os.path.join(TESTS_DIR, f))
                except Exception:
                    pass
        cleared.append("tests")

    if clear_audio:
        for f in os.listdir(AUDIO_DIR):
            if f.startswith(f"{safe_proj}_"):
                try:
                    os.remove(os.path.join(AUDIO_DIR, f))
                except Exception:
                    pass
        cleared.append("audio")

    if clear_questions:
        planner_file = os.path.join(proj_dir, PLANNER_FILENAME)
        if os.path.exists(planner_file):
            try:
                with open(planner_file, encoding="utf-8") as f:
                    pdata = json.load(f)
                if isinstance(pdata, dict):
                    pdata["questions"] = []
                    with open(planner_file, "w", encoding="utf-8") as f:
                        json.dump(pdata, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"⚠️ Chyba při mazání otázek v {planner_file}: {e}")
        cleared.append("questions")

    await send_log(f"🧹 Projekt '{safe_proj}': Vyčištěna vybraná data ({', '.join(cleared)}).")
    return {"status": "cleared", "project": safe_proj, "cleared_categories": cleared}


def cleanup_temp_file(path: str):
    """Pomocná funkce pro bezpečné smazání dočasného souboru po odeslání odpovědi."""
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception as e:
        print(f"[main] Notice: Nelze smazat dočasný soubor {path}: {e}")


@router.get("/api/projects/{project_id}/export-info")
async def get_project_export_info(project_id: str):
    """Vrací statistiky a souhrn dat projektu před zahájením exportu."""
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail=f"Projekt '{safe_proj}' nebyl nalezen.")

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
        col = chroma_client.get_collection(f"proj_{safe_proj}")
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


@router.get("/api/projects/{project_id}/export")
async def export_project(
    project_id: str,
    include_audio: bool = False,
    include_chat: bool = True,
    include_outputs: bool = True,
    include_progress: bool = True,
):
    """Zabalí kompletní studijní projekt do jednoho souboru balíčku .medproj (ZIP) pro snadný přenos na jiný počítač bez nutnosti re-indexace."""
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail=f"Projekt '{safe_proj}' nebyl nalezen.")

    await send_log(f"📦 Zahajuji export projektu '{safe_proj}' (audio: {'ano' if include_audio else 'ne'})...")

    with tempfile.NamedTemporaryFile(suffix=".medproj", delete=False) as tf:
        tmp_export_path = tf.name

    try:
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

                            zf.writestr(
                                f"uploads/{rel_p}", json.dumps(pdata, ensure_ascii=False, indent=2).encode("utf-8")
                            )
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
                col = chroma_client.get_collection(col_name)
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

        await send_log(
            f"✅ Export projektu '{safe_proj}' dokončen ({os.path.getsize(tmp_export_path) / 1024 / 1024:.1f} MB). Odesílám soubor..."
        )

        download_filename = f"{safe_proj}.medproj"
        return FileResponse(
            tmp_export_path,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(download_filename)}"},
            background=BackgroundTask(cleanup_temp_file, tmp_export_path),
        )

    except Exception as e:
        cleanup_temp_file(tmp_export_path)
        await send_log(f"❌ Chyba při exportu projektu '{safe_proj}': {str(e)}")
        raise HTTPException(status_code=500, detail=f"Chyba při exportu: {str(e)}")


@router.post("/api/projects/import/inspect")
async def inspect_project_import(file: UploadFile = File(...)):
    """Ověří a prozkoumá nahrávaný balíček projektu (.medproj nebo .zip) a vrátí souhrn pro potvrzení uživatelem."""
    filename = file.filename or "projekt.medproj"
    if not (filename.lower().endswith(".medproj") or filename.lower().endswith(".zip")):
        raise HTTPException(status_code=400, detail="Nahraný soubor musí mít příponu .medproj nebo .zip.")

    with tempfile.NamedTemporaryFile(suffix=".medproj", delete=False) as tf:
        tmp_inspect_path = tf.name

    try:
        with open(tmp_inspect_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        if not zipfile.is_zipfile(tmp_inspect_path):
            raise HTTPException(status_code=400, detail="Nahraný soubor není platný archiv ZIP / .medproj.")

        with zipfile.ZipFile(tmp_inspect_path, "r") as zf:
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
    finally:
        cleanup_temp_file(tmp_inspect_path)


@router.post("/api/projects/import")
async def import_project(
    file: UploadFile = File(...),
    project_name: str | None = Form(None),
    overwrite: bool = Form(False),
    include_chat: bool = Form(True),
    include_outputs: bool = Form(True),
    include_audio: bool = Form(True),
):
    """Naimportuje projekt z balíčku .medproj nebo .zip včetně zdrojových souborů, vektorů ChromaDB, SQLite indexu a studijních výstupů."""
    filename = file.filename or "projekt.medproj"
    with tempfile.NamedTemporaryFile(suffix=".medproj", delete=False) as tf:
        tmp_import_path = tf.name

    try:
        with open(tmp_import_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        if not zipfile.is_zipfile(tmp_import_path):
            raise HTTPException(status_code=400, detail="Nahraný soubor není platný archiv ZIP / .medproj.")

        with zipfile.ZipFile(tmp_import_path, "r") as zf:
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
            if os.path.exists(target_dir):
                if not overwrite:
                    raise HTTPException(
                        status_code=409,
                        detail=f"Projekt '{final_proj}' již existuje. Zvolte jiný název nebo zaškrtněte možnost přepsat existující projekt.",
                    )
                # Vyčištění stávajícího projektu před přepsáním
                try:
                    chroma_client.delete_collection(name=f"proj_{final_proj}")
                except Exception:
                    pass
                from chat_service import delete_project_records

                delete_project_records(final_proj)
                shutil.rmtree(target_dir, ignore_errors=True)

            os.makedirs(target_dir, exist_ok=True)
            await send_log(f"📥 Zahajuji import projektu '{final_proj}'...")

            # 1. Extrakce zdrojových souborů z uploads/
            imported_source_files = []
            for n in namelist:
                if n.startswith("uploads/") and not n.endswith("/"):
                    rel_p = n[len("uploads/") :]
                    dest_p = os.path.abspath(os.path.join(target_dir, rel_p))
                    if not dest_p.startswith(os.path.abspath(target_dir)):
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
                    target_col = chroma_client.get_or_create_collection(name=col_name)
                    ids = cdata.get("ids") or []
                    docs = cdata.get("documents") or []
                    metas = cdata.get("metadatas") or []
                    embs = cdata.get("embeddings") or []

                    total = len(ids)
                    batch_size = 500
                    for i in range(0, total, batch_size):
                        b_ids = ids[i : i + batch_size]
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

                    import_project_sqlite_data(final_proj, db_data, overwrite=overwrite)
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
                        fname = os.path.basename(n)
                        rest = fname[len(orig_proj) + 1 :] if fname.startswith(f"{orig_proj}_") else fname
                        new_fname = f"{final_proj}_{rest}"
                        dest = os.path.join(NOTES_DIR, new_fname)
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
                        fname = os.path.basename(n)
                        rest = fname[len(orig_proj) + 1 :] if fname.startswith(f"{orig_proj}_") else fname
                        new_fname = f"{final_proj}_{rest}"
                        dest = os.path.join(FLASHCARDS_DIR, new_fname)
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
                        fname = os.path.basename(n)
                        rest = fname[len(orig_proj) + 1 :] if fname.startswith(f"{orig_proj}_") else fname
                        new_fname = f"{final_proj}_{rest}"
                        dest = os.path.join(TESTS_DIR, new_fname)
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
                        fname = os.path.basename(n)
                        rest = fname[len(orig_proj) + 1 :] if fname.startswith(f"{orig_proj}_") else fname
                        new_fname = f"{final_proj}_{rest}"
                        dest = os.path.join(AUDIO_DIR, new_fname)
                        with zf.open(n) as sf, open(dest, "wb") as df:
                            shutil.copyfileobj(sf, df)
                        imported_outputs["audio"] += 1

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

    finally:
        cleanup_temp_file(tmp_import_path)


@router.get("/api/stats")
async def get_project_stats(project: str = ""):
    safe_proj = sanitize_name(project) if project else ""

    # Materiály
    files_count = 0
    if safe_proj:
        proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
        if os.path.exists(proj_dir):
            allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
            files_count = len([f for f in os.listdir(proj_dir) if f.lower().endswith(allowed_exts)])

    # Média (audio / video)
    audio_files = [f for f in os.listdir(AUDIO_DIR) if f.endswith((".mp3", ".mp4"))]
    if safe_proj:
        audio_files = [f for f in audio_files if f.startswith(f"{safe_proj}_")]

    # Poznámky
    notes_files = [f for f in os.listdir(NOTES_DIR) if f.endswith(".md")]
    if safe_proj:
        notes_files = [f for f in notes_files if f.startswith(f"{safe_proj}_")]

    # Kartičky
    flashcards_files = [f for f in os.listdir(FLASHCARDS_DIR) if f.endswith(".json")]
    if safe_proj:
        flashcards_files = [f for f in flashcards_files if f.startswith(f"{safe_proj}_")]

    # Testové otázky
    tests_files = [f for f in os.listdir(TESTS_DIR) if f.endswith(".json")]
    if safe_proj:
        tests_files = [f for f in tests_files if f.startswith(f"{safe_proj}_")]

    # Výukové lekce a chat
    lessons_count = 0
    chat_count = 0
    try:
        from services.chat_service import get_project_messages, list_lessons

        all_lessons = list_lessons()
        lessons_count = len(all_lessons)
        if safe_proj:
            chat_count = len(get_project_messages(safe_proj, limit=1000))
    except Exception:
        pass

    # Otázky (z plánovače / projektu)
    questions_count = 0
    if safe_proj:
        proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
        planner_file = os.path.join(proj_dir, "exam_planner.json")
        if os.path.exists(planner_file):
            try:
                with open(planner_file, encoding="utf-8") as f:
                    pdata = json.load(f)
                    questions_count = len(pdata.get("questions", []))
            except Exception:
                pass

    return {
        "project": project,
        "files_count": files_count,
        "media_count": len(audio_files),
        "notes_count": len(notes_files),
        "flashcards_count": len(flashcards_files),
        "tests_count": len(tests_files),
        "lessons_count": lessons_count,
        "chat_count": chat_count,
        "questions_count": questions_count,
    }
