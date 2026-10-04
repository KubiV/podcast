import os
from typing import Any

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, Response, UploadFile

from core.config import TESTS_DIR
from core.logger import send_log
from core.utils import sanitize_name
from services.ai_service import call_gemini_with_retries
from services.rag_service import query_rag_context_with_sources
from services.test_service import (
    TestStorageManager,
    evaluate_open_answer,
    generate_more_test_questions,
    generate_practice_test,
)

router = APIRouter()
test_storage = TestStorageManager(TESTS_DIR)


@router.post("/api/tests/generate")
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


@router.post("/api/tests/generate-more")
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


@router.get("/api/tests")
async def list_tests_endpoint(project: str = ""):
    try:
        tests = test_storage.list_tests(project=project)
        return {"tests": tests}
    except Exception as e:
        return {"tests": [], "error": str(e)}


@router.get("/api/tests/{filename}")
async def get_test_endpoint(filename: str):
    data = test_storage.get_test(filename)
    if not data:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return data


@router.post("/api/tests/{filename}/result")
async def save_test_result_endpoint(filename: str, payload: dict = Body(...)):
    updated = test_storage.save_test_result(filename, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return {"status": "success", "test": updated}


@router.delete("/api/tests/{filename}")
async def delete_test_endpoint(filename: str):
    success = test_storage.delete_test(filename)
    if success:
        await send_log(f"🗑️ Smazán test: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Test nebyl nalezen.")


@router.post("/api/tests/evaluate-open-answer")
async def evaluate_open_answer_endpoint(payload: dict = Body(...)):
    user_answer = payload.get("user_answer", "")
    model_answer = payload.get("model_answer", "")
    key_points = payload.get("key_points", [])
    if not isinstance(key_points, list):
        key_points = []
    result = evaluate_open_answer(user_answer, model_answer, key_points)
    return result
