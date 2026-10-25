"""
Charakterizace čistých funkcí služeb (krok 2.3).

1. Explicitní testy rozdílů mezi duplicitními implementacemi (podklad pro sjednocení v krocích 4.2 a 4.4).
2. Golden master: výstupy desítek funkcí pro sady vstupů z `tests/fixtures/service_cases.py` se porovnají
   s `tests/fixtures/services_golden.json`. Golden se mění jen záměrně přes `generate_services_golden`.
"""

import json
import os
import unittest

from tests.fixtures.service_cases import compute_all

GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "services_golden.json")


class TestDuplicateImplementations(unittest.TestCase):
    """Zdokumentované rozdíly duplicitních funkcí (nález R1, R3) – po sjednocení je nutné rozhodnout, co platí."""

    def test_sanitizer_variants_differ(self):
        from core.security import safe_filename
        from core.utils import sanitize_name
        from services.chat_service import sanitize_project_name
        from services.medulingo_service import sanitize_name as medulingo_sanitize
        from services.test_service import sanitize_name as test_sanitize

        # Diakritika: chat (FTS, vlákna, Chroma kolekce) používá jiné ID projektu než uploads/
        self.assertEqual(sanitize_name("Kardiologie_č"), "Kardiologie_č")
        self.assertEqual(sanitize_project_name("Kardiologie_č"), "Kardiologie__")
        # Okrajová podtržítka: core je ořezává, test_service a medulingo ne
        self.assertEqual(sanitize_name("__x__"), "x")
        self.assertEqual(test_sanitize("__x__"), "_x_")
        self.assertEqual(medulingo_sanitize("__x__"), "_x_")
        # safe_filename navíc bere jen název souboru a ořezává tečky
        self.assertEqual(safe_filename("../../etc/passwd"), "passwd")
        self.assertEqual(sanitize_name("../../etc/passwd"), ".._.._etc_passwd")
        self.assertEqual(safe_filename("..."), "")
        self.assertEqual(sanitize_name("..."), "...")

    def test_fallback_model_maps_differ(self):
        from services import ai_service, lesson_service

        self.assertEqual(ai_service.get_fallback_model("gemini-3.6-flash"), "gemini-flash-latest")
        self.assertEqual(lesson_service.get_fallback_model("gemini-3.6-flash"), "gemini-flash-latest")
        # Neznámý model: ai_service vrací výchozí model, lesson_service None (bez fallbacku)
        self.assertEqual(ai_service.get_fallback_model("neznamy-model"), "gemini-3.6-flash")
        self.assertIsNone(lesson_service.get_fallback_model("neznamy-model"))
        # gemini-2.5-pro: jen ai_service má mapování
        self.assertEqual(ai_service.get_fallback_model("gemini-2.5-pro"), "gemini-3.6-flash")
        self.assertIsNone(lesson_service.get_fallback_model("gemini-2.5-pro"))

    def test_json_parsers_differ(self):
        from services.ai_service import clean_and_parse_json
        from services.test_service import parse_and_validate_test_json

        # Obecný parser vyhodí výjimku, testový vrátí prázdný seznam
        with self.assertRaises(ValueError):
            clean_and_parse_json("Tohle není JSON.")
        self.assertEqual(parse_and_validate_test_json("Tohle není JSON."), [])
        # Obecný parser vrátí libovolné objekty, testový jen validní otázky
        self.assertEqual(clean_and_parse_json('{"single": true}'), [{"single": True}])
        self.assertEqual(parse_and_validate_test_json('{"single": true}'), [])


class TestServicesGolden(unittest.TestCase):
    maxDiff = 4000

    @classmethod
    def setUpClass(cls):
        with open(GOLDEN_PATH, encoding="utf-8") as f:
            cls.golden = json.load(f)
        # JSON round-trip sjednotí typy (n-tice → seznamy) stejně jako při generování golden souboru
        cls.actual = json.loads(json.dumps(compute_all(), ensure_ascii=False, sort_keys=True))

    def test_same_groups(self):
        self.assertEqual(sorted(self.actual), sorted(self.golden))

    def test_outputs_match_golden(self):
        for group, expected_cases in self.golden.items():
            actual_cases = self.actual.get(group, {})
            self.assertEqual(sorted(actual_cases), sorted(expected_cases), f"Vstupy skupiny {group} se liší")
            for case, expected in expected_cases.items():
                with self.subTest(group=group, case=case[:60]):
                    self.assertEqual(actual_cases[case], expected)


if __name__ == "__main__":
    unittest.main()
