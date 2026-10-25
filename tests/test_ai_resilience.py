"""
Charakterizace volání Gemini s opakováním a záložním modelem (krok 2.4):
`services.ai_service.call_gemini_with_retries` a `call_gemini_with_resilience` – sdílená implementace
v `services.ai_service` a wrapper `services.lesson_service` s vlastní mapou záložních modelů (sloučeno v kroku 4.2).

`asyncio.sleep` je nahrazený záznamníkem, takže testy nečekají a zaznamenají plán čekání.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from google.genai import types

from core.context import current_language_var
from services import ai_service, lesson_service
from tests.support import FakeGeminiClient

MODEL = "gemini-3.6-flash"


def e503():
    return Exception("503 UNAVAILABLE: The model is overloaded.")


def e429():
    return Exception("429 RESOURCE_EXHAUSTED quota")


class _Recorder:
    def __init__(self):
        self.sleeps: list[float] = []
        self.logs: list[str] = []

    async def sleep(self, seconds):
        self.sleeps.append(seconds)

    async def log(self, message):
        self.logs.append(message)

    async def report(self, step, pct, message):
        self.logs.append((step, pct, message))


class _Base(unittest.TestCase):
    def run_with(self, responses, call):
        """Spustí `call(fake, recorder)`; vrací (fake, recorder, výsledek nebo výjimka)."""
        fake = FakeGeminiClient(responses)
        rec = _Recorder()
        with patch("asyncio.sleep", rec.sleep), patch("services.ai_service.get_gemini_client", lambda *a, **k: fake):
            try:
                result = asyncio.run(call(fake, rec))
            except Exception as exc:  # noqa: BLE001 – charakterizujeme i vyhozené výjimky
                result = exc
        return fake, rec, result

    @staticmethod
    def models(fake):
        return [c["model"] for c in fake.calls]


class TestCallGeminiWithRetries(_Base):
    def retries(self, **kwargs):
        return lambda fake, rec: ai_service.call_gemini_with_retries(
            model=MODEL, contents=["Otázka"], log_fn=rec.log, **kwargs
        )

    def test_success_first_attempt(self):
        fake, rec, result = self.run_with(["OK"], self.retries())
        self.assertEqual((result, self.models(fake), rec.sleeps, rec.logs), ("OK", [MODEL], [], []))

    def test_retry_then_success(self):
        fake, rec, result = self.run_with([e503(), e503(), "OK"], self.retries())
        self.assertEqual(result, "OK")
        self.assertEqual(self.models(fake), [MODEL] * 3)
        self.assertEqual(rec.sleeps, [8, 16])
        self.assertEqual(len(rec.logs), 2)
        self.assertIn("(pokus 1/6). Čekám 8 s...", rec.logs[0])
        self.assertIn("HTTP 503", rec.logs[0])

    def test_fallback_model_from_third_failure(self):
        fake, rec, result = self.run_with([e503(), e503(), e503(), "OK"], self.retries())
        self.assertEqual(result, "OK")
        self.assertEqual(self.models(fake), [MODEL, MODEL, MODEL, "gemini-flash-latest"])
        self.assertEqual(rec.sleeps, [8, 16, 4])
        self.assertIn("Přepínám na záložní model gemini-flash-latest", rec.logs[2])

    def test_exhausted_raises_friendly_error(self):
        fake, rec, result = self.run_with([e503()], self.retries())
        self.assertEqual(self.models(fake), [MODEL] * 3 + ["gemini-flash-latest"] * 3)
        # Přepnutí na fallback spotřebuje jeden pokus, plán čekání se tím posune (30 s se přeskočí)
        self.assertEqual(rec.sleeps, [8, 16, 4, 45, 60])
        self.assertIsInstance(result, ValueError)
        self.assertTrue(str(result).startswith("Gemini: služba je dočasně nedostupná nebo přetížená."))
        self.assertIn("(Detail: HTTP 503", str(result))

    def test_fallback_disabled(self):
        fake, rec, result = self.run_with([e429()], self.retries(enable_fallback=False))
        self.assertEqual(self.models(fake), [MODEL] * 6)
        self.assertEqual(rec.sleeps, [8, 16, 30, 45, 60])
        self.assertIsInstance(result, ValueError)
        self.assertIn("limit požadavků je dočasně vyčerpán", str(result))

    def test_non_retryable_error_raised_immediately(self):
        error = ValueError("400 INVALID_ARGUMENT bad request")
        fake, rec, result = self.run_with([error], self.retries())
        self.assertIs(result, error)
        self.assertEqual((len(fake.calls), rec.sleeps), (1, []))

    def test_short_wait_intervals_return_none(self):
        # CHYBA (zapsáno v CHANGELOG 2.4): když přepnutí na fallback padne na poslední pokus,
        # smyčka skončí přes `continue` a funkce vrátí None místo výjimky. S výchozími intervaly nenastává.
        fake, rec, result = self.run_with([e503()], self.retries(wait_intervals=[1, 2]))
        self.assertIsNone(result)
        self.assertEqual(rec.sleeps, [1, 2, 4])
        self.assertEqual(len(fake.calls), 3)

    def test_empty_text_returns_empty_string(self):
        _, _, result = self.run_with([None], self.retries())
        self.assertEqual(result, "")

    def test_request_config_and_language_directive(self):
        fake, _, _ = self.run_with(
            ["OK"],
            lambda fake, rec: ai_service.call_gemini_with_retries(
                model=MODEL,
                contents=["x"],
                system_instruction="Jsi tutor.",
                temperature=0.2,
                max_output_tokens=123,
                response_mime_type="application/json",
            ),
        )
        config = fake.calls[0]["config"]
        self.assertEqual((config.temperature, config.max_output_tokens), (0.2, 123))
        self.assertEqual(config.response_mime_type, "application/json")
        self.assertTrue(config.system_instruction.startswith("Jsi tutor."))
        self.assertIn("CÍLOVÝ JAZYK VÝSTUPU: ČEŠTINA (CS)", config.system_instruction)

    def test_language_directive_follows_context_and_is_not_duplicated(self):
        token = current_language_var.set("en")
        try:
            fake, _, _ = self.run_with(
                ["OK"], lambda fake, rec: ai_service.call_gemini_with_retries(model=MODEL, contents=["x"])
            )
            directive_only = fake.calls[0]["config"].system_instruction
            self.assertIn("TARGET OUTPUT LANGUAGE: ENGLISH (EN)", directive_only)

            # Instrukce, která direktivu už obsahuje (za vlastním textem), se znovu nedoplňuje
            with_directive = "Jsi tutor." + ai_service.get_language_directive("en")
            fake, _, _ = self.run_with(
                ["OK"],
                lambda fake, rec: ai_service.call_gemini_with_retries(
                    model=MODEL, contents=["x"], system_instruction=with_directive
                ),
            )
            self.assertEqual(fake.calls[0]["config"].system_instruction, with_directive)

            # CHYBA (zapsáno v CHANGELOG 2.4): direktiva bez úvodního textu je po .strip() bez "\n\n",
            # kontrola `in` ji nenajde a doplní ji podruhé
            fake, _, _ = self.run_with(
                ["OK"],
                lambda fake, rec: ai_service.call_gemini_with_retries(
                    model=MODEL, contents=["x"], system_instruction=directive_only
                ),
            )
            self.assertEqual(fake.calls[0]["config"].system_instruction.count("TARGET OUTPUT LANGUAGE"), 2)
        finally:
            current_language_var.reset(token)

    def test_log_function_variants(self):
        # Synchronní log_fn i log_fn, která vyhodí výjimku, retry nezastaví
        messages = []
        _, _, result = self.run_with(
            [e503(), "OK"],
            lambda fake, rec: ai_service.call_gemini_with_retries(model=MODEL, contents=["x"], log_fn=messages.append),
        )
        self.assertEqual((result, len(messages)), ("OK", 1))

        def broken(_):
            raise RuntimeError("log selhal")

        _, _, result = self.run_with(
            [e503(), "OK"],
            lambda fake, rec: ai_service.call_gemini_with_retries(model=MODEL, contents=["x"], log_fn=broken),
        )
        self.assertEqual(result, "OK")

    def test_default_logging_goes_to_send_log(self):
        from core.logger import log_history

        before = len(log_history)
        self.run_with(
            [e503(), "OK"], lambda fake, rec: ai_service.call_gemini_with_retries(model=MODEL, contents=["x"])
        )
        new_messages = [entry[0] for entry in list(log_history)[before:]]
        self.assertTrue(any("(pokus 1/6). Čekám 8 s..." in m for m in new_messages))


class TestCallGeminiWithResilience(_Base):
    """`call_gemini_with_resilience` přímo z `ai_service` a přes wrapper `lesson_service` (liší se mapou fallbacků a krokem)."""

    IMPLEMENTATIONS = (
        ("ai_service", ai_service, "generating"),
        ("lesson_service", lesson_service, "generating_markdown"),
    )
    CONFIG = types.GenerateContentConfig(temperature=0.3, system_instruction="Původní instrukce")

    def resilience(self, module, model=MODEL, **kwargs):
        return lambda fake, rec: module.call_gemini_with_resilience(
            fake, model, ["x"], self.CONFIG, report_fn=rec.report, **kwargs
        )

    def test_success_returns_response_object_and_keeps_config(self):
        for name, module, _ in self.IMPLEMENTATIONS:
            with self.subTest(impl=name):
                fake, rec, result = self.run_with(["OK"], self.resilience(module))
                self.assertIsInstance(result, SimpleNamespace)
                self.assertEqual(result.text, "OK")
                # Konfigurace se předá beze změny – žádná jazyková direktiva (na rozdíl od call_gemini_with_retries)
                self.assertIs(fake.calls[0]["config"], self.CONFIG)
                self.assertEqual(rec.sleeps, [])

    def test_fallback_and_reporting(self):
        for name, module, step in self.IMPLEMENTATIONS:
            with self.subTest(impl=name):
                fake, rec, result = self.run_with([e503(), e503(), e503(), "OK"], self.resilience(module))
                self.assertEqual(result.text, "OK")
                self.assertEqual(self.models(fake), [MODEL, MODEL, MODEL, "gemini-flash-latest"])
                self.assertEqual(rec.sleeps, [6, 12, 4])
                self.assertEqual([(s, p) for s, p, _ in rec.logs], [(step, 30)] * 3)
                self.assertIn("Pokus 1/6", rec.logs[0][2])
                self.assertIn("gemini-flash-latest", rec.logs[2][2])

    def test_exhausted_reraises_original_exception(self):
        for name, module, _ in self.IMPLEMENTATIONS:
            with self.subTest(impl=name):
                error = e503()
                fake, rec, result = self.run_with([error], self.resilience(module))
                self.assertIs(result, error)
                self.assertEqual(self.models(fake), [MODEL] * 3 + ["gemini-flash-latest"] * 3)
                self.assertEqual(rec.sleeps, [6, 12, 4, 45, 60])

    def test_unknown_model_fallback_differs(self):
        fake, rec, _ = self.run_with([e503()], self.resilience(ai_service, model="neznamy-model"))
        self.assertEqual(self.models(fake), ["neznamy-model"] * 3 + [MODEL] * 3)
        self.assertEqual(rec.sleeps, [6, 12, 4, 45, 60])

        fake, rec, _ = self.run_with([e503()], self.resilience(lesson_service, model="neznamy-model"))
        self.assertEqual(self.models(fake), ["neznamy-model"] * 6)
        self.assertEqual(rec.sleeps, [6, 12, 25, 45, 60])

    def test_non_retryable_raised_immediately_and_report_optional(self):
        for name, module, _ in self.IMPLEMENTATIONS:
            with self.subTest(impl=name):
                error = ValueError("400 INVALID_ARGUMENT")
                fake, rec, result = self.run_with([error], self.resilience(module))
                self.assertIs(result, error)
                self.assertEqual(len(fake.calls), 1)
                fake, rec, result = self.run_with(
                    [e503(), "OK"],
                    lambda fake, rec, m=module: m.call_gemini_with_resilience(
                        fake, MODEL, ["x"], self.CONFIG, wait_intervals=[1]
                    ),
                )
                self.assertEqual((result.text, rec.sleeps), ("OK", [1]))


class TestLessonResilienceMessages(_Base):
    """Přesné hlášky a plán čekání lekcí – zachycené na kódu před sloučením v kroku 4.2."""

    E503_DETAIL = "HTTP 503 (Model Googlu je přetížený): The model is overloaded. Please try again later."
    E429_DETAIL = "HTTP 429 (Vyčerpán limit požadavků / RPM / TPM)"

    def run_lesson(self, responses, model):
        return self.run_with(
            responses,
            lambda fake, rec: lesson_service.call_gemini_with_resilience(
                fake, model, ["x"], types.GenerateContentConfig(), report_fn=rec.report
            ),
        )

    def test_fallback_messages(self):
        fake, rec, result = self.run_lesson([e503(), e503(), e503(), "OK"], MODEL)
        self.assertEqual(result.text, "OK")
        self.assertEqual(
            rec.logs,
            [
                (
                    "generating_markdown",
                    30,
                    f"⚠️ Gemini API je dočasně přetížené ({self.E503_DETAIL}). Pokus 1/6, čekám 6 s...",
                ),
                (
                    "generating_markdown",
                    30,
                    f"⚠️ Gemini API je dočasně přetížené ({self.E503_DETAIL}). Pokus 2/6, čekám 12 s...",
                ),
                (
                    "generating_markdown",
                    30,
                    f"⚠️ Model {MODEL} je na straně Googlu dočasně přetížen ({self.E503_DETAIL}). "
                    "Přepínám na záložní model gemini-flash-latest...",
                ),
            ],
        )

    def test_unknown_model_never_falls_back(self):
        fake, rec, result = self.run_lesson([e429()], "neznamy-model")
        self.assertIsInstance(result, Exception)
        self.assertEqual(self.models(fake), ["neznamy-model"] * 6)
        self.assertEqual(rec.sleeps, [6, 12, 25, 45, 60])
        self.assertEqual(
            [m for _, _, m in rec.logs],
            [
                f"⚠️ Gemini API je dočasně přetížené ({self.E429_DETAIL}). Pokus {i}/6, čekám {w} s..."
                for i, w in zip(range(1, 6), [6, 12, 25, 45, 60])
            ],
        )


if __name__ == "__main__":
    unittest.main()
