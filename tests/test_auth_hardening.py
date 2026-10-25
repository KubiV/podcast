"""Omezení pokusů o přihlášení a atomické vytvoření prvního admina (krok 1.9)."""

import base64
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app
from services.auth_service import AuthService
from tests.test_project_authz import PASSWORD, ProjectAuthzBase


def _reset_limiter():
    try:
        from core import rate_limit
    except ImportError:
        return
    rate_limit.login_limiter.reset_all()


class TestLoginRateLimit(ProjectAuthzBase):
    def setUp(self):
        super().setUp()
        _reset_limiter()

    def tearDown(self):
        _reset_limiter()
        super().tearDown()

    def login(self, username, password, ip="203.0.113.10"):
        client = TestClient(app, client=(ip, 50000))
        return client.post("/api/auth/login", json={"username": username, "password": password})

    # --- Charakterizace ---
    def test_successful_and_failed_login(self):
        ok = self.login("authz_alice", PASSWORD)
        self.assertEqual(ok.status_code, 200)
        self.assertIn("medstudio_session", ok.cookies)
        self.assertEqual(self.login("authz_alice", "spatne-heslo").status_code, 401)

    # --- Omezení ---
    def test_repeated_failures_block_user_from_ip(self):
        for _ in range(10):
            self.assertEqual(self.login("authz_alice", "spatne-heslo").status_code, 401)
        blocked = self.login("authz_alice", PASSWORD)
        self.assertEqual(blocked.status_code, 429)
        self.assertTrue(int(blocked.headers.get("retry-after", "0")) > 0)
        # jiná IP ani jiný uživatel z téže IP blokovaní nejsou
        self.assertEqual(self.login("authz_alice", PASSWORD, ip="203.0.113.99").status_code, 200)
        self.assertEqual(self.login("authz_bob", PASSWORD).status_code, 200)

    def test_success_resets_failures(self):
        for _ in range(9):
            self.login("authz_alice", "spatne-heslo")
        self.assertEqual(self.login("authz_alice", PASSWORD).status_code, 200)
        for _ in range(9):
            self.assertEqual(self.login("authz_alice", "spatne-heslo").status_code, 401)

    def test_many_usernames_block_ip(self):
        for i in range(30):
            self.login(f"neexistuje_{i}", "x")
        self.assertEqual(self.login("authz_bob", PASSWORD).status_code, 429)

    def test_block_expires_after_window(self):
        from core import rate_limit

        now = [1000.0]
        with patch.object(rate_limit.time, "monotonic", side_effect=lambda: now[0]):
            for _ in range(10):
                self.login("authz_alice", "spatne-heslo")
            self.assertEqual(self.login("authz_alice", PASSWORD).status_code, 429)
            now[0] += rate_limit.LOGIN_WINDOW_SECONDS + 1
            self.assertEqual(self.login("authz_alice", PASSWORD).status_code, 200)

    def test_legacy_basic_auth_limited(self):
        def basic(pw):
            token = base64.b64encode(f"x:{pw}".encode()).decode()
            client = TestClient(app, client=("203.0.113.20", 50000))
            return client.get("/api/settings", headers={"Authorization": f"Basic {token}"})

        with patch("main.APP_PASSWORD", "tajne-heslo"):
            self.assertEqual(basic("tajne-heslo").status_code, 200)
            for _ in range(30):
                basic("spatne")
            self.assertEqual(basic("tajne-heslo").status_code, 429)


class TestInitialAdminSetup(unittest.TestCase):
    def setUp(self):
        self._previous_instance = AuthService.get_instance()
        self._tmp = tempfile.TemporaryDirectory()
        self.auth = AuthService(self._tmp.name)

    def tearDown(self):
        AuthService._instance = self._previous_instance
        self._tmp.cleanup()

    def test_second_setup_refused(self):
        self.assertIsNotNone(self.auth.create_initial_admin("admin_a", PASSWORD)[0])
        user, err = self.auth.create_initial_admin("admin_b", PASSWORD)
        self.assertIsNone(user)
        self.assertTrue(err)

    def test_setup_atomic_when_check_races(self):
        """Simulace souběhu: kontrola needs_setup() proběhla dřív, než první admin vznikl."""
        self.assertIsNotNone(self.auth.create_initial_admin("admin_a", PASSWORD)[0])
        with patch.object(self.auth, "needs_setup", return_value=True):
            user, err = self.auth.create_initial_admin("admin_b", PASSWORD)
        self.assertIsNone(user)
        self.assertTrue(err)
        self.assertEqual(self.auth.get_user_count(), 1)

    def test_concurrent_setup_creates_single_admin(self):
        import threading

        barrier = threading.Barrier(4)
        results = []

        def attempt(i):
            barrier.wait()
            results.append(self.auth.create_initial_admin(f"admin_{i}", PASSWORD)[0])

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sum(1 for r in results if r), 1)
        self.assertEqual(self.auth.get_user_count(), 1)


if __name__ == "__main__":
    unittest.main()
