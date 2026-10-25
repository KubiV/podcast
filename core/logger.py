import asyncio
import json
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from core.context import current_user_var

LOG_HISTORY_LIMIT = 250
LOG_SUBSCRIBER_QUEUE_SIZE = 300


@dataclass(eq=False)
class LogSubscriber:
    user: dict[str, Any] | None
    queue: asyncio.Queue[tuple[str, dict[str, Any]]] = field(
        default_factory=lambda: asyncio.Queue(maxsize=LOG_SUBSCRIBER_QUEUE_SIZE)
    )


# Historie logů: (zpráva, id uživatele, který log vyvolal; None = systémový log)
log_history: deque[tuple[str, int | None]] = deque(maxlen=LOG_HISTORY_LIMIT)
log_subscribers: set[LogSubscriber] = set()


def serialize_sse(event_name: str, payload: dict[str, Any]) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _current_user_id() -> int | None:
    user = current_user_var.get()
    return user.get("id") if user else None


def can_receive_event(subscriber_user: dict[str, Any] | None, origin_user_id: int | None, project: str | None) -> bool:
    """
    Kdo smí událost vidět: admin vše; události s projektem (dávky, lekce) ti, kdo smí projekt číst;
    ostatní logy jen uživatel, který je vyvolal.
    """
    if not subscriber_user:
        return False
    if subscriber_user.get("role") == "admin":
        return True
    if project:
        from core.authz import can_access_project

        return can_access_project(project, user=subscriber_user)
    return origin_user_id is not None and origin_user_id == subscriber_user.get("id")


async def publish_event(event_name: str, payload: dict[str, Any]):
    origin_user_id = _current_user_id()
    project = payload.get("project")
    project = project if isinstance(project, str) and project else None

    for subscriber in tuple(log_subscribers):
        if not can_receive_event(subscriber.user, origin_user_id, project):
            continue
        queue = subscriber.queue
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            queue.put_nowait((event_name, payload))
        except asyncio.QueueFull:
            pass


async def send_log(message: str):
    clean_message = str(message).replace("\r", " ").replace("\n", " ")
    log_history.append((clean_message, _current_user_id()))
    print(f"[LOG] {clean_message}", flush=True)
    await publish_event("log", {"message": clean_message})


async def stream_events(user: dict[str, Any] | None) -> AsyncIterator[str]:
    """SSE proud pro jednoho odběratele: nejprve jemu viditelná historie logů, pak živé události."""
    subscriber = LogSubscriber(user=user)
    log_subscribers.add(subscriber)
    try:
        for message, origin_user_id in tuple(log_history):
            if can_receive_event(user, origin_user_id, None):
                yield serialize_sse("log", {"message": message})

        while True:
            event_name, payload = await subscriber.queue.get()
            yield serialize_sse(event_name, payload)
    finally:
        log_subscribers.discard(subscriber)


async def send_batch_event(project: str, event_type: str, batch_id: str, **data: Any):
    await publish_event(
        "batch",
        {
            "project": project,
            "type": event_type,
            "batch_id": batch_id,
            **data,
        },
    )


@dataclass
class BatchState:
    batch_id: str
    mode: str = "podcast"
    cancel_requested: bool = False
    completed_question_indexes: list[int] = field(default_factory=list)


active_batches: dict[str, BatchState] = {}
