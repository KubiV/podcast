"""
Klíč Gemini pro chat a lekce podle režimu API klíčů (krok 4.3, nálezy R4 a R5).

Chat (`services.chat.storage.get_ai_client`) a lekce dřív četly vždy globální klíč z konfigurace serveru
a v privátním režimu (per-user BYOK) ignorovaly klíč přihlášeného uživatele. Teď se řídí `core.clients`
stejně jako ostatní generování. Testy nahrazují `genai.Client` záznamníkem, takže nikam nevolají.
"""

import json
import os
import unittest
from unittest.mock import patch

import core.clients
from core.config import CONFIG_FILE
from core.context import current_user_var
from main import auth_service
from services.chat import storage
from tests.support import FakeGeminiClient, OfflineAITestCase
from tests.test_project_authz import ProjectAuthzBase

CFG_KEY = "test-server-config-key"
ALICE_KEY = "test-alice-own-key"
MISSING_KEY_MESSAGE = (
    "Není nastaven Google Gemini API klíč. Přejděte v horní liště do 'Nastavení ⚙️' a zadejte svůj API klíč."
)


class _ByokBase(ProjectAuthzBase):
    def setUp(self):
        super().setUp()
        self._shared_keys_before = auth_service.is_shared_api_keys()
        self.addCleanup(auth_service.set_shared_api_keys, self._shared_keys_before)
        self._config_before = open(CONFIG_FILE, encoding="utf-8").read() if os.path.exists(CONFIG_FILE) else None
        self.addCleanup(self._restore_config)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump({"gemini_api_key": CFG_KEY}, f)
        for name in ("alice", "admin"):
            before = auth_service.get_user_api_keys(self.ids[name])["gemini_api_key"]
            self.addCleanup(auth_service.save_user_api_keys, self.ids[name], gemini_api_key=before)
            auth_service.save_user_api_keys(self.ids[name], gemini_api_key="")

        # Záznamník místo genai.Client: každý vytvořený klient si pamatuje svůj klíč
        self.keys: list[str] = []

        def fake_client(api_key):
            self.keys.append(api_key)
            return FakeGeminiClient(["Odpověď z materiálů."])

        for p in (
            patch.object(core.clients.genai, "Client", fake_client),
            patch.object(core.clients, "_ai_client", None),
        ):
            p.start()
            self.addCleanup(p.stop)

    def _restore_config(self):
        if self._config_before is None:
            os.remove(CONFIG_FILE)
        else:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                f.write(self._config_before)

    def key_used_by_chat_client(self, user_name: str):
        """Klíč klienta, kterého chat/lekce dostanou v kontextu uživatele (nebo výjimka)."""
        user = auth_service.get_user_by_id(self.ids[user_name])
        token = current_user_var.set(user)
        try:
            storage.get_ai_client()
        except Exception as exc:  # noqa: BLE001 – charakterizujeme i chybu
            return exc
        finally:
            current_user_var.reset(token)
        return self.keys[-1]


class TestChatClientKeys(_ByokBase):
    def test_shared_mode_uses_server_key(self):
        auth_service.set_shared_api_keys(True)
        auth_service.save_user_api_keys(self.ids["alice"], gemini_api_key=ALICE_KEY)
        self.assertEqual(self.key_used_by_chat_client("alice"), CFG_KEY)

    def test_private_mode_uses_users_own_key(self):
        auth_service.set_shared_api_keys(False)
        auth_service.save_user_api_keys(self.ids["alice"], gemini_api_key=ALICE_KEY)
        self.assertEqual(self.key_used_by_chat_client("alice"), ALICE_KEY)

    def test_private_mode_user_without_key_gets_original_error(self):
        auth_service.set_shared_api_keys(False)
        result = self.key_used_by_chat_client("alice")
        self.assertIsInstance(result, ValueError)
        self.assertEqual(str(result), MISSING_KEY_MESSAGE)
        self.assertEqual(self.keys, [])

    def test_private_mode_admin_without_key_falls_back_to_server_key(self):
        auth_service.set_shared_api_keys(False)
        self.assertEqual(self.key_used_by_chat_client("admin"), CFG_KEY)

    def test_single_chroma_client(self):
        self.assertIs(storage.get_chroma_client(), core.clients.get_chroma_client())


class TestByokThroughEndpoints(_ByokBase, OfflineAITestCase):
    def test_chat_stream_uses_logged_in_users_key(self):
        auth_service.set_shared_api_keys(False)
        auth_service.save_user_api_keys(self.ids["alice"], gemini_api_key=ALICE_KEY)
        res = self.client_as("alice").post(
            "/api/chat/completions", json={"project": "authz_alice_proj", "message": "Co je v materiálech?"}
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("event: done", res.text)
        self.assertEqual(self.keys, [ALICE_KEY])

    def test_lesson_without_users_key_fails_with_original_message(self):
        auth_service.set_shared_api_keys(False)
        res = self.client_as("alice").post(
            "/api/lessons/generate",
            data={"title": "Lekce BYOK"},
            files=[("files", ("a.txt", b"text", "text/plain"))],
        )
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.json()["detail"], MISSING_KEY_MESSAGE)
        self.assertEqual(self.keys, [])


if __name__ == "__main__":
    unittest.main()
