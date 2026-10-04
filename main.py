import asyncio
import base64
import os
import secrets
import shutil
import sys
from datetime import datetime
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from core.clients import (
    get_chroma_client,
    get_elevenlabs_api_key,
    get_gemini_api_key,
    get_gemini_client,
    get_openai_api_key,
    get_openai_client,
)
from core.config import (
    APP_PASSWORD,
    AUDIO_DIR,
    BUNDLE_DIR,
    DB_DIR,
    FLASHCARDS_DIR,
    IS_FROZEN,
    LESSONS_DIR,
    NOTES_DIR,
    STATIC_DIR,
    TESTS_DIR,
    UPLOAD_DIR,
    USER_DATA_DIR,
    load_user_config,
    save_user_config,
)
from core.context import (
    current_language_var,
    current_user_var,
    get_current_language,
    get_language_directive,
)
from core.logger import (
    LOG_SUBSCRIBER_QUEUE_SIZE,
    BatchState,
    active_batches,
    log_history,
    log_subscribers,
    publish_event,
    send_batch_event,
    send_log,
    serialize_sse,
)
from core.security import safe_filename, safe_join
from core.utils import (
    chunk_text,
    extract_gemini_error_detail,
    friendly_api_error,
    is_retryable_gemini_error,
    sanitize_name,
)
from routers.auth import init as auth_init
from routers.auth import router as auth_router
from routers.batch import router as batch_router
from routers.chat_api import router as chat_api_router
from routers.files import router as files_router
from routers.flashcards import router as flashcards_router
from routers.medulingo import router as medulingo_router
from routers.notes import router as notes_router
from routers.podcast import router as podcast_router
from routers.print import router as print_router
from routers.projects import router as projects_router
from routers.settings import router as settings_router
from routers.tests_api import router as tests_api_router
from services.ai_service import (
    call_gemini_with_resilience,
    call_gemini_with_retries,
    clean_and_parse_json,
    get_fallback_model,
)
from services.auth_service import AuthService
from services.flashcards_service import (
    build_anki_tsv,
    build_quizlet_text,
    internal_generate_flashcards,
    normalize_front,
    resolve_card_source,
)
from services.notes_service import (
    internal_generate_notes,
    sanitize_markdown_tables,
)
from services.podcast_service import (
    create_mp4_with_subtitles,
    create_srt_for_audio,
    enrich_prompt_for_tts,
    internal_generate_audio,
    internal_generate_script,
)
from services.rag_service import (
    chunk_sections_with_metadata,
    decompose_question_to_subqueries,
    extract_sections_from_file,
    extract_text_from_file,
    index_file_to_chroma,
    query_rag_context_with_sources,
)

load_dotenv()

# Inicializace služby pro správu uživatelů a zabezpečení
auth_service = AuthService(USER_DATA_DIR)

# Přidání lokálního ffmpeg do PATH, pokud existuje
for b_dir in [BUNDLE_DIR, os.path.join(BUNDLE_DIR, "bin"), os.path.dirname(sys.executable) if IS_FROZEN else ""]:
    if b_dir and os.path.exists(b_dir):
        if (sys.platform == "win32" and os.path.exists(os.path.join(b_dir, "ffmpeg.exe"))) or (
            sys.platform != "win32" and os.path.exists(os.path.join(b_dir, "ffmpeg"))
        ):
            os.environ["PATH"] = b_dir + os.pathsep + os.environ.get("PATH", "")
            break


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

app = FastAPI(title="AI MedStudio")


# --- Auth Middleware ---
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path

    # Veřejně přístupné cesty:
    if (
        path in ("/health", "/manifest.json", "/icon.svg", "/favicon.ico", "/", "/index.html")
        or path.startswith("/css/")
        or path.startswith("/js/")
        or path.startswith("/static/")
        or path.startswith("/api/auth/status")
        or path.startswith("/api/auth/setup")
        or path.startswith("/api/auth/login")
        or path.startswith("/api/auth/register")
        or path.startswith("/api/auth/logout")
    ):
        token = request.cookies.get("medstudio_session")
        if not token:
            auth_h = request.headers.get("Authorization")
            if auth_h and auth_h.startswith("Bearer "):
                token = auth_h.split(" ", 1)[1].strip()
        user = auth_service.validate_session(token) if token else None

        if not user and auth_service.is_guest_allowed():
            user = {
                "id": -1,
                "username": "host",
                "email": None,
                "role": "viewer",
                "status": "approved",
                "is_guest": True,
            }

        request.state.user = user
        current_user_var.set(user)
        req_lang = (request.headers.get("x-app-language") or request.query_params.get("lang") or "cs").lower().strip()
        current_language_var.set(req_lang if req_lang in ("cs", "en", "fr") else "cs")
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

    if not user and auth_service.is_guest_allowed():
        user = {
            "id": -1,
            "username": "host",
            "email": None,
            "role": "viewer",
            "status": "approved",
            "is_guest": True,
        }

    if not user:
        if auth_service.needs_setup():
            return JSONResponse(
                status_code=401,
                content={"detail": "Systém vyžaduje prvotní nastavení administrátora.", "needs_setup": True},
            )
        return JSONResponse(
            status_code=401,
            content={"detail": "Přístup vyžaduje přihlášení.", "authenticated": False},
        )

    # Omezení pro roli 'viewer' (pozorovatel / host)
    if user.get("role") == "viewer":
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            is_allowed = path.startswith("/api/auth/") or path in (
                "/api/print/prepare",
                "/api/tests/evaluate-open-answer",
            )
            if not is_allowed:
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": "Režim pozorovatele: Nemáte oprávnění generovat nový obsah, nahrávat ani mazat data. Můžete pouze procházet a studovat již vytvořené materiály.",
                        "role": "viewer",
                    },
                )

    request.state.user = user
    current_user_var.set(user)
    req_lang = (request.headers.get("x-app-language") or request.query_params.get("lang") or "cs").lower().strip()
    current_language_var.set(req_lang if req_lang in ("cs", "en", "fr") else "cs")
    return await call_next(request)


# --- Core System Endpoints ---


@app.get("/api/logs")
async def stream_logs():
    async def event_generator():
        subscriber: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=LOG_SUBSCRIBER_QUEUE_SIZE)
        log_subscribers.add(subscriber)
        try:
            for log_message in tuple(log_history):
                yield serialize_sse("log", {"message": log_message})

            while True:
                event_name, payload = await subscriber.get()
                yield serialize_sse(event_name, payload)
        finally:
            log_subscribers.discard(subscriber)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# --- Registrace modulárních routerů ---
auth_init(auth_service)
app.include_router(auth_router)
app.include_router(settings_router)
app.include_router(projects_router)
app.include_router(files_router)
app.include_router(podcast_router)
app.include_router(notes_router)
app.include_router(flashcards_router)
app.include_router(batch_router)
app.include_router(tests_api_router)
app.include_router(medulingo_router)
app.include_router(chat_api_router)
app.include_router(print_router)

# --- Statické soubory ---
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
