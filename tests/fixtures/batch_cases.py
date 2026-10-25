"""
Scénáře pro charakterizaci dávkového zpracování (krok 3.4).

`run_all()` spustí každou dávkovou funkci (`routers.batch.background_*`) v každém scénáři s falešnými
generátory a zaznamená úplný průběh: všechny logy a dávkové události v pořadí (přes `core.logger.publish_event`),
plán čekání (`asyncio.sleep`), volání generátorů a stav `active_batches` po skončení.
Golden soubor vytvoří `python -m tests.fixtures.generate_batch_golden` – jen záměrně.
"""

import asyncio
import json
from typing import Any
from unittest.mock import patch

PROJECT = "batch_proj"
BATCH_ID = "batch-1"
AUTH_ERROR = "403 PERMISSION_DENIED: API key not valid"


def _questions(n: int = 3) -> list[dict[str, Any]]:
    return [{"q_index": i, "title": f"Otázka číslo {i} – kardiologie a srdeční selhání"} for i in range(n)]


# Scénář: název → (otázky, overnight_mode, plán chování generátoru, dodatečná nastavení)
# Plán: pro každé volání generátoru (podle pořadí) "ok", "fail", "auth" nebo "cancel" (zruší dávku a uspěje).
SCENARIOS: dict[str, dict[str, Any]] = {
    "all_ok": {"plan": ["ok"] * 3},
    "one_fails_no_overnight": {"overnight": False, "plan": ["ok", "fail", "fail", "fail", "ok"]},
    "fails_then_overnight_success": {"plan": ["fail", "fail", "fail", "ok", "ok", "ok"]},
    "fails_through_overnight": {"plan": ["fail"] * 3 + ["ok", "ok"] + ["fail", "fail"]},
    "cancel_during_first": {"plan": ["cancel", "ok", "ok"]},
    "auth_error": {"plan": ["auth", "ok", "ok"]},
    "cancel_between_podcast_steps": {"plan": ["cancel_after_script", "ok", "ok"], "podcast_only": True},
    "cancel_during_overnight": {"plan": ["fail"] * 3 + ["ok", "ok", "cancel_after_script", "ok"]},
    "failure_with_bad_title": {"questions": [{"q_index": 0, "title": None}], "plan": ["fail"] * 3},
    "stale_batch_id": {"stale": True, "plan": ["ok"] * 3},
}

MODES = ("podcast", "notes", "flashcards")


def _run(mode: str, scenario: dict[str, Any]) -> dict[str, Any]:
    from core.logger import BatchState, active_batches
    from routers import batch as batch_router

    trace: list[Any] = []
    sleeps: list[float] = []
    calls: list[str] = []
    plan = list(scenario["plan"])
    state = BatchState(batch_id=BATCH_ID, mode=mode)

    def next_action() -> str:
        return plan.pop(0) if plan else "ok"

    async def act(kind: str, title: Any) -> None:
        calls.append(f"{kind}:{title}")
        action = next_action() if kind != "audio" else "ok"
        if action in ("cancel", "cancel_after_script"):
            state.cancel_requested = True
            return
        if action == "fail":
            raise RuntimeError(f"Generování selhalo ({kind})")
        if action == "auth":
            raise RuntimeError(AUTH_ERROR)

    async def fake_script(title, *args, **kwargs):
        await act("script", title)
        return "SKRIPT", None

    async def fake_audio(script, filename, *args, **kwargs):
        await act("audio", filename)
        return ("/audio/x.mp3", "x.mp3", "mp3")

    async def fake_notes(title, *args, **kwargs):
        await act("notes", title)

    async def fake_cards(title, *args, **kwargs):
        await act("cards", title)

    async def fake_publish(event_name, payload):
        trace.append([event_name, payload])

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    questions = scenario.get("questions", _questions())
    active_batches.pop(PROJECT, None)
    active_batches[PROJECT] = state
    run_batch_id = "jiny-batch" if scenario.get("stale") else BATCH_ID
    with (
        patch("core.logger.publish_event", fake_publish),
        patch("asyncio.sleep", fake_sleep),
        patch.object(batch_router, "internal_generate_script", fake_script),
        patch.object(batch_router, "internal_generate_audio", fake_audio),
        patch.object(batch_router, "internal_generate_notes", fake_notes),
        patch.object(batch_router, "internal_generate_flashcards", fake_cards),
    ):
        overnight = scenario.get("overnight", True)
        if mode == "podcast":
            coro = batch_router.background_batch_process(
                questions, "PROMPT", "openai", "onyx", "mp3", PROJECT, "gemini-3.6-flash", run_batch_id, overnight
            )
        elif mode == "notes":
            coro = batch_router.background_notes_batch_process(
                questions, "PROMPT", PROJECT, "gemini-3.6-flash", run_batch_id, overnight
            )
        else:
            coro = batch_router.background_flashcards_batch_process(
                questions, 7, "PROMPT", PROJECT, "gemini-3.6-flash", run_batch_id, overnight
            )
        try:
            asyncio.run(coro)
            raised = None
        except Exception as exc:  # noqa: BLE001 – zachycujeme i vyhozené výjimky
            raised = type(exc).__name__
    still_active = PROJECT in active_batches
    active_batches.pop(PROJECT, None)
    return {
        "trace": json.loads(json.dumps(trace, ensure_ascii=False, default=str)),
        "sleeps": sleeps,
        "calls": calls,
        "raised": raised,
        "batch_still_active": still_active,
    }


def run_all() -> dict[str, Any]:
    results: dict[str, Any] = {}
    for mode in MODES:
        for name, scenario in SCENARIOS.items():
            if scenario.get("podcast_only") and mode != "podcast":
                continue
            results[f"{mode}/{name}"] = _run(mode, scenario)
    return results
