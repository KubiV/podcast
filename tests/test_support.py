"""Testy testovací infrastruktury (krok 2.1): blokace sítě, falešný Gemini klient a offline RAG."""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import asyncio
import json
import os
import socket
import urllib.request

from core.config import UPLOAD_DIR
from tests import NetworkAccessInTests
from tests.support import OfflineAITestCase, unique_name, write_file


class TestNetworkGuard(OfflineAITestCase):
    def test_external_network_blocked(self):
        with self.assertRaises(NetworkAccessInTests):
            urllib.request.urlopen("https://generativelanguage.googleapis.com/", timeout=2)
        with self.assertRaises(NetworkAccessInTests):
            socket.create_connection(("203.0.113.1", 443), timeout=1)

    def test_local_connections_allowed(self):
        sock = socket.socket()
        try:
            sock.settimeout(1)
            # Zavřený lokální port: očekává se odmítnutí spojení, ne blokace testovací pojistkou
            with self.assertRaises(OSError) as ctx:
                sock.connect(("127.0.0.1", 9))
            self.assertNotIsInstance(ctx.exception, NetworkAccessInTests)
        finally:
            sock.close()


class TestFakeGemini(OfflineAITestCase):
    def test_call_gemini_with_retries_uses_fake(self):
        from services.ai_service import call_gemini_with_retries

        fake = self.install_fake_gemini(["první", "druhá"])
        first = asyncio.run(
            call_gemini_with_retries(model="gemini-3.6-flash", contents=["Otázka"], system_instruction="Sys")
        )
        second = asyncio.run(call_gemini_with_retries(model="gemini-3.6-flash", contents=["Otázka 2"]))
        third = asyncio.run(call_gemini_with_retries(model="gemini-3.6-flash", contents=["Otázka 3"]))
        self.assertEqual((first, second, third), ("první", "druhá", "druhá"))
        self.assertEqual(len(fake.calls), 3)
        self.assertEqual(fake.calls[0]["model"], "gemini-3.6-flash")
        # Charakterizace: k systémové instrukci se automaticky připojí jazyková direktiva (výchozí čeština)
        self.assertTrue(fake.system_instructions[0].startswith("Sys"))
        self.assertIn("ČEŠTINA", fake.system_instructions[0])

    def test_non_retryable_error_propagates(self):
        from services.ai_service import call_gemini_with_retries

        self.install_fake_gemini([ValueError("400 INVALID_ARGUMENT")])
        with self.assertRaises(ValueError):
            asyncio.run(call_gemini_with_retries(model="gemini-3.6-flash", contents=["x"]))

    def test_responder_function(self):
        from services.ai_service import call_gemini_with_retries

        fake = self.install_fake_gemini(lambda model, contents, config: f"echo:{contents[0]}")
        self.assertEqual(asyncio.run(call_gemini_with_retries(model="m", contents=["ahoj"])), "echo:ahoj")
        self.assertIn("ahoj", fake.prompt_text())


class TestOfflineRag(OfflineAITestCase):
    def setUp(self):
        super().setUp()
        self.project = unique_name("rag")
        self.path = os.path.join(UPLOAD_DIR, self.project, "kardiologie.txt")
        write_file(
            self.path,
            "Digoxin se používá u fibrilace síní ke kontrole frekvence.\n\n"
            "Furosemid je kličkové diuretikum používané u srdečního selhání.",
        )

    def test_index_query_and_grounded_chat(self):
        from unittest.mock import patch

        from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

        from services.chat_service import stream_grounded_chat
        from services.rag_service import index_file_to_chroma, query_rag_context_with_sources

        # Skutečný ONNX model se nesmí použít (offline, deterministické embeddingy)
        onnx_guard = patch.object(ONNXMiniLM_L6_V2, "__call__", side_effect=AssertionError("ONNX model použit"))
        onnx_guard.start()
        self.addCleanup(onnx_guard.stop)

        asyncio.run(index_file_to_chroma(self.path, "kardiologie.txt", self.project))

        context, sources, raw = asyncio.run(
            query_rag_context_with_sources("digoxin fibrilace", self.project, n_results=5)
        )
        self.assertIn("Digoxin", raw)
        self.assertEqual([s["filename"] for s in sources], ["kardiologie.txt"])

        fake = self.install_fake_gemini(["Digoxin kontroluje frekvenci [1]."])

        async def collect():
            return [chunk async for chunk in stream_grounded_chat(self.project, "Kdy se dává digoxin?")]

        events = asyncio.run(collect())
        tokens = "".join(
            json.loads(e.split("data: ", 1)[1]).get("text", "") for e in events if e.startswith("event: token")
        )
        self.assertEqual(tokens, "Digoxin kontroluje frekvenci [1].")
        self.assertEqual(fake.calls[-1]["kind"], "stream")
        self.assertIn("Digoxin se používá", fake.prompt_text())
