"""Test harness: the real HTTP server on port 0 in a background thread, a plain HTTP client."""

from __future__ import annotations

import asyncio
import http.client
import json
import logging
import threading
from dataclasses import dataclass, field

from agencyos_telegram import logs
from agencyos_telegram.backend import TelegramBackend
from agencyos_telegram.fake_backend import MemoryBackend
from agencyos_telegram.server import ServerConfig, WorkerServer
from agencyos_telegram.service import ServiceConfig, WorkerService

TOKEN = "test-token-0123456789abcdef"
SESSION = "memory-session-1"
ACCOUNT = {"apiId": 123456, "apiHash": "0123456789abcdef0123456789abcdef", "session": SESSION}


class FakeClock:
    """A clock and sleep that never wait: sleeping just moves time forward and is recorded."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []
        self.starts: list[float] = []

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: dict
    raw: bytes = b""

    @property
    def ok(self) -> bool:
        return bool(self.body.get("ok"))

    @property
    def error(self) -> dict:
        return self.body["error"]


@dataclass
class WorkerHarness:
    backend: TelegramBackend = field(default_factory=MemoryBackend)
    token: str = TOKEN
    media_root: str | None = None
    clock: FakeClock = field(default_factory=FakeClock)
    server_options: dict = field(default_factory=dict)
    service_options: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.service = WorkerService(
            self.backend,
            ServiceConfig(
                media_root=self.media_root, clock=self.clock, sleep=self.clock.sleep, **self.service_options
            ),
        )
        self.server = WorkerServer(ServerConfig(token=self.token, port=0, **self.server_options), self.service)
        self.port = 0
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._ready = threading.Event()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.port = self.loop.run_until_complete(self.server.start())
        self._ready.set()
        self.loop.run_forever()

    def start(self) -> WorkerHarness:
        self._thread.start()
        assert self._ready.wait(10), "server did not start"
        return self

    def stop(self) -> None:
        if not self._thread.is_alive():
            return
        future = asyncio.run_coroutine_threadsafe(self.server.shutdown(), self.loop)
        future.result(15)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(10)
        if not self._thread.is_alive():
            self.loop.close()

    def run_in_loop(self, coroutine):
        """Run a coroutine on the server's loop (to build asyncio primitives or release gates)."""
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(10)

    # ---- client ---------------------------------------------------------------------------------
    def request(
        self,
        method: str,
        path: str,
        body: object | None = None,
        *,
        token: str | None = ...,  # type: ignore[assignment]
        headers: dict[str, str] | None = None,
        raw_body: bytes | None = None,
        content_type: str | None = "application/json",
        timeout: float = 20,
    ) -> Response:
        payload = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else b"")
        sent = dict(headers or {})
        if content_type and (payload or method == "POST"):
            sent.setdefault("Content-Type", content_type)
        token_value = self.token if token is ... else token
        if token_value is not None:
            sent.setdefault("X-AgencyOS-Worker-Token", token_value)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            connection.request(method, path, body=payload if method != "GET" else None, headers=sent)
            response = connection.getresponse()
            raw = response.read()
            parsed = json.loads(raw) if raw else {}
            return Response(response.status, {k.lower(): v for k, v in response.getheaders()}, parsed, raw)
        finally:
            connection.close()

    def post(self, path: str, body: object, **kwargs) -> Response:
        return self.request("POST", path, body, **kwargs)


class LogCapture(logging.Handler):
    """Collects what every handler could see: the formatted text and the structured fields."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def text(self) -> str:
        parts = []
        for record in self.records:
            parts.append(record.getMessage())
            fields = getattr(record, "fields", None)
            if fields:
                parts.append(json.dumps(fields, default=str))
            if record.exc_info:
                parts.append(repr(record.exc_info[1]))
        return "\n".join(parts)


def configure_test_logging(stream) -> LogCapture:
    """Install the production logging setup writing to `stream`, plus a capture of every record."""
    logs.configure_logging(stream, logging.DEBUG)
    capture = LogCapture()
    logging.getLogger().addHandler(capture)
    return capture
