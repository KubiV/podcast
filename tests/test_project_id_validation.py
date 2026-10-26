"""
Validace ID projektu: `.`, `..` a prázdné ID nesmí ukázat na `uploads/` ani na celou datovou složku (QA-001, QA-002).

`sanitize_name` ponechává tečky a Starlette dekóduje `%2E%2E` v cestě na `..`, takže před opravou student smazal
jediným `DELETE /api/projects/%2E%2E` celou datovou složku a pozorovatel nebo host si přes export stáhl `auth.db`.
Testy kontrolují, že každá cesta s ID projektu (v URL, v query, v JSON těle i ve formuláři) vrátí 400 a datová
složka zůstane beze změny. Pracují jen s dočasnou datovou složkou z `tests/__init__.py`.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import io
import json
import os
import re
import unittest
import zipfile

from fastapi import HTTPException

from core.config import UPLOAD_DIR, USER_DATA_DIR
from core.security import validate_project_id
from main import app, auth_service
from tests.test_project_authz import ProjectAuthzBase

# `%2E%2E` = `..`, `%2E` = `.`; holé `..` by klient normalizoval už v URL
DOT_IDS = ("%2E%2E", "%2E", "%2E%2E%2E")
DOT_NAMES = ("..", ".", "...", " .. ")
PROJECT_PATH_PARAMS = ("{project_id}", "{project}")
# `project` je tu jen escapovaný popisek tiskového náhledu, s cestami na disku nepracuje
PROJECT_LABEL_ONLY = {"/api/print/prepare"}
# Hodnoty, aby se požadavek dostal přes kontroly povinných polí až ke kontrole projektu
JSON_FILLERS = {
    "question": "Q",
    "questions": [{"id": 1, "title": "Q"}],
    "message": "Q",
    "script": "HOST: Q",
    "question_id": 1,
    "question_title": "Q",
    "previous_test_id": "x",
    "html": "<p>Q</p>",
}


def _snapshot() -> dict[str, list[str]]:
    # Pomocné soubory SQLite (-wal, -shm, -journal) vznikají a mizí průběžně, do snímku nepatří
    return {
        d: sorted(f for f in os.listdir(d) if not f.endswith(("-wal", "-shm", "-journal")))
        for d in (USER_DATA_DIR, UPLOAD_DIR)
    }


def _medproj(project_name: str = "Zdroj") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", json.dumps({"format": "medproj", "project_name": project_name}))
        zf.writestr("uploads/a.txt", "obsah")
    return buf.getvalue()


class TestValidateProjectId(unittest.TestCase):
    def test_rejects_empty_and_dot_only_ids(self):
        for name in ("", None, "   ", "!!!", *DOT_NAMES, "_.._"):
            with self.subTest(name=name), self.assertRaises(HTTPException) as ctx:
                validate_project_id(name)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_keeps_regular_ids(self):
        self.assertEqual(validate_project_id("Interna"), "Interna")
        self.assertEqual(validate_project_id("Kardiologie č. 1"), "Kardiologie_č._1")
        self.assertEqual(validate_project_id("v1.2"), "v1.2")
        # `../evil` se sanitizuje na běžný název složky uvnitř uploads/
        self.assertEqual(validate_project_id("../evil"), ".._evil")


class TestDotProjectIds(ProjectAuthzBase):
    """Student (role user) ve sdíleném režimu, kde by jinak prošel přes kontrolu vlastnictví."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Pojistka: testy smí běžet jen nad dočasnou datovou složkou z tests/__init__.py
        assert os.path.basename(USER_DATA_DIR).startswith("aimedstudio_tests_"), USER_DATA_DIR

    def setUp(self):
        super().setUp()
        auth_service.set_shared_projects(True)
        self.student = self.client_as("alice")
        self.before = _snapshot()

    def assertDataIntact(self):
        self.assertEqual(_snapshot(), self.before)

    def assertRejected(self, response, label: str):
        self.assertEqual(response.status_code, 400, f"{label}: {response.status_code} {response.text[:200]}")

    def test_delete_project_dot_ids(self):
        for pid in DOT_IDS:
            with self.subTest(pid=pid):
                self.assertRejected(self.student.delete(f"/api/projects/{pid}"), f"DELETE {pid}")
        self.assertDataIntact()

    def test_export_dot_ids_for_viewer_and_guest(self):
        viewer = self.client_as("viewer")
        guest_before = auth_service.is_guest_allowed()
        auth_service.set_guest_allowed(True)
        try:
            from fastapi.testclient import TestClient

            guest = TestClient(app)
            for client, who in ((viewer, "viewer"), (guest, "host"), (self.student, "student")):
                for pid in DOT_IDS:
                    for suffix in ("export", "export-info"):
                        with self.subTest(who=who, pid=pid, suffix=suffix):
                            r = client.get(f"/api/projects/{pid}/{suffix}")
                            self.assertRejected(r, f"{who} {suffix} {pid}")
                            self.assertNotIn(b"auth.db", r.content)
        finally:
            auth_service.set_guest_allowed(guest_before)

    def test_import_into_dot_names_is_rejected(self):
        for name in DOT_NAMES:
            for overwrite in ("true", "false"):
                with self.subTest(name=name, overwrite=overwrite):
                    r = self.student.post(
                        "/api/projects/import",
                        data={"project_name": name, "overwrite": overwrite},
                        files={"file": ("p.medproj", _medproj(), "application/zip")},
                    )
                    self.assertRejected(r, f"import {name!r}")
        self.assertDataIntact()

    def test_import_from_manifest_with_dot_name_is_rejected(self):
        """Bez `project_name` se cíl bere z manifestu; ani tam `..` nesmí projít."""
        r = self.student.post(
            "/api/projects/import",
            data={"overwrite": "true"},
            files={"file": ("p.medproj", _medproj(".."), "application/zip")},
        )
        self.assertRejected(r, "import manifest ..")
        inspect = self.student.post(
            "/api/projects/import/inspect", files={"file": ("p.medproj", _medproj(".."), "application/zip")}
        )
        self.assertEqual(inspect.status_code, 200)
        self.assertEqual(inspect.json()["suggested_name"], "Importovany_projekt")
        self.assertDataIntact()

    def test_create_and_rename_to_dot_names(self):
        for name in DOT_NAMES + ("!!!",):
            with self.subTest(name=name):
                self.assertRejected(self.student.post("/api/projects", json={"name": name}), f"create {name!r}")
                r = self.student.post("/api/projects/authz_alice_proj/rename", json={"new_name": name})
                self.assertRejected(r, f"rename → {name!r}")
        self.assertTrue(os.path.isdir(os.path.join(UPLOAD_DIR, "authz_alice_proj")))
        self.assertDataIntact()

    def test_lessons_dot_ids(self):
        for pid in DOT_IDS:
            with self.subTest(pid=pid):
                self.assertRejected(self.student.get(f"/api/lessons/{pid}"), f"GET lesson {pid}")
                self.assertRejected(self.student.delete(f"/api/lessons/{pid}"), f"DELETE lesson {pid}")
        self.assertDataIntact()

    def test_every_route_with_project_in_path(self):
        """Všechny operace z OpenAPI s `{project_id}`/`{project}` v cestě (zachytí i nově přidané routy)."""
        checked = 0
        for path, ops in app.openapi()["paths"].items():
            if not any(p in path for p in PROJECT_PATH_PARAMS):
                continue
            for method in ops:
                for pid in DOT_IDS:
                    url = path
                    for param in PROJECT_PATH_PARAMS:
                        url = url.replace(param, pid)
                    url = re.sub(r"\{[^}]+\}", "x.txt", url)
                    with self.subTest(method=method, url=url):
                        kwargs = {} if method in ("get", "delete") else {"json": {}}
                        self.assertRejected(self.student.request(method.upper(), url, **kwargs), f"{method} {url}")
                        checked += 1
        self.assertGreater(checked, 40)
        self.assertDataIntact()

    def test_every_route_with_project_in_query_or_json(self):
        """Operace s parametrem `project` v query nebo s polem `project` v JSON těle."""
        spec = app.openapi()
        schemas = spec["components"]["schemas"]
        checked = 0
        for path, ops in spec["paths"].items():
            if any(p in path for p in PROJECT_PATH_PARAMS) or path in PROJECT_LABEL_ONLY:
                continue
            url = re.sub(r"\{[^}]+\}", "x.json", path)
            for method, op in ops.items():
                query = [p["name"] for p in op.get("parameters", []) if p["in"] == "query"]
                ref = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema", {})
                body_props = schemas.get(ref.get("$ref", "").split("/")[-1], {}).get("properties", {})
                for name in ("..", "."):
                    if "project" in query:
                        with self.subTest(method=method, path=path, where="query", name=name):
                            r = self.student.request(method.upper(), url, params={"project": name})
                            self.assertRejected(r, f"{method} {path}?project={name}")
                            checked += 1
                    if "project" in body_props:
                        with self.subTest(method=method, path=path, where="json", name=name):
                            r = self.student.request(method.upper(), url, json={**JSON_FILLERS, "project": name})
                            self.assertRejected(r, f"{method} {path} json project={name}")
                            checked += 1
        self.assertGreater(checked, 20)
        self.assertDataIntact()

    def test_upload_form_dot_project(self):
        for name in DOT_NAMES:
            with self.subTest(name=name):
                r = self.student.post(
                    "/api/files/upload", data={"project": name}, files=[("files", ("a.txt", b"obsah", "text/plain"))]
                )
                self.assertRejected(r, f"upload {name!r}")
        self.assertFalse(os.path.exists(os.path.join(UPLOAD_DIR, "a.txt")))
        self.assertDataIntact()


if __name__ == "__main__":
    unittest.main()
