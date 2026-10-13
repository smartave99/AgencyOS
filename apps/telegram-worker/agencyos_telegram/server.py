"""The loopback HTTP server: auth, Host check, body limit, correlation ids, in-flight limit, shutdown.

A small HTTP/1.1 implementation on asyncio streams, one request per connection. It binds to
127.0.0.1 only. Request bodies and message text are never logged.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field

from . import limits, logs
from .errors import OUTCOME_UNKNOWN, RATE_LIMITED, BadRequest, WorkerError
from .service import ROUTES, WorkerService

TOKEN_HEADER = "x-agencyos-worker-token"
CORRELATION_HEADER = "x-correlation-id"
_CORRELATION_ID = re.compile(r"^[A-Za-z0-9._:\-]{1,64}$")
_REASONS = {
    200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed",
    413: "Payload Too Large", 421: "Misdirected Request", 500: "Internal Server Error",
    503: "Service Unavailable",
}
_SINGLE_HEADERS = frozenset({"host", "content-length", "transfer-encoding", TOKEN_HEADER})
_MAX_HEADERS = 100
_DRAIN_LIMIT = 4 * 1024 * 1024


@dataclass
class ServerConfig:
    token: str = field(repr=False)
    port: int = 0
    host: str = "127.0.0.1"  # loopback only; there is no option to change it
    max_body_bytes: int = limits.BODY_LIMIT_BYTES
    max_inflight: int = limits.MAX_INFLIGHT
    inflight_wait_seconds: float = limits.INFLIGHT_WAIT_SECONDS
    inflight_retry_after: int = limits.INFLIGHT_RETRY_AFTER_SECONDS
    max_header_bytes: int = 16 * 1024
    max_connections: int = 64
    header_timeout: float = 10.0
    body_timeout: float = 30.0
    maintenance_interval: float = 5.0
    shutdown_grace: float = 3.0
    close_timeout: float = 1.5


class HttpError(Exception):
    """A transport-level failure: an ordinary HTTP status with error.code BAD_REQUEST."""

    code = "BAD_REQUEST"

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class _Request:
    method: str
    path: str
    headers: dict[str, str]
    body_read: bool = False


class _Closed(Exception):
    """The peer went away before sending a full request."""


def _envelope_error(code: str, message: str, retry_after: int | None = None) -> dict:
    error: dict = {"code": code, "message": message}
    if retry_after is not None:
        error["retryAfterSeconds"] = retry_after
    return {"ok": False, "error": error}


class WorkerServer:
    def __init__(self, config: ServerConfig, service: WorkerService) -> None:
        self.config = config
        self.service = service
        self.port = config.port
        self._server: asyncio.AbstractServer | None = None
        self._tasks: set[asyncio.Task] = set()
        self._maintenance: asyncio.Task | None = None
        self._inflight = asyncio.Semaphore(config.max_inflight)
        self._connections = 0

    # ---- lifecycle -------------------------------------------------------------------------------
    async def start(self) -> int:
        self._server = await asyncio.start_server(
            self._on_connect, self.config.host, self.config.port, limit=self.config.max_header_bytes
        )
        self.port = self._server.sockets[0].getsockname()[1]
        self._maintenance = asyncio.create_task(self._maintenance_loop())
        return self.port

    async def shutdown(self) -> None:
        """Stop listening, let in-flight requests finish (briefly), disconnect every client."""
        if self._server is not None:
            self._server.close()
        if self._maintenance is not None:
            self._maintenance.cancel()
            await asyncio.gather(self._maintenance, return_exceptions=True)
        live = [t for t in self._tasks if not t.done()]
        if live:
            _, pending = await asyncio.wait(live, timeout=self.config.shutdown_grace)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        try:
            await asyncio.wait_for(self.service.close(), self.config.close_timeout)
        except Exception:
            logs.event("shutdown_close_failed", logging.WARNING)

    async def _maintenance_loop(self) -> None:
        while True:
            await asyncio.sleep(self.config.maintenance_interval)
            try:
                await self.service.maintenance()
            except Exception as exc:  # housekeeping must never take the server down
                logs.event("maintenance_failed", logging.WARNING, errorType=type(exc).__name__)

    # ---- connection handling ---------------------------------------------------------------------
    async def _on_connect(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
        try:
            if self._connections >= self.config.max_connections:
                return
            self._connections += 1
            try:
                await self._serve_one(reader, writer)
            finally:
                self._connections -= 1
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logs.event("connection_failed", logging.WARNING, errorType=type(exc).__name__)
        finally:
            if task is not None:
                self._tasks.discard(task)
            with contextlib.suppress(Exception):
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), 1.0)

    async def _serve_one(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        started = time.monotonic()
        cid = str(uuid.uuid4())
        logs.correlation_id.set(cid)
        logs.register_secrets(())
        method, path, path_label = "-", "", "(unknown)"
        status, payload = 500, _envelope_error("INTERNAL", "Internal error.")
        try:
            request = await self._read_head(reader)
            method, path = request.method, request.path
            supplied = request.headers.get(CORRELATION_HEADER, "")
            if _CORRELATION_ID.match(supplied):
                cid = supplied
                logs.correlation_id.set(cid)
            path_label = path if path in ROUTES or path == "/health" else "(unknown)"
            status, payload = await self._dispatch(request, reader, writer)
        except _Closed:
            return
        except HttpError as err:
            status, payload = err.status, _envelope_error(err.code, err.message)
        except BadRequest as err:
            status, payload = 400, _envelope_error("BAD_REQUEST", str(err))
        except asyncio.CancelledError:
            if path in ("/v1/messages/send", "/v1/communities/create"):
                # Interrupted by shutdown mid-send: the message may or may not have gone out.
                error = WorkerError(
                    OUTCOME_UNKNOWN,
                    "The worker shut down during a request that must not be repeated blindly. "
                    "Check the community before trying again.",
                )
                status, payload = 200, {"ok": False, "error": error.to_json()}
            else:
                status, payload = 503, _envelope_error("INTERNAL", "The worker is shutting down.")
        except Exception as exc:
            logs.event(
                "request_failed", logging.ERROR, errorType=type(exc).__name__,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
        await self._respond(writer, status, payload, cid)
        error = payload.get("error") if isinstance(payload, dict) else None
        logs.event(
            "request", method=method, path=path_label, status=status, ok=bool(payload.get("ok")),
            errorCode=error.get("code") if error else None,
            durationMs=int((time.monotonic() - started) * 1000),
        )

    async def _read_head(self, reader: asyncio.StreamReader) -> _Request:
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), self.config.header_timeout)
        except (asyncio.IncompleteReadError, ConnectionError):
            raise _Closed from None
        except asyncio.LimitOverrunError:
            raise HttpError(400, "request headers are too large") from None
        except TimeoutError:
            raise HttpError(400, "timed out waiting for the request headers") from None
        try:
            lines = raw.decode("latin-1").split("\r\n")[:-2]
            method, target, version = lines[0].split(" ")
        except ValueError:
            raise HttpError(400, "malformed request line") from None
        if not version.startswith("HTTP/1.") or not target.startswith("/"):
            raise HttpError(400, "malformed request line")
        if len(lines) - 1 > _MAX_HEADERS:
            raise HttpError(400, "too many headers")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            name, sep, value = line.partition(":")
            if not sep or not name or name != name.strip():
                raise HttpError(400, "malformed header")
            name = name.lower()
            if name in headers and name in _SINGLE_HEADERS:
                raise HttpError(400, f"duplicate {name} header")
            headers[name] = value.strip()
        return _Request(method.upper(), target.split("?", 1)[0], headers)

    async def _drain(self, reader: asyncio.StreamReader, request: _Request) -> None:
        """Discard an unread body so that an early error reply is not lost to a connection reset."""
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return
        if not request.body_read and 0 < length <= _DRAIN_LIMIT:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(reader.readexactly(length), 2.0)

    # ---- routing ------------------------------------------------------------------------------------
    def _check_host(self, request: _Request) -> None:
        host = request.headers.get("host", "").lower()
        if host not in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            raise HttpError(421, "unexpected Host header")

    def _check_token(self, request: _Request) -> None:
        supplied = request.headers.get(TOKEN_HEADER, "").encode("utf-8")
        if not hmac.compare_digest(supplied, self.config.token.encode("utf-8")):
            logs.event("auth_failed", logging.WARNING)
            raise HttpError(401, "missing or invalid worker token")

    async def _dispatch(
        self, request: _Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> tuple[int, dict]:
        try:
            self._check_host(request)
            if request.path == "/health" and request.method == "GET":
                return 200, self.service.health()
            self._check_token(request)
            route = ROUTES.get(request.path)
            if route is None:
                raise HttpError(404, "unknown route")
            if request.method != "POST":
                raise HttpError(405, "use POST")
            return await self._call_route(request, route, reader, writer)
        except HttpError:
            await self._drain(reader, request)
            raise

    async def _read_body(self, request: _Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> bytes:
        if "transfer-encoding" in request.headers:
            raise HttpError(400, "chunked bodies are not supported: send Content-Length")
        raw_length = request.headers.get("content-length", "")
        if not raw_length.isdigit() or len(raw_length) > 12:
            raise HttpError(400, "Content-Length is required")
        length = int(raw_length)
        if length > self.config.max_body_bytes:
            raise HttpError(413, f"request body is larger than {self.config.max_body_bytes} bytes")
        content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise HttpError(400, "Content-Type must be application/json")
        if request.headers.get("expect", "").lower() == "100-continue":
            writer.write(b"HTTP/1.1 100 Continue\r\n\r\n")
            await writer.drain()
        try:
            data = await asyncio.wait_for(reader.readexactly(length), self.config.body_timeout)
        except (asyncio.IncompleteReadError, ConnectionError):
            raise _Closed from None
        except TimeoutError:
            raise HttpError(400, "timed out reading the request body") from None
        request.body_read = True
        return data

    async def _call_route(self, request, route, reader, writer) -> tuple[int, dict]:
        raw = await self._read_body(request, reader, writer)
        try:
            body = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise HttpError(400, "request body is not valid JSON") from None
        logs.register_secrets(logs.secrets_in(body))
        args = route.validate(body, self.service.context)

        try:
            await asyncio.wait_for(self._inflight.acquire(), self.config.inflight_wait_seconds)
        except TimeoutError:
            error = _envelope_error(
                RATE_LIMITED,
                "The worker is busy with other requests. Try again shortly.",
                self.config.inflight_retry_after,
            )
            return 200, error
        try:
            result = await self.service.serve(route, args)
        except WorkerError as err:
            return 200, {"ok": False, "error": err.to_json()}
        finally:
            self._inflight.release()
        return 200, {"ok": True, **result}

    # ---- response ---------------------------------------------------------------------------------------
    async def _respond(self, writer: asyncio.StreamWriter, status: int, payload: dict, cid: str) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        head = (
            f"HTTP/1.1 {status} {_REASONS.get(status, 'Error')}\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"X-Correlation-Id: {cid}\r\n"
            "Cache-Control: no-store\r\n"
            "Connection: close\r\n\r\n"
        ).encode("latin-1")
        with contextlib.suppress(Exception):
            writer.write(head + body)
            await asyncio.wait_for(writer.drain(), 5.0)


def _reject_constant(name: str) -> None:
    raise ValueError(f"invalid JSON constant {name}")
