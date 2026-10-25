"""
Charakterizační testy CRUD endpointů (krok 2.2): projekty, soubory, poznámky, kartičky, testy, audio,
statistiky, plánovač, otázky a chat vlákna. Zachycují současné chování jako pojistku pro refaktoring
(fáze 3); časové hodnoty (mtime, created_at) se záměrně neporovnávají.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import json
import os
import time
import unittest

from core.config import AUDIO_DIR, FLASHCARDS_DIR, NOTES_DIR, TESTS_DIR, UPLOAD_DIR
from services.chat_service import save_message
from tests.support import client_for_user, ensure_user, unique_name, write_file


def _outputs_with_prefix(prefix: str) -> list[str]:
    return sorted(
        f for d in (NOTES_DIR, FLASHCARDS_DIR, TESTS_DIR, AUDIO_DIR) for f in os.listdir(d) if f.startswith(prefix)
    )


class CrudTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin_id = ensure_user("crud_admin", "admin")
        from main import auth_service

        auth_service.change_user_role(cls.admin_id, "admin", cls.admin_id)

    def setUp(self):
        from main import auth_service

        self._shared_before = auth_service.is_shared_projects()
        auth_service.set_shared_projects(True)
        self.client = client_for_user(self.admin_id)
        base = unique_name("Crud")
        res = self.client.post("/api/projects", json={"name": f"{base} Projekt!"})
        self.assertEqual(res.status_code, 200)
        self.project = res.json()["project"]
        self.assertEqual(self.project, f"{base}_Projekt")
        self.assertEqual(res.json()["owner_id"], self.admin_id)

    def tearDown(self):
        from main import auth_service

        auth_service.set_shared_projects(self._shared_before)

    def seed(self):
        p = self.project
        write_file(os.path.join(UPLOAD_DIR, p, "kapitola.txt"), "Text kapitoly.\n\nDruhý odstavec.")
        write_file(os.path.join(UPLOAD_DIR, p, "poznamka.md"), "md soubor")
        write_file(
            os.path.join(NOTES_DIR, f"{p}_Q1_Otazka.md"),
            f'<!-- METADATA\n{{"question": "Otázka 1", "project": "{p}", "sources": [{{"id": "1", "filename": "kapitola.txt"}}]}}\n-->\n# Nadpis\n\nText.',
        )
        write_file(os.path.join(NOTES_DIR, f"{p}_bez_meta.md"), "# Bez metadat")
        old = time.time() - 100
        os.utime(os.path.join(NOTES_DIR, f"{p}_Q1_Otazka.md"), (old, old))
        deck = {
            "question": "Otázka 1",
            "project": p,
            "count": 2,
            "cards": [
                {"front": "Co je A?", "back": "B", "source_ref": "[1, s. 3]"},
                {"front": "co je a", "back": "dup"},
            ],
            "sources": [{"id": "1", "filename": "kapitola.txt"}],
        }
        write_file(os.path.join(FLASHCARDS_DIR, f"{p}_Q1.json"), json.dumps(deck, ensure_ascii=False))
        # Konvence aplikace: soubor testu = {projekt}_{id}.json (save_test)
        self.test_id = unique_name("test")
        self.test_file = f"{p}_{self.test_id}.json"
        test = {
            "id": self.test_id,
            "filename": self.test_file,
            "project": p,
            "title": "Test 1",
            "questions": [{"id": "q1"}],
        }
        write_file(os.path.join(TESTS_DIR, self.test_file), json.dumps(test, ensure_ascii=False))
        write_file(os.path.join(AUDIO_DIR, f"{p}_Q1.mp3"), "mp3")
        write_file(os.path.join(AUDIO_DIR, f"{p}_Q1.srt"), "srt")


class TestProjectsAndFiles(CrudTestCase):
    def test_project_listed(self):
        body = self.client.get("/api/projects").json()
        self.assertIn(self.project, body["projects"])
        self.assertEqual((body["shared_projects"], body["is_admin"]), (True, True))

    def test_files_list_view_preview_delete(self):
        self.seed()
        p = self.project
        self.assertEqual(self.client.get("/api/files", params={"project": p}).json(), {"files": ["kapitola.txt"]})

        view = self.client.get(f"/api/files/{p}/kapitola.txt/view")
        self.assertEqual(view.text, "Text kapitoly.\n\nDruhý odstavec.")
        self.assertEqual(view.headers["content-type"], "text/plain; charset=utf-8")
        self.assertEqual(view.headers["content-disposition"], "inline; filename*=UTF-8''kapitola.txt")

        preview = self.client.get(f"/api/files/{p}/kapitola.txt/preview").json()
        self.assertEqual(
            {
                k: preview[k]
                for k in ("filename", "project", "extension", "size_bytes", "total_pages", "sections_count")
            },
            {
                "filename": "kapitola.txt",
                "project": p,
                "extension": "txt",
                "size_bytes": 32,
                "total_pages": 1,
                "sections_count": 1,
            },
        )
        self.assertEqual(
            preview["sections"],
            [{"text": "Text kapitoly.\n\nDruhý odstavec.", "source": "kapitola.txt", "page": "1", "page_number": 1}],
        )

        self.assertEqual(
            self.client.delete("/api/files/kapitola.txt", params={"project": p}).json(), {"status": "success"}
        )
        self.assertEqual(self.client.get("/api/files", params={"project": p}).json(), {"files": []})
        self.assertEqual(self.client.delete("/api/files/kapitola.txt", params={"project": p}).status_code, 404)

    def test_stats_and_export_info(self):
        self.seed()
        p = self.project
        stats = self.client.get("/api/stats", params={"project": p}).json()
        self.assertEqual(
            stats,
            {
                "project": p,
                "files_count": 1,
                "media_count": 1,
                "notes_count": 2,
                "flashcards_count": 1,
                "tests_count": 1,
                "lessons_count": stats["lessons_count"],
                "chat_count": 0,
                "questions_count": 0,
            },
        )
        info = self.client.get(f"/api/projects/{p}/export-info").json()
        # Charakterizace: export-info počítá všechny soubory projektu (i .md), /api/files jen povolené typy
        self.assertEqual(
            info["source_files"], [{"name": "kapitola.txt", "size": 32}, {"name": "poznamka.md", "size": 9}]
        )
        self.assertEqual(
            {
                k: info[k]
                for k in ("source_files_count", "notes_count", "flashcards_count", "tests_count", "audio_count")
            },
            {"source_files_count": 2, "notes_count": 2, "flashcards_count": 1, "tests_count": 1, "audio_count": 2},
        )


class TestOutputs(CrudTestCase):
    def setUp(self):
        super().setUp()
        self.seed()

    def test_notes(self):
        p = self.project
        notes = self.client.get("/api/notes", params={"project": p}).json()["notes"]
        self.assertEqual(
            [(n["filename"], n["title"]) for n in notes],
            [(f"{p}_bez_meta.md", f"{p}_bez_meta"), (f"{p}_Q1_Otazka.md", "Otázka 1")],
        )
        note = self.client.get(f"/api/notes/{p}_Q1_Otazka.md").json()
        self.assertEqual(note["markdown"], "# Nadpis\n\nText.")
        self.assertEqual(note["sources"], [{"id": "1", "filename": "kapitola.txt"}])
        self.assertEqual(note["project"], p)
        self.assertTrue(note["raw"].startswith("<!-- METADATA"))
        plain = self.client.get(f"/api/notes/{p}_bez_meta.md").json()
        self.assertEqual((plain["markdown"], plain["sources"], plain["project"]), ("# Bez metadat", [], ""))

        self.assertEqual(self.client.delete(f"/api/notes/{p}_bez_meta.md").json(), {"status": "success"})
        self.assertEqual(self.client.get(f"/api/notes/{p}_bez_meta.md").status_code, 404)

    def test_flashcards(self):
        p = self.project
        decks = self.client.get("/api/flashcards", params={"project": p}).json()["decks"]
        self.assertEqual([(d["filename"], d["question"], d["count"]) for d in decks], [(f"{p}_Q1.json", "Otázka 1", 2)])

        deck = self.client.get(f"/api/flashcards/{p}_Q1.json").json()
        self.assertEqual(
            deck["cards"][0],
            {
                "front": "Co je A?",
                "back": "B",
                "source_ref": "[1, s. 3]",
                "source_file": "kapitola.txt",
                "source_page": "3",
                "clean_page": "3",
                "source_quote": "",
            },
        )
        self.assertEqual(deck["cards"][1]["source_file"], "")

        export = self.client.get("/api/flashcards/export-all", params={"project": p}).json()
        # Charakterizace: duplicitní líc („co je a“) se při exportu sloučí
        self.assertEqual((export["project"], export["total_decks"], export["total_cards"]), (p, 1, 1))
        self.assertTrue(export["anki_tsv"].startswith("#separator:tab\n#html:true\n"))
        self.assertIn("Co je A?\tB", export["anki_tsv"])

        self.assertEqual(self.client.delete(f"/api/flashcards/{p}_Q1.json").json(), {"status": "success"})
        self.assertEqual(self.client.get("/api/flashcards", params={"project": p}).json(), {"decks": []})

    def test_tests(self):
        p = self.project
        listed = self.client.get("/api/tests", params={"project": p}).json()["tests"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(
            {
                k: listed[0][k]
                for k in ("filename", "id", "title", "project", "difficulty", "count", "rounds", "mode", "result")
            },
            {
                "filename": self.test_file,
                "id": self.test_id,
                "title": "Test 1",
                "project": p,
                "difficulty": "normal",
                "count": 1,
                "rounds": 1,
                "mode": "instant",
                "result": None,
            },
        )
        self.assertEqual(self.client.get(f"/api/tests/{self.test_file}").json()["id"], self.test_id)
        # Dohledání podle id (hledá podřetězec v názvech souborů všech projektů)
        self.assertEqual(self.client.get(f"/api/tests/{self.test_id}").json()["filename"], self.test_file)

        res = self.client.post(f"/api/tests/{self.test_file}/result", json={"score": 3, "total": 5}).json()
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["test"]["result"], {"score": 3, "total": 5})
        self.assertEqual(
            self.client.get("/api/tests", params={"project": p}).json()["tests"][0]["result"], {"score": 3, "total": 5}
        )

        self.assertEqual(self.client.delete(f"/api/tests/{self.test_file}").json(), {"status": "success"})
        self.assertEqual(self.client.get(f"/api/tests/{self.test_file}").status_code, 404)

    def test_audio_outputs(self):
        p = self.project
        self.assertEqual(
            sorted(self.client.get("/api/outputs", params={"project": p}).json()["files"]),
            [f"{p}_Q1.mp3", f"{p}_Q1.srt"],
        )
        self.assertEqual(self.client.delete(f"/api/outputs/{p}_Q1.srt").json(), {"status": "success"})
        self.assertEqual(self.client.get("/api/outputs", params={"project": p}).json()["files"], [f"{p}_Q1.mp3"])


class TestPlannerAndQuestions(CrudTestCase):
    def test_planner_and_questions_round_trip(self):
        p = self.project
        default = {"examDate": "", "startDate": "", "revisionDays": 14, "scheduleMode": "sequential", "questions": []}
        self.assertEqual(self.client.get(f"/api/projects/{p}/planner").json(), {"project": p, "planner": default})

        saved = self.client.post(
            f"/api/projects/{p}/planner",
            json={"examDate": "2026-12-01", "revisionDays": "7", "questions": [{"id": "q1", "title": "Otázka 1"}]},
        ).json()
        expected = {
            **default,
            "examDate": "2026-12-01",
            "revisionDays": 7,
            "questions": [{"id": "q1", "title": "Otázka 1"}],
        }
        self.assertEqual(saved, {"status": "success", "project": p, "planner": expected})

        questions = [{"id": "q1", "title": "Otázka 1"}, {"id": "q2", "title": "Otázka 2", "topic": "Kardio"}]
        self.assertEqual(
            self.client.post(f"/api/projects/{p}/questions", json={"questions": questions}).json(),
            {"status": "success", "project": p, "questions": questions},
        )
        self.assertEqual(self.client.get(f"/api/projects/{p}/questions").json(), {"project": p, "questions": questions})
        # Uložení otázek zachová ostatní nastavení plánovače
        planner = self.client.get(f"/api/projects/{p}/planner").json()["planner"]
        self.assertEqual(
            (planner["examDate"], planner["revisionDays"], planner["questions"]), ("2026-12-01", 7, questions)
        )
        self.assertEqual(self.client.get("/api/stats", params={"project": p}).json()["questions_count"], 2)


class TestChatThreads(CrudTestCase):
    def test_thread_lifecycle_and_exports(self):
        p = self.project
        created = self.client.post("/api/chat/threads", json={"project_id": p, "title": "Vlákno A"}).json()
        self.assertEqual(created["status"], "success")
        thread = created["thread"]
        self.assertEqual(
            {k: thread[k] for k in ("project_id", "title", "is_pinned", "message_count", "last_snippet", "last_role")},
            {
                "project_id": p,
                "title": "Vlákno A",
                "is_pinned": False,
                "message_count": 0,
                "last_snippet": "",
                "last_role": "",
            },
        )
        self.assertRegex(thread["id"], r"^thread_[0-9a-f]{12}$")
        tid = thread["id"]

        save_message(p, role="user", content="Ahoj", thread_id=tid)
        save_message(
            p, role="assistant", content="Dobrý den", thread_id=tid, sources=[{"id": "1", "filename": "kapitola.txt"}]
        )

        listed = self.client.get("/api/chat/threads", params={"project_id": p}).json()["threads"]
        self.assertEqual(
            [(t["id"], t["message_count"], t["last_snippet"], t["last_role"]) for t in listed],
            [(tid, 2, "Dobrý den", "assistant")],
        )
        found = self.client.get("/api/chat/threads", params={"project_id": "__all__", "q": "Dobrý"}).json()["threads"]
        self.assertIn(tid, [t["id"] for t in found])

        detail = self.client.get(f"/api/chat/threads/{tid}").json()
        self.assertEqual(
            [(m["role"], m["content"], m["sources"]) for m in detail["messages"]],
            [("user", "Ahoj", []), ("assistant", "Dobrý den", [{"id": "1", "filename": "kapitola.txt"}])],
        )
        self.assertEqual(detail["thread"]["message_count"], 2)

        self.assertEqual(
            self.client.patch(f"/api/chat/threads/{tid}", json={"title": "Přejmenováno"}).json()["thread"]["title"],
            "Přejmenováno",
        )
        self.assertTrue(self.client.post(f"/api/chat/threads/{tid}/pin").json()["thread"]["is_pinned"])
        self.assertFalse(self.client.post(f"/api/chat/threads/{tid}/pin").json()["thread"]["is_pinned"])

        export = self.client.get(f"/api/chat/threads/{tid}/export")
        self.assertRegex(
            export.headers["content-disposition"], r'^attachment; filename="chat_P_ejmenov_no_\d{8}_\d{6}\.md"$'
        )
        self.assertTrue(export.text.startswith(f"# Přejmenováno\n*Projekt: {p} | Vygenerováno: "))
        self.assertIn("### 👤 Uživatel", export.text)
        self.assertIn("**Citované zdroje:**\n- `[1]` kapitola.txt", export.text)

        msgs = self.client.get(f"/api/projects/{p}/messages").json()
        self.assertEqual([m["content"] for m in msgs["messages"]], ["Ahoj", "Dobrý den"])
        project_export = self.client.get(f"/api/projects/{p}/chat/export").text
        self.assertTrue(project_export.startswith(f"# Export chatu – Projekt: {p}\n"))

        self.assertEqual(self.client.delete(f"/api/chat/threads/{tid}").json(), {"status": "success", "deleted": True})
        self.assertEqual(self.client.get(f"/api/chat/threads/{tid}").status_code, 404)
        self.assertEqual(self.client.get("/api/chat/threads", params={"project_id": p}).json(), {"threads": []})


class TestRenameClearDelete(CrudTestCase):
    def setUp(self):
        super().setUp()
        self.seed()
        self.client.post(
            f"/api/projects/{self.project}/questions", json={"questions": [{"id": "q1", "title": "Otázka 1"}]}
        )
        self.client.post(
            f"/api/projects/{self.project}/planner", json={"examDate": "2026-12-01", "questions": [{"id": "q1"}]}
        )
        self.thread_id = self.client.post("/api/chat/threads", json={"project_id": self.project}).json()["thread"]["id"]
        save_message(self.project, role="user", content="Ahoj", thread_id=self.thread_id)

    def test_rename_moves_everything(self):
        old = self.project
        new = f"{old}_Novy"
        self.assertEqual(
            self.client.post(f"/api/projects/{old}/rename", json={"new_name": f"{old} Novy"}).json(),
            {"status": "renamed", "old_project": old, "new_project": new},
        )
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, old)))
        self.assertEqual(self.client.get("/api/files", params={"project": new}).json(), {"files": ["kapitola.txt"]})
        self.assertEqual(
            _outputs_with_prefix(new),
            sorted(
                [f"{new}_Q1_Otazka.md", f"{new}_bez_meta.md", f"{new}_Q1.json", f"{new}_{self.test_id}.json"]
                + [f"{new}_Q1.mp3", f"{new}_Q1.srt"]
            ),
        )
        self.assertEqual(_outputs_with_prefix(f"{old}_Q"), [])
        with open(os.path.join(TESTS_DIR, f"{new}_{self.test_id}.json"), encoding="utf-8") as f:
            test_data = json.load(f)
        self.assertEqual((test_data["project"], test_data["filename"]), (new, f"{new}_{self.test_id}.json"))
        threads = self.client.get("/api/chat/threads", params={"project_id": new}).json()["threads"]
        self.assertEqual([t["id"] for t in threads], [self.thread_id])
        self.assertEqual(self.client.get(f"/api/projects/{new}/planner").json()["planner"]["examDate"], "2026-12-01")
        self.assertNotIn(old, self.client.get("/api/projects").json()["projects"])

    def test_rename_edge_cases(self):
        p = self.project
        self.assertEqual(
            self.client.post(f"/api/projects/{p}/rename", json={"new_name": p}).json(),
            {"status": "unchanged", "project": p},
        )
        self.assertEqual(self.client.post(f"/api/projects/{p}/rename", json={"new_name": ""}).status_code, 400)
        other = self.client.post("/api/projects", json={"name": f"{p}_jiny"}).json()["project"]
        self.assertEqual(self.client.post(f"/api/projects/{p}/rename", json={"new_name": other}).status_code, 400)
        self.assertEqual(
            self.client.post("/api/projects/neexistuje_xyz/rename", json={"new_name": "abc_xyz"}).status_code, 404
        )

    def test_clear_data_is_selective(self):
        p = self.project
        res = self.client.post(
            f"/api/projects/{p}/clear-data", json={"clear_notes": True, "clear_chat": True, "clear_questions": True}
        )
        self.assertEqual(
            res.json(), {"status": "cleared", "project": p, "cleared_categories": ["chat", "notes", "questions"]}
        )
        self.assertEqual(
            _outputs_with_prefix(p), sorted([f"{p}_Q1.json", self.test_file, f"{p}_Q1.mp3", f"{p}_Q1.srt"])
        )
        self.assertEqual(self.client.get(f"/api/projects/{p}/messages").json()["messages"], [])
        planner = self.client.get(f"/api/projects/{p}/planner").json()["planner"]
        self.assertEqual((planner["examDate"], planner["questions"]), ("2026-12-01", []))
        self.assertEqual(self.client.get("/api/files", params={"project": p}).json(), {"files": ["kapitola.txt"]})

    def test_delete_project_removes_everything(self):
        p = self.project
        res = self.client.delete(f"/api/projects/{p}").json()
        self.assertEqual((res["status"], res["project"]), ("deleted", p))
        self.assertEqual(res["deleted_outputs"], {"notes": 2, "flashcards": 1, "tests": 1, "audio": 2})
        self.assertEqual(_outputs_with_prefix(p), [])
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, p)))
        self.assertEqual(self.client.get(f"/api/chat/threads/{self.thread_id}").status_code, 404)
        self.assertNotIn(p, self.client.get("/api/projects").json()["projects"])
        self.assertEqual(self.client.delete(f"/api/projects/{p}").status_code, 404)


if __name__ == "__main__":
    unittest.main()
