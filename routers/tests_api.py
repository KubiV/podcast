from typing import Any

from fastapi import APIRouter, Body, HTTPException

from core.authz import filter_accessible_output_files, require_output_file_access, require_project_access
from core.clients import require_allowed_model
from core.config import AI, TESTS_DIR
from core.logger import send_log
from core.request_models import RequestModel
from services.ai_service import call_gemini_with_retries
from services.rag_service import query_rag_context_with_sources
from services.test_service import (
    TestStorageManager,
    evaluate_open_answer,
    generate_more_test_questions,
    generate_practice_test,
)


class GenerateTestRequest(RequestModel):
    """Tělo '/api/tests/generate'."""

    project: str | None = ""
    questions: list[Any] | None = []
    categories: list[Any] | None = []
    categories_map: dict[str, Any] | None = {}
    count: int | None = 10
    question_types: list[Any] | None = ["single_choice", "multi_choice"]
    difficulty: str | None = "normal"
    mode: str | None = "instant"
    prompt: str | None = ""
    gemini_model: str | None = AI.default_gemini_model


class GenerateMoreTestsRequest(RequestModel):
    """Tělo '/api/tests/generate-more'."""

    previous_test_id: str | None = ""
    project: str | None = ""
    count: int | None = 5
    difficulty_shift: str | None = "same"
    focus_mistakes: bool | None = True
    gemini_model: str | None = AI.default_gemini_model


class EvaluateOpenAnswerRequest(RequestModel):
    """Tělo '/api/tests/evaluate-open-answer'."""

    user_answer: str | None = ""
    model_answer: str | None = ""
    key_points: list[Any] | None = []


router = APIRouter()
test_storage = TestStorageManager(TESTS_DIR)


def _require_test_access(filename_or_id: str, write: bool = False) -> dict[str, Any] | None:
    """Ověří přístup k projektu testu podle skutečného názvu souboru (test lze adresovat i přes id)."""
    data = test_storage.get_test(filename_or_id)
    if data:
        require_output_file_access(data.get("filename") or filename_or_id, write=write)
    return data


@router.post("/api/tests/generate")
async def generate_test_endpoint(payload: GenerateTestRequest = Body(...)):
    project = payload.project
    questions = payload.questions
    categories = payload.categories
    categories_map = payload.categories_map
    count = int(payload.count)
    question_types = payload.question_types
    difficulty = payload.difficulty
    mode = payload.mode
    custom_prompt = payload.prompt
    gemini_model = payload.gemini_model

    if not project:
        raise HTTPException(status_code=400, detail="Chybí název projektu.")
    require_project_access(project, write=True)
    require_allowed_model(gemini_model)
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
async def generate_more_tests_endpoint(payload: GenerateMoreTestsRequest = Body(...)):
    previous_test_id = payload.previous_test_id
    project = payload.project
    count = int(payload.count)
    difficulty_shift = payload.difficulty_shift
    focus_mistakes = bool(payload.focus_mistakes)
    gemini_model = payload.gemini_model

    if not previous_test_id or not project:
        raise HTTPException(status_code=400, detail="Chybí identifikátor testu nebo projekt.")
    require_project_access(project, write=True)
    require_allowed_model(gemini_model)
    _require_test_access(previous_test_id)

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
    if project:
        require_project_access(project)
    try:
        tests = test_storage.list_tests(project=project)
        allowed = set(filter_accessible_output_files(t["filename"] for t in tests))
        tests = [t for t in tests if t["filename"] in allowed]
        return {"tests": tests}
    except Exception as e:
        return {"tests": [], "error": str(e)}


@router.get("/api/tests/{filename}")
async def get_test_endpoint(filename: str):
    data = _require_test_access(filename)
    if not data:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return data


@router.post("/api/tests/{filename}/result")
async def save_test_result_endpoint(filename: str, payload: dict = Body(...)):
    _require_test_access(filename, write=True)
    updated = test_storage.save_test_result(filename, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Test nebyl nalezen.")
    return {"status": "success", "test": updated}


@router.delete("/api/tests/{filename}")
async def delete_test_endpoint(filename: str):
    require_output_file_access(filename, write=True)
    success = test_storage.delete_test(filename)
    if success:
        await send_log(f"🗑️ Smazán test: {filename}")
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Test nebyl nalezen.")


@router.post("/api/tests/evaluate-open-answer")
async def evaluate_open_answer_endpoint(payload: EvaluateOpenAnswerRequest = Body(...)):
    user_answer = payload.user_answer
    model_answer = payload.model_answer
    key_points = payload.key_points
    if not isinstance(key_points, list):
        key_points = []
    result = evaluate_open_answer(user_answer, model_answer, key_points)
    return result
