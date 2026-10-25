"""
Jednoduché omezení neúspěšných pokusů o přihlášení (v paměti procesu, bez externích závislostí).

Počítají se jen neúspěchy v klouzavém okně. Blokuje se dvojice IP + uživatel (hádání hesla k jednomu účtu)
a samotná IP (zkoušení mnoha účtů). Blokace podle samotného uživatelského jména záměrně není,
aby útočník nemohl zablokovat přihlášení cizímu účtu z jiné adresy.
"""

import math
import time
from collections import deque

LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES_PER_USER_IP = 10
LOGIN_MAX_FAILURES_PER_IP = 30
_MAX_TRACKED_KEYS = 10_000


class FailureLimiter:
    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = {}

    def _recent(self, key: str, now: float) -> deque[float]:
        entries = self._failures.get(key)
        if entries is None:
            return deque()
        while entries and now - entries[0] >= LOGIN_WINDOW_SECONDS:
            entries.popleft()
        if not entries:
            self._failures.pop(key, None)
        return entries

    def retry_after(self, keys_with_limits: list[tuple[str, int]]) -> int | None:
        """Počet sekund do odblokování, pokud některý klíč překročil svůj limit; jinak None."""
        now = time.monotonic()
        waits = []
        for key, limit in keys_with_limits:
            entries = self._recent(key, now)
            if len(entries) >= limit:
                waits.append(entries[len(entries) - limit] + LOGIN_WINDOW_SECONDS - now)
        return max(1, math.ceil(max(waits))) if waits else None

    def record_failure(self, keys: list[str]) -> None:
        now = time.monotonic()
        if len(self._failures) > _MAX_TRACKED_KEYS:
            for key in list(self._failures):
                self._recent(key, now)
        for key in keys:
            self._failures.setdefault(key, deque()).append(now)

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)

    def reset_all(self) -> None:
        self._failures.clear()


login_limiter = FailureLimiter()


def login_keys(client_ip: str, username: str) -> list[tuple[str, int]]:
    user_key = f"user-ip:{client_ip}:{(username or '').strip().lower()}"
    return [(user_key, LOGIN_MAX_FAILURES_PER_USER_IP), (f"ip:{client_ip}", LOGIN_MAX_FAILURES_PER_IP)]
