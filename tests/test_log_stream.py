"""
SSE stream /api/logs: formát a přehrání historie (charakterizace) a izolace událostí mezi uživateli (krok 1.3).

Stream se čte přímo z generátoru endpointu `main.stream_logs()`. Uživatel odběratele i původce události
se nastavuje přes `current_user_var` stejně, jako to dělá auth middleware.
"""

import asyncio
import json
import unittest
import uuid

from core.context import current_user_var
from core.logger import send_batch_event, send_log
from main import auth_service, stream_logs
from tests.test_project_authz import ProjectAuthzBase

TIMEOUT = 2.0


def _user(cls, name: str) -> dict:
    roles = {"admin": "admin", "viewer": "viewer"}
    return {"id": cls.ids[name], "username": f"authz_{name}", "role": roles.get(name, "user"), "status": "approved"}


async def _as(user: dict, coro_fn, *args, **kwargs):
    token = current_user_var.set(user)
    try:
        return await coro_fn(*args, **kwargs)
    finally:
        current_user_var.reset(token)


async def _open_stream(user: dict, start_marker: str):
    """Otevře stream jako `user` a přečte ho až po `start_marker` (od té chvíle je odběratel registrovaný)."""
    token = current_user_var.set(user)
    try:
        response = await stream_logs()
    finally:
        current_user_var.reset(token)
    stream = response.body_iterator
    await _as(user, send_log, start_marker)
    seen = await _read_until(stream, start_marker)
    return stream, seen


async def _read_until(stream, marker: str) -> list[str]:
    chunks = []
    while True:
        chunk = await asyncio.wait_for(stream.__anext__(), TIMEOUT)
        chunks.append(chunk)
        if marker in chunk:
            return chunks


class TestLogStream(ProjectAuthzBase):
    def setUp(self):
        super().setUp()
        self.admin = _user(self, "admin")
        self.alice = _user(self, "alice")
        self.bob = _user(self, "bob")
        self.viewer = _user(self, "viewer")

    def marker(self, label: str) -> str:
        return f"{label}-{uuid.uuid4().hex[:8]}"

    # --- Charakterizace: formát a historie ---
    def test_log_event_format_and_history_replay(self):
        async def scenario():
            msg = self.marker("historie")
            await _as(self.admin, send_log, f"{msg}\nřádek")
            stream, seen = await _open_stream(self.admin, self.marker("start"))
            await stream.aclose()
            return msg, seen

        msg, seen = asyncio.run(scenario())
        expected = "event: log\ndata: " + json.dumps({"message": f"{msg} řádek"}, ensure_ascii=False) + "\n\n"
        self.assertIn(expected, seen)

    def test_batch_event_format(self):
        async def scenario():
            stream, _ = await _open_stream(self.admin, self.marker("start"))
            await _as(self.admin, send_batch_event, "authz_alice_proj", "progress", "b1", q_index=3)
            chunk = await asyncio.wait_for(stream.__anext__(), TIMEOUT)
            await stream.aclose()
            return chunk

        payload = {"project": "authz_alice_proj", "type": "progress", "batch_id": "b1", "q_index": 3}
        self.assertEqual(asyncio.run(scenario()), "event: batch\ndata: " + json.dumps(payload) + "\n\n")

    def test_own_logs_delivered_live(self):
        async def scenario():
            stream, _ = await _open_stream(self.alice, self.marker("start"))
            msg = self.marker("vlastni")
            await _as(self.alice, send_log, msg)
            seen = await _read_until(stream, msg)
            await stream.aclose()
            return seen

        self.assertTrue(asyncio.run(scenario()))

    # --- Izolace mezi uživateli ---
    def collect(self, subscriber: dict, publish) -> str:
        """Otevře stream jako `subscriber`, provede `publish()` a vrátí vše přijaté do koncové značky."""

        async def scenario():
            stream, replayed = await _open_stream(subscriber, self.marker("start"))
            await publish()
            end = self.marker("konec")
            await _as(subscriber, send_log, end)
            seen = await _read_until(stream, end)
            await stream.aclose()
            return "".join(replayed + seen)

        return asyncio.run(scenario())

    def test_foreign_logs_not_delivered_live(self):
        secret = self.marker("tajne-alice")

        async def publish():
            await _as(self.alice, send_log, secret)

        self.assertNotIn(secret, self.collect(self.bob, publish))
        self.assertNotIn(secret, self.collect(self.viewer, publish))
        self.assertIn(secret, self.collect(self.admin, publish))

    def test_foreign_logs_not_replayed_from_history(self):
        secret = self.marker("historie-alice")
        asyncio.run(_as(self.alice, send_log, secret))

        async def publish():
            return None

        self.assertNotIn(secret, self.collect(self.bob, publish))
        self.assertIn(secret, self.collect(self.alice, publish))
        self.assertIn(secret, self.collect(self.admin, publish))

    def test_logs_without_user_context_only_for_admin(self):
        secret = self.marker("system")

        async def publish():
            token = current_user_var.set(None)
            try:
                await send_log(secret)
            finally:
                current_user_var.reset(token)

        self.assertNotIn(secret, self.collect(self.bob, publish))
        self.assertIn(secret, self.collect(self.admin, publish))

    def test_batch_events_follow_project_access_in_private_mode(self):
        auth_service.set_shared_projects(False)
        batch_id = self.marker("batch")

        async def publish():
            await _as(self.alice, send_batch_event, "authz_alice_proj", "progress", batch_id)

        self.assertNotIn(batch_id, self.collect(self.bob, publish))
        self.assertIn(batch_id, self.collect(self.alice, publish))
        self.assertIn(batch_id, self.collect(self.viewer, publish))
        self.assertIn(batch_id, self.collect(self.admin, publish))

    def test_batch_events_visible_to_all_in_shared_mode(self):
        auth_service.set_shared_projects(True)
        batch_id = self.marker("batch")

        async def publish():
            await _as(self.alice, send_batch_event, "authz_alice_proj", "progress", batch_id)

        self.assertIn(batch_id, self.collect(self.bob, publish))


if __name__ == "__main__":
    unittest.main()
