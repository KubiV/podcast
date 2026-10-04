import tempfile
import unittest

from services.ai_service import clean_and_parse_json, get_fallback_model
from services.auth_service import AuthService
from services.flashcards_service import normalize_front, resolve_card_source
from services.notes_service import sanitize_markdown_tables


class TestServices(unittest.TestCase):
    def test_clean_and_parse_json_plain(self):
        data = '{"name": "test", "items": [1, 2, 3]}'
        res = clean_and_parse_json(data)
        self.assertEqual(res, [{"name": "test", "items": [1, 2, 3]}])

    def test_clean_and_parse_json_codeblock(self):
        data = '```json\n[{"status": "ok", "count": 42}]\n```'
        res = clean_and_parse_json(data)
        self.assertEqual(res, [{"status": "ok", "count": 42}])

    def test_clean_and_parse_json_invalid(self):
        data = "This is not json at all"
        with self.assertRaises(ValueError):
            clean_and_parse_json(data)

    def test_get_fallback_model(self):
        self.assertEqual(get_fallback_model("gemini-3.6-flash"), "gemini-flash-latest")
        self.assertEqual(get_fallback_model("gemini-2.5-pro"), "gemini-3.6-flash")

    def test_sanitize_markdown_tables(self):
        raw = "| Col A | Col B |\n|---|---|\n| Cell 1 | Cell 2 || Cell 3 | Cell 4 |"
        cleaned = sanitize_markdown_tables(raw)
        self.assertIn("\n| Cell 3 | Cell 4 |", cleaned)

    def test_normalize_front(self):
        self.assertEqual(normalize_front("Co je to kardiomyopatie?"), "co je to kardiomyopatie")
        self.assertEqual(normalize_front("   DIABETES MELLITUS  "), "diabetes mellitus")

    def test_resolve_card_source(self):
        card = {"front": "Q", "back": "A", "source_ref": "[1, str. 12]"}
        sources = [{"id": "1", "filename": "kardiologie.pdf"}]
        resolved = resolve_card_source(card, sources_list=sources, project="kardio")
        self.assertEqual(resolved.get("source_file"), "kardiologie.pdf")
        self.assertEqual(resolved.get("source_page"), "12")

    def test_auth_service_toggle_user_active(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            auth = AuthService(tmpdir)
            admin_data, _ = auth.create_initial_admin("admin_user", "password123")
            admin_id = admin_data["id"]

            # Admin cannot block themselves
            success, msg, status = auth.toggle_user_active(admin_id, admin_id)
            self.assertFalse(success)
            self.assertIn("vlastní administrátorský účet", msg)

            # Register student and approve
            auth.set_registration_allowed(True)
            student_data, _ = auth.register_user("student_user", "password123")
            student_id = student_data["id"]
            auth.approve_user(student_id, role="user")

            # Toggle active -> disabled
            success, msg, status = auth.toggle_user_active(student_id, admin_id)
            self.assertTrue(success)
            self.assertEqual(status, "disabled")
            self.assertIn("zablokován", msg)

            # Toggle disabled -> approved
            success, msg, status = auth.toggle_user_active(student_id, admin_id)
            self.assertTrue(success)
            self.assertEqual(status, "approved")
            self.assertIn("odblokován", msg)

    def test_is_terminal_auth_error(self):
        from core.utils import is_terminal_auth_error

        self.assertTrue(is_terminal_auth_error(Exception("403 Forbidden: permission_denied")))
        self.assertTrue(is_terminal_auth_error(Exception("invalid_api_key provided")))
        self.assertFalse(is_terminal_auth_error(Exception("503 Service Unavailable")))


if __name__ == "__main__":
    unittest.main()
