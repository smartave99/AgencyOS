"""Bounds the worker enforces itself, request spacing and the idle-client pool.

Clocks and sleeps are injectable so tests never wait in real time.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Generic, TypeVar

# ---- request bounds (contract "Limits the worker enforces itself") --------------------------
SEARCH_MAX = 50
REFRESH_MAX_REFS = 20
MESSAGES_MAX = 20
DIALOGS_MAX = 200
JOIN_REQUESTS_MAX = 50
PUBLIC_MESSAGE_TEXT_MAX = 2000

REFRESH_SPACING_SECONDS = 1.0
MAX_INFLIGHT = 4
INFLIGHT_WAIT_SECONDS = 5.0
INFLIGHT_RETRY_AFTER_SECONDS = 5
BODY_LIMIT_BYTES = 256 * 1024

CLIENT_IDLE_SECONDS = 120.0
LOGIN_TTL_SECONDS = 600.0
MAX_PENDING_LOGINS = 16
MAX_WRONG_LOGIN_ATTEMPTS = 5  # wrong codes and passwords per loginId; the 5th ends the login

OPERATION_TIMEOUT_SECONDS = 60.0
SEND_TIMEOUT_SECONDS = 900.0


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def session_key(session: str) -> str:
    """The pool key for an account: sha256 of the session string, never the session itself."""
    return hashlib.sha256(session.encode("utf-8")).hexdigest()


@dataclass
class Spacer:
    """Keeps at least `interval` seconds between the starts of consecutive calls."""

    interval: float = REFRESH_SPACING_SECONDS
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    _last: float | None = None

    async def wait(self) -> None:
        if self._last is not None:
            remaining = self._last + self.interval - self.clock()
            if remaining > 0:
                await self.sleep(remaining)
        self._last = self.clock()


C = TypeVar("C")


class _Entry(Generic[C]):
    __slots__ = ("client", "last_used", "in_use")

    def __init__(self, client: C, now: float) -> None:
        self.client = client
        self.last_used = now
        self.in_use = 0


class ClientPool(Generic[C]):
    """Connected clients keyed by sha256(session), disconnected after `idle_seconds` idle.

    A client that is serving a request is never disconnected. Creation is single-flight per key.
    The pool holds clients in memory only; nothing is written anywhere.
    """

    def __init__(
        self,
        close: Callable[[C], Awaitable[None]],
        *,
        idle_seconds: float = CLIENT_IDLE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._close = close
        self._idle_seconds = idle_seconds
        self._clock = clock
        self._entries: dict[str, _Entry[C]] = {}
        self._creating: dict[str, asyncio.Lock] = {}

    def __len__(self) -> int:
        return len(self._entries)

    @asynccontextmanager
    async def lease(self, key: str, create: Callable[[], Awaitable[C]]) -> AsyncIterator[C]:
        entry = self._entries.get(key)
        if entry is None:
            async with self._creating.setdefault(key, asyncio.Lock()):
                entry = self._entries.get(key)
                if entry is None:
                    entry = _Entry(await create(), self._clock())
                    self._entries[key] = entry
        entry.in_use += 1
        try:
            yield entry.client
        finally:
            entry.in_use -= 1
            entry.last_used = self._clock()

    async def sweep(self) -> int:
        """Disconnect clients idle for at least idle_seconds. Returns how many were closed."""
        now = self._clock()
        stale = [
            key
            for key, entry in self._entries.items()
            if entry.in_use == 0 and now - entry.last_used >= self._idle_seconds
        ]
        for key in stale:
            await self.discard(key)
        return len(stale)

    async def discard(self, key: str) -> None:
        entry = self._entries.pop(key, None)
        self._creating.pop(key, None)
        if entry is not None:
            await self._quiet_close(entry.client)

    async def close_all(self) -> None:
        keys = list(self._entries)
        await asyncio.gather(*(self.discard(key) for key in keys), return_exceptions=True)

    async def _quiet_close(self, client: C) -> None:
        try:
            await self._close(client)
        except Exception:  # a failing disconnect must never stop a sweep or a shutdown
            pass
