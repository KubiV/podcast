import json
import os
import shutil
import tempfile
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from core.authz import filter_accessible_output_files, require_project_access
from core.clients import get_chroma_client
from core.config import (
    AUDIO_DIR,
    FLASHCARDS_DIR,
    NOTES_DIR,
    PLANNER_FILENAME,
    TESTS_DIR,
    UPLOAD_DIR,
)
from core.context import current_user_var
from core.logger import send_log
from core.request_models import RequestModel
from core.uploads import copy_with_limit, validate_import_archive
from core.utils import sanitize_name
from services.auth_service import AuthService
from services.chat_service import list_lessons
from services.projects.transfer import (
    build_export_archive,
    cleanup_temp_file,
    get_export_info,
    import_archive,
    inspect_archive,
    max_import_bytes,
)


class ProjectCreateRequest(RequestModel):
    """Tělo '/api/projects'."""

    name: str | None = None


class ProjectRenameRequest(RequestModel):
    """Tělo '/api/projects/{project_id}/rename'."""

    new_name: str | None = ""


class ProjectClearDataRequest(RequestModel):
    """Tělo '/api/projects/{project_id}/clear-data'."""

    clear_chat: bool | None = False
    clear_notes: bool | None = False
    clear_flashcards: bool | None = False
    clear_tests: bool | None = False
    clear_audio: bool | None = False
    clear_questions: bool | None = False


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
async def create_project(request: Request, payload: ProjectCreateRequest = Body(...)):
    name = payload.name
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
        from services.chat_service import delete_project_records

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
async def rename_project(project_id: str, request: Request, payload: ProjectRenameRequest = Body(...)):
    """Přejmenuje projekt, jeho složku, ChromaDB kolekci, SQLite vazby i generované soubory."""
    new_name = str(payload.new_name).strip()
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
        from services.chat_service import rename_project_records

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
async def clear_project_data(project_id: str, payload: ProjectClearDataRequest = Body(...)):
    """Selektivní vyčištění generovaných dat projektu se zachováním nahraných zdrojových podkladů."""
    require_project_access(project_id, write=True)
    safe_proj = sanitize_name(project_id)
    if not safe_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")

    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nebyl nalezen.")

    clear_chat = payload.clear_chat
    clear_notes = payload.clear_notes
    clear_flashcards = payload.clear_flashcards
    clear_tests = payload.clear_tests
    clear_audio = payload.clear_audio
    clear_questions = payload.clear_questions

    cleared = []

    if clear_chat:
        from services.chat_service import clear_project_messages

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


@router.get("/api/projects/{project_id}/export-info")
async def get_project_export_info(project_id: str):
    """Vrací statistiky a souhrn dat projektu před zahájením exportu."""
    require_project_access(project_id)
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail=f"Projekt '{safe_proj}' nebyl nalezen.")

    return get_export_info(safe_proj, proj_dir)


@router.get("/api/projects/{project_id}/export")
async def export_project(
    project_id: str,
    include_audio: bool = False,
    include_chat: bool = True,
    include_outputs: bool = True,
    include_progress: bool = True,
):
    """Zabalí kompletní studijní projekt do jednoho souboru balíčku .medproj (ZIP) pro snadný přenos na jiný počítač bez nutnosti re-indexace."""
    require_project_access(project_id)
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail=f"Projekt '{safe_proj}' nebyl nalezen.")

    await send_log(f"📦 Zahajuji export projektu '{safe_proj}' (audio: {'ano' if include_audio else 'ne'})...")

    with tempfile.NamedTemporaryFile(suffix=".medproj", delete=False) as tf:
        tmp_export_path = tf.name

    try:
        build_export_archive(
            tmp_export_path, safe_proj, proj_dir, include_audio, include_chat, include_outputs, include_progress
        )

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
        copy_with_limit(file.file, tmp_inspect_path, max_import_bytes(), "Balíček projektu")

        if not zipfile.is_zipfile(tmp_inspect_path):
            raise HTTPException(status_code=400, detail="Nahraný soubor není platný archiv ZIP / .medproj.")

        with zipfile.ZipFile(tmp_inspect_path, "r") as zf:
            validate_import_archive(zf)
            return inspect_archive(zf, filename)
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
        copy_with_limit(file.file, tmp_import_path, max_import_bytes(), "Balíček projektu")

        if not zipfile.is_zipfile(tmp_import_path):
            raise HTTPException(status_code=400, detail="Nahraný soubor není platný archiv ZIP / .medproj.")

        with zipfile.ZipFile(tmp_import_path, "r") as zf:
            validate_import_archive(zf)
            return await import_archive(
                zf, filename, project_name, overwrite, include_chat, include_outputs, include_audio
            )

    finally:
        cleanup_temp_file(tmp_import_path)


@router.get("/api/stats")
async def get_project_stats(project: str = ""):
    if project:
        require_project_access(project)
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
    audio_files = filter_accessible_output_files(audio_files)

    # Poznámky
    notes_files = [f for f in os.listdir(NOTES_DIR) if f.endswith(".md")]
    if safe_proj:
        notes_files = [f for f in notes_files if f.startswith(f"{safe_proj}_")]
    notes_files = filter_accessible_output_files(notes_files)

    # Kartičky
    flashcards_files = [f for f in os.listdir(FLASHCARDS_DIR) if f.endswith(".json")]
    if safe_proj:
        flashcards_files = [f for f in flashcards_files if f.startswith(f"{safe_proj}_")]
    flashcards_files = filter_accessible_output_files(flashcards_files)

    # Testové otázky
    tests_files = [f for f in os.listdir(TESTS_DIR) if f.endswith(".json")]
    if safe_proj:
        tests_files = [f for f in tests_files if f.startswith(f"{safe_proj}_")]
    tests_files = filter_accessible_output_files(tests_files)

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
