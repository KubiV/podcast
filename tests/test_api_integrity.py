import unittest

from fastapi.testclient import TestClient

from main import app


class TestApiIntegrity(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_openapi_schema_contains_all_core_routes(self):
        schema = app.openapi()
        paths = schema.get("paths", {})

        expected_paths = [
            "/health",
            "/api/auth/status",
            "/api/auth/login",
            "/api/settings",
            "/api/projects",
            "/api/files",
            "/api/files/upload",
            "/api/outputs",
            "/api/generate-script",
            "/api/generate-audio",
            "/api/generate-subtitles",
            "/api/generate-notes",
            "/api/notes",
            "/api/generate-flashcards",
            "/api/flashcards",
            "/api/cancel-batch",
            "/api/process-batch",
            "/api/tests",
            "/api/medulingo/overview",
            "/api/chat/threads",
            "/api/stats",
        ]

        for path in expected_paths:
            self.assertIn(path, paths, f"Path {path} is missing from OpenAPI schema!")

    def test_health_endpoint(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertIn("timestamp", data)


if __name__ == "__main__":
    unittest.main()
