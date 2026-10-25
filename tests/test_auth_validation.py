"""Validace uživatelského jména při registraci a prvotním nastavení (krok 1.6)."""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import tempfile
import unittest

from services.auth_service import AuthService

PASSWORD = "password123"


class TestUsernameValidation(unittest.TestCase):
    def setUp(self):
        # AuthService(...) přepisuje globální singleton, který používá aplikace; po testu ho vrátíme
        self._previous_instance = AuthService.get_instance()
        self._tmp = tempfile.TemporaryDirectory()
        self.auth = AuthService(self._tmp.name)

    def tearDown(self):
        AuthService._instance = self._previous_instance
        self._tmp.cleanup()

    def test_valid_usernames_accepted(self):
        admin, err = self.auth.create_initial_admin("admin.Novák", PASSWORD)
        self.assertIsNotNone(admin, err)
        for name in ("jan_novak", "Jan.Novák-2", "student@lf1", "Žofie"):
            with self.subTest(name=name):
                user, err = self.auth.register_user(name, PASSWORD)
                self.assertIsNotNone(user, err)

    def test_markup_and_quotes_rejected(self):
        self.auth.create_initial_admin("admin_user", PASSWORD)
        for name in ("x');alert(1)//", "<img src=x>", 'a"b', "a b", "a\nb", "a" * 65):
            with self.subTest(name=name):
                user, err = self.auth.register_user(name, PASSWORD)
                self.assertIsNone(user)
                self.assertTrue(err)

    def test_initial_admin_username_validated(self):
        admin, err = self.auth.create_initial_admin("<b>admin</b>", PASSWORD)
        self.assertIsNone(admin)
        self.assertTrue(err)
        self.assertTrue(self.auth.needs_setup())

    def test_existing_login_unaffected(self):
        admin, _ = self.auth.create_initial_admin("admin_user", PASSWORD)
        user, msg = self.auth.authenticate("admin_user", PASSWORD)
        self.assertIsNotNone(user, msg)


if __name__ == "__main__":
    unittest.main()
