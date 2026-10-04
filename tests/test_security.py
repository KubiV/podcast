import os
import unittest

from fastapi.testclient import TestClient

from core.security import safe_filename, safe_join
from core.utils import sanitize_name
from main import app


class TestSecurity(unittest.TestCase):
    def test_safe_filename(self):
        self.assertEqual(safe_filename("valid_file.pdf"), "valid_file.pdf")
        self.assertEqual(safe_filename("../../../etc/passwd"), "passwd")
        self.assertEqual(safe_filename("folder/nested/doc.txt"), "doc.txt")
        self.assertEqual(safe_filename("file;rm -rf.mp3"), "file_rm_-rf.mp3")

    def test_safe_join_valid(self):
        base_dir = "/tmp/test_dir"
        joined = safe_join(base_dir, "nested", "file.txt")
        self.assertTrue(joined.startswith(base_dir))
        self.assertEqual(joined, os.path.join(base_dir, "nested", "file.txt"))

    def test_safe_join_traversal_blocked(self):
        from fastapi import HTTPException

        base_dir = "/tmp/test_dir"
        with self.assertRaises(HTTPException):
            safe_join(base_dir, "../../etc/passwd")

    def test_sanitize_name(self):
        self.assertEqual(sanitize_name("Moje Zkouška 2026!"), "Moje_Zkouška_2026")
        self.assertEqual(sanitize_name("projekt / test"), "projekt_test")
        self.assertEqual(sanitize_name(""), "")

    def test_auth_middleware_public_access(self):
        client = TestClient(app)
        # /health must be accessible without authentication
        res = client.get("/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json().get("status"), "ok")

        # /api/auth/status must be accessible without authentication
        res_auth = client.get("/api/auth/status")
        self.assertIn(res_auth.status_code, (200, 401))
        self.assertIsInstance(res_auth.json(), dict)

    def test_auth_middleware_blocks_unauthorized_mutations(self):
        client = TestClient(app)
        # In viewer/guest mode or unauthenticated, mutating POST is blocked (401 or 403)
        res = client.post("/api/projects", json={"name": "test_hack"})
        self.assertIn(res.status_code, (401, 403))

    def test_viewer_role_cannot_modify_exam_questions_or_planner(self):
        from unittest.mock import patch

        client = TestClient(app)
        viewer_user = {
            "id": 99,
            "username": "test_viewer",
            "email": "viewer@test.local",
            "role": "viewer",
            "status": "approved",
            "is_guest": False,
        }
        with patch("services.auth_service.AuthService.validate_session", return_value=viewer_user):
            # 1. Medulingo complete endpoint
            res_med_comp = client.post(
                "/api/medulingo/complete",
                json={"project": "test_proj", "question_id": "q1", "grade": "A", "completed": True},
                cookies={"medstudio_session": "mock_token"},
            )
            self.assertEqual(res_med_comp.status_code, 403)
            self.assertIn("Režim pozorovatele", res_med_comp.json().get("detail", ""))

            # 2. Medulingo generate pack endpoint
            res_med_gen = client.post(
                "/api/medulingo/generate-pack",
                json={"project": "test_proj", "question_id": "q1", "question_title": "Test", "modules": ["notes"]},
                cookies={"medstudio_session": "mock_token"},
            )
            self.assertEqual(res_med_gen.status_code, 403)

            # 3. Project planner save endpoint
            res_planner = client.post(
                "/api/projects/test_proj/planner",
                json={"examDate": "2026-10-10", "startDate": "2026-10-01", "revisionDays": 10, "questions": []},
                cookies={"medstudio_session": "mock_token"},
            )
            self.assertEqual(res_planner.status_code, 403)

            # 4. Project questions save endpoint
            res_questions = client.post(
                "/api/projects/test_proj/questions",
                json=[{"id": "q1", "title": "Otázka 1", "number": 1}],
                cookies={"medstudio_session": "mock_token"},
            )
            self.assertEqual(res_questions.status_code, 403)


if __name__ == "__main__":
    unittest.main()
