import os
import traceback
import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException

from core.authz import require_project_access
from core.clients import require_allowed_model
from core.logger import BatchState, active_batches, send_log
from core.utils import sanitize_name
from services.batch import BatchTexts, run_question_batch
from services.flashcards_service import internal_generate_flashcards
from services.notes_service import internal_generate_notes
from services.podcast_service import (
    create_srt_for_audio,
    internal_generate_audio,
    internal_generate_script,
)

router = APIRouter()


PODCAST_BATCH_TEXTS = BatchTexts(
    started="🚀 Spouštím dávkové zpracování podcastů pro {questions} otázek...",
    cancelled_by_user="🛑 Dávkové zpracování bylo zrušeno uživatelem!",
    processing="▶️ [{idx}/{total}] Zpracovávám otázku: {title}",
    question_done="🎉 Hotovo [{idx}/{total}].",
    question_failed="⚠️ Otázku '{title}' se nepodařilo dokončit: {error}. Pokračuji v dávce...",
    sweep_round="🌙 [Noční kontrola podcastů – kolo {round}/{max_rounds}]: Znovu zkouším {count} nedokončených otázek...",
    sweep_retry="🔄 Doplňovací pokus podcastu: {title}...",
    finished_cancelled="🏁 Dávkové zpracování podcastů bylo zrušeno.",
    finished_completed="🏁 Dávkové zpracování podcastů kompletně dokončeno ({total}/{total} hotovo)!",
    finished_with_errors="🏁 Dávka podcastů dokončena: {done}/{total} hotovo, {pending} neúspěšných.",
    aborted="❌ Dávkové zpracování přerušeno chybou: {error}",
)

NOTES_BATCH_TEXTS = BatchTexts(
    started="🚀 Spouštím dávkové generování studijních textů pro {questions} otázek...",
    cancelled_by_user="🛑 Dávkové generování poznámek bylo zrušeno uživatelem!",
    processing="📝 [{idx}/{total}] Generuji studijní text: {title}",
    question_done="🎉 Text k otázce [{idx}/{total}] vygenerován a uložen.",
    question_failed="⚠️ Otázku '{title}' se nepodařilo vygenerovat: {error}. Pokračuji v dávce...",
    sweep_round="🌙 [Noční kontrola textů – kolo {round}/{max_rounds}]: Znovu zkouším {count} nedokončených otázek...",
    sweep_retry="🔄 Doplňovací pokus textu: {title}...",
    finished_cancelled="🏁 Dávkové generování studijních textů bylo zrušeno.",
    finished_completed="🏁 Dávkové generování textů kompletně dokončeno ({total}/{total} hotovo)!",
    finished_with_errors="🏁 Dávka textů dokončena: {done}/{total} hotovo, {pending} neúspěšných.",
    aborted="❌ Dávkové generování textů přerušeno: {error}",
)


def flashcards_batch_texts(count: int) -> BatchTexts:
    return BatchTexts(
        started=f"🚀 Spouštím dávkové generování kartiček ({count} ks/otázka) pro {{questions}} otázek...",
        cancelled_by_user="🛑 Dávkové generování kartiček bylo zrušeno uživatelem!",
        processing=f"🗂️ [{{idx}}/{{total}}] Generuji {count} kartiček: {{title}}",
        question_done="🎉 Kartičky k otázce [{idx}/{total}] vytvořeny a uloženy.",
        question_failed="⚠️ Otázku '{title}' se nepodařilo vygenerovat: {error}. Pokračuji v dávce...",
        sweep_round="🌙 [Noční kontrola kartiček – kolo {round}/{max_rounds}]: Znovu zkouším {count} nedokončených otázek...",
        sweep_retry="🔄 Doplňovací pokus kartiček: {title}...",
        finished_cancelled="🏁 Dávkové generování kartiček bylo zrušeno.",
        finished_completed="🏁 Dávkové generování kartiček kompletně dokončeno ({total}/{total} hotovo)!",
        finished_with_errors="🏁 Dávka kartiček dokončena: {done}/{total} hotovo, {pending} neúspěšných.",
        aborted="❌ Dávkové generování kartiček přerušeno: {error}",
    )


# --- ZRUŠENÍ DÁVKOVÉHO PROCESU ---
@router.post("/api/cancel-batch")
async def cancel_batch(payload: dict = Body(...)):
    project = sanitize_name(payload.get("project", ""))
    require_project_access(project, write=True)
    batch = active_batches.get(project)
    if not batch:
        return {"status": "not_running"}

    batch.cancel_requested = True
    await send_log(
        "🛑 Požadavek na zrušení dávky byl přijat. Dokončující API volání doběhne, další otázka se už nespustí."
    )
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
    async def produce(batch, title, question_index) -> bool:
        script, _ = await internal_generate_script(title, custom_prompt, provider, project, gemini_model)
        if batch.cancel_requested:
            return False
        safe_filename = f"{project}_Q{question_index}_{title[:15]}"
        await internal_generate_audio(script, safe_filename, provider, voice, output_format, title)
        return True

    await run_question_batch(
        project=project,
        batch_id=batch_id,
        questions=questions,
        mode="podcast",
        overnight_mode=overnight_mode,
        texts=PODCAST_BATCH_TEXTS,
        produce=produce,
        stop_on_auth_error=False,
    )


@router.post("/api/process-batch")
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
    require_project_access(project, write=True)
    require_allowed_model(gemini_model)

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
    async def produce(batch, title, question_index) -> bool:
        await internal_generate_notes(title, project, custom_prompt, gemini_model)
        return True

    await run_question_batch(
        project=project,
        batch_id=batch_id,
        questions=questions,
        mode="notes",
        overnight_mode=overnight_mode,
        texts=NOTES_BATCH_TEXTS,
        produce=produce,
        stop_on_auth_error=True,
    )


@router.post("/api/process-notes-batch")
async def process_notes_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    custom_prompt = payload.get("prompt", "")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky nebo projekt.")
    require_project_access(project, write=True)
    require_allowed_model(gemini_model)

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
    async def produce(batch, title, question_index) -> bool:
        await internal_generate_flashcards(title, project, count, custom_prompt, gemini_model)
        return True

    await run_question_batch(
        project=project,
        batch_id=batch_id,
        questions=questions,
        mode="flashcards",
        overnight_mode=overnight_mode,
        texts=flashcards_batch_texts(count),
        produce=produce,
        stop_on_auth_error=True,
    )


@router.post("/api/process-flashcards-batch")
async def process_flashcards_batch(background_tasks: BackgroundTasks, payload: dict = Body(...)):
    questions = payload.get("questions", [])
    count = int(payload.get("count", 10))
    custom_prompt = payload.get("prompt", "")
    project = sanitize_name(payload.get("project", ""))
    gemini_model = payload.get("gemini_model", "gemini-3.6-flash")
    overnight_mode = bool(payload.get("overnight_mode", True))

    if not questions or not project:
        raise HTTPException(status_code=400, detail="Chybí otázky nebo projekt.")
    require_project_access(project, write=True)
    require_allowed_model(gemini_model)

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
