"""
Sdílená podpora pro testy: uživatelé a přihlášení klienti, zápis testovacích souborů,
falešný Gemini klient a deterministické offline embeddingy pro ChromaDB.

Izolace datového adresáře, prázdné API klíče a blokace sítě jsou v `tests/__init__.py`.
"""

import hashlib
import os
import re
import unittest
import uuid
from collections.abc import Callable, Iterable
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

PASSWORD = "password123"
EMBEDDING_DIM = 384


# --- Soubory a uživatelé -------------------------------------------------------------


def write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def ensure_user(username: str, role: str) -> int:
    """Vrátí id uživatele; při prvním volání ho vytvoří (první uživatel v DB se stane adminem)."""
    from main import auth_service

    for u in auth_service.list_users():
        if u["username"] == username:
            return u["id"]
    if auth_service.needs_setup():
        user, err = auth_service.create_initial_admin(username, PASSWORD)
        assert user, err
        return user["id"]
    auth_service.set_registration_allowed(True)
    user, err = auth_service.register_user(username, PASSWORD)
    assert user, err
    auth_service.approve_user(user["id"], role=role)
    return user["id"]


def client_for_user(user_id: int, **client_kwargs: Any) -> TestClient:
    from main import app, auth_service

    token, _ = auth_service.create_session(user_id)
    client = TestClient(app, **client_kwargs)
    client.cookies.set("medstudio_session", token)
    return client


def unique_name(prefix: str = "proj") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


# --- Falešný Gemini klient -----------------------------------------------------------

Responder = Callable[[str, Any, Any], "str | Exception"]


class FakeGeminiClient:
    """
    Napodobuje `google.genai.Client` v rozsahu, který aplikace používá:
    `models.generate_content(...)` (odpověď s `.text` a `.candidates[0].finish_reason`)
    a `models.generate_content_stream(...)` (chunky s `.text` a `.candidates[0].content.parts`).

    Odpovědi: seznam (vrací se postupně, poslední se opakuje) nebo funkce `responder(model, contents, config)`.
    Výjimka v odpovědi se vyhodí, jako by selhalo API. Všechna volání se zaznamenají do `calls`.
    """

    def __init__(self, responses: Iterable["str | Exception"] | Responder = ("",), finish_reason: str = "STOP"):
        self.calls: list[dict[str, Any]] = []
        self._finish_reason = finish_reason
        if callable(responses):
            self._responder = responses
        else:
            queue = list(responses) or [""]

            def _from_queue(model, contents, config):
                return queue.pop(0) if len(queue) > 1 else queue[0]

            self._responder = _from_queue
        self.models = SimpleNamespace(
            generate_content=self._generate_content, generate_content_stream=self._generate_content_stream
        )

    def _answer(self, kind: str, model: str, contents: Any, config: Any) -> str:
        self.calls.append({"kind": kind, "model": model, "contents": contents, "config": config})
        result = self._responder(model, contents, config)
        if isinstance(result, Exception):
            raise result
        return result

    def _candidate(self, text: str) -> SimpleNamespace:
        return SimpleNamespace(
            finish_reason=self._finish_reason,
            content=SimpleNamespace(parts=[SimpleNamespace(text=text, thought=False)]),
        )

    def _generate_content(self, *, model: str, contents: Any, config: Any = None) -> SimpleNamespace:
        text = self._answer("generate", model, contents, config)
        return SimpleNamespace(text=text, candidates=[self._candidate(text)])

    def _generate_content_stream(self, *, model: str, contents: Any, config: Any = None):
        text = self._answer("stream", model, contents, config)
        parts = re.findall(r"\S+\s*", text) or [text]
        for part in parts:
            yield SimpleNamespace(text=part, candidates=[self._candidate(part)])

    # Pomůcky pro aserce
    @property
    def system_instructions(self) -> list[str]:
        return [str(getattr(c["config"], "system_instruction", "") or "") for c in self.calls]

    def prompt_text(self, index: int = -1) -> str:
        return str(self.calls[index]["contents"])


def _fake_embed(texts: Iterable[str]) -> list[np.ndarray]:
    """Deterministický „bag of words“ embedding: texty se společnými slovy mají podobné vektory."""
    vectors = []
    for text in texts:
        vec = np.zeros(EMBEDDING_DIM, dtype=np.float32)
        for word in re.findall(r"\w+", str(text).lower()):
            bucket = int.from_bytes(hashlib.sha256(word.encode()).digest()[:4], "big") % EMBEDDING_DIM
            vec[bucket] += 1.0
        norm = np.linalg.norm(vec)
        vectors.append(vec / norm if norm else vec)
    return vectors


class OfflineAITestCase(unittest.TestCase):
    """
    Základ pro testy, které procházejí AI nebo RAG logikou bez sítě:
    `install_fake_gemini(...)` nahradí Gemini klienta na všech místech, kde si ho aplikace bere,
    a embeddingy ChromaDB jsou po celou dobu testu deterministické a offline.
    """

    # Místa, odkud aplikace získává Gemini klienta (import jménem vyžaduje patch v každém modulu)
    GEMINI_CLIENT_TARGETS = (
        "core.clients.get_gemini_client",
        "services.ai_service.get_gemini_client",
        "services.chat.grounded_chat.get_ai_client",
        "services.lesson_service.get_ai_client",
    )

    def setUp(self) -> None:
        super().setUp()
        from chromadb.api.types import DefaultEmbeddingFunction

        embed_patch = patch.object(DefaultEmbeddingFunction, "__call__", lambda self, input: _fake_embed(input))
        embed_patch.start()
        self.addCleanup(embed_patch.stop)

    def install_fake_gemini(
        self, responses: Iterable["str | Exception"] | Responder = ("",), **kwargs
    ) -> FakeGeminiClient:
        fake = FakeGeminiClient(responses, **kwargs)
        for target in self.GEMINI_CLIENT_TARGETS:
            p = patch(target, lambda *a, **kw: fake)
            p.start()
            self.addCleanup(p.stop)
        return fake
