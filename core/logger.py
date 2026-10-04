import asyncio
import json
from collections import deque
from dataclasses import dataclass, field
from typing import Any

LOG_HISTORY_LIMIT = 250
LOG_SUBSCRIBER_QUEUE_SIZE = 300
log_history: deque[str] = deque(maxlen=LOG_HISTORY_LIMIT)
log_subscribers: set[asyncio.Queue[tuple[str, dict[str, Any]]]] = set()


def serialize_sse(event_name: str, payload: dict[str, Any]) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def publish_event(event_name: str, payload: dict[str, Any]):
    for subscriber in tuple(log_subscribers):
        if subscriber.full():
            try:
                subscriber.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            subscriber.put_nowait((event_name, payload))
        except asyncio.QueueFull:
            pass


async def send_log(message: str):
    clean_message = str(message).replace("\r", " ").replace("\n", " ")
    log_history.append(clean_message)
    print(f"[LOG] {clean_message}", flush=True)
    await publish_event("log", {"message": clean_message})


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
