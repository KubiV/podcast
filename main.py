import os
import sys
import subprocess
import glob
import shutil
import httpx
import asyncio
import json
import re
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, List, Optional, Tuple
import webbrowser
import html as html_lib
import secrets
import base64
import zipfile
import tempfile
from starlette.background import BackgroundTask
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException, Body, UploadFile, File, Form, BackgroundTasks, Request
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from auth_service import AuthService

from urllib.parse import quote
import pdfplumber
import chromadb
from dotenv import load_dotenv
from google import genai
from google.genai import types
from openai import OpenAI

try:
    from mutagen.mp3 import MP3
except ImportError:
    MP3 = None

try:
    import ffmpeg
except ImportError:
    ffmpeg = None

# --- NOVÉ KNIHOVNY PRO DOCX a PPTX ---
try:
    import docx
except ImportError:
    docx = None

try:
    import pptx
except ImportError:
    pptx = None

load_dotenv()

# Detekce prostředí: Zabalená binárka (PyInstaller) vs Běžný vývoj / Docker (Python)
IS_FROZEN = getattr(sys, "frozen", False)
env_data_dir = os.environ.get("AIMEDSTUDIO_DATA_DIR")

if env_data_dir:
    USER_DATA_DIR = os.path.abspath(env_data_dir)
    BUNDLE_DIR = sys._MEIPASS if IS_FROZEN else os.path.dirname(os.path.abspath(__file__))
elif IS_FROZEN:
    BUNDLE_DIR = sys._MEIPASS
    exe_dir = os.path.dirname(sys.executable)
    portable_data_dir = os.path.join(exe_dir, "data")
    if os.path.exists(portable_data_dir):
        USER_DATA_DIR = portable_data_dir
    else:
        USER_DATA_DIR = os.path.expanduser("~/Documents/AIMedStudio")
else:
    BUNDLE_DIR = os.path.dirname(os.path.abspath(__file__))
    USER_DATA_DIR = BUNDLE_DIR

os.environ["AIMEDSTUDIO_DATA_DIR"] = USER_DATA_DIR

# Inicializace služby pro správu uživatelů a zabezpečení
auth_service = AuthService(USER_DATA_DIR)

# Volitelná ochrana heslem pro serverový / Docker režim (zpětná kompatibilita)
APP_PASSWORD = os.getenv("APP_PASSWORD", "").strip()

app = FastAPI()

# Pydantic modely pro autentizaci
class SetupRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None

class LoginRequest(BaseModel):
    username: str
    password: str
    remember_me: bool = True

class RegisterRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None

class RegistrationToggleRequest(BaseModel):
    allow_registration: bool

class GuestToggleRequest(BaseModel):
    allow_guest: bool

class RoleChangeRequest(BaseModel):
    role: str

def set_auth_cookie(response: Response, token: str, remember_me: bool, request: Request):
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    max_age = 30 * 24 * 3600 if remember_me else 24 * 3600
    response.set_cookie(
        key="medstudio_session",
        value=token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=is_https,
        path="/"
    )

def clear_auth_cookie(response: Response, request: Request):
    is_https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.delete_cookie(
        key="medstudio_session",
        httponly=True,
        samesite="lax",
        secure=is_https,
        path="/"
    )

def require_admin(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Přístup vyžaduje přihlášení.")
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Tato akce vyžaduje administrátorská oprávnění.")
    return user

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path

    # Veřejně přístupné cesty:
    # - /health (Docker / Cloudflare healthcheck)
    # - /manifest.json, /icon.svg, /favicon.ico (PWA manifest a ikony)
    # - / a /index.html (hlavní SPA frontend s integrovaným dialogem přihlášení a prvotního nastavení)
    # - /api/auth/* (veřejné auth endpointy pro zjištění stavu, přihlášení a registraci)
    if (
        path in ("/health", "/manifest.json", "/icon.svg", "/favicon.ico", "/", "/index.html")
        or path.startswith("/api/auth/status")
        or path.startswith("/api/auth/setup")
        or path.startswith("/api/auth/login")
        or path.startswith("/api/auth/register")
        or path.startswith("/api/auth/logout")
    ):
        # I pro veřejné cesty zkusíme extrahovat přihlášeného uživatele, pokud existuje relace
        token = request.cookies.get("medstudio_session")
        if not token:
            auth_h = request.headers.get("Authorization")
            if auth_h and auth_h.startswith("Bearer "):
                token = auth_h.split(" ", 1)[1].strip()
        user = auth_service.validate_session(token) if token else None

        # Pokud není přihlášen a je povolen režim hosta, přiřadit virtuální roli hosta
        if not user and auth_service.is_guest_allowed():
            user = {
                "id": -1,
                "username": "host",
                "email": None,
                "role": "viewer",
                "status": "approved",
                "is_guest": True
            }

        request.state.user = user
        return await call_next(request)

    # Pro všechny ostatní endpointy (API, chráněné soubory, audio, materiály):
    token = request.cookies.get("medstudio_session")
    if not token:
        auth_h = request.headers.get("Authorization")
        if auth_h and auth_h.startswith("Bearer "):
            token = auth_h.split(" ", 1)[1].strip()

    user = auth_service.validate_session(token) if token else None

    # Zpětná kompatibilita pro Basic Auth APP_PASSWORD
    if not user and APP_PASSWORD:
        auth_h = request.headers.get("Authorization")
        if auth_h and auth_h.startswith("Basic "):
            try:
                encoded = auth_h.split(" ", 1)[1]
                decoded = base64.b64decode(encoded).decode("utf-8")
                if ":" in decoded:
                    _, pwd = decoded.split(":", 1)
                    if secrets.compare_digest(pwd, APP_PASSWORD):
                        user = {"id": 0, "username": "legacy_admin", "role": "admin", "status": "approved"}
            except Exception:
                pass

    # Pokud uživatel není přihlášen, zkontrolovat, zda je zapnutý režim nepřihlášeného hosta (pozorovatel)
    if not user and auth_service.is_guest_allowed():
        user = {
            "id": -1,
            "username": "host",
            "email": None,
            "role": "viewer",
            "status": "approved",
            "is_guest": True
        }

    if not user:
        if auth_service.needs_setup():
            return JSONResponse(
                status_code=401,
                content={"detail": "Systém vyžaduje prvotní nastavení administrátora.", "needs_setup": True}
            )
        return JSONResponse(
            status_code=401,
            content={"detail": "Přístup vyžaduje přihlášení.", "authenticated": False}
        )

    # OMEZENÍ PRO ROLI 'VIEWER' (POZOROVATEL / HOST):
    # Pozorovatel smí pouze procházet hotové věci (metody GET, HEAD, OPTIONS).
    # Veškeré generování, nahrávání souborů a mazání jsou blokovány s kódem 403 Forbidden.
    if user.get("role") == "viewer":
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            # Povolené výjimky pro read-only posty (příprava tisku, auth akce, lokální vyhodnocení odpovědí)
            is_allowed = (
                path.startswith("/api/auth/")
                or path in ("/api/print/prepare", "/api/tests/evaluate-open-answer")
            )
            if not is_allowed:
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": "Režim pozorovatele: Nemáte oprávnění generovat nový obsah, nahrávat ani mazat data. Můžete pouze procházet a studovat již vytvořené materiály.",
                        "role": "viewer"
                    }
                )

    request.state.user = user
    return await call_next(request)

@app.get("/health")
def health_check():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}

# --- ENDPOINTY PRO AUTENTIZACI A SPRÁVU ÚČTŮ ---

@app.get("/api/auth/status")
async def get_auth_status(request: Request):
    user = getattr(request.state, "user", None)
    return {
        "authenticated": user is not None and not user.get("is_guest", False),
        "is_guest": bool(user and user.get("is_guest", False)),
        "needs_setup": auth_service.needs_setup(),
        "allow_registration": auth_service.is_registration_allowed(),
        "allow_guest": auth_service.is_guest_allowed(),
        "user": user
    }


@app.post("/api/auth/setup")
async def setup_initial_admin(req: SetupRequest, request: Request, response: Response):
    user, err = auth_service.create_initial_admin(req.username, req.password, req.email)
    if err:
        raise HTTPException(status_code=400, detail=err)

    token, _ = auth_service.create_session(
        user["id"],
        remember_me=True,
        user_agent=request.headers.get("user-agent", "")
    )
    set_auth_cookie(response, token, True, request)
    return {"status": "ok", "user": user, "token": token}

@app.post("/api/auth/login")
async def login(req: LoginRequest, request: Request, response: Response):
    user, msg = auth_service.authenticate(req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail=msg)

    token, _ = auth_service.create_session(
        user["id"],
        remember_me=req.remember_me,
        user_agent=request.headers.get("user-agent", "")
    )
    set_auth_cookie(response, token, req.remember_me, request)
    return {"status": "ok", "user": user, "token": token}

@app.post("/api/auth/register")
async def register(req: RegisterRequest):
    user, err = auth_service.register_user(req.username, req.password, req.email)
    if err:
        raise HTTPException(status_code=400, detail=err)
    return {
        "status": "pending",
        "message": "Vaše žádost o registraci byla úspěšně odeslána. Účet musí před prvním přihlášením schválit administrátor serveru."
    }

@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get("medstudio_session")
    if not token:
        auth_h = request.headers.get("Authorization")
        if auth_h and auth_h.startswith("Bearer "):
            token = auth_h.split(" ", 1)[1].strip()
    if token:
        auth_service.revoke_session(token)
    clear_auth_cookie(response, request)
    return {"status": "ok"}

# --- ADMIN ENDPOINTY PRO SPRÁVU A SCHVALOVÁNÍ ÚČTŮ ---

@app.get("/api/auth/admin/users")
async def admin_get_users(request: Request):
    require_admin(request)
    return {
        "users": auth_service.list_users(),
        "summary": auth_service.get_auth_summary()
    }

@app.get("/api/auth/admin/pending")
async def admin_get_pending(request: Request):
    require_admin(request)
    return {"pending": auth_service.list_pending_requests()}

@app.post("/api/auth/admin/approve/{user_id}")
async def admin_approve_user(user_id: int, request: Request, role: str = "user"):
    require_admin(request)
    success = auth_service.approve_user(user_id, role=role)
    if not success:
        raise HTTPException(status_code=404, detail="Čekající uživatel nebyl nalezen.")
    role_label = "Pozorovatel" if role == "viewer" else ("Uživatel" if role == "user" else role)
    return {"status": "ok", "message": f"Účet byl úspěšně schválen s rolí: {role_label}.", "role": role}

@app.post("/api/auth/admin/change-role/{user_id}")
async def admin_change_role(user_id: int, req: RoleChangeRequest, request: Request):
    admin = require_admin(request)
    success, msg = auth_service.change_user_role(user_id, req.role, admin["id"])
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "ok", "message": msg, "role": req.role}

@app.post("/api/auth/admin/reject/{user_id}")
async def admin_reject_user(user_id: int, request: Request):
    require_admin(request)
    success = auth_service.reject_user(user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Čekající uživatel nebyl nalezen.")
    return {"status": "ok", "message": "Žádost byla zamítnuta."}

@app.post("/api/auth/admin/toggle-status/{user_id}")
async def admin_toggle_status(user_id: int, request: Request):
    admin = require_admin(request)
    success, msg = auth_service.toggle_user_active(user_id, admin["id"])
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "ok", "message": msg}

@app.delete("/api/auth/admin/users/{user_id}")
async def admin_delete_user(user_id: int, request: Request):
    admin = require_admin(request)
    success, msg = auth_service.delete_user(user_id, admin["id"])
    if not success:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": "ok", "message": msg}

@app.post("/api/auth/admin/registration-toggle")
async def admin_toggle_registration(req: RegistrationToggleRequest, request: Request):
    require_admin(request)
    auth_service.set_registration_allowed(req.allow_registration)
    return {"status": "ok", "allow_registration": req.allow_registration}

@app.post("/api/auth/admin/guest-toggle")
async def admin_toggle_guest(req: GuestToggleRequest, request: Request):
    require_admin(request)
    auth_service.set_guest_allowed(req.allow_guest)
    return {"status": "ok", "allow_guest": req.allow_guest}



# Pokud je přibalena lokální binárka ffmpeg, přidáme ji na začátek PATH
for b_dir in [BUNDLE_DIR, os.path.join(BUNDLE_DIR, "bin"), os.path.dirname(sys.executable) if IS_FROZEN else ""]:
    if b_dir and os.path.exists(b_dir):
        if (sys.platform == "win32" and os.path.exists(os.path.join(b_dir, "ffmpeg.exe"))) or \
           (sys.platform != "win32" and os.path.exists(os.path.join(b_dir, "ffmpeg"))):
            os.environ["PATH"] = b_dir + os.pathsep + os.environ.get("PATH", "")
            break

STATIC_DIR = os.path.join(BUNDLE_DIR, "static")
UPLOAD_DIR = os.path.join(USER_DATA_DIR, "uploads")
LESSONS_DIR = os.path.join(USER_DATA_DIR, "lessons_data")
AUDIO_DIR = os.path.join(USER_DATA_DIR, "generated_audio")
NOTES_DIR = os.path.join(USER_DATA_DIR, "generated_notes")
FLASHCARDS_DIR = os.path.join(USER_DATA_DIR, "generated_flashcards")
TESTS_DIR = os.path.join(USER_DATA_DIR, "generated_tests")
DB_DIR = os.path.join(USER_DATA_DIR, "chroma_db")
CONFIG_FILE = os.path.join(USER_DATA_DIR, "user_config.json")

for d in [UPLOAD_DIR, LESSONS_DIR, AUDIO_DIR, NOTES_DIR, FLASHCARDS_DIR, TESTS_DIR, DB_DIR, STATIC_DIR]:
    os.makedirs(d, exist_ok=True)

def migrate_lessons_out_of_uploads() -> None:
    """Automatická migrace: přesune složky výukových lekcí z uploads/ do samostatného lessons_data/."""
    if not os.path.exists(UPLOAD_DIR):
        return
    for item in os.listdir(UPLOAD_DIR):
        item_path = os.path.join(UPLOAD_DIR, item)
        if os.path.isdir(item_path) and (item.startswith("lekce_") or item.startswith("lesson_")):
            dest_path = os.path.join(LESSONS_DIR, item)
            try:
                if not os.path.exists(dest_path):
                    shutil.move(item_path, dest_path)
                    print(f"📦 [Migrace] Výuková lekce '{item}' přesunuta do lessons_data/")
                else:
                    for sub in os.listdir(item_path):
                        s_src = os.path.join(item_path, sub)
                        s_dst = os.path.join(dest_path, sub)
                        if not os.path.exists(s_dst):
                            shutil.move(s_src, s_dst)
                    shutil.rmtree(item_path, ignore_errors=True)
            except Exception as e:
                print(f"⚠️ [Migrace] Chyba při přesunu složky lekce {item}: {e}")

migrate_lessons_out_of_uploads()

# Správa uživatelské konfigurace (BYOK: Bring Your Own Key)
def load_user_config() -> dict[str, Any]:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ Chyba při načítání konfigurace {CONFIG_FILE}: {e}")
    return {}

def save_user_config(cfg: dict[str, Any]) -> None:
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

def get_gemini_api_key() -> str:
    cfg = load_user_config()
    return (cfg.get("gemini_api_key") or os.getenv("GEMINI_API_KEY") or "").strip()

def get_openai_api_key() -> str:
    cfg = load_user_config()
    return (cfg.get("openai_api_key") or os.getenv("OPENAI_API_KEY") or "").strip()

def get_elevenlabs_api_key() -> str:
    cfg = load_user_config()
    return (cfg.get("elevenlabs_api_key") or os.getenv("ELEVENLABS_API_KEY") or "").strip()

def get_gemini_client() -> genai.Client:
    key = get_gemini_api_key()
    if not key:
        raise HTTPException(
            status_code=400,
            detail="Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a vložte svůj API klíč."
        )
    return genai.Client(api_key=key)

def get_openai_client() -> OpenAI:
    key = get_openai_api_key()
    if not key:
        raise HTTPException(
            status_code=400,
            detail="Není nastaven OpenAI API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a zadejte svůj API klíč."
        )
    return OpenAI(api_key=key)

chroma_client = chromadb.PersistentClient(path=DB_DIR)
LOG_HISTORY_LIMIT = 250
LOG_SUBSCRIBER_QUEUE_SIZE = 300
log_history: deque[str] = deque(maxlen=LOG_HISTORY_LIMIT)
log_subscribers: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()


@dataclass
class BatchState:
    """Stav jedné běžící dávky pro konkrétní projekt."""

    batch_id: str
    mode: str = "podcast"  # "podcast", "notes", "flashcards"
    cancel_requested: bool = False
    completed_question_indexes: list[int] = field(default_factory=list)


# V jednom projektu smí běžet jen jedna dávka. Díky tomu nelze omylem spustit
# dvě souběžné syntézy, které by přepisovaly stejné výstupní soubory.
active_batches: dict[str, BatchState] = {}


def serialize_sse(event_name: str, payload: dict[str, Any]) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def publish_event(event_name: str, payload: dict[str, Any]):
    """Rozešle událost všem připojeným konzolím bez blokování zpracování."""
    for subscriber in tuple(log_subscribers):
        if subscriber.full():
            try:
                subscriber.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            subscriber.put_nowait((event_name, payload))
        except asyncio.QueueFull:
            # Ojedinělá plná fronta nesmí zastavit vlastní dávkové zpracování.
            pass


async def send_log(message: str):
    """Jediné místo pro zápis provozních logů: terminál aplikace i webová konzole."""
    clean_message = str(message).replace("\r", " ").replace("\n", " ")
    log_history.append(clean_message)
    print(f"[LOG] {clean_message}", flush=True)
    await publish_event("log", {"message": clean_message})


async def send_batch_event(project: str, event_type: str, batch_id: str, **data: Any):
    await publish_event(
        "batch",
        {
            "project": project,
            "type": event_type,
            "batch_id": batch_id,
            **data,
        },
    )

@app.get("/api/logs")
async def stream_logs():
    async def event_generator():
        subscriber: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(
            maxsize=LOG_SUBSCRIBER_QUEUE_SIZE
        )
        log_subscribers.add(subscriber)
        try:
            # Nově otevřená konzole dostane i krátký kontext před připojením.
            # Kopie brání chybě při souběžném přidání nového logu do deque.
            for log_message in tuple(log_history):
                yield serialize_sse("log", {"message": log_message})

            while True:
                event_name, payload = await subscriber.get()
                yield serialize_sse(event_name, payload)
        finally:
            log_subscribers.discard(subscriber)

    return StreamingResponse(event_generator(), media_type="text/event-stream")

def sanitize_name(name: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]', '_', name.strip())

# --- SPRÁVA PROJEKTŮ ---
@app.get("/api/projects")
async def list_projects():
    from chat_service import list_lessons
    try:
        lesson_ids = {l.get("project_id") for l in list_lessons() if l.get("project_id")}
    except Exception:
        lesson_ids = set()

    projects = [
        d for d in os.listdir(UPLOAD_DIR)
        if os.path.isdir(os.path.join(UPLOAD_DIR, d))
        and not d.startswith("lekce_")
        and not d.startswith("lesson_")
        and not d.startswith(".")
        and d not in lesson_ids
    ]
    return {"projects": sorted(projects)}

@app.post("/api/projects")
async def create_project(payload: dict = Body(...)):
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Název projektu je prázdný.")
    safe_name = sanitize_name(name)
    os.makedirs(os.path.join(UPLOAD_DIR, safe_name), exist_ok=True)
    await send_log(f"📁 Nový projekt vytvořen: {safe_name}")
    return {"project": safe_name}

@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str):
    """Kompletně smaže projekt včetně všech materiálů, ChromaDB vektorů, SQLite historie i výstupů."""
    safe_proj = sanitize_name(project_id)
    if not safe_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")
    
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

    await send_log(f"🗑️ Projekt '{safe_proj}' a veškerá jeho data byla úspěšně smazána.")
    return {
        "status": "deleted",
        "project": safe_proj,
        "deleted_outputs": deleted_counts
    }

@app.post("/api/projects/{project_id}/rename")
async def rename_project(project_id: str, payload: dict = Body(...)):
    """Přejmenuje projekt, jeho složku, ChromaDB kolekci, SQLite vazby i generované soubory."""
    new_name = str(payload.get("new_name", "")).strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Nový název projektu nesmí být prázdný.")
    
    old_proj = sanitize_name(project_id)
    new_proj = sanitize_name(new_name)

    if not old_proj or not new_proj:
        raise HTTPException(status_code=400, detail="Neplatný název projektu.")
    
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
            with open(planner_file, "r", encoding="utf-8") as f:
                pdata = json.load(f)
            if "project" in pdata:
                pdata["project"] = new_proj
            with open(planner_file, "w", encoding="utf-8") as f:
                json.dump(pdata, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    # 5. Přejmenování generovaných souborů (notes, flashcards, tests, audio)
    for folder, is_test in [
        (NOTES_DIR, False),
        (FLASHCARDS_DIR, False),
        (TESTS_DIR, True),
        (AUDIO_DIR, False)
    ]:
        if not os.path.exists(folder):
            continue
        for fname in os.listdir(folder):
            if fname.startswith(f"{old_proj}_"):
                rest = fname[len(old_proj) + 1:]
                new_fname = f"{new_proj}_{rest}"
                old_fpath = os.path.join(folder, fname)
                new_fpath = os.path.join(folder, new_fname)
                try:
                    if is_test and fname.endswith(".json"):
                        try:
                            with open(old_fpath, "r", encoding="utf-8") as jf:
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
    return {
        "status": "renamed",
        "old_project": old_proj,
        "new_project": new_proj
    }

@app.post("/api/projects/{project_id}/clear-data")
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
                try: os.remove(os.path.join(NOTES_DIR, f))
                except Exception: pass
        cleared.append("notes")

    if clear_flashcards:
        for f in os.listdir(FLASHCARDS_DIR):
            if f.startswith(f"{safe_proj}_"):
                try: os.remove(os.path.join(FLASHCARDS_DIR, f))
                except Exception: pass
        cleared.append("flashcards")

    if clear_tests:
        for f in os.listdir(TESTS_DIR):
            if f.startswith(f"{safe_proj}_"):
                try: os.remove(os.path.join(TESTS_DIR, f))
                except Exception: pass
        cleared.append("tests")

    if clear_audio:
        for f in os.listdir(AUDIO_DIR):
            if f.startswith(f"{safe_proj}_"):
                try: os.remove(os.path.join(AUDIO_DIR, f))
                except Exception: pass
        cleared.append("audio")

    if clear_questions:
        planner_file = os.path.join(proj_dir, PLANNER_FILENAME)
        if os.path.exists(planner_file):
            try:
                with open(planner_file, "r", encoding="utf-8") as f:
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

@app.get("/api/projects/{project_id}/export-info")
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
                    with open(fp, "r", encoding="utf-8") as pf:
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
    notes_count = len([f for f in os.listdir(NOTES_DIR) if f.startswith(f"{safe_proj}_")]) if os.path.exists(NOTES_DIR) else 0
    cards_count = len([f for f in os.listdir(FLASHCARDS_DIR) if f.startswith(f"{safe_proj}_") and f.endswith(".json")]) if os.path.exists(FLASHCARDS_DIR) else 0
    tests_count = len([f for f in os.listdir(TESTS_DIR) if f.startswith(f"{safe_proj}_") and f.endswith(".json")]) if os.path.exists(TESTS_DIR) else 0

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


@app.get("/api/projects/{project_id}/export")
async def export_project(
    project_id: str,
    include_audio: bool = False,
    include_chat: bool = True,
    include_outputs: bool = True,
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
                    zf.write(full_p, f"uploads/{rel_p}")
                    if f == PLANNER_FILENAME:
                        try:
                            with open(full_p, "r", encoding="utf-8") as pf:
                                pdata = json.load(pf)
                                manifest["stats"]["questions_count"] = len(pdata.get("questions") or [])
                        except Exception:
                            pass
                    else:
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

        await send_log(f"✅ Export projektu '{safe_proj}' dokončen ({os.path.getsize(tmp_export_path) / 1024 / 1024:.1f} MB). Odesílám soubor...")

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


@app.post("/api/projects/import/inspect")
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
            source_files_in_zip = [n[len("uploads/"):] for n in namelist if n.startswith("uploads/") and not n.endswith("/") and not n.endswith(PLANNER_FILENAME)]
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


@app.post("/api/projects/import")
async def import_project(
    file: UploadFile = File(...),
    project_name: Optional[str] = Form(None),
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
                    rel_p = n[len("uploads/"):]
                    dest_p = os.path.abspath(os.path.join(target_dir, rel_p))
                    if not dest_p.startswith(os.path.abspath(target_dir)):
                        continue
                    os.makedirs(os.path.dirname(dest_p), exist_ok=True)
                    with zf.open(n) as sf, open(dest_p, "wb") as df:
                        shutil.copyfileobj(sf, df)

                    if os.path.basename(dest_p) == PLANNER_FILENAME:
                        try:
                            with open(dest_p, "r", encoding="utf-8") as pf:
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
                        b_ids = ids[i:i + batch_size]
                        b_docs = docs[i:i + batch_size]
                        b_metas = metas[i:i + batch_size]
                        b_embs = embs[i:i + batch_size] if (embs and len(embs) == total) else None
                        if b_embs:
                            target_col.upsert(ids=b_ids, documents=b_docs, metadatas=b_metas, embeddings=b_embs)
                        else:
                            target_col.upsert(ids=b_ids, documents=b_docs, metadatas=b_metas)
                    imported_chunks = total
                    await send_log(f"🧠 Úspěšně načteno {imported_chunks} vektorových chunků do ChromaDB (kolekce: {col_name}).")
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
                        rest = fname[len(orig_proj) + 1:] if fname.startswith(f"{orig_proj}_") else fname
                        new_fname = f"{final_proj}_{rest}"
                        dest = os.path.join(NOTES_DIR, new_fname)
                        text = zf.read(n).decode("utf-8", errors="replace")
                        text = re.sub(
                            r'<!-- METADATA\s*({.*?})\s*-->',
                            lambda m: f'<!-- METADATA\n{json.dumps({**json.loads(m.group(1)), "project": final_proj}, ensure_ascii=False)}\n-->',
                            text,
                            count=1,
                            flags=re.DOTALL,
                        )
                        with open(dest, "w", encoding="utf-8") as f:
                            f.write(text)
                        imported_outputs["notes"] += 1

                    elif n.startswith("generated/flashcards/") and not n.endswith("/"):
                        fname = os.path.basename(n)
                        rest = fname[len(orig_proj) + 1:] if fname.startswith(f"{orig_proj}_") else fname
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
                        rest = fname[len(orig_proj) + 1:] if fname.startswith(f"{orig_proj}_") else fname
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
                        rest = fname[len(orig_proj) + 1:] if fname.startswith(f"{orig_proj}_") else fname
                        new_fname = f"{final_proj}_{rest}"
                        dest = os.path.join(AUDIO_DIR, new_fname)
                        with zf.open(n) as sf, open(dest, "wb") as df:
                            shutil.copyfileobj(sf, df)
                        imported_outputs["audio"] += 1

            await send_log(f"🎉 Projekt '{final_proj}' byl úspěšně importován (včetně {len(imported_source_files)} podkladů a {imported_chunks} vektorových chunků).")

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

# --- UNIVERZÁLNÍ EXTRAKCE TEXTU SE ZACHOVÁNÍM STRAN ---
async def extract_sections_from_file(file_path: str, filename: str) -> list[dict[str, Any]]:
    """
    Extrahuje strukturovaný text s metadaty (číslo stránky, snímku nebo sekce).
    Vrací seznam dictů: [{"text": str, "source": filename, "page": str}].
    """
    ext = filename.lower().split('.')[-1]
    sections: list[dict[str, Any]] = []

    if ext == "pdf":
        with pdfplumber.open(file_path) as pdf:
            total_pages = len(pdf.pages)
            for idx, page in enumerate(pdf.pages):
                if idx % 10 == 0:
                    await asyncio.sleep(0.01)  # Udržení asynchronicity
                text = page.extract_text()
                if text and text.strip():
                    sections.append({
                        "text": text.strip(),
                        "source": filename,
                        "page": str(idx + 1)
                    })

    elif ext == "docx":
        if docx is None:
            raise ImportError("Chybí knihovna python-docx")
        doc = docx.Document(file_path)
        current_block = []
        current_heading = "Úvod"
        for idx, para in enumerate(doc.paragraphs):
            if idx % 100 == 0:
                await asyncio.sleep(0.01)
            p_text = para.text.strip()
            if not p_text:
                continue
            if para.style and para.style.name.startswith("Heading"):
                if current_block:
                    sections.append({
                        "text": "\n".join(current_block),
                        "source": filename,
                        "page": current_heading
                    })
                    current_block = []
                current_heading = p_text[:40]
            current_block.append(p_text)
        if current_block:
            sections.append({
                "text": "\n".join(current_block),
                "source": filename,
                "page": current_heading
            })

    elif ext == "pptx":
        if pptx is None:
            raise ImportError("Chybí knihovna python-pptx")
        prs = pptx.Presentation(file_path)
        for idx, slide in enumerate(prs.slides):
            if idx % 5 == 0:
                await asyncio.sleep(0.01)
            slide_lines = []
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text and shape.text.strip():
                    slide_lines.append(shape.text.strip())
            if slide_lines:
                sections.append({
                    "text": "\n".join(slide_lines),
                    "source": filename,
                    "page": f"Slide {idx + 1}"
                })

    elif ext in ("txt", "md"):
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        raw_parts = re.split(r'\n(?=#{1,3}\s+|\n---+\n)', content)
        page_counter = 1
        for part in raw_parts:
            part_clean = part.strip()
            if part_clean:
                sections.append({
                    "text": part_clean,
                    "source": filename,
                    "page": str(page_counter)
                })
                page_counter += 1
    else:
        raise ValueError(f"Nepodporovaný formát: {ext}")

    return sections

async def extract_text_from_file(file_path: str, filename: str) -> str:
    """Zpětně kompatibilní agregovaná extrakce celého textu dokumentu."""
    sections = await extract_sections_from_file(file_path, filename)
    return "\n\n".join(s["text"] for s in sections)

# --- PRÁCE S MATERIÁLY (POKROČILÝ RAG & CHUNKING) ---

def sanitize_markdown_tables(text: str) -> str:
    """
    Opraví případné slití řádků tabulek, normalizuje escape sekvence a zajistí
    prázdné řádky okolo tabulek, aby se nikdy neslily do jednoho nečitelného bloku.
    Zároveň odstraní prázdné řádky uvnitř tabulek, které by rozbily jejich vykreslení v Markdownu.
    """
    if not text:
        return ""
    # 1. Normalizace surového \\n na skutečné nové řádky, pokud došlo k dvojitému escapování
    if "\\n" in text and "\n\n" not in text:
        text = text.replace("\\n", "\n")

    # 2. Oprava slitých řádků tabulky na jednom řádku: "| buňka | | další |" -> "| buňka |\n| další |"
    text = re.sub(r'(\|\s*)\|\s*([^\s|])', r'\1\n| \2', text)

    # 3. Odstranění prázdných řádků MEZI řádky tabulky (řádky začínající a končící |)
    while re.search(r'(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)', text):
        text = re.sub(r'(\|[^\n\r]+\|)\s*\n\s*\n+(\s*\|)', r'\1\n\2', text)

    # 4. Zajistit prázdný řádek před Markdown tabulkou, pokud bezprostředně předchází běžný text (nikoliv řádek tabulky!)
    text = re.sub(r'([^\n\r|])\r?\n(\s*\|[^\n\r]+\|)', r'\1\n\n\2', text)

    # 5. Zajistit prázdný řádek za Markdown tabulkou (následující řádek nesmí být řádek tabulky)
    text = re.sub(r'(\|[^\n\r]+\|)\r?\n([^\n\r|\s])', r'\1\n\n\2', text)
    return text

def chunk_sections_with_metadata(
    sections: list[dict[str, Any]],
    chunk_size: int = 7000,
    overlap: int = 1000
) -> list[dict[str, Any]]:
    """
    Sémantický token-aware chunking (cca 1500–2200 tokenů = 6000–8000 znaků).
    Sdružuje sekce, zachovává přesná čísla stran / slidy a dělí výhradně na
    přirozených hranicích odstavců a vět, nikoliv uprostřed slov či tabulek.
    """
    chunks: list[dict[str, Any]] = []
    current_text = ""
    current_source = ""
    start_page = None
    end_page = None

    def flush_chunk(text_to_save: str, src: str, p_start: Any, p_end: Any):
        clean_t = text_to_save.strip()
        if not clean_t:
            return
        page_label = str(p_start) if p_start == p_end or not p_end else f"{p_start}–{p_end}"
        chunks.append({
            "document": clean_t,
            "source": src,
            "page": page_label,
        })

    for sec in sections:
        sec_text = sec["text"]
        source = sec["source"]
        page = sec.get("page", "1")

        if not current_text:
            current_text = sec_text
            current_source = source
            start_page = page
            end_page = page
            continue

        if len(current_text) + len(sec_text) + 2 <= chunk_size:
            current_text += "\n\n" + sec_text
            end_page = page
        else:
            flush_chunk(current_text, current_source, start_page, end_page)

            # Inteligentní překryv (overlap) na hranici odstavce nebo věty
            overlap_text = ""
            if len(current_text) > overlap:
                overlap_start = len(current_text) - overlap
                split_idx = current_text.find("\n\n", overlap_start)
                if split_idx == -1:
                    split_idx = current_text.find(". ", overlap_start)
                    if split_idx != -1:
                        split_idx += 2
                if split_idx == -1:
                    split_idx = overlap_start
                overlap_text = current_text[split_idx:].strip()

            if overlap_text:
                current_text = overlap_text + "\n\n" + sec_text
                start_page = end_page
                end_page = page
            else:
                current_text = sec_text
                start_page = page
                end_page = page

    if current_text.strip():
        flush_chunk(current_text, current_source, start_page, end_page)

    return chunks

def chunk_text(text: str, chunk_size: int = 6500, overlap: int = 1000) -> list:
    """Zpětně kompatibilní funkce chunkingu pro čistý text se sémantickým dělením."""
    if not text:
        return []
    chunks = []
    start = 0
    text_len = len(text)
    while start < text_len:
        end = min(start + chunk_size, text_len)
        if end < text_len:
            cut = text.rfind("\n\n", start + overlap, end)
            if cut == -1:
                cut = text.rfind(". ", start + overlap, end)
                if cut != -1:
                    cut += 2
            if cut != -1 and cut > start:
                end = cut
        clean_chunk = text[start:end].strip()
        if clean_chunk:
            chunks.append(clean_chunk)
        if end == text_len:
            break
        start = max(end - overlap, start + 1)
    return chunks

async def index_file_to_chroma(file_path: str, filename: str, project_name: str):
    await send_log(f"📖 Extraktuji text z dokumentu s analýzou stran: {filename} ({project_name})...")
    try:
        sections = await extract_sections_from_file(file_path, filename)

        if not sections:
            await send_log(f"⚠️ Dokument {filename} neobsahuje žádný strojově čitelný text.")
            return

        chunks = chunk_sections_with_metadata(sections)
        collection_name = f"proj_{sanitize_name(project_name)}"
        collection = chroma_client.get_or_create_collection(name=collection_name)

        docs = [c["document"] for c in chunks]
        ids = [f"{filename}_chunk_{i}" for i in range(len(chunks))]
        metadatas = [
            {
                "source": c["source"],
                "page": str(c.get("page", "1")),
                "chunk_index": i
            }
            for i, c in enumerate(chunks)
        ]

        collection.add(documents=docs, metadatas=metadatas, ids=ids)
        try:
            from chat_service import index_chunks_to_fts
            fts_chunks = [
                {
                    "id": ids[i],
                    "document": docs[i],
                    "source": metadatas[i]["source"],
                    "page": metadatas[i]["page"],
                }
                for i in range(len(chunks))
            ]
            index_chunks_to_fts(safe_proj, fts_chunks)
        except Exception as e:
            print(f"[main] FTS indexing warning: {e}")
        await send_log(f"✅ Dokument {filename} úspěšně zpracován ({len(chunks)} sémantických chunků s metadaty stran uloženo).")
    except Exception as e:
        await send_log(f"❌ Selhalo indexování souboru {filename}: {str(e)}")

@app.get("/api/files")
async def list_files(project: str):
    safe_proj = sanitize_name(project)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        return {"files": []}
    
    allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
    all_files = os.listdir(proj_dir)
    valid_files = [f for f in all_files if f.lower().endswith(allowed_exts)]
    return {"files": valid_files}

# ZDE JE OPRAVA PRO VÍCE SOUBORŮ NARÁZ:
@app.post("/api/files/upload")
async def upload_files(background_tasks: BackgroundTasks, project: str = Form(...), files: List[UploadFile] = File(...)):
    safe_proj = sanitize_name(project)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    
    allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
    saved_files = []

    for file in files:
        if not file.filename.lower().endswith(allowed_exts):
            await send_log(f"⚠️ Přeskočen soubor {file.filename}: Nepodporovaný formát.")
            continue
            
        file_path = os.path.join(proj_dir, file.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        saved_files.append(file.filename)
        await send_log(f"📥 Soubor {file.filename} nahrán. Řadím do fronty pro vektorizaci...")
        background_tasks.add_task(index_file_to_chroma, file_path, file.filename, safe_proj)
        
    return {"filenames": saved_files}

@app.delete("/api/files/{filename}")
async def delete_file(filename: str, project: str):
    safe_proj = sanitize_name(project)
    file_path = os.path.join(UPLOAD_DIR, safe_proj, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        
        collection_name = f"proj_{safe_proj}"
        try:
            collection = chroma_client.get_collection(name=collection_name)
            collection.delete(where={"source": filename})
        except Exception:
            pass

        try:
            from chat_service import delete_chunks_from_fts
            delete_chunks_from_fts(project_id=safe_proj, source=filename)
        except Exception:
            pass
        
        await send_log(f"🗑️ Soubor {filename} a jeho vektory byly z projektu smazány.")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

def get_file_mime_type(filename: str) -> str:
    ext = filename.lower().split('.')[-1]
    mime_map = {
        "pdf": "application/pdf",
        "txt": "text/plain; charset=utf-8",
        "md": "text/markdown; charset=utf-8",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
    }
    return mime_map.get(ext, "application/octet-stream")

@app.get("/api/files/{project}/{filename}/view")
async def view_project_file(project: str, filename: str):
    """Servíruje nahraný soubor (PDF, TXT apod.) pro přímé zobrazení v prohlížeči (inline disposition)."""
    safe_proj = sanitize_name(project)
    file_path = os.path.join(UPLOAD_DIR, safe_proj, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Soubor nenalezen.")

    media_type = get_file_mime_type(filename)
    return FileResponse(
        file_path,
        media_type=media_type,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(filename)}"}
    )

@app.get("/api/files/{project}/{filename}/preview")
async def preview_project_file(project: str, filename: str):
    """Vrací strukturovaný obsah a metadata souboru pro náhled v rozhraní (podporuje DOCX, PPTX, TXT, PDF)."""
    safe_proj = sanitize_name(project)
    file_path = os.path.join(UPLOAD_DIR, safe_proj, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Soubor nenalezen.")

    file_size = os.path.getsize(file_path)
    ext = filename.lower().split('.')[-1]
    
    sections = []
    raw_text = ""
    try:
        sections = await extract_sections_from_file(file_path, filename)
        if ext in ("txt", "md"):
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                raw_text = f.read()
    except Exception as e:
        sections = [{"text": f"Chyba při extrakci obsahu: {str(e)}", "page": "Chyba", "source": filename}]

    return {
        "filename": filename,
        "project": safe_proj,
        "extension": ext,
        "size_bytes": file_size,
        "sections_count": len(sections),
        "sections": sections,
        "raw_text": raw_text
    }


@app.post("/api/projects/{project}/reindex")
async def reindex_project_files(project: str, background_tasks: BackgroundTasks):
    """Smaže stávající index v ChromaDB a znovu hloubkově zaindexuje všechny nahrané soubory s novým sémantickým chunkingem a metadaty stran."""
    safe_proj = sanitize_name(project)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    if not os.path.exists(proj_dir):
        raise HTTPException(status_code=404, detail="Projekt nenalezen.")

    collection_name = f"proj_{safe_proj}"
    try:
        chroma_client.delete_collection(name=collection_name)
    except Exception:
        pass

    try:
        from chat_service import delete_chunks_from_fts
        delete_chunks_from_fts(project_id=safe_proj)
    except Exception:
        pass

    allowed_exts = (".pdf", ".docx", ".pptx", ".txt")
    files_to_index = [f for f in os.listdir(proj_dir) if f.lower().endswith(allowed_exts)]
    
    for fname in files_to_index:
        fpath = os.path.join(proj_dir, fname)
        background_tasks.add_task(index_file_to_chroma, fpath, fname, safe_proj)

    await send_log(f"🔄 Spuštěno hloubkové přerindexování projektu '{safe_proj}' ({len(files_to_index)} souborů).")
    return {"status": "reindexing_started", "project": safe_proj, "files_count": len(files_to_index)}

@app.post("/api/files/upload-csv")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.endswith(".csv") and not file.filename.endswith(".txt"):
        raise HTTPException(status_code=400, detail="Podporovány jsou pouze .csv nebo .txt soubory.")
    
    contents = await file.read()
    decoded = contents.decode("utf-8")
    lines = decoded.splitlines()
    
    parsed_questions = []
    for line in lines:
        clean = line.strip().replace('"', '').replace("'", "")
        if clean:
            parsed_questions.append(clean)
            
    await send_log(f"📋 Naimportováno {len(parsed_questions)} otázek ze souboru {file.filename}.")
    return {"questions": parsed_questions}

# --- PRŮZKUMNÍK SOUBORŮ ---
@app.get("/api/outputs")
async def list_outputs(project: str = ""):
    try:
        files = [f for f in os.listdir(AUDIO_DIR) if f.endswith(('.mp3', '.mp4', '.srt'))]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]
            
        files.sort(key=lambda x: os.path.getmtime(os.path.join(AUDIO_DIR, x)), reverse=True)
        return {"files": files}
    except Exception as e:
        return {"files": [], "error": str(e)}

@app.delete("/api/outputs/{filename}")
async def delete_output(filename: str):
    file_path = os.path.join(AUDIO_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Vymazán soubor média: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

# --- ZPRACOVÁNÍ AI ---
def enrich_prompt_for_tts(base_prompt: str, provider: str) -> str:
    tts_instructions = ""
    if provider == "elevenlabs":
        tts_instructions = (
            "\n\n[TTS INSTRUKCE PRO ELEVENLABS]: Cílový syntetizátor je vysoce expresivní. "
            "Piš text tak, aby podporoval dynamickou intonaci. Můžeš používat tři tečky (...) "
            "pro dramatické pauzy nebo zamyšlení. Klad důraz na přirozený dechový rytmus mluvčího."
        )
    elif provider == "openai":
        tts_instructions = (
            "\n\n[TTS INSTRUKCE PRO OPENAI]: Cílový syntetizátor je OpenAI TTS. "
            "Tento model potřebuje jasnou interpunkci k formování intonace. "
            "Pro zdůraznění pointy používej kratší úderné věty. Dbej na jasně oddělená souvětí, "
            "aby modulace hlasu nezněla monotónně."
        )
    return base_prompt + tts_instructions


def friendly_api_error(error: Exception, provider: str) -> str:
    """Převede časté chyby vzdálených API na stručnou a použitelnou zprávu."""
    raw_error = str(error)
    normalized_error = raw_error.lower()

    if "denied access" in normalized_error or "permission_denied" in normalized_error or "403" in normalized_error:
        return (
            f"{provider}: přístup byl zamítnut (403 PERMISSION_DENIED). "
            "Google zablokoval přístup pro tento projekt (časté u free tier projektů). "
            "Řešení: Vytvořte nový API klíč v novém projektu na https://aistudio.google.com/app/apikey a uložte jej do .env."
        )
    if "404" in normalized_error or "not_found" in normalized_error:
        return (
            f"{provider}: model nebyl nalezen (404 NOT_FOUND). "
            "Původní model (např. gemini-2.5-flash) již není dostupný pro nové uživatele. "
            "Doporučujeme použít výchozí gemini-3.6-flash nebo gemini-flash-latest."
        )
    if "insufficient_quota" in normalized_error or "billing" in normalized_error:
        return (
            f"{provider}: vyčerpána dostupná kvóta nebo kredit. "
            "Zkontrolujte tarif a fakturaci, potom lze dávku spustit znovu."
        )
    if "invalid_api_key" in normalized_error or "api key" in normalized_error:
        return f"{provider}: neplatný nebo chybějící API klíč. Zkontrolujte soubor .env."
    if "429" in normalized_error or "resource exhausted" in normalized_error:
        return f"{provider}: limit požadavků je dočasně vyčerpán. Zkuste dávku spustit znovu za chvíli."
    if "503" in normalized_error or "unavailable" in normalized_error or "overloaded" in normalized_error:
        return f"{provider}: služba je dočasně nedostupná nebo přetížená. Zkuste to prosím za pár minut."
    if "timeout" in normalized_error or "timed out" in normalized_error:
        return f"{provider}: vypršel časový limit spojení. Zkuste dávku spustit znovu."
    return raw_error


def is_terminal_auth_error(error: Exception) -> bool:
    """Zjistí, zda se jedná o fatální chybu autorizace (403, zablokovaný projekt, neplatný API klíč)."""
    normalized = str(error).lower()
    return any(marker in normalized for marker in ("denied access", "permission_denied", "403", "invalid_api_key"))


def extract_gemini_error_detail(error: Exception) -> str:
    """Extrahuje stručný a přesný detail o chybě z Gemini API pro diagnostiku."""
    raw = str(error)
    normalized = raw.lower()

    code = ""
    if "403" in raw or "permission_denied" in normalized:
        code = "HTTP 403 (Přístup zamítnut / Projekt nepovolen)"
    elif "404" in raw or "not_found" in normalized:
        code = "HTTP 404 (Model nenalezen nebo již není podporován)"
    elif "429" in raw or "resource_exhausted" in normalized:
        code = "HTTP 429 (Vyčerpán limit požadavků / RPM / TPM)"
    elif "503" in raw or "unavailable" in normalized or "overloaded" in normalized:
        code = "HTTP 503 (Model Googlu je přetížený)"
    elif "504" in raw or "timeout" in normalized:
        code = "HTTP 504 / Timeout"
    elif "500" in raw:
        code = "HTTP 500 (Interní chyba serveru Google)"
    elif "connecterror" in normalized or "nodename nor servname" in normalized or "failed to resolve" in normalized:
        code = "Chyba sítě (Nelze navázat spojení se servery Google)"

    # Zkusit vytáhnout specifickou hlášku z JSON odpovědi nebo textu
    msg_match = re.search(r"['\"]message['\"]:\s*['\"]([^'\"]+)['\"]", raw)
    detail = ""
    if msg_match:
        detail = msg_match.group(1).strip()
    elif "the model is overloaded" in normalized:
        detail = "The model is overloaded. Please try again later."
    elif "quota exceeded" in normalized:
        quota_match = re.search(r"(quota exceeded[^\.\n]+)", raw, re.IGNORECASE)
        if quota_match:
            detail = quota_match.group(1).strip()

    if code and detail:
        return f"{code}: {detail}"
    if code:
        return code
    if detail:
        return detail

    clean_raw = " ".join(raw.split())
    return clean_raw[:120] + "..." if len(clean_raw) > 120 else clean_raw


def is_retryable_gemini_error(error: Exception) -> bool:
    normalized_error = str(error).lower()
    return any(
        marker in normalized_error
        for marker in (
            "503",
            "unavailable",
            "overloaded",
            "429",
            "resource exhausted",
            "resource_exhausted",
            "quota",
            "timeout",
            "timed out",
            "504",
            "500",
            "internal server error",
            "connecterror",
            "connection reset",
            "remote disconnected",
            "deadline exceeded",
        )
    )

async def call_gemini_with_retries(
    model: str,
    contents: list,
    system_instruction: str = "",
    temperature: float = 0.7,
    max_output_tokens: int = 8192,
    response_mime_type: str = "",
) -> str:
    # Pro dlouhé noční běhy a špičky Googlu: 5 pokusů s progresivním čekáním
    wait_intervals = [10, 20, 35, 60]
    max_retries = len(wait_intervals) + 1

    for attempt in range(max_retries):
        try:
            config_args = {"temperature": temperature, "max_output_tokens": max_output_tokens}
            if system_instruction:
                config_args["system_instruction"] = system_instruction
            if response_mime_type:
                config_args["response_mime_type"] = response_mime_type

            client = get_gemini_client()
            response = await asyncio.to_thread(
                client.models.generate_content,
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(**config_args),
            )
            return response.text or ""
        except Exception as e:
            if is_retryable_gemini_error(e):
                err_detail = extract_gemini_error_detail(e)
                if attempt < max_retries - 1:
                    wait_time = wait_intervals[attempt]
                    await send_log(f"⚠️ Gemini API [{err_detail}] (pokus {attempt + 1}/{max_retries}). Čekám {wait_time} s...")
                    await asyncio.sleep(wait_time)
                else:
                    raise ValueError(f"{friendly_api_error(e, 'Gemini')} (Detail: {err_detail})") from e
            else:
                raise

def decompose_question_to_subqueries(question: str) -> list[str]:
    """
    Rozloží kombinovanou zkouškovou otázku (např. 'Lístek 1: a) Astma bronchiale, b) Lymfomy')
    na jednotlivá dílčí témata, aby RAG našel dostatek materiálu pro všechny části zkouškového lístku.
    """
    clean_q = question.strip()
    parts = re.split(r'(?:^|\s+)(?:[a-zA-Z0-9]\)|\([a-zA-Z0-9]\))\s*', clean_q)
    sub_queries = []
    for p in parts:
        p_clean = p.strip(" :;,.-")
        if re.match(r'^(?:Lístek|Otázka|Téma|Ot\.?)\s*\d+$', p_clean, re.IGNORECASE):
            continue
        if len(p_clean) >= 3:
            sub_queries.append(p_clean)

    if not sub_queries and (";" in clean_q or "\n" in clean_q):
        for p in re.split(r'[\n;]+', clean_q):
            p_clean = p.strip(" :;,.-")
            if len(p_clean) >= 3 and not re.match(r'^(?:Lístek|Otázka)\s*\d+$', p_clean, re.IGNORECASE):
                sub_queries.append(p_clean)

    queries = [clean_q]
    for sq in sub_queries:
        if sq.lower() not in [q.lower() for q in queries]:
            queries.append(sq)
    return queries

async def query_rag_context_with_sources(question: str, project: str, n_results: int = 40) -> tuple[str, list[dict[str, Any]], str]:
    safe_proj = sanitize_name(project)
    await send_log(f"🔍 Hybridní RAG: Prohledávám materiály pro téma: '{question[:50]}...'")
    from chat_service import retrieve_chat_context

    sub_queries = decompose_question_to_subqueries(question)
    query_to_use = " ".join(sub_queries) if sub_queries else question

    context_text, unique_sources, raw_context = await retrieve_chat_context(
        project_id=safe_proj,
        query=query_to_use,
        n_results=n_results,
        return_raw=True,
    )

    if not raw_context.strip():
        raise ValueError("V materiálech nebyly nalezeny žádné podklady k této otázce.")

    return context_text, unique_sources, raw_context


DEFAULT_PODCAST_PROMPT = """Jsi špičkový profesor vnitřního lékařství a zkušený zkoušející. Tvým úkolem je připravit medika 5. ročníku na náročnou ústní zkoušku z interny. Na základě přiložených studijních materiálů kompletně zpracuj zkouškovou otázku: [NÁZEV OTÁZKY].
Napiš text jako vysoce koncentrovaný, plynulý audiosouhrn určený k HLASITÉMU POSLECHU. Zcela vynech klasickou "podcastovou omáčku" (absolutně žádné "Vítejte", "Dnes se podíváme na...", "Dobrý den" apod.). Text musí být vybalancovaný pro soustředěný poslech, ale maximálně nabitý fakty.
Dodrž tyto striktní instrukce:
1. MAXIMÁLNÍ DÉLKA textu je absolutně omezena na {MAX_CHARS} znaků. Zaměř se striktně na "high-yield" informace a klíčová slova, která musí u zkoušky zaznít.
2. STRUKTURA VÝKLADU: Začni rovnou jedinou údernou větou, která zkoušejícímu okamžitě ukáže, že přesně víš, o čem mluvíš (tzv. otvírák). Následně do plynulého monologu postupně a logicky zakomponuj těchto 10 bodů v přesném pořadí:
 Definice a dělení (také dle různých hledisek)
 Epidemiologie
 Etiologie a rizikové faktory
 Patofyziologie
 Klinický obraz
 Diagnostika
 Diferenciální diagnostika
 Léčba
 Komplikace
 Prognóza a prevence
3. PLYNULOST A ZVUKOVÉ ZÁLOŽKY: Vždy těsně předtím, než začneš mluvit o dalším bodu osnovy, velmi stručně a přirozeně zmíníš jeho název, aby se posluchač mohl rychle zorientovat (např. "K definici tohoto stavu...", "Pokud jde o epidemiologii...", "V rámci klinického obrazu dominují..."). Vyhni se ale robotickému číslování typu "Bod jedna, definice". Přechody musí znít plynule a přirozeně jako výklad na přednášce.
4. RYTMUS A DÉLKA VĚT: Striktně omez délku jednotlivých vět, aby mozek stíhal informace ukládat. Pokud musíš vyjmenovat více než tři symptomy, rizikové faktory nebo léky, rozděl výčet do dvou či více na sebe navazujících vět. Udržíš tím přirozené tempo mluveného slova.
5. ZKRATKY A AKRONYMY: Klinické akronymy a zkratky vždy plynule rozepiš do textu celým slovem (například místo "na EKG" napiš "na elektrokardiogramu", místo "IgG" napiš "imunoglobulin G"), aby je hlasový syntetizátor nepřečetl jako nesmyslný shluk hlásek.
6. ODBORNOST: Mluv výhradně spisovnou, ale přirozenou češtinou. Odborné termíny nevysvětluj polopaticky – mluvíš k budoucímu lékaři. Uváděj je rovnou v přesných klinických souvislostech.
7. ZÁKAZ FORMÁTOVÁNÍ: Nepoužívej ŽÁDNÉ odrážky, seznamy, závorky ani tabulky. Text musí být čistě lineární a syntakticky plynulý, aby ho šlo přečíst bez zadrhávání TTS syntetizátoru.
8. ČISTÝ TEXT: Výsledek nesmí obsahovat žádné režijní poznámky (např. pauza, nadechnutí). Výstupem bude pouze čistý mluvený text připravený pro převod na hlas."""

async def internal_generate_script(question: str, custom_prompt: str, provider: str, project: str, gemini_model: str):
    prompt_to_use = custom_prompt if custom_prompt and custom_prompt.strip() else DEFAULT_PODCAST_PROMPT
    if "[NÁZEV OTÁZKY]" in prompt_to_use:
        prompt_to_use = prompt_to_use.replace("[NÁZEV OTÁZKY]", question)
    if "{QUESTION}" in prompt_to_use:
        prompt_to_use = prompt_to_use.replace("{QUESTION}", question)
    if "{MAX_CHARS}" in prompt_to_use:
        prompt_to_use = prompt_to_use.replace("{MAX_CHARS}", "8000")

    final_prompt = enrich_prompt_for_tts(prompt_to_use, provider)
    context_text, unique_sources, raw_context = await query_rag_context_with_sources(question, project, n_results=30)

    ukazka_textu = raw_context[:150].replace('\n', ' ')
    await send_log(f"📄 NALEZENÝ TEXT (ukázka): {ukazka_textu}...")

    full_user_content = f"ZPRACOVÁVANÁ ZKOUŠKOVÁ OTÁZKA: {question}\n\n=== RELEVANTNÍ VÝTAŽEK ZE SKRIPT ===\n{raw_context}\n=================================="
    await send_log(f"🤖 Kontext nalezen. Odesílám zadání scénáře do {gemini_model} API...")

    script = await call_gemini_with_retries(
        model=gemini_model,
        contents=[full_user_content],
        system_instruction=final_prompt,
        temperature=0.7,
    )
    return script, raw_context

DEFAULT_NOTES_PROMPT = r"""Jsi špičkový profesor vnitřního lékařství a zkušený, náročný, ale spravedlivý zkoušející. Tvým úkolem je připravit medika 5. ročníku na ústní zkoušku z interny. Na základě nahraných studijních materiálů v tomto notebooku vytvoř komplexní, vysoce strukturovaný a fakticky nabitý studijní text k této zkouškové otázce: {QUESTION}.

Dodrž tyto striktní instrukce:
1. CÍLOVKA A ÚROVEŇ ODBORNOSTI: Text je určen pro medika před zkouškou. Vynech základní omáčku a polopatické vysvětlování (žádné opakování bazální anatomie). Zaměř se striktně na "high-yield" informace, klasifikace, diagnostická kritéria, algoritmy léčby a klinická "buzzwords", která musí u zkoušky zaznít.
2. ABSOLUTNÍ ZÁKAZ "WALL OF TEXT": Mozek se učí vizuálně. Vyhni se dlouhým souvislým odstavcům. Text musí být scannovatelný. Piš heslovitě, maximálně využívej odrážky (bullet points) a u klasifikací nebo diferenciální diagnostiky neváhej použít Markdown tabulku, pokud to zvýší přehlednost.
3. ZVÝRAZNĚNÍ: Pomocí tučného písma systematicky zvýrazňuj klíčové pojmy, názvy syndromů, specifická diagnostická kritéria a hlavní skupiny léků.
4. ZKRATKY: Na rozdíl od audio-přehledů zde běžné klinické zkratky (EKG, CT, MR, JIP, ACEi, NYHA, CHSK atd.) NERozepisuj. Text musí být úderný a odpovídat běžnému lékařskému zápisu.
5. VÍCEJAZYČNOST A TERMINOLOGIE: Nahrané materiály mohou být v různých jazycích (např. anglické mezinárodní guidelines, české učebnice a skripta). Informace přirozeně integruj a sjednoť do přesné a standardní české lékařské terminologie.
6. ZDROJOVÁNÍ V HORNÍM INDEXU: Využij poskytnuté očíslované úryvky zdrojů označené jako [1], [2] atd. U každého klíčového faktu, kritéria či doporučení uveď referenci na daný zdroj formou horního indexu <sup>[1]</sup> nebo [1].
7. STRUKTURA VÝKLADU: Text musí striktně dodržet následující osnovu. Každý bod bude tvořit samostatnou sekci s nadpisem (použij H2 formátování - ##):
## Otvírák: (Jedna geniální, úderná věta, kterou student zkoušku začne, aby ukázal absolutní přehled.)
## Definice: (Krátká, úderná, přesná.)
## Dělení (základní a také dle různých hledisek)
## Epidemiologie: (Jen klíčová data – věk, pohlaví, incidence.)
## Etiologie a rizikové faktory:
## Patofyziologie: (Stručný a logický mechanismus.)
## Klinický obraz: (Typické příznaky, dělení, manifestace.)
## Diagnostika: (Laboratoř, zobrazovací metody, zlatý standard, diagnostická kritéria.)
## Diferenciální diagnostika: (Nejdůležitější jednotky a stručný klíč, jak je odlišit.)
## Léčba: (Konzervativní, farmakologická s konkrétními zástupci, intervenční/chirurgická.)
## Komplikace: (Akutní a chronické.)
## Prognóza a prevence:
## Chytáky a "Red Flags": (1-3 typické záludnosti, oblíbené dotazy zkoušejících nebo chyby, na kterých se vyhazuje.)
## Použité zdroje: (Očíslovaný seznam citovaných podkladů s přesnými názvy souborů)
8. ČISTÝ VÝSTUP: Vynech jakékoliv AI fráze typu "Zde je váš text", "Doufám, že to pomáže". Začni rovnou nadpisem první úrovně (# {QUESTION}) a skonči sekcí Použité zdroje. Vycházej primárně a pouze z nahraných zdrojů."""

async def internal_generate_notes(question: str, project: str, custom_prompt: str = "", gemini_model: str = "gemini-3.6-flash"):
    context_text, unique_sources, raw_context = await query_rag_context_with_sources(question, project, n_results=40)

    prompt_template = custom_prompt if custom_prompt and custom_prompt.strip() else DEFAULT_NOTES_PROMPT
    final_prompt = prompt_template.replace("{QUESTION}", question)

    sources_summary = "\n".join([f"[{s['id']}] {s['filename']}" for s in unique_sources])

    full_user_content = (
        f"ZPRACOVÁVANÁ ZKOUŠKOVÁ OTÁZKA: {question}\n\n"
        f"SEZNAM PŘIŘAZENÝCH ZDROJŮ PRO CITACE V TÉTO OTÁZCE:\n{sources_summary}\n\n"
        f"=== RELEVANTNÍ ÚRYVKY Z NAHRANÝCH MATERIÁLŮ (s označením stran a segmentů) ===\n"
        f"{context_text}\n"
        f"===============================================================================\n\n"
        f"INSTRUKCE PRO GENEROVÁNÍ:\n"
        f"- Vypracuj vyčerpávající, přehledný a fakticky nabitý studijní text pro medika 5. ročníku před zkouškou z interny.\n"
        f"- Dodrž striktní strukturu H2 nadpisů dle osnovy v systémovém promptu.\n"
        f"- Piš heslovitě s odrážkami, zvýrazňuj tučným písmem klíčové pojmy a léky, klinické zkratky nerozepisuj.\n"
        f"- U diferenciální diagnostiky nebo klasifikací použij přehlednou Markdown tabulku.\n"
        f"- U každého klíčového faktu uveď citaci zdroje formou horního indexu <sup>[1]</sup> nebo [1]."
    )

    await send_log(f"📝 Odesílám zadání pro vygenerování studijního textu do {gemini_model} (max 16k tokenů, hloubková syntéza)...")
    notes_markdown = await call_gemini_with_retries(
        model=gemini_model,
        contents=[full_user_content],
        system_instruction=final_prompt,
        temperature=0.25,
        max_output_tokens=16384,
    )

    # Ošetření a normalizace formátování tabulek před uložením na disk
    notes_markdown = sanitize_markdown_tables(notes_markdown)

    safe_title = sanitize_name(question[:40])
    safe_proj = sanitize_name(project)
    notes_filename = f"{safe_proj}_{safe_title}.md"
    file_path = os.path.join(NOTES_DIR, notes_filename)

    meta_header = (
        f"<!-- METADATA\n"
        f"{json.dumps({'project': project, 'question': question, 'sources': unique_sources}, ensure_ascii=False)}\n"
        f"-->\n\n"
    )

    with open(file_path, "w", encoding="utf-8") as f:
        f.write(meta_header + notes_markdown)

    await send_log(f"✅ Studijní text úspěšně uložen do souboru {notes_filename}.")
    return notes_markdown, unique_sources, notes_filename

DEFAULT_FLASHCARDS_PROMPT = """Jsi špičkový profesor medicíny a expert na efektivní učení (spaced repetition). Tvým úkolem je na základě přiložených studijních materiálů vytvořit sérii přesně {COUNT} vysoce efektivních studijních kartiček (flashcards) pro Anki a Quizlet k této zkouškové otázce: {QUESTION}.

STRIKTNÍ PRAVIDLA PRO KARTIČKY:
1. CÍLOVÁ SKUPINA: Medik 5. ročníku před zkouškou z interny. Žádné triviální obecnosti. Kartičky musí testovat rozhodující diagnostická kritéria, léky první volby, patognomické nálezy, laboratorní odchylky, skórovací schémata a nebezpečné omyly (Red Flags).
2. FORMÁT KARTIČKY (Front & Back):
   - Líc (front): Přesná, jednoznačně položená klinická otázka, např. "Jaká je triáda příznaků u X?", "Lék 1. volby u těžké exacerbace Y?", "Jaká jsou diagnostická kritéria Z?".
   - Rub (back): Stručná, úderná a přesná odpověď. Používej odrážky, tučné zvýraznění klíčových léků/dávek a běžné klinické zkratky.
3. PŘESNÉ CITACE A ODKAZY NA STRÁNKU (STANDARD NOTEBOOKLM):
   Každá kartička MUSÍ být přesně ozdrojována z přiložených podkladů. V hlavičkách segmentů vidíš formát: '--- [ZDROJ X: soubor.pdf | Strana Y | Segment Z] ---'.
   Ve výstupu do pole "source_file" uveď přesný název souboru (např. 'Klener_Vnitrni_lekarstvi.pdf'), do "source_page" uveď číslo strany (např. '45' nebo '45–47') a do "source_quote" uveď krátkou doslovnou větu/údaj z textu. Do "source_ref" uveď souhrnnou citaci [X, s. Y].
4. DIVERZITA TYPŮ OTÁZEK:
   - Diagnostika & kritéria (např. Wells skóre, CURB-65, kritéria revmatoidní artritidy).
   - Terapie (iniciální management, lék volby, kontraindikace).
   - Diferenciální diagnostika (jak spolehlivě odlišit dvě podobné jednotky).
   - Red Flags a záludnosti zkoušejících.
5. UNIKÁTNOST OTÁZEK: Každá kartička musí mít ZCELA UNIKÁTNÍ otázku (lícovou stranu). Žádná otázka se nesmí opakovat, parafrázovat ani ptát na tutéž informaci. Každá kartička testuje odlišný specifický fakt, diferenciální kritérium, dávkování či komplikaci.
6. JAZYK A ZDROJE: Materiály mohou být v cizím jazyce (např. anglické guidelines). Kartičky formuluj v profesionální české lékařské terminologii. Vycházej z přiložených očíslovaných zdrojů.
7. FORMÁT VÝSTUPU:
   Vrať VÝHRADNĚ platný JSON formát bez jakéhokoliv doplňkového textu, vysvětlování či obalového markdownu (žádné ```json na začátku ani na konci).
   Výstupem musí být JSON pole objektů přesně v této struktuře:
   [
     {
       "id": 1,
       "front": "Otázka na lícové straně",
       "back": "Stručná odpověď s odrážkami či zvýrazněním",
       "source_file": "presny_nazev_souboru.pdf",
       "source_page": "45",
       "source_quote": "Doslovný fragment textu nebo kritérium",
       "source_ref": "[1, s. 45]"
     }
   ]"""

ADVANCED_ANKI_FLASHCARDS_PROMPT = """Jsi špičkový profesor medicíny, pedagog a mezinárodní expert na spaced repetition (Anki) podle metodických standardů Sorbonne Université, referenčního rámce francouzského Collège a Oleho Anki-konvence (Anki-Konvention).
Tvým úkolem je na základě přiložených studijních materiálů vytvořit sérii přesně {COUNT} vysoce pokročilých, atomických a kognitivně provázaných studijních kartiček k tématu/otázce: {QUESTION}.

ZÁVAZNÁ PRAVIDLA PRO POKROČILÉ ANKI KARTIČKY:

1. KOGNITIVNÍ ZÁKLAD – POROZUMĚNÍ PŘED MEMOROVÁNÍM (Pravidlo 21):
   Karty striktně děl do tří didaktických kategorií:
   a) ODVODITELNÁ KARTA (logique): Kde jeden mechanismus nese celou odpověď, PRINCIP JE HLAVNÍ VĚC a fakta jsou jeho přímým důsledkem.
      - Odpověď začíná principem: <b>Le principe</b> : ... (nebo česky <b>Princip</b> : ...).
      - Následují fakta jako logické důsledky principu (např. časové prahy, patofyziologický řetězec).
      - Dodatečné kauzální zdůvodnění patří do tlumeného řádku: <i>Pourquoi : …</i>
      - Nápověda na líci v závorce formuluje VÝCHOZÍ OTÁZKU/ÚVAHU, ze které odpověď plyne (např. "(3 composantes · 1 distinction — l'action est-elle planifiée ?)"). Nápověda jmenuje otázku k zamyšlení, NIKDY samotnou odpověď!
   b) NAPŮL ODVODITELNÁ KARTA: Pravidlo + výjimky. Pravidlo patří na kartu jako hlavní sdělení, výjimka je zřetelně označena (<i>Výjimka : ...</i> nebo <i>À l'inverse : ...</i>).
   c) ČISTÁ FAKTA: Kde žádný mechanismus není, nic se nevymýšlí (dávkování léků, zákonné lhůty, mezinárodní názvy DCI, diagnostické prahy skóre).
   ⚠️ PŘÍSNÝ ZÁKAZ VYMYŠLENÝCH MECHANISMŮ: Kde podklad kauzální vysvětlení nedává, karta zůstává striktně faktovou. Věrohodně znějící, ale nepodložené odvození se v testech a zkouškách stává systematickou chybou!

2. ANATOMIE KARTY:
   - LÍC (front):
     Vždy začíná čipem důležitosti: [Rang A] (základní povinné jádro zkoušky) nebo [Rang B] (prohlubující/specializační).
     Následuje přesná otázka.
     Otázka končí NÁPOVĚDOU V ZÁVORCE: např. <br><small style='color:#a8a29e;'><i>(Nápověda...)</i></small>.
   - RUB (back):
     Začíná principem (u odvoditelných).
     Obsahuje maximálně 1–3 hlavní body s tučně zvýrazněnými klíčovými pojmy, léky a čísly (<b>...</b>).
     Tlumené vedlejší řádky pro kontext (kurzívou):
       • <i>Pourquoi : …</i> (kauzální zdůvodnění ze zdroje)
       • <i>Aussi : …</i> (doplňující fakta pro úplnost, která se nemají aktivně zkoušet)
       • <i>Piège : …</i> (klinický chyták, diagnostická past, častá záměna, rozpor mezi zdroji)
       • <i>À l'inverse : …</i> (opačný pól, zrcadlový kontrast)
     Zakončeno sbaleným blokem ČESKÉ VRSTVY (<details>...</details>).

3. NÁPOVĚDA V ZÁVORCE (INDICE - Pravidlo 6, 7):
   - Nápověda POČÍTÁ a JMENUJE PŘIHRÁDKY/KATEGORIE, NIKDY samotné prvky!
     Např.: (4 catégories : iatrogénie · métabolique et endocrinien · neurologique · causes mécaniques) — ptá se, co do nich patří.
     U tabulky/srovnání: (tableau confusion ↔ démence · 4 lignes : installation, vigilance, réversibilité, signes).
   - VÝJIMKA: Pokud jsou samotné kategorie zkoušeným učivem (např. 8 sémiologických domén, 3 clustery osobnosti, 4 mechanismy), nápověda zůstává čistě početní: (3 clusters), aby neprozradila odpověď na líci!
   - Žádné vágní výrazy („stačí pár příkladů“, „a zbytek“). Příklady jmenované v nápovědě se v odpovědi zafixují a nezkracují.
   - Délka nápovědy: medián kolem 50 znaků, nikdy přes 100 znaků.

4. ATOMICITA A ROZSAH (Pravidla 1, 2, 11, 12, 14):
   - Nejvýše 1–3 hlavní body na kartu! Raději 1–3 body s naprostou jistotou než 5–8 bodů povrchně.
   - Kontrast místo paralelních karet (Pravidlo 12): Dva případy lišící se jedním parametrem či číslem se učí společně v kontrastu — srovnání je vlastní lekcí!
   - Otázka a odpověď míří stejným směrem (Pravidlo 1).
   - Příslovce zdroje se striktně přenášejí (Pravidlo 2): « n'entraîne jamais », « n'excède habituellement pas », « n'est pas systématique » (nikdy nevede k..., obvykle nepřekračuje..., není systematické) — zkouškové testy (EDN/QCM) stojí přesně na těchto nuancích!
   - Čísla jen tehdy, když nesou klinické rozhodnutí (Pravidlo 11): věk, lhůta, práh skóre, dávka. Běžnou incidenci a prevalenci netestovat v jádru otázky.

5. PŘEHLEDOVÉ SYNTETICKÉ KARTY (SYNTHÈSE - Pravidlo 18):
   Do sady přirozeně zařaď i typy přehledových karet (cca 1–2 karty na 10 položek):
   - Dělicí otázka: jedna otázka, na které se spolehlivě rozcházejí dvě diagnózy (např. „Mizí psychotické příznaky spolu s odezněním epizody nálady?“).
   - Srovnávací tabulka: 3–5 entit × 3–4 znaky.
   - Pojmový žebřík: stupně kontinua ve správném logickém a chronologickém pořadí (např. idée délirante → syndrome délirant → délire aigu → trouble délirant persistant).
   - Falešný přítel (faux-ami): termíny, které v češtině/laicky znamenají něco jiného (např. délire = blud, nikoli delirium; delirium = confusion mentale).

6. JAZYKOVÉ PRAVIDLO A ČESKÁ VRSTVA (Pravidla 22, 25, 26):
   - Pokud jsou podkladové materiály v cizím jazyce (např. francouzské Collège pro zkoušky EDN), otázka, nápověda i odpověď jsou v jazyce originálu pro nácvik zkouškových formulací. Pokud jsou podklady v češtině, jazykem je profesionální česká medicínská terminologie.
   - Každá karta MUSÍ mít na rubu sbalený blok ČESKÉ VRSTVY pro hluboké porozumění:
     <details style='margin-top:10px; padding:6px 10px; border-left:3px solid #3d7cc9; background:rgba(61,124,201,0.08); font-size:0.92em; border-radius:4px;'>
       <summary style='cursor:pointer; color:#38bdf8; font-weight:600;'>🇨🇿 Česky — překlad a pojmy</summary>
       <div style='margin-top:6px;'>
         <div><strong>Otázka:</strong> [Český překlad otázky a nápovědy, 1–2 věty]</div>
         <div style='margin-top:4px;'><strong>Odpověď:</strong> [Český překlad principu a hlavních bodů; vedlejší řádky jen stručně]</div>
         <div style='margin-top:6px; font-size:0.9em; border-top:1px dashed rgba(255,255,255,0.15); padding-top:4px;'>
           <strong>Pojmy (MKN-10 / Glosář):</strong><br>
           • <em>odborný termín</em>: české vysvětlení a oficiální český ekvivalent (MKN-10 / DSM-5); ⚠️ upozornění na falešné přátele a reálie.
         </div>
       </div>
     </details>
   - Česká vrstva POUZE překládá a vysvětluje to, co je na kartě – NEPŘIDÁVÁ žádná nová fakta, která nejsou v originálním jádru karty!

7. PŘESNÉ CITACE (NOTEBOOKLM STANDARD):
   Každá kartička musí obsahovat přesnou citaci z přiložených podkladů:
   "source_file": přesný název souboru (např. 'College_Psychiatrie_4e.pdf'),
   "source_page": číslo strany (např. '29' nebo '141–145'),
   "source_quote": doslovná citace ze zdroje,
   "source_ref": souhrnná reference [soubor, s. XY].

8. FORMÁT VÝSTUPU:
   Vrať VÝHRADNĚ platný JSON formát bez jakéhokoliv doplňkového textu či markdown obalu (žádné ```json na začátku ani na konci).
   JSON pole objektů:
   [
     {
       "id": 1,
       "front": "[Rang A] Qu'est-ce que l'athymhormie, et en quoi l'aboulie diffère-t-elle de l'apragmatisme ?<br><small style='color:#a8a29e;'><i>(2 composantes · 1 distinction — l'action est-elle planifiée ?)</i></small>",
       "back": "<b>Le principe</b> : athymhormie = <b>athymie</b> + <b>aboulie</b><br>• <b>Aboulie</b> : difficulté à <b>initier</b> une action <b>pourtant planifiée</b><br>• <b>Apragmatisme</b> : difficulté à initier une action <b>par défaut de planification</b><br><br><small><i>Pourquoi : Déficit de l'élan vital et de la motivation globale.</i></small><br><br><details style='margin-top:10px; padding:6px 10px; border-left:3px solid #3d7cc9; background:rgba(61,124,201,0.08); font-size:0.92em; border-radius:4px;'><summary style='cursor:pointer; color:#38bdf8; font-weight:600;'>🇨🇿 Česky — překlad a pojmy</summary><div style='margin-top:6px;'><div><strong>Otázka:</strong> Co je athymhormie a čím se liší abulie od apragmatismu? (2 složky · 1 rozlišení — je akce naplánovaná?)</div><div style='margin-top:4px;'><strong>Odpověď:</strong> Princip: athymhormie = vymizení nálady (athymie) + abulie. Abulie: akce je naplánovaná, ale nedaří se ji spustit. Apragmatismus: akce se nespustí, protože chybí plán.</div><div style='margin-top:6px; font-size:0.9em; border-top:1px dashed rgba(255,255,255,0.15); padding-top:4px;'><strong>Pojmy:</strong><br>• <em>athymie</em>: vymizení nálady jako takové — ne smutek, ale nepřítomnost afektivního tónu.<br>• <em>aboulie</em>: porucha vůle a motivace (v češtině abulie).<br>• <em>apragmatisme</em>: porucha plánování a organizace činností.</div></div></details>",
       "rang": "A",
       "hint": "2 composantes · 1 distinction — l'action est-elle planifiée ?",
       "card_type": "logique",
       "source_file": "College_Psychiatrie.pdf",
       "source_page": "29",
       "source_quote": "L'athymhormie associe athymie et aboulie...",
       "source_ref": "[College_Psychiatrie.pdf, s. 29]"
     }
   ]"""

FLASHCARDS_PROMPTS = {
    "standard": DEFAULT_FLASHCARDS_PROMPT,
    "advanced": ADVANCED_ANKI_FLASHCARDS_PROMPT,
}

def clean_and_parse_json(raw_text: str) -> list[dict[str, Any]]:
    cleaned = raw_text.strip()
    # Odstranění markdown bloků ```json ... ```
    if "```" in cleaned:
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()

    # 1. Přímé načtení přes standardní json.loads
    try:
        data = json.loads(cleaned, strict=False)
        if isinstance(data, list) and len(data) > 0:
            return data
        if isinstance(data, dict) and "cards" in data and isinstance(data["cards"], list):
            return data["cards"]
    except Exception:
        pass

    # 2. Regex nalezení pole [ ... ] s odstraněním trailing commas
    match = re.search(r"\[\s*\{.*\}\s*\]", cleaned, re.DOTALL)
    if match:
        try:
            sanitized = re.sub(r",\s*([\]\}])", r"\1", match.group(0))
            data = json.loads(sanitized, strict=False)
            if isinstance(data, list) and len(data) > 0:
                return data
        except Exception:
            pass

    # 3. Záchranný parser: extrakce všech dokončených objektů kartiček i při useknutém výstupu
    cards = []
    card_pattern = re.compile(
        r'\{\s*"(?:id|front)"[\s\S]*?"back"\s*:\s*"(?:[^"\\]|\\.)*"[\s\S]*?\}',
        re.DOTALL
    )
    for m in card_pattern.finditer(cleaned):
        block = m.group(0)
        try:
            block_clean = re.sub(r",\s*\}", "}", block)
            obj = json.loads(block_clean, strict=False)
            if "front" in obj and "back" in obj:
                cards.append(obj)
        except Exception:
            f_match = re.search(r'"front"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            b_match = re.search(r'"back"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            s_match = re.search(r'"source_ref"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            sf_match = re.search(r'"source_file"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            sp_match = re.search(r'"source_page"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            sq_match = re.search(r'"source_quote"\s*:\s*"((?:[^"\\]|\\.)*)"', block)
            if f_match and b_match:
                cards.append({
                    "id": len(cards) + 1,
                    "front": f_match.group(1),
                    "back": b_match.group(1),
                    "source_ref": s_match.group(1) if s_match else "",
                    "source_file": sf_match.group(1) if sf_match else "",
                    "source_page": sp_match.group(1) if sp_match else "",
                    "source_quote": sq_match.group(1) if sq_match else "",
                })

    if cards:
        return cards

    raise ValueError("Model nevrátil platný JSON formát pro kartičky. Zkuste generování opakovat.")

def normalize_front(text: str) -> str:
    return re.sub(r"[^\w\s]", "", str(text or "")).strip().lower()

def resolve_card_source(card: dict[str, Any], sources_list: list[dict[str, Any]] = None, project: str = "") -> dict[str, Any]:
    """
    Zajistí, že kartička má doplněné source_file, source_page a čistý odkaz pro zobrazení i Anki export.
    Funguje plně zpětně kompatibilně i pro starší formáty (pouze source_ref: '[1]' nebo '[1, s. 45]').
    """
    source_file = str(card.get("source_file") or "").strip()
    source_page = str(card.get("source_page") or card.get("page") or "").strip()
    source_ref = str(card.get("source_ref") or "").strip()
    source_quote = str(card.get("source_quote") or "").strip()

    # Mapa zdrojů podle ID a názvu
    id_to_file: dict[str, str] = {}
    if sources_list:
        for s in sources_list:
            if isinstance(s, dict):
                sid = str(s.get("id", ""))
                fname = str(s.get("filename", ""))
                if sid and fname:
                    id_to_file[sid] = fname

    # Pokud chybí source_file, zkusíme extrahovat ze source_ref
    if not source_file and source_ref:
        m_page = re.search(r"\[(?:Zdroj\s*)?(\d+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]", source_ref, re.IGNORECASE)
        if m_page:
            sid = m_page.group(1)
            if not source_page and m_page.group(2):
                source_page = m_page.group(2).strip()
            if sid in id_to_file:
                source_file = id_to_file[sid]
        else:
            m_direct = re.search(r"\[Zdroj:\s*([^,\]]+)(?:,\s*s(?:tr)?\.?\s*([^\]]+))?\]", source_ref, re.IGNORECASE)
            if m_direct:
                source_file = m_direct.group(1).strip()
                if not source_page and m_direct.group(2):
                    source_page = m_direct.group(2).strip()

    # Pokud máme source_file jako číslo zdroje (např. "1" nebo "[1]"), vyhledáme v mapě
    clean_sf_num = re.sub(r"[^\d]", "", source_file)
    if clean_sf_num and clean_sf_num in id_to_file and not source_file.lower().endswith((".pdf", ".docx", ".pptx", ".txt")):
        source_file = id_to_file[clean_sf_num]

    # Pokud stále nemáme source_page, ale je v source_ref:
    if not source_page and source_ref:
        m_p = re.search(r"s(?:tr)?\.?\s*([0-9]+(?:\s*[-–]\s*[0-9]+)?)", source_ref, re.IGNORECASE)
        if m_p:
            source_page = m_p.group(1).strip()

    # Pokud stále nemáme source_file, ale máme alespoň 1 unikátní zdroj v seznamu
    if not source_file and sources_list and len(sources_list) == 1 and isinstance(sources_list[0], dict):
        source_file = sources_list[0].get("filename", "")

    # Číslo první stránky pro #page=X
    clean_page_num = ""
    if source_page:
        m_digits = re.search(r"\d+", source_page)
        if m_digits:
            clean_page_num = m_digits.group(0)

    if source_file:
        card["source_file"] = source_file
    if source_page:
        card["source_page"] = source_page
    if source_quote:
        card["source_quote"] = source_quote

    safe_proj = sanitize_name(project) if project else ""
    view_url = ""
    if source_file and safe_proj:
        view_url = f"/uploads/{safe_proj}/{source_file}"
        if clean_page_num:
            view_url += f"#page={clean_page_num}"

    card["view_url"] = view_url
    card["clean_page"] = clean_page_num
    return card

def build_anki_tsv(cards: list[dict[str, Any]], project: str, question: str, sources_list: list[dict[str, Any]] = None) -> str:
    lines = [
        "#separator:tab",
        "#html:true",
        f"#tags:interna zkouška {sanitize_name(project)}",
    ]
    safe_proj = sanitize_name(project)
    for c in cards:
        resolved = resolve_card_source(c, sources_list or [], safe_proj)
        front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", "<br>")
        back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", "<br>")
        
        # Podpora pro Rang v hlavičce, pokud ještě není ve front
        rang = str(resolved.get("rang", "")).strip()
        if rang and f"[Rang {rang}]" not in front:
            front = f"[Rang {rang}] " + front

        # Podpora pro nápovědu v závorce, pokud ještě není ve front
        hint = str(resolved.get("hint", "")).strip()
        if hint and hint not in front and f"({hint})" not in front:
            front += f"<br><small style='color:#a8a29e;'><i>({hint})</i></small>"

        # Podpora pro českou vrstvu (cz), pokud ještě není vložena v back
        cz_data = resolved.get("cz")
        if cz_data and "<details" not in back:
            if isinstance(cz_data, dict):
                cz_q = cz_data.get("q", "")
                cz_a = cz_data.get("a", "")
                cz_pojmy = cz_data.get("pojmy", [])
                pojmy_html = ""
                if cz_pojmy and isinstance(cz_pojmy, list):
                    items = []
                    for p in cz_pojmy:
                        if isinstance(p, (list, tuple)) and len(p) >= 2:
                            items.append(f"• <em>{p[0]}</em>: {p[1]}")
                        elif isinstance(p, dict):
                            term = p.get("term") or p.get("pojem") or ""
                            expl = p.get("expl") or p.get("vyznam") or p.get("popis") or ""
                            items.append(f"• <em>{term}</em>: {expl}")
                        elif isinstance(p, str):
                            items.append(f"• {p}")
                    if items:
                        pojmy_html = f"<div style='margin-top:6px; font-size:0.9em; border-top:1px dashed rgba(255,255,255,0.15); padding-top:4px;'><strong>Pojmy (MKN-10 / Glosář):</strong><br>{'<br>'.join(items)}</div>"

                cz_block = (
                    f"<br><br><details class='cz' style='margin-top:10px; padding:6px 10px; border-left:3px solid #3d7cc9; background:rgba(61,124,201,0.08); font-size:0.92em; border-radius:4px; text-align:left;'>"
                    f"<summary style='cursor:pointer; color:#38bdf8; font-weight:600;'>🇨🇿 Česky — překlad a pojmy</summary>"
                    f"<div style='margin-top:6px;'>"
                    f"<div><strong>Otázka:</strong> {cz_q}</div>"
                    f"<div style='margin-top:4px;'><strong>Odpověď:</strong> {cz_a}</div>"
                    f"{pojmy_html}"
                    f"</div></details>"
                )
                back += cz_block

        src_file = resolved.get("source_file", "")
        src_page = resolved.get("source_page", "")
        src_ref = resolved.get("source_ref", "")
        clean_page = resolved.get("clean_page", "")

        citation_html = ""
        if src_file:
            page_text = f" (s. {src_page})" if src_page else ""
            hash_page = f"#page={clean_page}" if clean_page else ""
            file_url = f"http://localhost:8000/uploads/{safe_proj}/{src_file}{hash_page}"
            citation_html = f"<br><br><small style='color:#0284c7; font-size: 11px;'>📖 <a href='{file_url}' target='_blank' style='color:#0284c7; text-decoration: underline;'>{src_file}{page_text}</a></small>"
        elif src_ref:
            citation_html = f" <small style='color:gray;'>{src_ref}</small>"

        back += citation_html
        lines.append(f"{front}\t{back}")
    return "\n".join(lines)

def build_quizlet_text(cards: list[dict[str, Any]], sources_list: list[dict[str, Any]] = None) -> str:
    lines = []
    for c in cards:
        resolved = resolve_card_source(c, sources_list or [])
        front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", " ")
        back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", " ")
        src_file = resolved.get("source_file", "")
        src_page = resolved.get("source_page", "")
        src_ref = resolved.get("source_ref", "")
        if src_file:
            page_text = f", s. {src_page}" if src_page else ""
            back += f" [📖 {src_file}{page_text}]"
        elif src_ref:
            back += f" {src_ref}"
        lines.append(f"{front}\t{back}")
    return "\n".join(lines)

async def internal_generate_flashcards(
    question: str,
    project: str,
    count: int = 10,
    custom_prompt: str = "",
    gemini_model: str = "gemini-3.6-flash",
    force_regenerate: bool = False,
):
    target_count = max(1, min(int(count), 500))
    safe_title = sanitize_name(question[:40])
    safe_proj = sanitize_name(project)
    flashcards_filename = f"{safe_proj}_{safe_title}.json"
    file_path = os.path.join(FLASHCARDS_DIR, flashcards_filename)

    existing_data = None
    if not force_regenerate:
        # 1. Zkusíme přímý název souboru
        if os.path.exists(file_path):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    existing_data = json.load(f)
            except Exception:
                existing_data = None

        # 2. Fallback: Vyhledání souboru v projektu podle shodného znění otázky
        if not existing_data and os.path.exists(FLASHCARDS_DIR):
            try:
                norm_q = question.strip().lower()
                for fname in os.listdir(FLASHCARDS_DIR):
                    if fname.startswith(f"{safe_proj}_") and fname.endswith(".json"):
                        fpath = os.path.join(FLASHCARDS_DIR, fname)
                        try:
                            with open(fpath, "r", encoding="utf-8") as f:
                                cand = json.load(f)
                                if str(cand.get("question", "")).strip().lower() == norm_q:
                                    existing_data = cand
                                    file_path = fpath
                                    flashcards_filename = fname
                                    break
                        except Exception:
                            continue
            except Exception:
                pass

    existing_cards = []
    existing_count = 0
    if existing_data and isinstance(existing_data.get("cards"), list):
        existing_cards = existing_data["cards"]
        existing_count = len(existing_cards)

    # Tolerance pro "přibližně stejný počet kartiček":
    # 15% nebo alespoň 3 kartičky (např. u 20 je 17-20 v pořádku, u 50 je 43-50 v pořádku)
    tolerance = max(3, int(target_count * 0.15))

    # Pokud již máme dostatečný počet kartiček, přeskočíme a negenerujeme znovu
    if not force_regenerate and existing_count >= (target_count - tolerance):
        await send_log(
            f"⏩ Otázka '{question[:35]}' již má {existing_count} hotových kartiček "
            f"(požadováno: {target_count}). Přeskakuji generování."
        )
        return existing_data, flashcards_filename

    # Pokud máme hotové kartičky, ale je jich málo oproti požadovanému množství,
    # zachováme existující a budeme pouze dogenerovávat chybějící bez duplicit
    if not force_regenerate and existing_count > 0:
        missing_count = target_count - existing_count
        await send_log(
            f"🔄 Otázka '{question[:35]}' již má {existing_count} kartiček, ale cíl je {target_count}. "
            f"Dogeneruji zbývajících {missing_count} kartiček bez duplicit..."
        )
        all_cards = list(existing_cards)
        seen_fronts = set()
        for c in existing_cards:
            k = normalize_front(c.get("front", ""))
            if k:
                seen_fronts.add(k)
    else:
        all_cards = []
        seen_fronts = set()

    context_text, unique_sources, raw_context = await query_rag_context_with_sources(question, project, n_results=25)

    prompt_template = DEFAULT_FLASHCARDS_PROMPT
    if custom_prompt and custom_prompt.strip():
        cp_clean = custom_prompt.strip()
        cp_lower = cp_clean.lower()
        if cp_lower in ["advanced", "advanced_anki", "pokrocile_anki", "pokročilé anki", "pokročilé anki kartičky"]:
            prompt_template = ADVANCED_ANKI_FLASHCARDS_PROMPT
        elif cp_lower in ["standard", "default"]:
            prompt_template = DEFAULT_FLASHCARDS_PROMPT
        else:
            prompt_template = cp_clean
    sources_summary = "\n".join([f"[{s['id']}] {s['filename']}" for s in unique_sources])

    full_user_content = (
        f"ZKOUŠKOVÁ OTÁZKA: {question}\n\n"
        f"SEZNAM PŘIŘAZENÝCH ZDROJŮ PRO CITACE:\n{sources_summary}\n\n"
        f"=== ÚRYVKY Z MATERIÁLŮ ===\n"
        f"{context_text}\n"
        f"=========================="
    )

    remaining_needed = target_count - len(all_cards)

    # Pokud začínáme od nuly a cíl je malý (<= 35), stačí 1 rychlý prompt
    if len(all_cards) == 0 and remaining_needed <= 35:
        final_prompt = prompt_template.replace("{QUESTION}", question).replace("{COUNT}", str(target_count))
        final_prompt += (
            f"\n\n[STRIKTNÍ POŽADAVEK NA UNIKÁTNOST]: Vytvoř přesně {target_count} zcela unikátních kartiček. "
            "Každá otázka na lícové straně se musí ptát na jiný klinický fakt bez jakýchkoliv duplicit a parafrází."
        )
        await send_log(f"🗂️ Generuji {target_count} unikátních Anki/Quizlet kartiček k otázce: '{question}' přes {gemini_model}...")
        raw_response = await call_gemini_with_retries(
            model=gemini_model,
            contents=[full_user_content],
            system_instruction=final_prompt,
            temperature=0.3,
            max_output_tokens=8192,
            response_mime_type="application/json",
        )
        parsed = clean_and_parse_json(raw_response)
        for c in parsed:
            key = normalize_front(c.get("front", ""))
            if key and key not in seen_fronts:
                seen_fronts.add(key)
                all_cards.append(c)
            elif not key:
                all_cards.append(c)

    # Pokud stále zbývá dogenerovat (buď cíl > 35, nebo dogenerováváme stávající sadu, nebo 1. prompt nevrátil dostatek)
    if len(all_cards) < target_count:
        domains = [
            "Klíčová diagnostická kritéria, klasifikace, skórovací schémata a patognomické znaky",
            "Léčebné algoritmy, léky první volby, farmakoterapie a akutní management",
            "Diferenciální diagnostika, odlišení podobných klinických jednotek a atypické prezentace",
            "Akutní a chronické komplikace, závažné lékové interakce a kontraindikace",
            "Oblíbené chytáky zkoušejících, nejčastější chyby u zkoušky a klinické Red Flags",
            "Etiologie, patofyziologické mechanismy a rizikové faktory",
            "Interpretace laboratorních nálezů, biochemie, EKG a zobrazovacích metod",
            "Prognóza, dlouhodobé sledování, dispenzarizace a prevence",
        ]

        sub_batch_size = 25
        needed = target_count - len(all_cards)
        num_batches = (needed + sub_batch_size - 1) // sub_batch_size
        max_rounds = num_batches + 4
        await send_log(f"🗂️ Cíl {target_count} kartiček (zbývá dogenerovat {needed} ks): generuji v tematických sériích bez duplicit...")

        round_idx = 0
        while len(all_cards) < target_count and round_idx < max_rounds:
            remaining = target_count - len(all_cards)
            current_b_count = min(sub_batch_size, remaining)
            domain_focus = domains[round_idx % len(domains)]
            round_idx += 1

            await send_log(f"▶️ Série {round_idx} (cíl: +{current_b_count} ks, celkem unikátních: {len(all_cards)}/{target_count}) – oblast: {domain_focus[:45]}...")

            sub_prompt = prompt_template.replace("{QUESTION}", question).replace("{COUNT}", str(current_b_count))
            sub_prompt += f"\n\n[SPECIFICKÉ ZAMĚŘENÍ TÉTO SÉRIE]: Zaměř se specificky a do hloubky na tuto klinickou oblast: {domain_focus}."
            
            # Předání předchozích otázek pro eliminaci duplicit
            if all_cards:
                prev_sample = [f'- "{c.get("front", "").strip()}"' for c in all_cards[-35:]]
                sub_prompt += (
                    f"\n\n[STRIKTNÍ ZÁKAZ DUPLICIT]: V této sadě již existuje následujících {len(all_cards)} otázek. "
                    f"JE PŘÍSNĚ ZAKÁZÁNO je opakovat nebo se ptát na stejné detaily:\n"
                    + "\n".join(prev_sample)
                )

            try:
                raw_response = await call_gemini_with_retries(
                    model=gemini_model,
                    contents=[full_user_content],
                    system_instruction=sub_prompt,
                    temperature=0.35,
                    max_output_tokens=8192,
                    response_mime_type="application/json",
                )
                batch_cards = clean_and_parse_json(raw_response)
                for c in batch_cards:
                    key = normalize_front(c.get("front", ""))
                    if key and key not in seen_fronts:
                        seen_fronts.add(key)
                        all_cards.append(c)
                        if len(all_cards) >= target_count:
                            break
            except Exception as sub_err:
                await send_log(f"⚠️ Chyba v sérii {round_idx}: {str(sub_err)}. Pokračuji...")

    all_cards = all_cards[:target_count]

    # Přečíslování ID kartiček
    for i, card in enumerate(all_cards):
        card["id"] = i + 1

    if not all_cards:
        raise ValueError("Nepodařilo se vytvořit žádné kartičky. Zkontrolujte spojení nebo opakujte dotaz.")

    # Sloučení zdrojů s dřívějšími
    combined_sources = list(existing_data.get("sources", [])) if (existing_data and isinstance(existing_data.get("sources"), list)) else []
    seen_source_ids = {s.get("id") for s in combined_sources if isinstance(s, dict)}
    for s in unique_sources:
        if isinstance(s, dict) and s.get("id") not in seen_source_ids:
            seen_source_ids.add(s.get("id"))
            combined_sources.append(s)

    active_sources = combined_sources if combined_sources else unique_sources

    # Obohatíme každou kartu o přesné URL a informace o zdroji
    for c in all_cards:
        resolve_card_source(c, active_sources, project)

    anki_tsv = build_anki_tsv(all_cards, project, question, sources_list=active_sources)
    quizlet_text = build_quizlet_text(all_cards, sources_list=active_sources)

    payload = {
        "project": project,
        "question": question,
        "count": len(all_cards),
        "sources": active_sources,
        "cards": all_cards,
        "anki_tsv": anki_tsv,
        "quizlet_text": quizlet_text,
    }

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    if existing_count > 0:
        added = len(all_cards) - existing_count
        await send_log(f"✅ Úspěšně dogenerováno {added} nových kartiček. Celkem uloženo {len(all_cards)} kartiček do {flashcards_filename}.")
    else:
        await send_log(f"✅ Vytvořeno a uloženo celkem {len(all_cards)} kartiček do {flashcards_filename}.")
    return payload, flashcards_filename

async def create_srt_for_audio(script: str, audio_filename: str):
    if MP3 is None:
        await send_log("⚠️ Pro generování .srt titulků chybí knihovna 'mutagen'. (pip install mutagen)")
        return False

    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    if not os.path.exists(audio_path):
        return False

    try:
        await send_log("📝 Generuji .srt titulky...")
        audio_info = MP3(audio_path)
        total_duration = audio_info.info.length
        
        srt_filename = audio_filename.replace('.mp3', '.srt')
        srt_path = os.path.join(AUDIO_DIR, srt_filename)
        
        def format_srt_time(seconds):
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            secs = int(seconds % 60)
            millis = int((seconds - int(seconds)) * 1000)
            return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"
        
        sentences = re.split(r'(?<=[.!?]) +', script)
        total_chars = sum(len(s) for s in sentences if s.strip())
        
        with open(srt_path, 'w', encoding='utf-8') as srt_file:
            current_time = 0.0
            srt_index = 1
            for sentence in sentences:
                clean_sentence = sentence.strip()
                if not clean_sentence: continue
                    
                duration = total_duration * (len(clean_sentence) / total_chars)
                start_time = current_time
                end_time = current_time + duration
                
                srt_file.write(f"{srt_index}\n")
                srt_file.write(f"{format_srt_time(start_time)} --> {format_srt_time(end_time)}\n")
                srt_file.write(f"{clean_sentence}\n\n")
                
                current_time = end_time
                srt_index += 1
                
        return True
    except Exception as e:
        await send_log(f"⚠️ Nelze vytvořit titulky: {str(e)}")
        return False

async def create_mp4_with_subtitles(audio_filename: str, question_title: str):
    if ffmpeg is None:
        await send_log("⚠️ Chybí knihovna 'ffmpeg-python'. Video nebude vytvořeno.")
        return False

    base_name = audio_filename.replace(".mp3", "")
    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    srt_path = os.path.join(AUDIO_DIR, f"{base_name}.srt")
    video_path = os.path.join(AUDIO_DIR, f"{base_name}.mp4")
    title_txt_path = os.path.join(AUDIO_DIR, f"{base_name}_title.txt")
    
    with open(title_txt_path, "w", encoding="utf-8") as f:
        f.write(question_title)
    
    await send_log("🎬 FFmpeg: Vytvářím MP4 video s titulky...")
    try:
        srt_path_esc = srt_path.replace("\\", "/")
        title_txt_path_esc = title_txt_path.replace("\\", "/")
        
        vf_filter = (
            "color=c=#0f172a:s=1280x720[bg];"
            f"[bg]drawtext=textfile='{title_txt_path_esc}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2-120:text_align=C[with_text];"
            f"[with_text]subtitles='{srt_path_esc}':force_style='FontSize=26,PrimaryColour=&H00FFFFFF'"
        )

        (
            ffmpeg
            .input(audio_path)
            .output(video_path, 
                    vcodec='libx264', 
                    acodec='aac', 
                    shortest=None,
                    vf=vf_filter)
            .overwrite_output()
            .run(quiet=True)
        )
        
        if os.path.exists(title_txt_path):
            os.remove(title_txt_path)
            
        await send_log(f"✅ Video uloženo jako {base_name}.mp4")
        return True
    except Exception as e:
        await send_log(f"⚠️ Selhalo vytváření videa. Chyba: {str(e)}")
        return False

async def internal_generate_audio(script: str, filename: str, provider: str, voice: str, output_format: str, question_title: str):
    safe_title = "".join([c for c in filename if c.isalnum() or c in (' ', '_', '-')]).strip().replace(" ", "_")
    audio_filename = f"{safe_title}.mp3"
    audio_path = os.path.join(AUDIO_DIR, audio_filename)
    temporary_audio_path = f"{audio_path}.part"

    sentences = re.split(r'(?<=[.!?]) +', script)
    chunks = []
    current_chunk = ""
    CHUNK_LIMIT = 4000
    
    if len(script) > CHUNK_LIMIT:
        await send_log(f"✂️ Text je rozdělen pro překročení limitů TTS.")

    for sentence in sentences:
        if len(current_chunk) + len(sentence) < CHUNK_LIMIT:
            current_chunk += sentence + " "
        else:
            if current_chunk.strip():
                chunks.append(current_chunk.strip())
            current_chunk = sentence + " "
            
    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    if os.path.exists(temporary_audio_path):
        os.remove(temporary_audio_path)

    try:
        # Zapisujeme do dočasného souboru. Neúspěšný pokus tak nikdy nevydá
        # neúplné MP3 za hotový výsledek v průzkumníku.
        with open(temporary_audio_path, 'wb') as final_audio_file:
            for idx, chunk in enumerate(chunks):
                if not chunk:
                    continue

                if len(chunks) > 1:
                    await send_log(f"🔊 {provider.upper()} TTS: Generuji část audia {idx + 1}/{len(chunks)}...")
                else:
                    await send_log(f"🔊 {provider.upper()} TTS: Generuji audiosoubor...")

                if provider == "openai":
                    def create_openai_speech() -> bytes:
                        client = get_openai_client()
                        response = client.audio.speech.create(
                            model="tts-1", voice=voice, input=chunk
                        )
                        return b"".join(response.iter_bytes())

                    final_audio_file.write(await asyncio.to_thread(create_openai_speech))

                elif provider == "elevenlabs":
                    el_key = get_elevenlabs_api_key()
                    if not el_key:
                        raise ValueError("Chybí klíč ElevenLabs. Zadejte jej prosím v sekci Nastavení ⚙️.")
                    headers = {"xi-api-key": el_key, "Content-Type": "application/json"}
                    data = {
                        "text": chunk,
                        "model_id": "eleven_multilingual_v2",
                        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}
                    }
                    voice_id = voice if len(voice) > 5 else "21m00Tcm4TlvDq8ikWAM"
                    async with httpx.AsyncClient() as client:
                        res = await client.post(
                            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                            headers=headers, json=data, timeout=120.0
                        )
                        if res.status_code != 200:
                            raise ValueError(res.text)
                        final_audio_file.write(res.content)
                else:
                    raise ValueError(f"Nepodporovaný TTS poskytovatel: {provider}")

        os.replace(temporary_audio_path, audio_path)
    except Exception as e:
        if os.path.exists(temporary_audio_path):
            os.remove(temporary_audio_path)
        raise ValueError(friendly_api_error(e, provider.upper())) from e
    
    await create_srt_for_audio(script, audio_filename)
    
    if output_format == "mp4":
        success = await create_mp4_with_subtitles(audio_filename, question_title)
        if success:
            return f"/audio/{safe_title}.mp4", f"{safe_title}.mp4", "mp4"
                    
    return f"/audio/{audio_filename}", audio_filename, "mp3"

# --- ZRUŠENÍ DÁVKOVÉHO PROCESU ---
@app.post("/api/cancel-batch")
async def cancel_batch(payload: dict = Body(...)):
    project = sanitize_name(payload.get("project", ""))
    batch = active_batches.get(project)
    if not batch:
        return {"status": "not_running"}

    batch.cancel_requested = True
    await send_log("🛑 Požadavek na zrušení dávky byl přijat. Dokončující API volání doběhne, další otázka se už nespustí.")
    return {"status": "cancelling", "batch_id": batch.batch_id}


async def background_batch_process(
    questions: list,
    custom_prompt: str,
    provider: str,
    voice: str,
    output_format: str,
    project: str,
    gemini_model: str,
    batch_id: str,
    overnight_mode: bool = True,
):
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None
    failed_questions = []

    try:
        await send_log(f"🚀 Spouštím dávkové zpracování podcastů pro {len(questions)} otázek...")
        await send_batch_event(
            project,
            "started",
            batch_id,
            mode="podcast",
            question_indexes=[question.get("q_index") for question in questions],
        )

        for idx, question_data in enumerate(questions):
            if batch.cancel_requested:
                await send_log("🛑 Dávkové zpracování bylo zrušeno uživatelem!")
                outcome = "cancelled"
                break

            title = question_data.get('title')
            question_index = question_data.get("q_index")
            await send_log(f"▶️ [{idx+1}/{len(questions)}] Zpracovávám otázku: {title}")

            success = False
            last_err = None
            for attempt in range(3):
                if batch.cancel_requested:
                    break
                try:
                    script, _ = await internal_generate_script(title, custom_prompt, provider, project, gemini_model)
                    if batch.cancel_requested:
                        break
                    safe_filename = f"{project}_Q{question_index}_{title[:15]}"
                    await internal_generate_audio(script, safe_filename, provider, voice, output_format, title)
                    success = True
                    break
                except Exception as err:
                    last_err = err
                    if attempt < 2 and not batch.cancel_requested:
                        wait_s = (attempt + 1) * 5
                        await send_log(f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s...")
                        await asyncio.sleep(wait_s)

            if success:
                batch.completed_question_indexes.append(question_index)
                if question_index in pending_question_indexes:
                    pending_question_indexes.remove(question_index)
                await send_batch_event(
                    project,
                    "question_completed",
                    batch_id,
                    mode="podcast",
                    question_index=question_index,
                )
                await send_log(f"🎉 Hotovo [{idx+1}/{len(questions)}].")
            else:
                await send_log(f"⚠️ Otázku '{title[:35]}' se nepodařilo dokončit: {str(last_err)}. Pokračuji v dávce...")
                failed_questions.append(question_data)
                await send_batch_event(
                    project,
                    "question_failed",
                    batch_id,
                    mode="podcast",
                    question_index=question_index,
                    error=str(last_err),
                )

            await asyncio.sleep(1.0)

        # Noční kontrola kompletnosti: doplňovací kola pro neúspěšné otázky
        if overnight_mode and failed_questions and not batch.cancel_requested:
            max_sweeps = 2
            sweep_idx = 0
            while failed_questions and sweep_idx < max_sweeps and not batch.cancel_requested:
                sweep_idx += 1
                await send_log(f"🌙 [Noční kontrola podcastů – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek...")
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(f"🔄 Doplňovací pokus podcastu: {q_title[:35]}...")
                    try:
                        script, _ = await internal_generate_script(q_title, custom_prompt, provider, project, gemini_model)
                        if batch.cancel_requested:
                            break
                        safe_filename = f"{project}_Q{q_idx}_{q_title[:15]}"
                        await internal_generate_audio(script, safe_filename, provider, voice, output_format, q_title)
                        batch.completed_question_indexes.append(q_idx)
                        if q_idx in pending_question_indexes:
                            pending_question_indexes.remove(q_idx)
                        await send_batch_event(
                            project,
                            "question_completed",
                            batch_id,
                            mode="podcast",
                            question_index=q_idx,
                        )
                        await send_log(f"🎉 Úspěšně doplněno v noční kontrole: {q_title[:35]}")
                    except Exception as sw_err:
                        await send_log(f"⚠️ Doplňovací pokus pro '{q_title[:35]}' selhal: {str(sw_err)}")
                        still_failed.append(q_data)
                    await asyncio.sleep(1.0)
                failed_questions = still_failed

        if batch.cancel_requested:
            outcome = "cancelled"
            await send_log("🏁 Dávkové zpracování podcastů bylo zrušeno.")
        elif len(pending_question_indexes) == 0:
            outcome = "completed"
            await send_log(f"🏁 Dávkové zpracování podcastů kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!")
        else:
            outcome = "completed_with_errors"
            await send_log(f"🏁 Dávka podcastů dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných.")

    except Exception as e:
        outcome = "failed"
        failed_message = str(e)
        await send_log(f"❌ Dávkové zpracování přerušeno chybou: {failed_message}")
    finally:
        try:
            await send_batch_event(
                project,
                "finished",
                batch_id,
                mode="podcast",
                outcome=outcome,
                completed_question_indexes=batch.completed_question_indexes,
                pending_question_indexes=pending_question_indexes,
                error=failed_message,
            )
        finally:
            # Bezpodmínečný úklid je klíčový: po chybě musí jít dávku ihned
            # znovu spustit, bez restartování backendu.
            current_batch = active_batches.get(project)
            if current_batch and current_batch.batch_id == batch_id:
                del active_batches[project]

@app.post("/api/process-batch")
async def process_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    custom_prompt = payload.get("prompt")
    provider = payload.get("provider", "openai")
    voice = payload.get("voice", "onyx")
    output_format = payload.get("format", "mp3")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not custom_prompt or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky, prompt nebo projekt.")

    if project in active_batches:
        raise HTTPException(
            status_code=409,
            detail="Pro tento projekt už běží dávka. Vyčkejte na její dokončení nebo ji nejprve zrušte.",
        )

    batch_id = str(uuid.uuid4())
    active_batches[project] = BatchState(batch_id=batch_id)
    background_tasks.add_task(
        background_batch_process,
        questions,
        custom_prompt,
        provider,
        voice,
        output_format,
        project,
        gemini_model,
        batch_id,
        overnight_mode,
    )
    return {"status": "started", "batch_id": batch_id, "mode": "podcast"}


# --- DÁVKOVÉ ZPRACOVÁNÍ: STUDIJNÍ POZNÁMKY ---
async def background_notes_batch_process(
    questions: list,
    custom_prompt: str,
    project: str,
    gemini_model: str,
    batch_id: str,
    overnight_mode: bool = True,
):
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None
    failed_questions = []

    try:
        await send_log(f"🚀 Spouštím dávkové generování studijních textů pro {len(questions)} otázek...")
        await send_batch_event(
            project,
            "started",
            batch_id,
            mode="notes",
            question_indexes=[question.get("q_index") for question in questions],
        )

        for idx, question_data in enumerate(questions):
            if batch.cancel_requested:
                await send_log("🛑 Dávkové generování poznámek bylo zrušeno uživatelem!")
                outcome = "cancelled"
                break

            title = question_data.get("title")
            question_index = question_data.get("q_index")
            await send_log(f"📝 [{idx+1}/{len(questions)}] Generuji studijní text: {title}")

            success = False
            last_err = None
            for attempt in range(3):
                if batch.cancel_requested:
                    break
                try:
                    await internal_generate_notes(title, project, custom_prompt, gemini_model)
                    success = True
                    break
                except Exception as err:
                    last_err = err
                    if is_terminal_auth_error(err):
                        await send_log(f"🛑 Fatální chyba autorizace: {friendly_api_error(err, 'Gemini')}")
                        batch.cancel_requested = True
                        break
                    if attempt < 2 and not batch.cancel_requested:
                        wait_s = (attempt + 1) * 5
                        await send_log(f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s...")
                        await asyncio.sleep(wait_s)

            if success:
                batch.completed_question_indexes.append(question_index)
                if question_index in pending_question_indexes:
                    pending_question_indexes.remove(question_index)
                await send_batch_event(
                    project,
                    "question_completed",
                    batch_id,
                    mode="notes",
                    question_index=question_index,
                )
                await send_log(f"🎉 Text k otázce [{idx+1}/{len(questions)}] vygenerován a uložen.")
            else:
                await send_log(f"⚠️ Otázku '{title[:35]}' se nepodařilo vygenerovat: {str(last_err)}. Pokračuji v dávce...")
                failed_questions.append(question_data)
                await send_batch_event(
                    project,
                    "question_failed",
                    batch_id,
                    mode="notes",
                    question_index=question_index,
                    error=str(last_err),
                )

            await asyncio.sleep(1.0)

        # Noční kontrola kompletnosti: doplňovací kola pro neúspěšné otázky
        if overnight_mode and failed_questions and not batch.cancel_requested:
            max_sweeps = 2
            sweep_idx = 0
            while failed_questions and sweep_idx < max_sweeps and not batch.cancel_requested:
                sweep_idx += 1
                await send_log(f"🌙 [Noční kontrola textů – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek...")
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(f"🔄 Doplňovací pokus textu: {q_title[:35]}...")
                    try:
                        await internal_generate_notes(q_title, project, custom_prompt, gemini_model)
                        batch.completed_question_indexes.append(q_idx)
                        if q_idx in pending_question_indexes:
                            pending_question_indexes.remove(q_idx)
                        await send_batch_event(
                            project,
                            "question_completed",
                            batch_id,
                            mode="notes",
                            question_index=q_idx,
                        )
                        await send_log(f"🎉 Úspěšně doplněno v noční kontrole: {q_title[:35]}")
                    except Exception as sw_err:
                        await send_log(f"⚠️ Doplňovací pokus pro '{q_title[:35]}' selhal: {str(sw_err)}")
                        still_failed.append(q_data)
                    await asyncio.sleep(1.0)
                failed_questions = still_failed

        if batch.cancel_requested:
            outcome = "cancelled"
            await send_log("🏁 Dávkové generování studijních textů bylo zrušeno.")
        elif len(pending_question_indexes) == 0:
            outcome = "completed"
            await send_log(f"🏁 Dávkové generování textů kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!")
        else:
            outcome = "completed_with_errors"
            await send_log(f"🏁 Dávka textů dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných.")

    except Exception as e:
        outcome = "failed"
        failed_message = str(e)
        await send_log(f"❌ Dávkové generování textů přerušeno: {failed_message}")
    finally:
        try:
            await send_batch_event(
                project,
                "finished",
                batch_id,
                mode="notes",
                outcome=outcome,
                completed_question_indexes=batch.completed_question_indexes,
                pending_question_indexes=pending_question_indexes,
                error=failed_message,
            )
        finally:
            current_batch = active_batches.get(project)
            if current_batch and current_batch.batch_id == batch_id:
                del active_batches[project]


@app.post("/api/process-notes-batch")
async def process_notes_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    custom_prompt = payload.get("prompt", "")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky nebo projekt.")

    if project in active_batches:
        raise HTTPException(
            status_code=409,
            detail="Pro tento projekt už běží dávka. Vyčkejte na její dokončení nebo ji nejprve zrušte.",
        )

    batch_id = str(uuid.uuid4())
    active_batches[project] = BatchState(batch_id=batch_id, mode="notes")
    background_tasks.add_task(
        background_notes_batch_process,
        questions,
        custom_prompt,
        project,
        gemini_model,
        batch_id,
        overnight_mode,
    )
    return {"status": "started", "batch_id": batch_id, "mode": "notes"}


# --- DÁVKOVÉ ZPRACOVÁNÍ: KARTIČKY ---
async def background_flashcards_batch_process(
    questions: list,
    count: int,
    custom_prompt: str,
    project: str,
    gemini_model: str,
    batch_id: str,
    overnight_mode: bool = True,
):
    batch = active_batches.get(project)
    if not batch or batch.batch_id != batch_id:
        return

    pending_question_indexes = [question.get("q_index") for question in questions]
    outcome = "completed"
    failed_message = None
    failed_questions = []

    try:
        await send_log(f"🚀 Spouštím dávkové generování kartiček ({count} ks/otázka) pro {len(questions)} otázek...")
        await send_batch_event(
            project,
            "started",
            batch_id,
            mode="flashcards",
            question_indexes=[question.get("q_index") for question in questions],
        )

        for idx, question_data in enumerate(questions):
            if batch.cancel_requested:
                await send_log("🛑 Dávkové generování kartiček bylo zrušeno uživatelem!")
                outcome = "cancelled"
                break

            title = question_data.get("title")
            question_index = question_data.get("q_index")
            await send_log(f"🗂️ [{idx+1}/{len(questions)}] Generuji {count} kartiček: {title}")

            success = False
            last_err = None
            for attempt in range(3):
                if batch.cancel_requested:
                    break
                try:
                    await internal_generate_flashcards(title, project, count, custom_prompt, gemini_model)
                    success = True
                    break
                except Exception as err:
                    last_err = err
                    if is_terminal_auth_error(err):
                        await send_log(f"🛑 Fatální chyba autorizace: {friendly_api_error(err, 'Gemini')}")
                        batch.cancel_requested = True
                        break
                    if attempt < 2 and not batch.cancel_requested:
                        wait_s = (attempt + 1) * 5
                        await send_log(f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s...")
                        await asyncio.sleep(wait_s)

            if success:
                batch.completed_question_indexes.append(question_index)
                if question_index in pending_question_indexes:
                    pending_question_indexes.remove(question_index)
                await send_batch_event(
                    project,
                    "question_completed",
                    batch_id,
                    mode="flashcards",
                    question_index=question_index,
                )
                await send_log(f"🎉 Kartičky k otázce [{idx+1}/{len(questions)}] vytvořeny a uloženy.")
            else:
                await send_log(f"⚠️ Otázku '{title[:35]}' se nepodařilo vygenerovat: {str(last_err)}. Pokračuji v dávce...")
                failed_questions.append(question_data)
                await send_batch_event(
                    project,
                    "question_failed",
                    batch_id,
                    mode="flashcards",
                    question_index=question_index,
                    error=str(last_err),
                )

            await asyncio.sleep(1.0)

        # Noční kontrola kompletnosti: doplňovací kola pro neúspěšné otázky
        if overnight_mode and failed_questions and not batch.cancel_requested:
            max_sweeps = 2
            sweep_idx = 0
            while failed_questions and sweep_idx < max_sweeps and not batch.cancel_requested:
                sweep_idx += 1
                await send_log(f"🌙 [Noční kontrola kartiček – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek...")
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(f"🔄 Doplňovací pokus kartiček: {q_title[:35]}...")
                    try:
                        await internal_generate_flashcards(q_title, project, count, custom_prompt, gemini_model)
                        batch.completed_question_indexes.append(q_idx)
                        if q_idx in pending_question_indexes:
                            pending_question_indexes.remove(q_idx)
                        await send_batch_event(
                            project,
                            "question_completed",
                            batch_id,
                            mode="flashcards",
                            question_index=q_idx,
                        )
                        await send_log(f"🎉 Úspěšně doplněno v noční kontrole: {q_title[:35]}")
                    except Exception as sw_err:
                        await send_log(f"⚠️ Doplňovací pokus pro '{q_title[:35]}' selhal: {str(sw_err)}")
                        still_failed.append(q_data)
                    await asyncio.sleep(1.0)
                failed_questions = still_failed

        if batch.cancel_requested:
            outcome = "cancelled"
            await send_log("🏁 Dávkové generování kartiček bylo zrušeno.")
        elif len(pending_question_indexes) == 0:
            outcome = "completed"
            await send_log(f"🏁 Dávkové generování kartiček kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!")
        else:
            outcome = "completed_with_errors"
            await send_log(f"🏁 Dávka kartiček dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných.")

    except Exception as e:
        outcome = "failed"
        failed_message = str(e)
        await send_log(f"❌ Dávkové generování kartiček přerušeno: {failed_message}")
    finally:
        try:
            await send_batch_event(
                project,
                "finished",
                batch_id,
                mode="flashcards",
                outcome=outcome,
                completed_question_indexes=batch.completed_question_indexes,
                pending_question_indexes=pending_question_indexes,
                error=failed_message,
            )
        finally:
            current_batch = active_batches.get(project)
            if current_batch and current_batch.batch_id == batch_id:
                del active_batches[project]


@app.post("/api/process-flashcards-batch")
async def process_flashcards_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    count = int(payload.get("count", 10))
    custom_prompt = payload.get("prompt", "")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky nebo projekt.")

    if project in active_batches:
        raise HTTPException(
            status_code=409,
            detail="Pro tento projekt už běží dávka. Vyčkejte na její dokončení nebo ji nejprve zrušte.",
        )

    batch_id = str(uuid.uuid4())
    active_batches[project] = BatchState(batch_id=batch_id, mode="flashcards")
    background_tasks.add_task(
        background_flashcards_batch_process,
        questions,
        count,
        custom_prompt,
        project,
        gemini_model,
        batch_id,
        overnight_mode,
    )
    return {"status": "started", "batch_id": batch_id, "mode": "flashcards"}

@app.post("/api/generate-script")
async def generate_script(payload: dict = Body(...)):
    question = payload.get("question")
    custom_prompt = payload.get("prompt")
    provider = payload.get("provider", "openai")
    project = payload.get("project")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    
    if not question or not custom_prompt or not project:
        raise HTTPException(status_code=400, detail="Chybí parametry dotazu.")

    try:
        script, context = await internal_generate_script(question, custom_prompt, provider, project, gemini_model)
        return {"script": script, "context": context}
    except Exception as e:
        await send_log(f"❌ Chyba při generování scénáře: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-audio")
async def generate_audio(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename", "podcast")
    provider = payload.get("provider", "openai")
    voice = payload.get("voice", "onyx")
    output_format = payload.get("format", "mp3")
    question_title = payload.get("question_title", filename)

    await send_log(f"🔊 Spouštím TTS syntézu přes {provider}...")
    try:
        audio_url, audio_filename, final_format = await internal_generate_audio(script, filename, provider, voice, output_format, question_title)
        return {"audio_url": audio_url, "filename": audio_filename, "format": final_format}
    except Exception as e:
        await send_log(f"❌ Tvorba záznamu selhala: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-subtitles")
async def generate_subtitles_endpoint(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename")

    success = await create_srt_for_audio(script, filename)
    if success:
        return {"status": "success", "message": "Titulky vygenerovány."}
    else:
        raise HTTPException(status_code=500, detail="Titulky se nepodařilo vygenerovat.")

# --- STATISTIKY PRO DASHBOARD ---
@app.get("/api/stats")
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
    audio_files = [f for f in os.listdir(AUDIO_DIR) if f.endswith(('.mp3', '.mp4'))]
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
        from chat_service import list_lessons, get_project_messages
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
                with open(planner_file, "r", encoding="utf-8") as f:
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

# --- STUDIJNÍ POZNÁMKY (NOTES) ---
@app.post("/api/generate-notes")
async def generate_notes_endpoint(payload: dict = Body(...)):
    question = payload.get("question")
    project = payload.get("project")
    custom_prompt = payload.get("prompt", "")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")

    if not question or not project:
        raise HTTPException(status_code=400, detail="Chybí znění otázky nebo projekt.")

    try:
        markdown, sources, filename = await internal_generate_notes(
            question=question,
            project=project,
            custom_prompt=custom_prompt,
            gemini_model=gemini_model,
        )
        return {"markdown": markdown, "sources": sources, "filename": filename}
    except Exception as e:
        err_msg = friendly_api_error(e, "Gemini")
        await send_log(f"❌ Selhalo generování studijního textu: {err_msg}")
        raise HTTPException(status_code=500, detail=err_msg)

@app.get("/api/notes")
async def list_notes(project: str = ""):
    try:
        files = [f for f in os.listdir(NOTES_DIR) if f.endswith(".md")]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(os.path.join(NOTES_DIR, x)), reverse=True)
        results = []
        for f in files:
            path = os.path.join(NOTES_DIR, f)
            mtime = os.path.getmtime(path)
            q_title = f.replace(".md", "")
            # Pokus o extrakci názvu otázky z metadat na začátku souboru
            try:
                with open(path, "r", encoding="utf-8") as file_handle:
                    header = file_handle.read(1024)
                    match = re.search(r'<!-- METADATA\s*(\{.*?\})\s*-->', header, re.DOTALL)
                    if match:
                        meta = json.loads(match.group(1))
                        if "question" in meta:
                            q_title = meta["question"]
            except Exception:
                pass

            results.append({
                "filename": f,
                "title": q_title,
                "mtime": mtime,
                "size": os.path.getsize(path),
            })
        return {"notes": results}
    except Exception as e:
        return {"notes": [], "error": str(e)}

@app.get("/api/notes/{filename}")
async def get_note(filename: str):
    file_path = os.path.join(NOTES_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Poznámky nenalezeny.")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    # Očištění metadata komentáře pro čistý Markdown náhled
    clean_markdown = re.sub(r'^<!-- METADATA.*?-->\s*', '', content, flags=re.DOTALL)
    sources = []
    project = ""
    meta_match = re.search(r'^<!-- METADATA\s*(\{.*?\})\s*-->', content, flags=re.DOTALL)
    if meta_match:
        try:
            meta_json = json.loads(meta_match.group(1))
            sources = meta_json.get("sources", [])
            project = meta_json.get("project", "")
        except Exception:
            pass
    return {"filename": filename, "markdown": clean_markdown, "raw": content, "sources": sources, "project": project}

@app.delete("/api/notes/{filename}")
async def delete_note(filename: str):
    file_path = os.path.join(NOTES_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Smazány poznámky: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

# --- KARTIČKY (ANKI / QUIZLET) ---
@app.get("/api/flashcards-prompts")
async def get_flashcards_prompts():
    return {
        "presets": [
            {
                "id": "standard",
                "name": "Standardní medicínské kartičky",
                "description": "Základní klinické kartičky pro internu a medicínské zkoušky (kritéria, léky, diagnostika).",
                "prompt": DEFAULT_FLASHCARDS_PROMPT,
            },
            {
                "id": "advanced",
                "name": "Pokročilé Anki Kartičky",
                "description": "Metodika Anki-konvence (Sorbonne / Collège / Ole): kognitivní odvoditelnost (princip -> fakta), přihrádková nápověda v závorce, Rang A/B, Pourquoi/Piège/Aussi, přehledové karty (dělicí, faux-ami) a rozbalovací česká vrstva (MKN-10).",
                "prompt": ADVANCED_ANKI_FLASHCARDS_PROMPT,
            }
        ]
    }

@app.post("/api/generate-flashcards")
async def generate_flashcards_endpoint(payload: dict = Body(...)):
    question = payload.get("question")
    project = payload.get("project")
    count = int(payload.get("count", 10))
    custom_prompt = payload.get("prompt", "")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    force_regenerate = bool(payload.get("force_regenerate", False))

    if not question or not project:
        raise HTTPException(status_code=400, detail="Chybí znění otázky nebo projekt.")

    try:
        deck_data, filename = await internal_generate_flashcards(
            question=question,
            project=project,
            count=count,
            custom_prompt=custom_prompt,
            gemini_model=gemini_model,
            force_regenerate=force_regenerate,
        )
        return {**deck_data, "filename": filename}
    except Exception as e:
        await send_log(f"❌ Selhalo generování kartiček: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/flashcards")
async def list_flashcards(project: str = ""):
    try:
        files = [f for f in os.listdir(FLASHCARDS_DIR) if f.endswith(".json")]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(os.path.join(FLASHCARDS_DIR, x)), reverse=True)
        results = []
        for f in files:
            path = os.path.join(FLASHCARDS_DIR, f)
            try:
                with open(path, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                    results.append({
                        "filename": f,
                        "question": data.get("question", f),
                        "count": data.get("count", len(data.get("cards", []))),
                        "mtime": os.path.getmtime(path),
                    })
            except Exception:
                results.append({
                    "filename": f,
                    "question": f,
                    "count": 0,
                    "mtime": os.path.getmtime(path),
                })
        return {"decks": results}
    except Exception as e:
        return {"decks": [], "error": str(e)}

@app.get("/api/flashcards/export-all")
async def export_all_flashcards(project: str = ""):
    try:
        files = [f for f in os.listdir(FLASHCARDS_DIR) if f.endswith(".json")]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(os.path.join(FLASHCARDS_DIR, x)))
        all_cards = []
        decks_info = []
        seen_fronts = set()

        for f in files:
            path = os.path.join(FLASHCARDS_DIR, f)
            try:
                with open(path, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                    q_title = data.get("question", f)
                    cards = data.get("cards", [])
                    decks_info.append({
                        "filename": f,
                        "question": q_title,
                        "count": len(cards),
                    })
                    for c in cards:
                        front = str(c.get("front", "")).strip()
                        key = normalize_front(front)
                        if key and key in seen_fronts:
                            continue
                        if key:
                            seen_fronts.add(key)

                        card_copy = dict(c)
                        card_copy["question_context"] = q_title
                        card_copy["deck_sources"] = data.get("sources", [])
                        all_cards.append(card_copy)
            except Exception:
                continue

        for idx, c in enumerate(all_cards, 1):
            c["id"] = idx

        anki_lines = [
            "#separator:tab",
            "#html:true",
            f"#tags:interna zkouška {sanitize_name(project)} souhrn",
        ]
        quizlet_lines = []

        safe_proj = sanitize_name(project)
        for c in all_cards:
            resolved = resolve_card_source(c, c.get("deck_sources", []), project)
            front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", "<br>")
            back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", "<br>")

            # Podpora pro Rang v hlavičce
            rang = str(resolved.get("rang", "")).strip()
            if rang and f"[Rang {rang}]" not in front:
                front = f"[Rang {rang}] " + front

            # Podpora pro nápovědu v závorce
            hint = str(resolved.get("hint", "")).strip()
            if hint and hint not in front and f"({hint})" not in front:
                front += f"<br><small style='color:#a8a29e;'><i>({hint})</i></small>"

            # Podpora pro českou vrstvu (cz)
            cz_data = resolved.get("cz")
            if cz_data and "<details" not in back:
                if isinstance(cz_data, dict):
                    cz_q = cz_data.get("q", "")
                    cz_a = cz_data.get("a", "")
                    cz_pojmy = cz_data.get("pojmy", [])
                    pojmy_html = ""
                    if cz_pojmy and isinstance(cz_pojmy, list):
                        items = []
                        for p in cz_pojmy:
                            if isinstance(p, (list, tuple)) and len(p) >= 2:
                                items.append(f"• <em>{p[0]}</em>: {p[1]}")
                            elif isinstance(p, dict):
                                term = p.get("term") or p.get("pojem") or ""
                                expl = p.get("expl") or p.get("vyznam") or p.get("popis") or ""
                                items.append(f"• <em>{term}</em>: {expl}")
                            elif isinstance(p, str):
                                items.append(f"• {p}")
                        if items:
                            pojmy_html = f"<div style='margin-top:6px; font-size:0.9em; border-top:1px dashed rgba(255,255,255,0.15); padding-top:4px;'><strong>Pojmy (MKN-10 / Glosář):</strong><br>{'<br>'.join(items)}</div>"

                    cz_block = (
                        f"<br><br><details class='cz' style='margin-top:10px; padding:6px 10px; border-left:3px solid #3d7cc9; background:rgba(61,124,201,0.08); font-size:0.92em; border-radius:4px; text-align:left;'>"
                        f"<summary style='cursor:pointer; color:#38bdf8; font-weight:600;'>🇨🇿 Česky — překlad a pojmy</summary>"
                        f"<div style='margin-top:6px;'>"
                        f"<div><strong>Otázka:</strong> {cz_q}</div>"
                        f"<div style='margin-top:4px;'><strong>Odpověď:</strong> {cz_a}</div>"
                        f"{pojmy_html}"
                        f"</div></details>"
                    )
                    back += cz_block
            
            src_file = resolved.get("source_file", "")
            src_page = resolved.get("source_page", "")
            src_ref = resolved.get("source_ref", "")
            clean_page = resolved.get("clean_page", "")
            q_ctx = resolved.get("question_context", "")

            extra = []
            if q_ctx:
                extra.append(f"📌 {q_ctx}")

            if src_file:
                page_text = f" (s. {src_page})" if src_page else ""
                hash_page = f"#page={clean_page}" if clean_page else ""
                file_url = f"http://localhost:8000/uploads/{safe_proj}/{src_file}{hash_page}"
                extra.append(f"<a href='{file_url}' target='_blank' style='color:#0284c7; text-decoration: underline;'>📖 {src_file}{page_text}</a>")
            elif src_ref:
                extra.append(f"📖 {src_ref}")

            if extra:
                back += f" <small style='color:gray;'>({' | '.join(extra)})</small>"
            anki_lines.append(f"{front}\t{back}")

            q_front = str(resolved.get("front", "")).replace("\t", " ").replace("\n", " ")
            q_back = str(resolved.get("back", "")).replace("\t", " ").replace("\n", " ")
            if src_file:
                page_text = f", s. {src_page}" if src_page else ""
                q_back += f" [📖 {src_file}{page_text}]"
            elif src_ref:
                q_back += f" [{src_ref}]"
            quizlet_lines.append(f"{q_front}\t{q_back}")

        return {
            "project": project,
            "total_decks": len(decks_info),
            "total_cards": len(all_cards),
            "decks": decks_info,
            "anki_tsv": "\n".join(anki_lines),
            "quizlet_text": "\n".join(quizlet_lines),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/flashcards/{filename}")
async def get_flashcard_deck(filename: str):
    file_path = os.path.join(FLASHCARDS_DIR, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Sada kartiček nenalezena.")
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Automatické dovyřešení zdrojů i pro dříve uložené starší sady
    cards = data.get("cards", [])
    sources = data.get("sources", [])
    project = data.get("project", "")
    for c in cards:
        resolve_card_source(c, sources, project)

    return data

@app.delete("/api/flashcards/{filename}")
async def delete_flashcards(filename: str):
    file_path = os.path.join(FLASHCARDS_DIR, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Smazána sada kartiček: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")

# =========================================================================
# TESTOVÉ OTÁZKY (PRACTICE TESTS)
# =========================================================================
from test_service import (
    TestStorageManager,
    generate_practice_test,
    generate_more_test_questions,
    evaluate_open_answer,
)

test_storage = TestStorageManager(TESTS_DIR)

@app.post("/api/tests/generate")
async def generate_test_endpoint(payload: dict = Body(...)):
    project = payload.get("project", "")
    questions = payload.get("questions", [])
    categories = payload.get("categories", [])
    categories_map = payload.get("categories_map", {})
    count = int(payload.get("count", 10))
    question_types = payload.get("question_types", ["single_choice", "multi_choice"])
    difficulty = payload.get("difficulty", "normal")
    mode = payload.get("mode", "instant")
    custom_prompt = payload.get("prompt", "")
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")

    if not project:
        raise HTTPException(status_code=400, detail="Chybí název projektu.")
    if isinstance(questions, str):
        questions = [questions] if questions.strip() else []
    if isinstance(categories, str):
        categories = [categories] if categories.strip() else []

    try:
        test_data, filename = await generate_practice_test(
            project=project,
            questions=questions,
            count=count,
            question_types=question_types,
            difficulty=difficulty,
            mode=mode,
            custom_prompt=custom_prompt,
            gemini_model=gemini_model,
            tests_dir=TESTS_DIR,
            rag_query_fn=query_rag_context_with_sources,
            gemini_call_fn=call_gemini_with_retries,
            log_fn=send_log,
            categories=categories,
            categories_map=categories_map,
        )
        return {**test_data, "filename": filename}
    except Exception as e:
        await send_log(f"❌ Selhalo generování testu: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tests/generate-more")
async def generate_more_tests_endpoint(payload: dict = Body(...)):
    previous_test_id = payload.get("previous_test_id", "")
    project = payload.get("project", "")
    count = int(payload.get("count", 5))
    difficulty_shift = payload.get("difficulty_shift", "same")
    focus_mistakes = bool(payload.get("focus_mistakes", True))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")

    if not previous_test_id or not project:
        raise HTTPException(status_code=400, detail="Chybí identifikátor testu nebo projekt.")

    try:
        new_test, filename = await generate_more_test_questions(
            previous_test_id=previous_test_id,
            project=project,
            count=count,
            difficulty_shift=difficulty_shift,
            focus_mistakes=focus_mistakes,
            gemini_model=gemini_model,
            tests_dir=TESTS_DIR,
            rag_query_fn=query_rag_context_with_sources,
            gemini_call_fn=call_gemini_with_retries,
            log_fn=send_log,
        )
        return {**new_test, "filename": filename}
    except Exception as e:
        await send_log(f"❌ Selhalo dogenerování otázek testu: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tests")
async def list_tests_endpoint(project: str = ""):
    try:
        tests = test_storage.list_tests(project=project)
        return {"tests": tests}
    except Exception as e:
        return {"tests": [], "error": str(e)}

@app.get("/api/tests/{filename}")
async def get_test_endpoint(filename: str):
    data = test_storage.get_test(filename)
    if not data:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return data

@app.post("/api/tests/{filename}/result")
async def save_test_result_endpoint(filename: str, payload: dict = Body(...)):
    updated = test_storage.save_test_result(filename, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return {"status": "success", "test": updated}

@app.delete("/api/tests/{filename}")
async def delete_test_endpoint(filename: str):
    success = test_storage.delete_test(filename)
    if success:
        await send_log(f"🗑️ Smazán test: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Test nebyl nalezen.")

@app.post("/api/tests/evaluate-open-answer")
async def evaluate_open_answer_endpoint(payload: dict = Body(...)):
    user_answer = payload.get("user_answer", "")
    model_answer = payload.get("model_answer", "")
    key_points = payload.get("key_points", [])
    if not isinstance(key_points, list):
        key_points = []
    result = evaluate_open_answer(user_answer, model_answer, key_points)
    return result

# =========================================================================
# NOVÉ MODULY: GROUNDED CHAT & VÝUKOVÁ LEKCE OD A DO Z
# =========================================================================
from chat_service import (
    get_project_messages,
    save_message,
    clear_project_messages,
    export_project_chat_markdown,
    export_thread_chat_markdown,
    stream_grounded_chat,
    list_threads,
    create_thread,
    get_thread,
    update_thread,
    toggle_thread_pin,
    delete_thread,
    get_thread_messages,
    get_lesson,
    list_lessons,
    delete_lesson,
)
from lesson_service import generate_lesson_package

# --- 1. PROJEKTOVÝ GROUNDED CHAT ---
@app.post("/api/chat/completions")
async def chat_completions_endpoint(payload: dict = Body(...)):
    project = payload.get("project")
    message = payload.get("message")
    model = payload.get("model", "gemini-3.6-flash")
    custom_sys = payload.get("system_prompt", "")
    thread_id = payload.get("thread_id")

    if not project or not message:
        raise HTTPException(status_code=400, detail="Chybí projekt nebo text zprávy.")

    safe_proj = sanitize_name(project)
    await send_log(f"💬 Chat dotaz ({safe_proj}): '{message[:50]}...'")

    return StreamingResponse(
        stream_grounded_chat(
            project_id=safe_proj,
            user_message=message,
            model=model,
            custom_system_prompt=custom_sys,
            thread_id=thread_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

# --- SPRÁVA CHATOVÝCH VLÁKEN (THREADS) ---

@app.get("/api/chat/threads")
async def get_chat_threads_endpoint(project_id: Optional[str] = None, q: Optional[str] = None):
    safe_proj = sanitize_name(project_id) if project_id and project_id != "__all__" else None
    threads = list_threads(project_id=safe_proj, search_query=q)
    return {"threads": threads}


@app.post("/api/chat/threads")
async def create_chat_thread_endpoint(payload: dict = Body(...)):
    project = payload.get("project_id") or payload.get("project")
    if not project:
        raise HTTPException(status_code=400, detail="Chybí identifikátor projektu.")
    title = payload.get("title")
    thread_id = payload.get("id")
    safe_proj = sanitize_name(project)
    thread = create_thread(project_id=safe_proj, title=title, thread_id=thread_id)
    return {"status": "success", "thread": thread}


@app.get("/api/chat/threads/{thread_id}")
async def get_chat_thread_detail_endpoint(thread_id: str):
    thread = get_thread(thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    messages = get_thread_messages(thread_id)
    return {"thread": thread, "messages": messages}


@app.patch("/api/chat/threads/{thread_id}")
async def update_chat_thread_endpoint(thread_id: str, payload: dict = Body(...)):
    title = payload.get("title")
    is_pinned = payload.get("is_pinned")
    updated = update_thread(thread_id, title=title, is_pinned=is_pinned)
    if not updated:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    return {"status": "success", "thread": updated}


@app.post("/api/chat/threads/{thread_id}/pin")
async def toggle_chat_thread_pin_endpoint(thread_id: str):
    updated = toggle_thread_pin(thread_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    return {"status": "success", "thread": updated}


@app.delete("/api/chat/threads/{thread_id}")
async def delete_chat_thread_endpoint(thread_id: str):
    success = delete_thread(thread_id)
    return {"status": "success", "deleted": success}


@app.get("/api/chat/threads/{thread_id}/export")
async def export_chat_thread_endpoint(thread_id: str):
    thread = get_thread(thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Konverzace nenalezena.")
    md_content = export_thread_chat_markdown(thread_id)
    clean_title = re.sub(r"[^a-zA-Z0-9_-]", "_", thread["title"][:30])
    filename = f"chat_{clean_title}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    from fastapi.responses import Response
    return Response(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/projects/{project_id}/messages")
async def get_project_chat_messages(project_id: str, thread_id: Optional[str] = None):
    safe_proj = sanitize_name(project_id)
    messages = get_project_messages(safe_proj, thread_id=thread_id)
    return {"project": safe_proj, "messages": messages}

@app.delete("/api/projects/{project_id}/messages")
async def clear_project_chat(project_id: str):
    safe_proj = sanitize_name(project_id)
    clear_project_messages(safe_proj)
    await send_log(f"🗑️ Historie chatu pro projekt '{safe_proj}' byla vyčištěna.")
    return {"status": "success", "project": safe_proj}

@app.get("/api/projects/{project_id}/chat/export")
async def export_chat_history(project_id: str, thread_id: Optional[str] = None):
    safe_proj = sanitize_name(project_id)
    md_content = export_project_chat_markdown(safe_proj, thread_id=thread_id)
    filename = f"chat_{safe_proj}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
    from fastapi.responses import Response
    return Response(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# --- SPRÁVA PLÁNOVAČE ZKOUŠKY (EXAM PLANNER) ---
PLANNER_FILENAME = "exam_planner.json"

@app.get("/api/projects/{project_id}/planner")
async def get_project_planner(project_id: str):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    default_planner = {
        "examDate": "",
        "startDate": "",
        "revisionDays": 14,
        "scheduleMode": "sequential",
        "questions": []
    }

    if not os.path.exists(planner_file):
        return {"project": safe_proj, "planner": default_planner}

    try:
        with open(planner_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return {"project": safe_proj, "planner": data}
    except Exception as e:
        await send_log(f"⚠️ Chyba při čtení plánovače zkoušky ({safe_proj}): {str(e)}")
        return {"project": safe_proj, "planner": default_planner}

@app.post("/api/projects/{project_id}/planner")
async def save_project_planner(project_id: str, payload: dict = Body(...)):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    planner_data = payload.get("planner") if "planner" in payload else payload

    clean_data = {
        "examDate": str(planner_data.get("examDate", "") or ""),
        "startDate": str(planner_data.get("startDate", "") or ""),
        "revisionDays": int(planner_data.get("revisionDays", 14) or 14),
        "scheduleMode": str(planner_data.get("scheduleMode", "sequential") or "sequential"),
        "questions": planner_data.get("questions", [])
    }

    try:
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(clean_data, f, ensure_ascii=False, indent=2)
        await send_log(f"💾 Plánovač zkoušky pro projekt '{safe_proj}' úspěšně uložen ({len(clean_data['questions'])} otázek).")
        return {"status": "success", "project": safe_proj, "planner": clean_data}
    except Exception as e:
        await send_log(f"❌ Chyba při ukládání plánovače zkoušky ({safe_proj}): {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/projects/{project_id}/questions")
async def get_project_questions(project_id: str):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    if not os.path.exists(planner_file):
        return {"project": safe_proj, "questions": []}

    try:
        with open(planner_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return {"project": safe_proj, "questions": data.get("questions", [])}
    except Exception as e:
        await send_log(f"⚠️ Chyba při čtení otázek projektu ({safe_proj}): {str(e)}")
        return {"project": safe_proj, "questions": []}

@app.post("/api/projects/{project_id}/questions")
async def save_project_questions(project_id: str, payload: dict = Body(...)):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    os.makedirs(proj_dir, exist_ok=True)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    questions = payload.get("questions", [])
    if not isinstance(questions, list):
        raise HTTPException(status_code=400, detail="Otázky musí být seznam.")

    current_planner = {
        "examDate": "",
        "startDate": "",
        "revisionDays": 14,
        "scheduleMode": "sequential",
        "questions": []
    }
    if os.path.exists(planner_file):
        try:
            with open(planner_file, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    current_planner = loaded
        except Exception:
            pass

    current_planner["questions"] = questions

    try:
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(current_planner, f, ensure_ascii=False, indent=2)
        await send_log(f"💾 Otázky pro projekt '{safe_proj}' úspěšně uloženy ({len(questions)} otázek).")
        return {"status": "success", "project": safe_proj, "questions": questions}
    except Exception as e:
        await send_log(f"❌ Chyba při ukládání otázek projektu ({safe_proj}): {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/projects/{project_id}/ai-classify-questions")
async def ai_classify_questions_endpoint(project_id: str, payload: dict = Body(default={})):
    safe_proj = sanitize_name(project_id)
    proj_dir = os.path.join(UPLOAD_DIR, safe_proj)
    planner_file = os.path.join(proj_dir, PLANNER_FILENAME)

    if not os.path.exists(planner_file):
        raise HTTPException(status_code=404, detail="Pro daný projekt neexistuje plánovač ani seznam otázek.")

    try:
        with open(planner_file, "r", encoding="utf-8") as f:
            planner_data = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chyba při čtení plánovače: {str(e)}")

    questions = planner_data.get("questions", [])
    if not questions:
        raise HTTPException(status_code=400, detail="Projekt neobsahuje žádné otázky ke klasifikaci.")

    await send_log(f"🤖 Zahajuji AI klasifikaci {len(questions)} otázek pro projekt '{safe_proj}'...")

    compact_questions = []
    for idx, q in enumerate(questions):
        compact_questions.append({
            "id": q.get("id") or f"pq_{idx+1}",
            "index": idx + 1,
            "title": q.get("title", ""),
            "current_topic": q.get("topic", "Všeobecné")
        })

    prompt_system = (
        "Jsi špičkový profesor medicíny a didaktik lékařských fakult. "
        "Tvým úkolem je každou z následujících zkouškových otázek z medicíny přesně a logicky zařadit do správného lékařského oboru / okruhu.\n\n"
        "STRIKTNÍ PRAVIDLA:\n"
        "1. Používej čisté, zavedené české názvy lékařských oborů (např. Kardiologie, Pneumologie, Gastroenterologie, Hematologie, Nefrologie, Endokrinologie, Revmatologie, Infektologie, Neurologie, Onkologie, Akutní medicína, Všeobecné vnitřní lékařství, Chirurgie apod.).\n"
        "2. Pokud je otázka složená z více témat (např. 'a) Astma bronchiale, b) Nehodgkinské lymfomy'), zvol obor prvního/dominantního tématu nebo nejvýstižnější obor.\n"
        "3. Vyhni se obecným nicneříkajícím názvům jako 'Lístek 1' nebo 'Otázka'.\n"
        "4. Výstup musí být striktní JSON pole objektů s klíči 'id' a 'topic'. Pokud text otázky obsahuje číslo lístku nebo otázky, můžeš doplnit i 'number'.\n"
        "Příklad:\n"
        '[{"id": "pq_1", "topic": "Pneumologie", "number": "1"}]'
    )

    prompt_user = (
        f"Zde je seznam otázek k didaktickému zařazení do lékařských oborů:\n"
        f"{json.dumps(compact_questions, ensure_ascii=False, indent=1)}"
    )

    gemini_model = payload.get("gemini_model") or "gemini-3.6-flash"
    try:
        response_text = await call_gemini_with_retries(
            model=gemini_model,
            contents=[prompt_user],
            system_instruction=prompt_system,
            temperature=0.1,
            response_mime_type="application/json"
        )

        classified = clean_and_parse_json(response_text)
        if not isinstance(classified, list) or len(classified) == 0:
            match = re.search(r"\[\s*\{.*\}\s*\]", response_text, re.DOTALL)
            if match:
                classified = json.loads(match.group(0), strict=False)

        topic_map = {}
        number_map = {}
        for item in (classified or []):
            if isinstance(item, dict) and "id" in item:
                if item.get("topic"):
                    topic_map[str(item["id"])] = str(item["topic"]).strip()
                if item.get("number"):
                    number_map[str(item["id"])] = str(item["number"]).strip()

        updated_count = 0
        categories_set = set()
        for idx, q in enumerate(questions):
            q_id = str(q.get("id") or f"pq_{idx+1}")
            if q_id in topic_map:
                q["topic"] = topic_map[q_id]
                updated_count += 1
            elif idx < len(classified) and isinstance(classified[idx], dict) and classified[idx].get("topic"):
                q["topic"] = str(classified[idx]["topic"]).strip()
                updated_count += 1

            if q_id in number_map and not q.get("number"):
                q["number"] = number_map[q_id]

            categories_set.add(q.get("topic") or "Všeobecné")

        planner_data["questions"] = questions
        with open(planner_file, "w", encoding="utf-8") as f:
            json.dump(planner_data, f, ensure_ascii=False, indent=2)

        categories_list = sorted(list(categories_set))
        await send_log(f"✅ AI úspěšně překategorizovala {updated_count} otázek do {len(categories_list)} oborů: {', '.join(categories_list[:5])}...")
        return {
            "status": "success",
            "project": safe_proj,
            "questions": questions,
            "categories": categories_list,
            "updated_count": updated_count
        }
    except Exception as e:
        await send_log(f"❌ Chyba při AI klasifikaci otázek: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Chyba AI klasifikace: {str(e)}")

# --- 2. VÝUKOVÁ LEKCE OD A DO Z (EDUCATIONAL LECTURE GENERATOR) ---
@app.post("/api/lessons/generate")
async def generate_lesson_endpoint(
    project_name: Optional[str] = Form(None),
    title: str = Form(...),
    target_language: str = Form("Čeština"),
    gemini_model: str = Form("gemini-3.6-flash"),
    tts_provider: str = Form("openai"),
    tts_voice: str = Form("onyx"),
    files: List[UploadFile] = File(...),
):
    if not title.strip():
        raise HTTPException(status_code=400, detail="Chybí název lekce.")
    if not files:
        raise HTTPException(status_code=400, detail="Musíte nahrát alespoň jeden soubor.")

    # Samostatný identifikátor lekce, ukládaný mimo prostor projektů (nepřidává se do projektů)
    raw_lesson_id = f"lekce_{title}"
    safe_lesson_id = sanitize_name(raw_lesson_id)

    # 1. Založení dedikované složky lekce v LESSONS_DIR (mimo uploads/)
    lesson_dir = os.path.join(LESSONS_DIR, safe_lesson_id)
    os.makedirs(lesson_dir, exist_ok=True)
    await send_log(f"🎓 Zahajuji tvorbu výukové lekce od A do Z: '{title}' (ID: {safe_lesson_id})")

    # 2. Uložení nahraných souborů na disk do složky lekce
    saved_file_tuples: List[Tuple[str, str]] = []
    for file in files:
        safe_fname = "".join([c for c in file.filename if c.isalnum() or c in (" ", ".", "_", "-")]).strip()
        fpath = os.path.join(lesson_dir, safe_fname)
        with open(fpath, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        saved_file_tuples.append((fpath, safe_fname))

    # Callback pro rozesílání progress událostí do SSE
    async def progress_notifier(evt_data: dict):
        await publish_event("lesson_progress", evt_data)

    try:
        lesson_result = await generate_lesson_package(
            project_id=safe_lesson_id,
            lesson_title=title,
            target_language=target_language,
            file_paths=saved_file_tuples,
            gemini_model=gemini_model,
            tts_provider=tts_provider,
            tts_voice=tts_voice,
            progress_callback=progress_notifier,
        )
        return lesson_result
    except Exception as e:
        friendly = friendly_api_error(e, "Gemini")
        await send_log(f"❌ Chyba při generování výukové lekce: {friendly}")
        raise HTTPException(status_code=500, detail=friendly)

@app.get("/api/lessons")
async def list_lessons_endpoint():
    try:
        lessons = list_lessons()
        return {"lessons": lessons}
    except Exception as e:
        return {"lessons": [], "error": str(e)}

@app.get("/api/lessons/{project_id}")
async def get_lesson_endpoint(project_id: str):
    safe_proj = sanitize_name(project_id)
    lesson = get_lesson(safe_proj)
    if not lesson:
        raise HTTPException(status_code=404, detail="Výuková lekce nenalezena.")
    return {"lesson": lesson}

@app.delete("/api/lessons/{project_id}")
async def delete_lesson_endpoint(project_id: str):
    safe_id = sanitize_name(project_id)
    from chat_service import delete_lesson_records
    delete_lesson_records(safe_id)

    # 1. Smazání dedikované složky lekce z LESSONS_DIR a UPLOAD_DIR
    for base_dir in [LESSONS_DIR, UPLOAD_DIR]:
        p = os.path.join(base_dir, safe_id)
        if os.path.exists(p):
            try:
                shutil.rmtree(p, ignore_errors=True)
            except Exception as e:
                print(f"⚠️ Chyba při mazání složky lekce {p}: {e}")

    # 2. Smazání ChromaDB kolekce lekce
    try:
        chroma_client.delete_collection(name=f"proj_{safe_id}")
    except Exception:
        pass

    # 3. Smazání generovaného audia lekce
    for fname in os.listdir(AUDIO_DIR):
        if fname.startswith(f"{safe_id}_"):
            try:
                os.remove(os.path.join(AUDIO_DIR, fname))
            except Exception:
                pass

    # 4. Smazání poznámek lekce
    for fname in os.listdir(NOTES_DIR):
        if fname.startswith(f"{safe_id}_"):
            try:
                os.remove(os.path.join(NOTES_DIR, fname))
            except Exception:
                pass

    await send_log(f"🗑️ Výuková lekce '{safe_id}' a veškerá její data byla úspěšně smazána.")
    return {"status": "success", "project": safe_id}


# =========================================================================
# 3. MEDULINGO™ (INTEGROVANÝ DUOLINGO MÓD PRO MEDICÍNU)
# =========================================================================
from medulingo_service import MedulingoService, MEDULINGO_PODCAST_PROMPT

@app.get("/api/medulingo/overview")
async def medulingo_overview_endpoint(project: str = ""):
    if not project:
        raise HTTPException(status_code=400, detail="Chybí parametr projektu.")
    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    return service.get_medulingo_overview(safe_proj)

@app.get("/api/medulingo/question/{question_id}")
async def medulingo_question_detail_endpoint(question_id: str, project: str = ""):
    if not project:
        raise HTTPException(status_code=400, detail="Chybí parametr projektu.")
    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    return service.get_question_path_content(safe_proj, question_id)

@app.post("/api/medulingo/generate-pack")
async def medulingo_generate_pack_endpoint(payload: dict = Body(...)):
    project = payload.get("project")
    question_id = payload.get("question_id")
    question_title = payload.get("question_title", "")
    modules = payload.get("modules", ["notes", "cards", "podcast", "test"])
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    tts_provider = payload.get("tts_provider", "openai")
    tts_voice = payload.get("tts_voice", "onyx")

    if not project or (not question_id and not question_title):
        raise HTTPException(status_code=400, detail="Chybí identifikátor otázky nebo projekt.")

    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)

    planner = service._get_planner_data(safe_proj)
    target_q = None
    for q in planner.get("questions", []):
        if q.get("id") == question_id or q.get("title") == question_title or str(q.get("number")) == str(question_id):
            target_q = q
            break

    q_title = target_q.get("title", question_title) if target_q else question_title
    q_topic = target_q.get("topic", "Všeobecné") if target_q else "Všeobecné"
    q_num = target_q.get("number", "1") if target_q else "1"

    await send_log(f"🦉 [Medulingo] Zahajuji on-demand generování pro: '{q_title}' ({', '.join(modules)})...")
    results = {}

    # 1. STUDIJNÍ TEXT
    if "notes" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 1/4 Generuji strukturovaný studijní text pro '{q_title}'...")
            notes_md, sources, n_file = await internal_generate_notes(
                question=q_title,
                project=safe_proj,
                custom_prompt="",
                gemini_model=gemini_model,
            )
            results["notes"] = {"status": "ok", "filename": n_file}
            if target_q:
                target_q["notesStatus"] = "Done"
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování textu: {e}")
            results["notes"] = {"status": "error", "error": str(e)}

    # 2. KARTIČKY (FLASHCARDS)
    if "cards" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 2/4 Generuji sérii flashcards pro '{q_title}'...")
            cards_data, c_file = await internal_generate_flashcards(
                question=q_title,
                project=safe_proj,
                count=10,
                custom_prompt="",
                gemini_model=gemini_model,
                force_regenerate=True,
            )
            results["cards"] = {"status": "ok", "filename": c_file, "count": len(cards_data.get("cards", []))}
            if target_q:
                target_q["cardsStatus"] = "Done"
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování kartiček: {e}")
            results["cards"] = {"status": "error", "error": str(e)}

    # 3. KRÁTKÝ PODCAST
    if "podcast" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 3/4 Vytvářím úderný Medulingo minipodcast pro '{q_title}'...")
            pod_prompt = MEDULINGO_PODCAST_PROMPT.replace("{QUESTION}", q_title)
            script, _ = await internal_generate_script(
                question=q_title,
                custom_prompt=pod_prompt,
                provider=tts_provider,
                project=safe_proj,
                gemini_model=gemini_model,
            )
            safe_q_name = sanitize_name(q_title[:30])
            audio_base_filename = f"{safe_proj}_Q{q_num}_{safe_q_name}"
            audio_url, audio_filename, _ = await internal_generate_audio(
                script=script,
                filename=audio_base_filename,
                provider=tts_provider,
                voice=tts_voice,
                output_format="mp3",
                question_title=f"Medulingo: {q_title}",
            )
            try:
                await create_srt_for_audio(script, audio_filename)
            except Exception:
                pass
            results["podcast"] = {"status": "ok", "audio_url": audio_url, "filename": audio_filename}
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování podcastu: {e}")
            results["podcast"] = {"status": "error", "error": str(e)}

    # 4. FINÁLNÍ TEST
    if "test" in modules:
        try:
            await send_log(f"🦉 [Medulingo] 4/4 Sestavuji finální test k otázce '{q_title}'...")
            test_data, t_file = await generate_practice_test(
                project=safe_proj,
                questions=[q_title],
                count=4,
                question_types=["single_choice", "multi_choice", "case_study"],
                difficulty="normal",
                mode="instant",
                custom_prompt="",
                gemini_model=gemini_model,
                tests_dir=TESTS_DIR,
                rag_query_fn=query_rag_context_with_sources,
                gemini_call_fn=call_gemini_with_retries,
                log_fn=send_log,
                categories=[q_topic],
                question_id=target_q.get("id") if target_q else question_id,
            )
            results["test"] = {"status": "ok", "filename": t_file, "count": len(test_data.get("questions", []))}
            if target_q:
                target_q["testsStatus"] = "Done"
                target_q["test_file"] = t_file
        except Exception as e:
            await send_log(f"⚠️ [Medulingo] Chyba generování testu: {e}")
            results["test"] = {"status": "error", "error": str(e)}

    if target_q:
        service._save_planner_data(safe_proj, planner)

    await send_log(f"🎉 [Medulingo] Balíček pro '{q_title}' byl úspěšně připraven!")

    fresh_details = service.get_question_path_content(safe_proj, target_q.get("id", question_id) if target_q else question_id)
    return {
        "status": "success",
        "results": results,
        "question_details": fresh_details,
    }

@app.post("/api/medulingo/complete")
async def medulingo_complete_endpoint(payload: dict = Body(...)):
    project = payload.get("project")
    question_id = payload.get("question_id")
    grade = payload.get("grade", "A")
    completed = payload.get("completed", True)

    if not project or not question_id:
        raise HTTPException(status_code=400, detail="Chybí projekt nebo question_id.")

    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    res = service.complete_question(safe_proj, question_id, grade, completed=completed)
    status_str = f"úspěšně splněna se známkou {grade}" if completed else "označena jako nesplněná"
    await send_log(f"🏆 [Medulingo] Otázka '{question_id}' {status_str}!")
    return res


# =========================================================================
# ENDPOINTY PRO NASTAVENÍ A VLASTNÍ API KLÍČE (BYOK)
# =========================================================================

@app.get("/api/settings")
async def get_settings():
    cfg = load_user_config()
    g_key = (cfg.get("gemini_api_key") or os.getenv("GEMINI_API_KEY") or "").strip()
    o_key = (cfg.get("openai_api_key") or os.getenv("OPENAI_API_KEY") or "").strip()
    e_key = (cfg.get("elevenlabs_api_key") or os.getenv("ELEVENLABS_API_KEY") or "").strip()

    def mask(k: str) -> str:
        if not k:
            return ""
        if len(k) <= 8:
            return "****"
        return k[:4] + "..." + k[-4:]

    return {
        "gemini_configured": bool(g_key),
        "gemini_masked": mask(g_key),
        "openai_configured": bool(o_key),
        "openai_masked": mask(o_key),
        "elevenlabs_configured": bool(e_key),
        "elevenlabs_masked": mask(e_key),
        "user_data_dir": USER_DATA_DIR,
        "is_desktop": IS_FROZEN,
        "pomodoro_settings": cfg.get("pomodoro_settings", {}),
    }


@app.post("/api/settings")
async def save_settings(payload: dict[str, Any] = Body(...)):
    cfg = load_user_config()

    if "gemini_api_key" in payload:
        val = str(payload["gemini_api_key"]).strip()
        if "..." not in val:
            cfg["gemini_api_key"] = val
    if "openai_api_key" in payload:
        val = str(payload["openai_api_key"]).strip()
        if "..." not in val:
            cfg["openai_api_key"] = val
    if "elevenlabs_api_key" in payload:
        val = str(payload["elevenlabs_api_key"]).strip()
        if "..." not in val:
            cfg["elevenlabs_api_key"] = val
    if "pomodoro_settings" in payload and isinstance(payload["pomodoro_settings"], dict):
        cfg["pomodoro_settings"] = payload["pomodoro_settings"]

    save_user_config(cfg)
    await send_log("⚙️ Nastavení API klíčů a preferencí bylo úspěšně uloženo.")
    return {"status": "success", "message": "Nastavení bylo úspěšně uloženo."}


@app.post("/api/settings/test-key")
async def test_api_key(payload: dict[str, Any] = Body(...)):
    provider = payload.get("provider", "gemini")
    key = str(payload.get("key") or "").strip()

    if not key or "..." in key:
        if provider == "gemini":
            key = get_gemini_api_key()
        elif provider == "openai":
            key = get_openai_api_key()
        elif provider == "elevenlabs":
            key = get_elevenlabs_api_key()

    if not key:
        return {"valid": False, "message": f"Klíč pro {provider.upper()} není zadán."}

    try:
        if provider == "gemini":
            test_client = genai.Client(api_key=key)
            test_model = str(payload.get("model") or "gemini-3.6-flash").strip()
            # Rychlé ověření modelu s automatickým fallbackem
            try:
                await asyncio.to_thread(
                    test_client.models.generate_content,
                    model=test_model,
                    contents="ping",
                    config=types.GenerateContentConfig(max_output_tokens=10),
                )
            except Exception as test_err:
                err_str = str(test_err).lower()
                if ("404" in err_str or "not_found" in err_str) and test_model != "gemini-flash-latest":
                    await asyncio.to_thread(
                        test_client.models.generate_content,
                        model="gemini-flash-latest",
                        contents="ping",
                        config=types.GenerateContentConfig(max_output_tokens=10),
                    )
                    test_model = "gemini-flash-latest"
                else:
                    raise test_err
            return {"valid": True, "message": f"Google Gemini API klíč je platný a připraven k použití ({test_model})!"}

        elif provider == "openai":
            test_client = OpenAI(api_key=key)
            await asyncio.to_thread(test_client.models.list)
            return {"valid": True, "message": "OpenAI API klíč je platný a ověřen!"}

        elif provider == "elevenlabs":
            async with httpx.AsyncClient(timeout=10) as http_client:
                res = await http_client.get(
                    "https://api.elevenlabs.io/v1/user",
                    headers={"xi-api-key": key},
                )
                if res.status_code == 200:
                    data = res.json()
                    char_count = data.get("subscription", {}).get("character_count", 0)
                    char_limit = data.get("subscription", {}).get("character_limit", 0)
                    return {
                        "valid": True,
                        "message": f"ElevenLabs klíč je platný! Využito: {char_count:,} z {char_limit:,} znaků.",
                    }
                else:
                    return {"valid": False, "message": f"ElevenLabs vrátil chybu {res.status_code}: {res.text[:100]}"}

        else:
            return {"valid": False, "message": f"Neznámý poskytovatel: {provider}"}

    except Exception as e:
        print(f"⚠️ Test klíče selhal pro {provider}: {e}")
        if provider == "gemini":
            friendly = friendly_api_error(e, "Gemini")
            detail = extract_gemini_error_detail(e)
            msg = friendly if friendly != str(e) else f"Chyba ověření ({detail})"
            return {"valid": False, "message": msg}
        return {"valid": False, "message": f"Chyba ověření: {str(e)[:150]}"}


@app.post("/api/settings/open-data-folder")
async def open_data_folder():
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", USER_DATA_DIR])
        elif sys.platform == "win32":
            os.startfile(USER_DATA_DIR)
        else:
            subprocess.Popen(["xdg-open", USER_DATA_DIR])
        return {"status": "success", "path": USER_DATA_DIR}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Nelze otevřít složku: {e}")


# --- TISKOVÝ SERVIS (DEDIKOVANÝ NÁHLED A EXPORT DO PDF) ---
_print_jobs: dict[str, dict[str, Any]] = {}

@app.post("/api/print/prepare")
async def prepare_print_job(request: Request, payload: dict = Body(...)):
    """
    Přijme vygenerovaný HTML obsah a metadata k tisku.
    Uloží data do dočasné mezipaměti a vrátí URL adresu čistého tiskového náhledu.
    Pokud je požadováno (auto_open_browser), otevře odkaz v systémovém prohlížeči.
    """
    doc_id = uuid.uuid4().hex[:10]
    title = str(payload.get("title", "")).strip() or "Studijní dokument"
    html_content = str(payload.get("html", "")).strip()
    project = str(payload.get("project", "")).strip()
    auto_open = bool(payload.get("auto_open_browser", False))
    now_ts = datetime.now().timestamp()

    _print_jobs[doc_id] = {
        "title": title,
        "html": html_content,
        "project": project,
        "created_at": now_ts,
    }

    # Úklid úloh starších než 2 hodiny
    for k in list(_print_jobs.keys()):
        if now_ts - _print_jobs[k].get("created_at", 0) > 7200:
            _print_jobs.pop(k, None)

    base_url = str(request.base_url).rstrip("/")
    full_url = f"{base_url}/print_preview/{doc_id}"

    if auto_open:
        try:
            webbrowser.open(full_url)
        except Exception as e:
            print(f"⚠️ Nepodařilo se automaticky otevřít systémový prohlížeč pro tisk: {e}")

    return {"status": "ok", "doc_id": doc_id, "url": full_url}


@app.get("/print_preview/{doc_id}", response_class=HTMLResponse)
async def view_print_preview_page(doc_id: str):
    job = _print_jobs.get(doc_id)
    if not job:
        raise HTTPException(status_code=404, detail="Tiskový dokument nebyl nalezen nebo vypršela jeho platnost.")

    safe_title = html_lib.escape(job["title"])
    safe_project = html_lib.escape(job["project"] or "Hlavní projekt")
    date_str = datetime.now().strftime("%d.%m.%Y %H:%M")
    rendered_body = job["html"]

    html = f"""<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{safe_title} | AI MedStudio Tisk</title>
    <style>
        *, *::before, *::after {{
            box-sizing: border-box;
        }}
        body {{
            margin: 0;
            padding: 0;
            background-color: #f8fafc;
            color: #0f172a;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }}
        .print-toolbar {{
            position: sticky;
            top: 0;
            z-index: 1000;
            background: #0f172a;
            color: #f8fafc;
            padding: 12px 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            font-size: 14px;
        }}
        .print-toolbar-title {{
            font-weight: 700;
            display: flex;
            align-items: center;
            gap: 8px;
        }}
        .print-btn-primary {{
            background: #059669;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-weight: 700;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s ease;
        }}
        .print-btn-primary:hover {{
            background: #047857;
        }}
        .print-btn-secondary {{
            background: #334155;
            color: #cbd5e1;
            border: none;
            padding: 8px 14px;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.15s ease;
        }}
        .print-btn-secondary:hover {{
            background: #475569;
            color: white;
        }}
        .page-sheet {{
            max-width: 860px;
            margin: 24px auto;
            background: white;
            padding: 48px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.06);
            border: 1px solid #e2e8f0;
        }}
        .doc-header {{
            border-bottom: 2px solid #0f172a;
            padding-bottom: 16px;
            margin-bottom: 28px;
        }}
        .doc-badge {{
            display: inline-block;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #059669;
            margin-bottom: 6px;
        }}
        .doc-title {{
            font-size: 26px;
            font-weight: 800;
            margin: 0 0 8px 0;
            color: #0f172a;
            line-height: 1.25;
        }}
        .doc-meta {{
            font-size: 12px;
            color: #64748b;
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
        }}
        /* Typography */
        .markdown-content h1 {{ font-size: 20px; font-weight: 800; margin: 24px 0 12px 0; border-bottom: 1px solid #cbd5e1; padding-bottom: 6px; page-break-after: avoid; color: #0f172a; }}
        .markdown-content h2 {{ font-size: 17px; font-weight: 700; margin: 20px 0 10px 0; page-break-after: avoid; color: #1e293b; }}
        .markdown-content h3 {{ font-size: 15px; font-weight: 700; margin: 16px 0 8px 0; page-break-after: avoid; color: #334155; }}
        .markdown-content h4 {{ font-size: 14px; font-weight: 700; margin: 14px 0 6px 0; page-break-after: avoid; color: #475569; }}
        .markdown-content p {{ margin: 0 0 12px 0; }}
        .markdown-content ul, .markdown-content ol {{ margin: 0 0 14px 0; padding-left: 24px; }}
        .markdown-content li {{ margin-bottom: 6px; }}
        .markdown-content table {{
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
            font-size: 12.5px;
            page-break-inside: avoid;
        }}
        .markdown-content th, .markdown-content td {{
            border: 1px solid #cbd5e1;
            padding: 8px 10px;
            text-align: left;
            vertical-align: top;
        }}
        .markdown-content th {{
            background-color: #f1f5f9;
            font-weight: 700;
            color: #0f172a;
        }}
        .markdown-content tr:nth-child(even) {{
            background-color: #f8fafc;
        }}
        .markdown-content blockquote {{
            border-left: 4px solid #0ea5e9;
            margin: 14px 0;
            padding: 8px 16px;
            background: #f0f9ff;
            color: #0369a1;
            border-radius: 0 6px 6px 0;
        }}
        .markdown-content pre, .markdown-content code {{
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 12px;
        }}
        .markdown-content code {{
            background: #f1f5f9;
            color: #0f172a;
            padding: 2px 5px;
            border-radius: 4px;
            border: 1px solid #e2e8f0;
        }}
        .markdown-content pre {{
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            page-break-inside: avoid;
        }}
        .markdown-content sup {{
            font-weight: 700;
            color: #0369a1;
            font-size: 9px;
            padding: 1px 4px;
            background: #e0f2fe;
            border-radius: 3px;
            margin-left: 2px;
        }}
        .doc-footer {{
            margin-top: 40px;
            padding-top: 16px;
            border-top: 1px solid #e2e8f0;
            font-size: 11px;
            color: #94a3b8;
            display: flex;
            justify-content: space-between;
        }}

        @media print {{
            body {{
                background: white !important;
                color: black !important;
            }}
            .print-toolbar {{
                display: none !important;
            }}
            .page-sheet {{
                max-width: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
            }}
            @page {{
                size: A4;
                margin: 16mm 14mm 16mm 14mm;
            }}
            a {{
                text-decoration: none;
                color: inherit;
            }}
        }}
    </style>
</head>
<body>
    <div class="print-toolbar">
        <div class="print-toolbar-title">
            <span>🩺 AI MedStudio</span>
            <span style="opacity: 0.5;">|</span>
            <span style="font-weight: 500; font-size: 13px;">Tiskový náhled: {safe_title}</span>
        </div>
        <div style="display: flex; gap: 8px;">
            <button onclick="window.print()" class="print-btn-primary">
                <span>🖨️</span> Vytisknout / Uložit do PDF
            </button>
            <button onclick="window.close()" class="print-btn-secondary">
                Zavřít
            </button>
        </div>
    </div>
    <div class="page-sheet">
        <header class="doc-header">
            <div class="doc-badge">AI MedStudio &bull; Studijní materiály</div>
            <h1 class="doc-title">{safe_title}</h1>
            <div class="doc-meta">
                <span><strong>Projekt:</strong> {safe_project}</span>
                <span><strong>Vygenerováno:</strong> {date_str}</span>
            </div>
        </header>
        <article class="markdown-content">
            {rendered_body}
        </article>
        <footer class="doc-footer">
            <span>AI MedStudio – Vytvořeno pro lékařskou fakultu (RAG Syntéza & Citace)</span>
            <span>Vytištěno: {date_str}</span>
        </footer>
    </div>
    <script>
        window.addEventListener('load', function() {{
            setTimeout(function() {{
                window.print();
            }}, 350);
        }});
    </script>
</body>
</html>"""
    return HTMLResponse(content=html)


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/lessons-data", StaticFiles(directory=LESSONS_DIR), name="lessons-data")
app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")
app.mount("/notes-files", StaticFiles(directory=NOTES_DIR), name="notes-files")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host=host, port=port, reload=False)
