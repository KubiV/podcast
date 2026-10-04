import os
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request

from core.config import TESTS_DIR, USER_DATA_DIR
from core.context import current_user_var
from core.logger import send_log
from core.utils import sanitize_name
from prompts.podcast import DEFAULT_PODCAST_PROMPT
from services.ai_service import call_gemini_with_retries
from services.flashcards_service import internal_generate_flashcards
from services.medulingo_service import MEDULINGO_PODCAST_PROMPT, MedulingoService
from services.notes_service import internal_generate_notes
from services.podcast_service import (
    create_srt_for_audio,
    internal_generate_audio,
    internal_generate_script,
)
from services.rag_service import query_rag_context_with_sources
from services.test_service import generate_practice_test

router = APIRouter()


@router.get("/api/medulingo/overview")
async def medulingo_overview_endpoint(project: str = ""):
    if not project:
        raise HTTPException(status_code=400, detail="Chybí parametr projektu.")
    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    return service.get_medulingo_overview(safe_proj)


@router.get("/api/medulingo/question/{question_id}")
async def medulingo_question_detail_endpoint(question_id: str, project: str = ""):
    if not project:
        raise HTTPException(status_code=400, detail="Chybí parametr projektu.")
    safe_proj = sanitize_name(project)
    service = MedulingoService(USER_DATA_DIR)
    return service.get_question_path_content(safe_proj, question_id)


@router.post("/api/medulingo/generate-pack")
async def medulingo_generate_pack_endpoint(request: Request, payload: dict = Body(...)):
    user = getattr(request.state, "user", None) or current_user_var.get()
    if user and user.get("role") == "viewer":
        raise HTTPException(status_code=403, detail="Režim pozorovatele: Nemáte oprávnění generovat obsah lekcí.")

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
            if target_q:
                target_q["audioStatus"] = "Done"
                target_q["audio_file"] = audio_filename
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

    fresh_details = service.get_question_path_content(
        safe_proj, target_q.get("id", question_id) if target_q else question_id
    )
    return {
        "status": "success",
        "results": results,
        "question_details": fresh_details,
    }


@router.post("/api/medulingo/complete")
async def medulingo_complete_endpoint(request: Request, payload: dict = Body(...)):
    user = getattr(request.state, "user", None) or current_user_var.get()
    if user and user.get("role") == "viewer":
        raise HTTPException(
            status_code=403, detail="Režim pozorovatele: Nemáte oprávnění měnit stav splnění zkouškových otázek."
        )

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
