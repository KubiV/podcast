"""
Import balíčku projektu, upload souborů a úložiště testů (krok 1.7).

Charakterizace: export → import běžného projektu zachová soubory a výstupy, běžný upload funguje.
Bezpečnost: allowlist přípon, únik z cílové složky, zip bomb, limity velikosti a počtu, path traversal v úložišti testů.
"""

import io
import json
import os
import tempfile
import unittest
import uuid
import zipfile
from unittest.mock import patch

from fastapi import HTTPException

from core.config import AUDIO_DIR, FLASHCARDS_DIR, NOTES_DIR, TESTS_DIR, UPLOAD_DIR
from services.test_service import TestStorageManager
from tests.test_project_authz import ProjectAuthzBase, _write


def _zip(entries: dict[str, bytes | str], compression=zipfile.ZIP_DEFLATED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=compression) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


class TestImportAndUpload(ProjectAuthzBase):
    def setUp(self):
        super().setUp()
        self.client = self.client_as("alice")
        self.proj = f"imp_{uuid.uuid4().hex[:6]}"

    def import_zip(self, data: bytes, name: str):
        return self.client.post(
            "/api/projects/import",
            data={"project_name": name},
            files={"file": ("balicek.medproj", data, "application/octet-stream")},
        )

    # --- Charakterizace ---
    def test_export_import_round_trip(self):
        src = self.proj
        self.client.post("/api/projects", json={"name": src})
        _write(os.path.join(UPLOAD_DIR, src, "skripta.pdf"), "%PDF-1.4 fake")
        _write(
            os.path.join(UPLOAD_DIR, src, "exam_planner.json"),
            json.dumps({"project": src, "questions": [{"id": "q1"}]}),
        )
        _write(
            os.path.join(NOTES_DIR, f"{src}_Q1_Otazka.md"),
            f'<!-- METADATA\n{{"question": "Q1", "project": "{src}"}}\n-->\n# Q1',
        )
        _write(
            os.path.join(FLASHCARDS_DIR, f"{src}_Q1.json"), json.dumps({"question": "Q1", "project": src, "cards": []})
        )
        _write(
            os.path.join(TESTS_DIR, f"{src}_t1.json"),
            json.dumps({"id": "t1", "filename": f"{src}_t1.json", "project": src}),
        )
        _write(os.path.join(AUDIO_DIR, f"{src}_Q1_Podcast.mp3"), "mp3")

        exported = self.client.get(f"/api/projects/{src}/export", params={"include_audio": True})
        self.assertEqual(exported.status_code, 200)
        dst = f"{src}_kopie"
        res = self.import_zip(exported.content, dst)
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["source_files"], ["skripta.pdf"])
        self.assertEqual(body["outputs"], {"notes": 1, "flashcards": 1, "tests": 1, "audio": 1})
        with open(os.path.join(UPLOAD_DIR, dst, "skripta.pdf"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "%PDF-1.4 fake")
        with open(os.path.join(UPLOAD_DIR, dst, "exam_planner.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["project"], dst)
        self.assertTrue(os.path.exists(os.path.join(NOTES_DIR, f"{dst}_Q1_Otazka.md")))
        self.assertTrue(os.path.exists(os.path.join(FLASHCARDS_DIR, f"{dst}_Q1.json")))
        with open(os.path.join(TESTS_DIR, f"{dst}_t1.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["filename"], f"{dst}_t1.json")
        self.assertTrue(os.path.exists(os.path.join(AUDIO_DIR, f"{dst}_Q1_Podcast.mp3")))

    def test_regular_upload(self):
        res = self.client.post(
            "/api/files/upload",
            data={"project": self.proj},
            files=[("files", ("kapitola.txt", b"text", "text/plain"))],
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["filenames"], ["kapitola.txt"])
        self.assertTrue(os.path.exists(os.path.join(UPLOAD_DIR, self.proj, "kapitola.txt")))

    def test_test_storage_regular_use(self):
        with tempfile.TemporaryDirectory() as tmp:
            storage = TestStorageManager(tmp)
            name = storage.save_test({"project": "p", "id": "t1", "questions": []})
            self.assertEqual(name, "p_t1.json")
            self.assertEqual(storage.get_test("p_t1.json")["id"], "t1")
            self.assertTrue(storage.delete_test("p_t1.json"))

    # --- Bezpečnost ---
    def test_import_skips_disallowed_source_extensions(self):
        data = _zip({"uploads/ok.pdf": "pdf", "uploads/evil.html": "<script>x</script>", "uploads/a.svg": "<svg/>"})
        res = self.import_zip(data, self.proj)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertTrue(os.path.exists(os.path.join(UPLOAD_DIR, self.proj, "ok.pdf")))
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, self.proj, "evil.html")))
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, self.proj, "a.svg")))
        self.assertEqual(res.json()["source_files"], ["ok.pdf"])

    def test_import_cannot_escape_to_sibling_project(self):
        sibling = f"{self.proj}2"
        res = self.import_zip(_zip({f"uploads/../{sibling}/evil.pdf": "x"}), self.proj)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, sibling, "evil.pdf")))

    def test_import_output_names_sanitized_and_filtered(self):
        data = _zip(
            {
                "generated/audio/x');alert(1);(.mp3": "a",
                "generated/notes/evil.html": "<script>",
                "generated/notes/ok.md": "# ok",
            }
        )
        res = self.import_zip(data, self.proj)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertFalse(any("'" in f for f in os.listdir(AUDIO_DIR) if f.startswith(self.proj)))
        self.assertTrue(os.path.exists(os.path.join(AUDIO_DIR, f"{self.proj}_x_alert_1_.mp3")))
        self.assertFalse(os.path.exists(os.path.join(NOTES_DIR, f"{self.proj}_evil.html")))
        self.assertTrue(os.path.exists(os.path.join(NOTES_DIR, f"{self.proj}_ok.md")))

    def test_import_rejects_zip_bomb(self):
        data = _zip({"uploads/bomb.txt": b"\0" * (20 * 1024 * 1024)})
        res = self.import_zip(data, self.proj)
        self.assertIn(res.status_code, (400, 413))
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, self.proj, "bomb.txt")))

    def test_import_rejects_too_many_entries(self):
        with patch("core.uploads.MAX_IMPORT_ENTRIES", 3):
            res = self.import_zip(_zip({f"uploads/{i}.txt": "x" for i in range(5)}), self.proj)
        self.assertEqual(res.status_code, 413)
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, self.proj)))

    def test_import_rejects_oversized_archive(self):
        with patch("core.uploads.MAX_IMPORT_ARCHIVE_BYTES", 100):
            res = self.import_zip(_zip({"uploads/a.txt": os.urandom(400)}, zipfile.ZIP_STORED), self.proj)
            inspect = self.client.post(
                "/api/projects/import/inspect",
                files={"file": ("b.medproj", _zip({"uploads/a.txt": os.urandom(400)}, zipfile.ZIP_STORED))},
            )
        self.assertEqual(res.status_code, 413)
        self.assertEqual(inspect.status_code, 413)

    def test_upload_rejects_oversized_file_without_leftovers(self):
        with patch("core.uploads.MAX_UPLOAD_FILE_BYTES", 10):
            res = self.client.post(
                "/api/files/upload",
                data={"project": self.proj},
                files=[("files", ("velky.txt", b"x" * 100, "text/plain"))],
            )
        self.assertEqual(res.status_code, 413)
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, self.proj, "velky.txt")))

    def test_upload_batch_with_oversized_file_saves_nothing(self):
        with patch("core.uploads.MAX_UPLOAD_FILE_BYTES", 10):
            res = self.client.post(
                "/api/files/upload",
                data={"project": self.proj},
                files=[("files", ("maly.txt", b"x", "text/plain")), ("files", ("velky.txt", b"x" * 100, "text/plain"))],
            )
        self.assertEqual(res.status_code, 413)
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, self.proj, "maly.txt")))

    def test_test_storage_blocks_path_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            storage = TestStorageManager(os.path.join(tmp, "tests"))
            _write(os.path.join(tmp, "outside.json"), json.dumps({"id": "x"}))
            with self.assertRaises(HTTPException):
                storage.get_test("../outside.json")
            with self.assertRaises(HTTPException):
                storage.delete_test("../outside.json")
            self.assertTrue(os.path.exists(os.path.join(tmp, "outside.json")))


if __name__ == "__main__":
    unittest.main()
