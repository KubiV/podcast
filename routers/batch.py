import asyncio
import os
import traceback
import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException

from core.logger import BatchState, active_batches, send_batch_event, send_log
from core.utils import friendly_api_error, is_terminal_auth_error, sanitize_name
from services.flashcards_service import internal_generate_flashcards
from services.notes_service import internal_generate_notes
from services.podcast_service import (
    create_srt_for_audio,
    internal_generate_audio,
    internal_generate_script,
)

router = APIRouter()


# --- ZRUŠENÍ DÁVKOVÉHO PROCESU ---
@router.post("/api/cancel-batch")
async def cancel_batch(payload: dict = Body(...)):
    project = sanitize_name(payload.get("project", ""))
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

            title = question_data.get("title")
            question_index = question_data.get("q_index")
            await send_log(f"▶️ [{idx + 1}/{len(questions)}] Zpracovávám otázku: {title}")

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
                        await send_log(
                            f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s..."
                        )
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
                await send_log(f"🎉 Hotovo [{idx + 1}/{len(questions)}].")
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
                await send_log(
                    f"🌙 [Noční kontrola podcastů – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek..."
                )
                await asyncio.sleep(6.0)
                still_failed = []
                for q_data in failed_questions:
                    if batch.cancel_requested:
                        break
                    q_title = q_data.get("title")
                    q_idx = q_data.get("q_index")
                    await send_log(f"🔄 Doplňovací pokus podcastu: {q_title[:35]}...")
                    try:
                        script, _ = await internal_generate_script(
                            q_title, custom_prompt, provider, project, gemini_model
                        )
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
            await send_log(
                f"🏁 Dávkové zpracování podcastů kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!"
            )
        else:
            outcome = "completed_with_errors"
            await send_log(
                f"🏁 Dávka podcastů dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných."
            )

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
            await send_log(f"📝 [{idx + 1}/{len(questions)}] Generuji studijní text: {title}")

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
                        await send_log(
                            f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s..."
                        )
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
                await send_log(f"🎉 Text k otázce [{idx + 1}/{len(questions)}] vygenerován a uložen.")
            else:
                await send_log(
                    f"⚠️ Otázku '{title[:35]}' se nepodařilo vygenerovat: {str(last_err)}. Pokračuji v dávce..."
                )
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
                await send_log(
                    f"🌙 [Noční kontrola textů – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek..."
                )
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
            await send_log(
                f"🏁 Dávkové generování textů kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!"
            )
        else:
            outcome = "completed_with_errors"
            await send_log(
                f"🏁 Dávka textů dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných."
            )

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


@router.post("/api/process-notes-batch")
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
            await send_log(f"🗂️ [{idx + 1}/{len(questions)}] Generuji {count} kartiček: {title}")

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
                        await send_log(
                            f"⚠️ [Pokus {attempt + 1}/3] Otázka '{title[:35]}' selhala: {str(err)}. Opakuji za {wait_s} s..."
                        )
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
                await send_log(f"🎉 Kartičky k otázce [{idx + 1}/{len(questions)}] vytvořeny a uloženy.")
            else:
                await send_log(
                    f"⚠️ Otázku '{title[:35]}' se nepodařilo vygenerovat: {str(last_err)}. Pokračuji v dávce..."
                )
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
                await send_log(
                    f"🌙 [Noční kontrola kartiček – kolo {sweep_idx}/{max_sweeps}]: Znovu zkouším {len(failed_questions)} nedokončených otázek..."
                )
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
            await send_log(
                f"🏁 Dávkové generování kartiček kompletně dokončeno ({len(questions)}/{len(questions)} hotovo)!"
            )
        else:
            outcome = "completed_with_errors"
            await send_log(
                f"🏁 Dávka kartiček dokončena: {len(batch.completed_question_indexes)}/{len(questions)} hotovo, {len(pending_question_indexes)} neúspěšných."
            )

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
