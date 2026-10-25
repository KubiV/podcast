"""
Autorizace přístupu k projektům (IDOR) v režimu privátních i sdílených projektů.

Testy pracují s datovým adresářem nastaveným v `tests/__init__.py`, vytvářejí si vlastní
uživatele a projekty a nevolají žádné AI API (negativní případy končí 403 dřív).
"""

import io
import json
import os
import unittest
import zipfile

from fastapi.testclient import TestClient

from core.config import AUDIO_DIR, FLASHCARDS_DIR, NOTES_DIR, TESTS_DIR, UPLOAD_DIR
from core.logger import active_batches
from main import app, auth_service
from services.chat_service import create_thread, get_thread

PASSWORD = "password123"


def _ensure_user(username: str, role: str) -> int:
    for u in auth_service.list_users():
        if u["username"] == username:
            return u["id"]
    if auth_service.needs_setup():
        user, err = auth_service.create_initial_admin(username, PASSWORD)
        assert user, err
        return user["id"]
    auth_service.set_registration_allowed(True)
    user, err = auth_service.register_user(username, PASSWORD)
    assert user, err
    auth_service.approve_user(user["id"], role=role)
    return user["id"]


def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


class ProjectAuthzBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ids = {
            "admin": _ensure_user("authz_admin", "admin"),
            "alice": _ensure_user("authz_alice", "user"),
            "bob": _ensure_user("authz_bob", "user"),
            "viewer": _ensure_user("authz_viewer", "viewer"),
        }
        # Pokud admin vznikl dříve (jiný testovací modul), zajistíme mu roli admin
        auth_service.change_user_role(cls.ids["admin"], "admin", cls.ids["admin"])

    def setUp(self):
        self._shared_before = auth_service.is_shared_projects()
        for owner in ("alice", "bob"):
            proj = f"authz_{owner}_proj"
            auth_service.set_project_owner(proj, self.ids[owner])
            _write(os.path.join(UPLOAD_DIR, proj, "doc.txt"), "obsah")
            _write(
                os.path.join(NOTES_DIR, f"{proj}_q1.md"),
                f'<!-- METADATA\n{{"question": "Q1", "project": "{proj}"}}\n-->\n# Q1',
            )
            _write(os.path.join(FLASHCARDS_DIR, f"{proj}_q1.json"), json.dumps({"question": "Q1", "cards": []}))
            _write(
                os.path.join(TESTS_DIR, f"{proj}_t1.json"),
                json.dumps({"id": f"{proj}_t1", "filename": f"{proj}_t1.json", "project": proj, "questions": []}),
            )
            _write(os.path.join(AUDIO_DIR, f"{proj}_q1.mp3"), "audio")
        self.bob_thread = create_thread("authz_bob_proj", title="Bobovo vlákno")["id"]

    def tearDown(self):
        auth_service.set_shared_projects(self._shared_before)
        active_batches.pop("authz_bob_proj", None)

    def client_as(self, name: str) -> TestClient:
        token, _ = auth_service.create_session(self.ids[name])
        client = TestClient(app)
        client.cookies.set("medstudio_session", token)
        return client


class TestPrivateProjects(ProjectAuthzBase):
    def setUp(self):
        super().setUp()
        auth_service.set_shared_projects(False)

    # --- Vlastník: přístup zůstává ---
    def test_owner_can_read_own_project(self):
        c = self.client_as("alice")
        self.assertEqual(c.get("/api/files", params={"project": "authz_alice_proj"}).json()["files"], ["doc.txt"])
        self.assertEqual(c.get("/api/notes/authz_alice_proj_q1.md").status_code, 200)
        self.assertEqual(c.get("/api/flashcards/authz_alice_proj_q1.json").status_code, 200)
        self.assertEqual(c.get("/api/tests/authz_alice_proj_t1.json").status_code, 200)
        self.assertEqual(c.get("/api/files/authz_alice_proj/doc.txt/view").status_code, 200)
        self.assertEqual(c.get("/api/projects/authz_alice_proj/planner").status_code, 200)

    # --- Cizí projekt: čtení ---
    def test_foreign_project_reads_forbidden(self):
        c = self.client_as("alice")
        forbidden = [
            ("/api/files", {"project": "authz_bob_proj"}),
            ("/api/files/authz_bob_proj/doc.txt/view", None),
            ("/api/files/authz_bob_proj/doc.txt/preview", None),
            ("/api/notes", {"project": "authz_bob_proj"}),
            ("/api/notes/authz_bob_proj_q1.md", None),
            ("/api/flashcards", {"project": "authz_bob_proj"}),
            ("/api/flashcards/authz_bob_proj_q1.json", None),
            ("/api/flashcards/export-all", {"project": "authz_bob_proj"}),
            ("/api/tests", {"project": "authz_bob_proj"}),
            ("/api/tests/authz_bob_proj_t1.json", None),
            ("/api/outputs", {"project": "authz_bob_proj"}),
            ("/api/stats", {"project": "authz_bob_proj"}),
            ("/api/medulingo/overview", {"project": "authz_bob_proj"}),
            ("/api/medulingo/question/q1", {"project": "authz_bob_proj"}),
            ("/api/projects/authz_bob_proj/planner", None),
            ("/api/projects/authz_bob_proj/questions", None),
            ("/api/projects/authz_bob_proj/messages", None),
            ("/api/projects/authz_bob_proj/chat/export", None),
            ("/api/projects/authz_bob_proj/export-info", None),
            ("/api/projects/authz_bob_proj/export", None),
            (f"/api/chat/threads/{self.bob_thread}", None),
            (f"/api/chat/threads/{self.bob_thread}/export", None),
            ("/api/projects/authz_alice_proj/messages", {"thread_id": self.bob_thread}),
        ]
        for url, params in forbidden:
            with self.subTest(url=url, params=params):
                self.assertEqual(c.get(url, params=params).status_code, 403)

    def test_unfiltered_listings_hide_foreign_outputs(self):
        c = self.client_as("alice")
        notes = [n["filename"] for n in c.get("/api/notes").json()["notes"]]
        self.assertIn("authz_alice_proj_q1.md", notes)
        self.assertNotIn("authz_bob_proj_q1.md", notes)

        decks = [d["filename"] for d in c.get("/api/flashcards").json()["decks"]]
        self.assertNotIn("authz_bob_proj_q1.json", decks)

        tests = [t["filename"] for t in c.get("/api/tests").json()["tests"]]
        self.assertNotIn("authz_bob_proj_t1.json", tests)

        outputs = c.get("/api/outputs").json()["files"]
        self.assertIn("authz_alice_proj_q1.mp3", outputs)
        self.assertNotIn("authz_bob_proj_q1.mp3", outputs)

        threads = [t["id"] for t in c.get("/api/chat/threads", params={"project_id": "__all__"}).json()["threads"]]
        self.assertNotIn(self.bob_thread, threads)

    # --- Cizí projekt: zápis ---
    def test_foreign_project_writes_forbidden_and_data_kept(self):
        c = self.client_as("alice")
        bob = "authz_bob_proj"
        requests = [
            ("delete", "/api/files/doc.txt", {"params": {"project": bob}}),
            ("delete", f"/api/notes/{bob}_q1.md", {}),
            ("delete", f"/api/flashcards/{bob}_q1.json", {}),
            ("delete", f"/api/tests/{bob}_t1.json", {}),
            ("post", f"/api/tests/{bob}_t1.json/result", {"json": {"score": 1}}),
            ("delete", f"/api/outputs/{bob}_q1.mp3", {}),
            ("post", f"/api/projects/{bob}/clear-data", {"json": {"clear_notes": True}}),
            ("post", f"/api/projects/{bob}/reindex", {}),
            ("post", f"/api/projects/{bob}/planner", {"json": {"questions": []}}),
            ("post", f"/api/projects/{bob}/questions", {"json": {"questions": []}}),
            ("post", f"/api/projects/{bob}/ai-classify-questions", {"json": {}}),
            ("delete", f"/api/projects/{bob}/messages", {}),
            ("post", "/api/generate-notes", {"json": {"question": "Q", "project": bob}}),
            ("post", "/api/generate-flashcards", {"json": {"question": "Q", "project": bob}}),
            ("post", "/api/generate-script", {"json": {"question": "Q", "prompt": "P", "project": bob}}),
            ("post", "/api/generate-audio", {"json": {"script": "S", "filename": f"{bob}_q1"}}),
            ("post", "/api/generate-subtitles", {"json": {"script": "S", "filename": f"{bob}_q1.mp3"}}),
            ("post", "/api/tests/generate", {"json": {"project": bob}}),
            ("post", "/api/tests/generate-more", {"json": {"project": bob, "previous_test_id": f"{bob}_t1"}}),
            (
                "post",
                "/api/tests/generate-more",
                {"json": {"project": "authz_alice_proj", "previous_test_id": f"{bob}_t1"}},
            ),
            ("post", "/api/process-batch", {"json": {"questions": [{"q_index": 0}], "prompt": "P", "project": bob}}),
            ("post", "/api/process-notes-batch", {"json": {"questions": [{"q_index": 0}], "project": bob}}),
            ("post", "/api/process-flashcards-batch", {"json": {"questions": [{"q_index": 0}], "project": bob}}),
            ("post", "/api/cancel-batch", {"json": {"project": bob}}),
            ("post", "/api/medulingo/generate-pack", {"json": {"project": bob, "question_id": "q1"}}),
            ("post", "/api/medulingo/complete", {"json": {"project": bob, "question_id": "q1"}}),
            ("post", "/api/chat/completions", {"json": {"project": bob, "message": "ahoj"}}),
            (
                "post",
                "/api/chat/completions",
                {"json": {"project": "authz_alice_proj", "message": "ahoj", "thread_id": self.bob_thread}},
            ),
            ("post", "/api/chat/threads", {"json": {"project_id": bob}}),
            ("post", "/api/chat/threads", {"json": {"project_id": "authz_alice_proj", "id": self.bob_thread}}),
            ("patch", f"/api/chat/threads/{self.bob_thread}", {"json": {"title": "x"}}),
            ("post", f"/api/chat/threads/{self.bob_thread}/pin", {}),
            ("delete", f"/api/chat/threads/{self.bob_thread}", {}),
        ]
        for method, url, kwargs in requests:
            with self.subTest(method=method, url=url, body=kwargs.get("json")):
                self.assertEqual(getattr(c, method)(url, **kwargs).status_code, 403)

        self.assertTrue(os.path.exists(os.path.join(UPLOAD_DIR, bob, "doc.txt")))
        self.assertTrue(os.path.exists(os.path.join(NOTES_DIR, f"{bob}_q1.md")))
        self.assertTrue(os.path.exists(os.path.join(AUDIO_DIR, f"{bob}_q1.mp3")))
        self.assertNotIn(bob, active_batches)
        thread = get_thread(self.bob_thread)
        self.assertIsNotNone(thread)
        self.assertEqual(thread["title"], "Bobovo vlákno")

    def test_foreign_upload_forbidden(self):
        c = self.client_as("alice")
        res = c.post(
            "/api/files/upload",
            data={"project": "authz_bob_proj"},
            files=[("files", ("evil.txt", b"x", "text/plain"))],
        )
        self.assertEqual(res.status_code, 403)
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, "authz_bob_proj", "evil.txt")))

    def test_import_overwrite_of_foreign_project_forbidden(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("manifest.json", json.dumps({"project_name": "authz_bob_proj"}))
            zf.writestr("uploads/evil.txt", "x")
        c = self.client_as("alice")
        res = c.post(
            "/api/projects/import",
            data={"project_name": "authz_bob_proj", "overwrite": "true"},
            files={"file": ("p.medproj", buf.getvalue(), "application/zip")},
        )
        self.assertEqual(res.status_code, 403)
        self.assertTrue(os.path.exists(os.path.join(UPLOAD_DIR, "authz_bob_proj", "doc.txt")))
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, "authz_bob_proj", "evil.txt")))

    # --- Admin a pozorovatel ---
    def test_admin_can_access_foreign_project(self):
        c = self.client_as("admin")
        self.assertEqual(c.get("/api/notes/authz_bob_proj_q1.md").status_code, 200)
        self.assertEqual(c.get(f"/api/chat/threads/{self.bob_thread}").status_code, 200)
        notes = [n["filename"] for n in c.get("/api/notes").json()["notes"]]
        self.assertIn("authz_bob_proj_q1.md", notes)

    def test_viewer_can_read_but_not_write(self):
        c = self.client_as("viewer")
        self.assertEqual(c.get("/api/notes/authz_bob_proj_q1.md").status_code, 200)
        self.assertEqual(c.get("/api/files", params={"project": "authz_bob_proj"}).status_code, 200)
        self.assertEqual(c.delete("/api/notes/authz_bob_proj_q1.md").status_code, 403)
        self.assertTrue(os.path.exists(os.path.join(NOTES_DIR, "authz_bob_proj_q1.md")))


class TestSharedProjects(ProjectAuthzBase):
    """Charakterizace: ve sdíleném režimu se chování nemění, každý uživatel vidí vše."""

    def setUp(self):
        super().setUp()
        auth_service.set_shared_projects(True)

    def test_foreign_project_accessible_in_shared_mode(self):
        c = self.client_as("alice")
        self.assertEqual(c.get("/api/files", params={"project": "authz_bob_proj"}).json()["files"], ["doc.txt"])
        self.assertEqual(c.get("/api/notes/authz_bob_proj_q1.md").status_code, 200)
        self.assertEqual(c.get("/api/tests/authz_bob_proj_t1.json").status_code, 200)
        self.assertEqual(c.get(f"/api/chat/threads/{self.bob_thread}").status_code, 200)
        self.assertEqual(c.get("/api/projects/authz_bob_proj/planner").status_code, 200)
        notes = [n["filename"] for n in c.get("/api/notes").json()["notes"]]
        self.assertIn("authz_bob_proj_q1.md", notes)
        outputs = c.get("/api/outputs").json()["files"]
        self.assertIn("authz_bob_proj_q1.mp3", outputs)
        threads = [t["id"] for t in c.get("/api/chat/threads", params={"project_id": "__all__"}).json()["threads"]]
        self.assertIn(self.bob_thread, threads)

    def test_foreign_note_deletable_in_shared_mode(self):
        c = self.client_as("alice")
        self.assertEqual(c.delete("/api/notes/authz_bob_proj_q1.md").status_code, 200)
        self.assertFalse(os.path.exists(os.path.join(NOTES_DIR, "authz_bob_proj_q1.md")))


if __name__ == "__main__":
    unittest.main()
