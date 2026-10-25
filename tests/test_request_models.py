"""
Pydantic modely těl požadavků (krok 4.10).

Modely nahradily `payload: dict = Body(...)` s `payload.get(klíč, default)`. Platné požadavky musí dostat stejné
hodnoty jako dřív: chybějící klíč → původní default, `null` → None, hodnota se nepřevádí (strict) a neznámé
klíče se ignorují. Nově vrací 422 jen hodnota jiného typu.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import json
import unittest

from pydantic import ValidationError

from core.config import AI
from core.request_models import RequestModel
from main import app
from routers import batch, chat_api, flashcards, medulingo, notes, podcast, projects, tests_api
from routers import print as print_router
from routers import settings as settings_router
from tests.test_project_authz import ProjectAuthzBase

QUESTIONS = [{"title": "Srdeční selhání", "q_index": 0}]

# Těla ve tvaru, v jakém je posílá frontend (static/js/*.js)
FRONTEND_PAYLOADS = {
    batch.CancelBatchRequest: {"project": "proj"},
    batch.PodcastBatchRequest: {
        "questions": QUESTIONS,
        "prompt": "P",
        "provider": "openai",
        "voice": "onyx",
        "format": "mp3",
        "project": "proj",
        "gemini_model": "gemini-3.6-flash",
        "overnight_mode": True,
    },
    batch.NotesBatchRequest: {
        "questions": QUESTIONS,
        "prompt": "",
        "project": "proj",
        "gemini_model": "gemini-3.6-flash",
        "overnight_mode": False,
    },
    batch.FlashcardsBatchRequest: {
        "questions": QUESTIONS,
        "count": 12,
        "prompt": "",
        "project": "proj",
        "gemini_model": "gemini-3.6-flash",
        "overnight_mode": True,
    },
    chat_api.ChatCompletionRequest: {
        "project": "proj",
        "message": "Co je v materiálech?",
        "system_prompt": "",
        "model": "gemini-3.6-flash",
    },
    chat_api.ChatThreadCreateRequest: {"project_id": "proj", "title": "Nové vlákno"},
    chat_api.ChatThreadUpdateRequest: {"title": "Přejmenováno"},
    chat_api.ClassifyQuestionsRequest: {"gemini_model": "gemini-3.6-flash"},
    flashcards.GenerateFlashcardsRequest: {
        "question": "Q",
        "count": 10,
        "project": "proj",
        "prompt": "",
        "gemini_model": "gemini-3.6-flash",
        "force_regenerate": False,
    },
    medulingo.MedulingoGeneratePackRequest: {
        "project": "proj",
        "question_id": "pq_1",
        "question_title": "Q",
        "modules": ["notes", "cards"],
        "gemini_model": "gemini-3.6-flash",
        "tts_provider": "openai",
        "tts_voice": "onyx",
    },
    medulingo.MedulingoCompleteRequest: {"project": "proj", "question_id": 3, "grade": None, "completed": True},
    notes.GenerateNotesRequest: {"question": "Q", "project": "proj", "prompt": "", "gemini_model": "gemini-3.6-flash"},
    podcast.GenerateScriptRequest: {
        "question": "Q",
        "prompt": "P",
        "project": "proj",
        "gemini_model": "gemini-3.6-flash",
    },
    podcast.GenerateAudioRequest: {
        "script": "Text",
        "filename": "proj_Q1_Srdce",
        "question_title": "Srdce",
        "provider": "openai",
        "voice": "onyx",
        "format": "mp3",
    },
    podcast.GenerateSubtitlesRequest: {"script": "Text", "filename": "proj_Q1"},
    print_router.PrintPrepareRequest: {"title": "Dok", "html": "<p>x</p>", "project": "", "auto_open_browser": False},
    projects.ProjectCreateRequest: {"name": "Kardiologie"},
    projects.ProjectRenameRequest: {"new_name": "Kardio 2"},
    projects.ProjectClearDataRequest: {
        "clear_chat": True,
        "clear_notes": False,
        "clear_flashcards": False,
        "clear_tests": True,
        "clear_audio": False,
    },
    settings_router.ApiKeyTestRequest: {"provider": "gemini", "key": "test-key", "model": "gemini-3.6-flash"},
    tests_api.GenerateTestRequest: {
        "project": "proj",
        "questions": ["Q1", "Q2"],
        "categories": ["Kardio"],
        "categories_map": {"Kardio": ["Q1"]},
        "count": 10,
        "question_types": ["single_choice"],
        "difficulty": "normal",
        "mode": "instant",
        "gemini_model": "gemini-3.6-flash",
    },
    tests_api.GenerateMoreTestsRequest: {
        "previous_test_id": "proj_t1.json",
        "project": "proj",
        "count": 5,
        "difficulty_shift": "same",
        "focus_mistakes": True,
        "gemini_model": "gemini-3.6-flash",
    },
    tests_api.EvaluateOpenAnswerRequest: {"user_answer": "a", "model_answer": "b", "key_points": ["k"]},
}

# Výchozí hodnoty z dřívějších payload.get(klíč, default) v handlerech (snímek kódu před krokem 4.10, nezávislý na modelech).
# question_title u generate-audio: chybějící klíč → filename (řeší handler), null → None.
EXPECTED_DEFAULTS = {
    batch.CancelBatchRequest: {"project": ""},
    batch.PodcastBatchRequest: {
        "format": "mp3",
        "gemini_model": AI.default_gemini_model,
        "overnight_mode": True,
        "project": "",
        "prompt": None,
        "provider": "openai",
        "questions": [],
        "voice": "onyx",
    },
    batch.NotesBatchRequest: {
        "gemini_model": AI.default_gemini_model,
        "overnight_mode": True,
        "project": "",
        "prompt": "",
        "questions": [],
    },
    batch.FlashcardsBatchRequest: {
        "count": 10,
        "gemini_model": AI.default_gemini_model,
        "overnight_mode": True,
        "project": "",
        "prompt": "",
        "questions": [],
    },
    chat_api.ChatCompletionRequest: {
        "message": None,
        "model": AI.default_gemini_model,
        "project": None,
        "system_prompt": "",
        "thread_id": None,
    },
    chat_api.ChatThreadCreateRequest: {"id": None, "project": None, "project_id": None, "title": None},
    chat_api.ChatThreadUpdateRequest: {"is_pinned": None, "title": None},
    chat_api.ClassifyQuestionsRequest: {"gemini_model": None},
    flashcards.GenerateFlashcardsRequest: {
        "count": 10,
        "force_regenerate": False,
        "gemini_model": AI.default_gemini_model,
        "project": None,
        "prompt": "",
        "question": None,
    },
    medulingo.MedulingoGeneratePackRequest: {
        "gemini_model": AI.default_gemini_model,
        "modules": ["notes", "cards", "podcast", "test"],
        "project": None,
        "question_id": None,
        "question_title": "",
        "tts_provider": "openai",
        "tts_voice": "onyx",
    },
    medulingo.MedulingoCompleteRequest: {"completed": True, "grade": "A", "project": None, "question_id": None},
    notes.GenerateNotesRequest: {
        "gemini_model": AI.default_gemini_model,
        "project": None,
        "prompt": "",
        "question": None,
    },
    podcast.GenerateScriptRequest: {
        "gemini_model": AI.default_gemini_model,
        "project": None,
        "prompt": None,
        "provider": "openai",
        "question": None,
    },
    podcast.GenerateAudioRequest: {
        "filename": "podcast",
        "format": "mp3",
        "provider": "openai",
        "question_title": None,
        "script": None,
        "voice": "onyx",
    },
    podcast.GenerateSubtitlesRequest: {"filename": None, "script": None},
    print_router.PrintPrepareRequest: {"auto_open_browser": False, "html": "", "project": "", "title": ""},
    projects.ProjectCreateRequest: {"name": None},
    projects.ProjectRenameRequest: {"new_name": ""},
    projects.ProjectClearDataRequest: {
        "clear_audio": False,
        "clear_chat": False,
        "clear_flashcards": False,
        "clear_notes": False,
        "clear_questions": False,
        "clear_tests": False,
    },
    settings_router.ApiKeyTestRequest: {"key": None, "model": None, "provider": "gemini"},
    tests_api.GenerateTestRequest: {
        "categories": [],
        "categories_map": {},
        "count": 10,
        "difficulty": "normal",
        "gemini_model": AI.default_gemini_model,
        "mode": "instant",
        "project": "",
        "prompt": "",
        "question_types": ["single_choice", "multi_choice"],
        "questions": [],
    },
    tests_api.GenerateMoreTestsRequest: {
        "count": 5,
        "difficulty_shift": "same",
        "focus_mistakes": True,
        "gemini_model": AI.default_gemini_model,
        "previous_test_id": "",
        "project": "",
    },
    tests_api.EvaluateOpenAnswerRequest: {"key_points": [], "model_answer": "", "user_answer": ""},
}


def parse(model, payload):
    """Validace jako u HTTP požadavku (JSON)."""
    return model.model_validate_json(json.dumps(payload))


class TestRequestModels(unittest.TestCase):
    def test_all_models_strict_and_covered(self):
        self.assertEqual(len(FRONTEND_PAYLOADS), 23)
        self.assertEqual(set(EXPECTED_DEFAULTS), set(FRONTEND_PAYLOADS))
        for model in FRONTEND_PAYLOADS:
            self.assertTrue(issubclass(model, RequestModel))
            self.assertTrue(model.model_config["strict"])

    def test_frontend_payloads_keep_dict_get_semantics(self):
        for model, payload in FRONTEND_PAYLOADS.items():
            with self.subTest(model=model.__name__):
                m = parse(model, payload)
                for name, field in model.model_fields.items():
                    self.assertEqual(getattr(m, name), payload.get(name, field.default))

    def test_defaults_match_previous_get_defaults(self):
        for model, expected in EXPECTED_DEFAULTS.items():
            with self.subTest(model=model.__name__):
                m = parse(model, {})
                self.assertEqual({k: getattr(m, k) for k in model.model_fields}, expected)

    def test_null_stays_none_and_extra_keys_ignored(self):
        for model in FRONTEND_PAYLOADS:
            with self.subTest(model=model.__name__):
                m = parse(model, {**{k: None for k in model.model_fields}, "neznamy_klic": 1})
                self.assertEqual({k: getattr(m, k) for k in model.model_fields}, dict.fromkeys(model.model_fields))
                self.assertFalse(hasattr(m, "neznamy_klic"))

    def test_mutable_defaults_not_shared(self):
        a, b = parse(tests_api.GenerateTestRequest, {}), parse(tests_api.GenerateTestRequest, {})
        a.question_types.append("x")
        self.assertEqual(b.question_types, ["single_choice", "multi_choice"])

    def test_no_coercion(self):
        cases = [
            (flashcards.GenerateFlashcardsRequest, {"count": "10"}),
            (flashcards.GenerateFlashcardsRequest, {"force_regenerate": "true"}),
            (projects.ProjectRenameRequest, {"new_name": 5}),
            (batch.PodcastBatchRequest, {"questions": ["Q"]}),
            (tests_api.GenerateTestRequest, {"categories_map": []}),
        ]
        for model, payload in cases:
            with self.subTest(model=model.__name__, payload=payload), self.assertRaises(ValidationError):
                parse(model, payload)
        # ID otázky Medulinga může být řetězec i číslo a zůstane beze změny
        self.assertEqual(parse(medulingo.MedulingoCompleteRequest, {"question_id": 7}).question_id, 7)
        self.assertEqual(parse(medulingo.MedulingoCompleteRequest, {"question_id": "7"}).question_id, "7")


class TestRequestModelsOverHttp(ProjectAuthzBase):
    def test_wrong_type_is_422(self):
        res = self.client_as("alice").post(
            "/api/generate-flashcards", json={"question": "Q", "project": "authz_alice_proj", "count": "10"}
        )
        self.assertEqual(res.status_code, 422)

    def test_unknown_keys_ignored_and_values_used(self):
        c = self.client_as("alice")
        res = c.post("/api/chat/threads", json={"project_id": "authz_alice_proj", "title": "Vlákno", "navic": [1]})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["thread"]["title"], "Vlákno")

    def test_classify_accepts_missing_body(self):
        res = self.client_as("alice").post("/api/projects/authz_alice_proj/ai-classify-questions")
        self.assertNotEqual(res.status_code, 422)

    def test_openapi_documents_request_bodies(self):
        schema = app.openapi()
        body = schema["paths"]["/api/generate-flashcards"]["post"]["requestBody"]["content"]["application/json"][
            "schema"
        ]
        self.assertEqual(body["$ref"], "#/components/schemas/GenerateFlashcardsRequest")


if __name__ == "__main__":
    unittest.main()
