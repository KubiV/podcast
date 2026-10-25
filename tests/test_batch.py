"""
Charakterizace dávkového zpracování podcastů, poznámek a kartiček (krok 3.4).

Golden master zachycuje úplný průběh (logy + dávkové události v pořadí, plán čekání, volání generátorů,
úklid `active_batches`) pro 3 režimy × 10 scénářů. Explicitní testy dokumentují rozdíly mezi režimy.
"""

import tests  # noqa: F401 – musí být první: izolace dat, prázdné API klíče a blokace sítě (tests/__init__.py)

# isort: split

import json
import os
import unittest

from tests.fixtures.batch_cases import SCENARIOS, _run, run_all

GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "batch_golden.json")


def _batch_events(result):
    return [payload for name, payload in result["trace"] if name == "batch"]


class TestBatchDifferences(unittest.TestCase):
    def test_terminal_auth_error_stops_notes_and_cards_but_not_podcast(self):
        for mode in ("notes", "flashcards"):
            with self.subTest(mode=mode):
                finished = _batch_events(_run(mode, SCENARIOS["auth_error"]))[-1]
                self.assertEqual(finished["outcome"], "cancelled")
        finished = _batch_events(_run("podcast", SCENARIOS["auth_error"]))[-1]
        self.assertEqual(finished["outcome"], "completed")

    def test_cancel_between_podcast_steps_marks_question_failed(self):
        events = _batch_events(_run("podcast", SCENARIOS["cancel_between_podcast_steps"]))
        self.assertEqual([e["type"] for e in events], ["started", "question_failed", "finished"])
        self.assertEqual(events[1]["error"], "None")
        self.assertEqual(events[-1]["outcome"], "cancelled")

    def test_cleanup_and_stale_batch(self):
        for mode in ("podcast", "notes", "flashcards"):
            with self.subTest(mode=mode):
                self.assertFalse(_run(mode, SCENARIOS["failure_with_bad_title"])["batch_still_active"])
                stale = _run(mode, SCENARIOS["stale_batch_id"])
                self.assertEqual((stale["trace"], stale["calls"]), ([], []))


class TestBatchGolden(unittest.TestCase):
    maxDiff = 6000

    def test_matches_golden(self):
        with open(GOLDEN_PATH, encoding="utf-8") as f:
            golden = json.load(f)
        actual = json.loads(json.dumps(run_all(), ensure_ascii=False, sort_keys=True))
        self.assertEqual(sorted(actual), sorted(golden))
        for key, expected in golden.items():
            with self.subTest(case=key):
                self.assertEqual(actual[key], expected)


if __name__ == "__main__":
    unittest.main()
