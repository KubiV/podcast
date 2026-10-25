import os

from fastapi import APIRouter, Body, HTTPException

from core.authz import filter_accessible_output_files, require_output_file_access, require_project_access
from core.clients import require_allowed_model
from core.config import AI, AUDIO_DIR
from core.logger import send_log
from core.request_models import RequestModel
from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from services.podcast_service import (
    audio_filename_for,
    create_srt_for_audio,
    internal_generate_audio,
    internal_generate_script,
)


class GenerateScriptRequest(RequestModel):
    """Tělo '/api/generate-script'."""

    question: str | None = None
    prompt: str | None = None
    provider: str | None = "openai"
    project: str | None = None
    gemini_model: str | None = AI.default_gemini_model


class GenerateAudioRequest(RequestModel):
    """Tělo '/api/generate-audio'."""

    script: str | None = None
    filename: str | None = "podcast"
    question_title: str | None = None
    provider: str | None = "openai"
    voice: str | None = "onyx"
    format: str | None = "mp3"


class GenerateSubtitlesRequest(RequestModel):
    """Tělo '/api/generate-subtitles'."""

    script: str | None = None
    filename: str | None = None


router = APIRouter()


@router.get("/api/outputs")
async def list_outputs(project: str = ""):
    if project:
        require_project_access(project)
    try:
        files = [f for f in os.listdir(AUDIO_DIR) if f.endswith((".mp3", ".mp4", ".srt"))]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]
        files = filter_accessible_output_files(files)

        files.sort(key=lambda x: os.path.getmtime(os.path.join(AUDIO_DIR, x)), reverse=True)
        return {"files": files}
    except Exception as e:
        return {"files": [], "error": str(e)}


@router.delete("/api/outputs/{filename}")
async def delete_output(filename: str):
    require_output_file_access(safe_filename(filename), write=True)
    file_path = safe_join(AUDIO_DIR, safe_filename(filename))
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Vymazán soubor média: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")


@router.post("/api/generate-script")
async def generate_script(payload: GenerateScriptRequest = Body(...)):
    question = payload.question
    custom_prompt = payload.prompt
    provider = payload.provider
    project = payload.project
    gemini_model = payload.gemini_model

    if not question or not custom_prompt or not project:
        raise HTTPException(status_code=400, detail="Chybí parametry dotazu.")
    require_project_access(project, write=True)
    require_allowed_model(gemini_model)

    try:
        script, context = await internal_generate_script(question, custom_prompt, provider, project, gemini_model)
        return {"script": script, "context": context}
    except Exception as e:
        await send_log(f"❌ Chyba při generování scénáře: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/generate-audio")
async def generate_audio(payload: GenerateAudioRequest = Body(...)):
    script = payload.script
    filename = payload.filename
    provider = payload.provider
    voice = payload.voice
    output_format = payload.format
    question_title = payload.question_title if "question_title" in payload.model_fields_set else filename
    require_output_file_access(safe_filename(audio_filename_for(str(filename))), write=True)

    await send_log(f"🔊 Spouštím TTS syntézu přes {provider}...")
    try:
        audio_url, audio_filename, final_format = await internal_generate_audio(
            script, filename, provider, voice, output_format, question_title
        )
        return {"audio_url": audio_url, "filename": audio_filename, "format": final_format}
    except Exception as e:
        await send_log(f"❌ Tvorba záznamu selhala: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/generate-subtitles")
async def generate_subtitles_endpoint(payload: GenerateSubtitlesRequest = Body(...)):
    script = payload.script
    filename = payload.filename
    require_output_file_access(safe_filename(str(filename or "")), write=True)

    success = await create_srt_for_audio(script, filename)
    if success:
        return {"status": "success", "message": "Titulky vygenerovány."}
    else:
        raise HTTPException(status_code=500, detail="Titulky se nepodařilo vygenerovat.")


# --- STATISTIKY PRO DASHBOARD ---
