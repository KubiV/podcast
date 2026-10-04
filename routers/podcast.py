import os
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from core.config import AUDIO_DIR
from core.logger import send_log
from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from services.podcast_service import (
    create_srt_for_audio,
    internal_generate_audio,
    internal_generate_script,
)

router = APIRouter()


@router.get("/api/outputs")
async def list_outputs(project: str = ""):
    try:
        files = [f for f in os.listdir(AUDIO_DIR) if f.endswith((".mp3", ".mp4", ".srt"))]
        if project:
            safe_proj = sanitize_name(project)
            files = [f for f in files if f.startswith(f"{safe_proj}_")]

        files.sort(key=lambda x: os.path.getmtime(os.path.join(AUDIO_DIR, x)), reverse=True)
        return {"files": files}
    except Exception as e:
        return {"files": [], "error": str(e)}


@router.delete("/api/outputs/{filename}")
async def delete_output(filename: str):
    file_path = safe_join(AUDIO_DIR, safe_filename(filename))
    if os.path.exists(file_path):
        os.remove(file_path)
        await send_log(f"🗑️ Vymazán soubor média: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Soubor nenalezen.")


@router.post("/api/generate-script")
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


@router.post("/api/generate-audio")
async def generate_audio(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename", "podcast")
    provider = payload.get("provider", "openai")
    voice = payload.get("voice", "onyx")
    output_format = payload.get("format", "mp3")
    question_title = payload.get("question_title", filename)

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
async def generate_subtitles_endpoint(payload: dict = Body(...)):
    script = payload.get("script")
    filename = payload.get("filename")

    success = await create_srt_for_audio(script, filename)
    if success:
        return {"status": "success", "message": "Titulky vygenerovány."}
    else:
        raise HTTPException(status_code=500, detail="Titulky se nepodařilo vygenerovat.")


# --- STATISTIKY PRO DASHBOARD ---
