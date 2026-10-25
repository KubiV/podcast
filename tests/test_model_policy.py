"""
Volba modelu a vlastní systémový prompt (krok 1.10).

Ve sdíleném režimu API klíčů (platí server) smí běžný uživatel použít jen modely z allowlistu;
admin a uživatelé s vlastním klíčem mohou zadat libovolný model. Testy nevolají AI API (klíče jsou prázdné),
sledují jen, zda požadavek skončí na kontrole modelu.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import unittest

from core.logger import active_batches
from main import auth_service
from tests.test_project_authz import ProjectAuthzBase

CUSTOM_MODEL = "gemini-ultra-experimental"
MODEL_ERROR = "není na tomto serveru povolen"


class TestModelPolicy(ProjectAuthzBase):
    def setUp(self):
        super().setUp()
        self._shared_keys_before = auth_service.is_shared_api_keys()
        auth_service.set_shared_api_keys(True)
        auth_service.set_shared_projects(True)

    def tearDown(self):
        auth_service.set_shared_api_keys(self._shared_keys_before)
        active_batches.pop("authz_alice_proj", None)
        super().tearDown()

    def requests_with_model(self, model: str):
        proj = "authz_alice_proj"
        return [
            ("post", "/api/generate-notes", {"json": {"question": "Q", "project": proj, "gemini_model": model}}),
            ("post", "/api/generate-flashcards", {"json": {"question": "Q", "project": proj, "gemini_model": model}}),
            (
                "post",
                "/api/generate-script",
                {"json": {"question": "Q", "prompt": "P", "project": proj, "gemini_model": model}},
            ),
            ("post", "/api/tests/generate", {"json": {"project": proj, "gemini_model": model}}),
            (
                "post",
                "/api/tests/generate-more",
                {"json": {"project": proj, "previous_test_id": "authz_alice_proj_t1", "gemini_model": model}},
            ),
            (
                "post",
                "/api/medulingo/generate-pack",
                {"json": {"project": proj, "question_id": "q1", "modules": [], "gemini_model": model}},
            ),
            ("post", f"/api/projects/{proj}/ai-classify-questions", {"json": {"gemini_model": model}}),
            (
                "post",
                "/api/process-notes-batch",
                {"json": {"questions": [{"q_index": 0}], "project": proj, "gemini_model": model}},
            ),
            ("post", "/api/chat/completions", {"json": {"project": proj, "message": "ahoj", "model": model}}),
            (
                "post",
                "/api/lessons/generate",
                {
                    "data": {"title": "Lekce", "gemini_model": model},
                    "files": [("files", ("a.txt", b"text", "text/plain"))],
                },
            ),
        ]

    def assert_model_rejected(self, client, model, rejected: bool):
        for method, url, kwargs in self.requests_with_model(model):
            with self.subTest(url=url, model=model):
                try:
                    res = getattr(client, method)(url, **kwargs)
                except Exception as exc:
                    # Požadavek prošel kontrolou modelu a spadl až dál (např. stream chatu bez API klíče)
                    self.assertFalse(rejected, f"očekávané zamítnutí modelu, ale: {exc!r}")
                    active_batches.pop("authz_alice_proj", None)
                    continue
                detail = (
                    str(res.json().get("detail", ""))
                    if res.headers.get("content-type", "").startswith("application/json")
                    else ""
                )
                if rejected:
                    self.assertEqual(res.status_code, 400)
                    self.assertIn(MODEL_ERROR, detail)
                else:
                    self.assertNotIn(MODEL_ERROR, detail)
                active_batches.pop("authz_alice_proj", None)

    # --- Charakterizace: modely z UI projdou kontrolou ---
    def test_ui_models_allowed_for_user(self):
        for model in ("gemini-3.6-flash", "gemini-flash-latest", "gemini-pro-latest"):
            self.assert_model_rejected(self.client_as("alice"), model, rejected=False)

    # --- Nová pravidla ---
    def test_custom_model_rejected_for_user_with_shared_keys(self):
        self.assert_model_rejected(self.client_as("alice"), CUSTOM_MODEL, rejected=True)
        self.assertNotIn("authz_alice_proj", active_batches)

    def test_custom_model_allowed_for_admin(self):
        self.assert_model_rejected(self.client_as("admin"), CUSTOM_MODEL, rejected=False)

    def test_custom_model_allowed_with_own_keys(self):
        auth_service.set_shared_api_keys(False)
        self.assert_model_rejected(self.client_as("alice"), CUSTOM_MODEL, rejected=False)

    def test_custom_system_prompt_kept_but_length_limited(self):
        client = self.client_as("alice")
        try:
            ok = client.post(
                "/api/chat/completions",
                json={"project": "authz_alice_proj", "message": "ahoj", "system_prompt": "Jsi tutor."},
            )
            self.assertNotEqual(ok.status_code, 400)
        except Exception:
            pass  # prošlo validací, stream spadl až na chybějícím API klíči
        too_long = client.post(
            "/api/chat/completions",
            json={"project": "authz_alice_proj", "message": "ahoj", "system_prompt": "x" * 20_001},
        )
        self.assertEqual(too_long.status_code, 400)


if __name__ == "__main__":
    unittest.main()
