"""
Párování studijních textů s otázkami v Medulingu.

Studijní text se ukládá jako `{projekt}_{název otázky zkrácený na 40 znaků}.md` (`notes_filename`). Medulingo
dřív hledalo celý název otázky v názvu souboru, takže otázky delší než 40 znaků svůj text nenašly
(„Pro tuto otázku ještě nebyl vygenerován studijní text“, přestože soubor existoval).
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from core.config import NOTES_DIR, UPLOAD_DIR
from main import auth_service
from services.medulingo_service import MedulingoService
from services.notes_service import notes_filename
from tests.test_project_authz import ProjectAuthzBase

LONG_TITLE = "Nehodgkinské lymfomy, chronická lymfocytární leukemie a příbuzné chorobné stavy"
NOTES_MD = "<!-- METADATA\n{}\n-->\n\n# Lymfomy\n\n## Klasifikace\nB a T lymfomy.\n\n## Léčba\nR-CHOP.\n"


class TestMedulingoNotesMatching(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="medulingo_notes_")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.service = MedulingoService(self.root)
        self.question = {"id": "pq_2", "number": "2", "title": LONG_TITLE, "topic": "Hematologie"}
        self.service._save_planner_data("Interna", {"questions": [self.question]})
        os.makedirs(self.service.notes_dir, exist_ok=True)

    def write_notes(self, filename: str) -> None:
        with open(os.path.join(self.service.notes_dir, filename), "w", encoding="utf-8") as f:
            f.write(NOTES_MD)

    def test_long_title_finds_notes_by_saved_filename(self):
        expected = notes_filename("Interna", LONG_TITLE)
        self.assertEqual(expected, "Interna_Nehodgkinské_lymfomy_chronická_lymfocyt.md")
        self.write_notes(expected)

        content = self.service.get_question_path_content("Interna", "pq_2")

        self.assertTrue(content["status"]["has_notes"])
        self.assertEqual(content["status"]["notes_file"], expected)
        self.assertTrue(content["subtopics"])

    def test_notes_file_stored_on_question_wins(self):
        self.write_notes(notes_filename("Interna", LONG_TITLE))
        self.write_notes("Interna_vlastni_text.md")
        self.service._save_planner_data(
            "Interna", {"questions": [{**self.question, "notes_file": "Interna_vlastni_text.md"}]}
        )

        content = self.service.get_question_path_content("Interna", "pq_2")

        self.assertEqual(content["status"]["notes_file"], "Interna_vlastni_text.md")

    def test_missing_stored_file_falls_back_to_saved_filename(self):
        self.write_notes(notes_filename("Interna", LONG_TITLE))
        self.service._save_planner_data(
            "Interna", {"questions": [{**self.question, "notes_file": "Interna_smazany.md"}]}
        )

        content = self.service.get_question_path_content("Interna", "pq_2")

        self.assertEqual(content["status"]["notes_file"], notes_filename("Interna", LONG_TITLE))


class TestMedulingoGeneratePackStoresNotesFile(ProjectAuthzBase):
    def test_generated_notes_are_found_right_away(self):
        project = "authz_alice_proj"
        planner_path = os.path.join(UPLOAD_DIR, project, "exam_planner.json")
        with open(planner_path, "w", encoding="utf-8") as f:
            json.dump({"questions": [{"id": "pq_9", "number": "9", "title": LONG_TITLE}]}, f, ensure_ascii=False)
        self.addCleanup(os.remove, planner_path)
        saved = notes_filename(project, LONG_TITLE)

        async def fake_notes(question, project, **kwargs):
            with open(os.path.join(NOTES_DIR, saved), "w", encoding="utf-8") as f:
                f.write(NOTES_MD)
            return "md", [], saved

        self.addCleanup(
            lambda: os.path.exists(os.path.join(NOTES_DIR, saved)) and os.remove(os.path.join(NOTES_DIR, saved))
        )
        shared_before = auth_service.is_shared_api_keys()
        self.addCleanup(auth_service.set_shared_api_keys, shared_before)
        auth_service.set_shared_api_keys(True)
        with patch("routers.medulingo.internal_generate_notes", fake_notes):
            res = self.client_as("alice").post(
                "/api/medulingo/generate-pack",
                json={"project": project, "question_id": "pq_9", "question_title": LONG_TITLE, "modules": ["notes"]},
            )
        self.assertEqual(res.status_code, 200, res.text)

        with open(planner_path, encoding="utf-8") as f:
            stored = json.load(f)["questions"][0]
        self.assertEqual(stored.get("notes_file"), saved)
        detail = self.client_as("alice").get("/api/medulingo/question/pq_9", params={"project": project}).json()
        self.assertEqual(detail["status"]["notes_file"], saved)
        self.assertTrue(detail["subtopics"])


if __name__ == "__main__":
    unittest.main()
