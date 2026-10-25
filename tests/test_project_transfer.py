"""
Charakterizace exportu a importu projektu (.medproj) před přesunem logiky do services/projects (krok 3.2).

Doplňuje round-trip a bezpečnostní testy z `tests/test_import_upload.py`: obsah archivu a manifestu,
přepínače exportu, `inspect`, konflikty a přepsání, přenos vektorů ChromaDB a SQLite záznamů.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import asyncio
import io
import json
import os
import zipfile

from core.config import AUDIO_DIR, NOTES_DIR, UPLOAD_DIR
from services.chat_service import create_thread, save_message
from tests.support import OfflineAITestCase, client_for_user, ensure_user, unique_name, write_file


class TransferTestCase(OfflineAITestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_id = ensure_user("transfer_admin", "admin")
        from main import auth_service

        auth_service.change_user_role(cls.admin_id, "admin", cls.admin_id)

    def setUp(self):
        super().setUp()
        from main import auth_service

        self._shared_before = auth_service.is_shared_projects()
        auth_service.set_shared_projects(True)
        self.addCleanup(auth_service.set_shared_projects, self._shared_before)
        self.client = client_for_user(self.admin_id)
        self.project = self.client.post("/api/projects", json={"name": unique_name("Prenos")}).json()["project"]
        p = self.project
        write_file(
            os.path.join(UPLOAD_DIR, p, "kapitola.txt"), "Digoxin se používá u fibrilace síní.\n\nDruhý odstavec."
        )
        planner = {
            "project": p,
            "examDate": "2026-12-01",
            "questions": [
                {
                    "id": "q1",
                    "title": "Otázka 1",
                    "status": "Done",
                    "completedDate": "2026-10-01",
                    "grade": "A",
                    "note": "ok",
                    "notesStatus": "Done",
                },
                {"id": "q2", "title": "Otázka 2", "status": "To do"},
            ],
        }
        write_file(os.path.join(UPLOAD_DIR, p, "exam_planner.json"), json.dumps(planner, ensure_ascii=False))
        write_file(
            os.path.join(NOTES_DIR, f"{p}_Q1.md"), f'<!-- METADATA\n{{"question": "Q1", "project": "{p}"}}\n-->\n# Q1'
        )
        write_file(os.path.join(AUDIO_DIR, f"{p}_Q1.mp3"), "mp3")
        thread = create_thread(p, title="Vlákno")["id"]
        save_message(p, role="user", content="Ahoj", thread_id=thread)

        from services.rag_service import index_file_to_chroma

        asyncio.run(index_file_to_chroma(os.path.join(UPLOAD_DIR, p, "kapitola.txt"), "kapitola.txt", p))

    def export(self, **params) -> zipfile.ZipFile:
        res = self.client.get(f"/api/projects/{self.project}/export", params=params)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.headers["content-type"], "application/octet-stream")
        self.assertEqual(res.headers["content-disposition"], f"attachment; filename*=UTF-8''{self.project}.medproj")
        return zipfile.ZipFile(io.BytesIO(res.content))

    def import_bytes(self, data: bytes, **form):
        return self.client.post(
            "/api/projects/import", data=form, files={"file": ("balicek.medproj", data, "application/octet-stream")}
        )


class TestExport(TransferTestCase):
    def test_archive_contents_and_manifest(self):
        zf = self.export()
        p = self.project
        self.assertEqual(
            sorted(zf.namelist()),
            sorted(
                [
                    "uploads/kapitola.txt",
                    "uploads/exam_planner.json",
                    "chroma_vectors.json",
                    "database.json",
                    f"generated/notes/{p}_Q1.md",
                    "manifest.json",
                ]
            ),
        )
        manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual(
            {
                k: manifest[k]
                for k in (
                    "version",
                    "format",
                    "app_name",
                    "project_name",
                    "include_audio",
                    "include_chat",
                    "include_outputs",
                )
            },
            {
                "version": 1,
                "format": "medproj",
                "app_name": "AI MedStudio",
                "project_name": p,
                "include_audio": False,
                "include_chat": True,
                "include_outputs": True,
            },
        )
        stats = manifest["stats"]
        self.assertEqual(stats["source_files"], ["kapitola.txt"])
        self.assertEqual(
            {
                k: stats[k]
                for k in (
                    "source_files_count",
                    "questions_count",
                    "notes_count",
                    "audio_count",
                    "chat_threads_count",
                    "chat_messages_count",
                    "has_embeddings",
                )
            },
            {
                "source_files_count": 1,
                "questions_count": 2,
                "notes_count": 1,
                "audio_count": 0,
                "chat_threads_count": 1,
                "chat_messages_count": 1,
                "has_embeddings": True,
            },
        )
        vectors = json.loads(zf.read("chroma_vectors.json"))
        self.assertEqual(vectors["collection_name"], f"proj_{p}")
        self.assertEqual(stats["chunks_count"], vectors["total_chunks"])
        self.assertGreater(vectors["total_chunks"], 0)
        self.assertEqual(len(vectors["ids"]), len(vectors["embeddings"]))
        db = json.loads(zf.read("database.json"))
        self.assertEqual([m["content"] for m in db["chat_messages"]], ["Ahoj"])

    def test_export_flags(self):
        p = self.project
        zf = self.export(include_audio=True, include_chat=False, include_outputs=False, include_progress=False)
        names = zf.namelist()
        self.assertIn(f"generated/audio/{p}_Q1.mp3", names)
        self.assertFalse(any(n.startswith("generated/notes/") for n in names))
        db = json.loads(zf.read("database.json"))
        self.assertEqual((db["chat_threads"], db["chat_messages"]), ([], []))
        planner = json.loads(zf.read("uploads/exam_planner.json"))
        self.assertEqual(
            planner["questions"][0],
            {
                "id": "q1",
                "title": "Otázka 1",
                "status": "To do",
                "completedDate": None,
                "grade": "",
                "note": "",
                "notesStatus": "To do",
            },
        )
        manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual((manifest["stats"]["audio_count"], manifest["stats"]["notes_count"]), (1, 0))

    def test_export_missing_project(self):
        self.assertEqual(self.client.get("/api/projects/neexistuje_abc/export").status_code, 404)


class TestInspectAndImport(TransferTestCase):
    def test_inspect(self):
        data = self.export().fp.getvalue()
        res = self.client.post("/api/projects/import/inspect", files={"file": ("x.medproj", data)}).json()
        p = self.project
        self.assertEqual(
            {
                k: res[k]
                for k in (
                    "status",
                    "filename",
                    "project_name",
                    "suggested_name",
                    "exists",
                    "has_vectors",
                    "source_files",
                    "source_files_count",
                    "questions_count",
                    "notes_count",
                    "audio_count",
                )
            },
            {
                "status": "ok",
                "filename": "x.medproj",
                "project_name": p,
                "suggested_name": f"{p}_2",
                "exists": True,
                "has_vectors": True,
                "source_files": ["kapitola.txt"],
                "source_files_count": 1,
                "questions_count": 2,
                "notes_count": 1,
                "audio_count": 0,
            },
        )
        self.assertGreater(res["chunks_count"], 0)

    def test_inspect_rejects_bad_files(self):
        self.assertEqual(
            self.client.post("/api/projects/import/inspect", files={"file": ("x.txt", b"x")}).status_code, 400
        )
        self.assertEqual(
            self.client.post("/api/projects/import/inspect", files={"file": ("x.zip", b"nejde o zip")}).status_code, 400
        )
        self.assertEqual(self.import_bytes(b"nejde o zip").status_code, 400)

    def test_import_copy_transfers_vectors_chat_and_planner(self):
        data = self.export().fp.getvalue()
        target = f"{self.project}_kopie"
        res = self.import_bytes(data, project_name=target)
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(
            {k: body[k] for k in ("status", "project", "source_files", "source_files_count", "outputs", "message")},
            {
                "status": "success",
                "project": target,
                "source_files": ["kapitola.txt"],
                "source_files_count": 1,
                "outputs": {"notes": 1, "flashcards": 0, "tests": 0, "audio": 0},
                "message": f"Projekt '{target}' byl úspěšně importován.",
            },
        )
        from core.clients import get_chroma_client

        source_count = get_chroma_client().get_collection(f"proj_{self.project}").count()
        self.assertEqual(body["chunks_count"], source_count)
        self.assertEqual(get_chroma_client().get_collection(f"proj_{target}").count(), source_count)
        # Kopie pod jiným názvem dostane vlastní vlákno; původní projekt o své vlákno nepřijde (oprava 3.2a)
        threads = self.client.get("/api/chat/threads", params={"project_id": target}).json()["threads"]
        self.assertEqual([(t["title"], t["message_count"]) for t in threads], [("Vlákno", 1)])
        original = self.client.get("/api/chat/threads", params={"project_id": self.project}).json()["threads"]
        self.assertEqual([(t["title"], t["message_count"]) for t in original], [("Vlákno", 1)])
        self.assertNotEqual(threads[0]["id"], original[0]["id"])
        self.assertEqual(
            [m["content"] for m in self.client.get(f"/api/chat/threads/{threads[0]['id']}").json()["messages"]],
            ["Ahoj"],
        )
        planner = self.client.get(f"/api/projects/{target}/planner").json()["planner"]
        self.assertEqual((planner["project"], len(planner["questions"])), (target, 2))
        with open(os.path.join(NOTES_DIR, f"{target}_Q1.md"), encoding="utf-8") as f:
            self.assertIn(f'"project": "{target}"', f.read())

    def test_copy_import_keeps_original_searchable(self):
        """Oprava 3.2a: kopie nepřevezme FTS metadata originálu; vyhledávání funguje v obou projektech."""
        from services.chat_service import get_db_connection
        from services.rag_service import query_rag_context_with_sources

        def meta_ids(project):
            with get_db_connection() as conn:
                rows = conn.execute(
                    "SELECT chunk_id FROM project_chunks_meta WHERE project_id = ?", (project,)
                ).fetchall()
            return {r[0] for r in rows}

        # Pozn.: metadata chunků stejnojmenného souboru patří prvnímu projektu, který ho zaindexoval
        # (samostatná chyba, CHANGELOG 3.2a) – proto se porovnává stav originálu před a po importu.
        data = self.export().fp.getvalue()
        original_before = meta_ids(self.project)
        target = f"{self.project}_kopie"
        self.assertEqual(self.import_bytes(data, project_name=target).status_code, 200)
        self.assertEqual(meta_ids(self.project), original_before)
        copy_ids = meta_ids(target)
        self.assertTrue(copy_ids)
        self.assertTrue(all(cid.startswith(f"{target}::") for cid in copy_ids))

        from core.clients import get_chroma_client

        self.assertEqual(set(get_chroma_client().get_collection(f"proj_{target}").get()["ids"]), copy_ids)
        for project in (self.project, target):
            with self.subTest(project=project):
                _, sources, raw = asyncio.run(query_rag_context_with_sources("digoxin fibrilace", project, n_results=5))
                self.assertIn("Digoxin", raw)
                self.assertEqual([s["filename"] for s in sources], ["kapitola.txt"])

    def test_import_under_same_name_keeps_ids(self):
        """Import pod původním názvem (jiný server / po smazání originálu) ID vláken a chunků zachovává."""
        data = self.export().fp.getvalue()
        thread_id = self.client.get("/api/chat/threads", params={"project_id": self.project}).json()["threads"][0]["id"]
        from core.clients import get_chroma_client

        chunk_ids = set(get_chroma_client().get_collection(f"proj_{self.project}").get()["ids"])
        self.assertEqual(self.client.delete(f"/api/projects/{self.project}").status_code, 200)
        self.assertEqual(self.import_bytes(data).status_code, 200)
        threads = self.client.get("/api/chat/threads", params={"project_id": self.project}).json()["threads"]
        self.assertEqual([t["id"] for t in threads], [thread_id])
        self.assertEqual(set(get_chroma_client().get_collection(f"proj_{self.project}").get()["ids"]), chunk_ids)

    def test_import_conflict_and_overwrite(self):
        data = self.export().fp.getvalue()
        conflict = self.import_bytes(data)
        self.assertEqual(conflict.status_code, 409)
        self.assertIn("již existuje", conflict.json()["detail"])

        write_file(os.path.join(UPLOAD_DIR, self.project, "navic.txt"), "smaže se při přepsání")
        res = self.import_bytes(data, overwrite="true", include_chat="false")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(
            self.client.get("/api/files", params={"project": self.project}).json(), {"files": ["kapitola.txt"]}
        )
        self.assertEqual(
            self.client.get("/api/chat/threads", params={"project_id": self.project}).json(), {"threads": []}
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
