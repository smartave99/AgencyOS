"""One JSON object per line on stderr, with secrets scrubbed.

Secrets never get a chance to be logged on purpose: request bodies and message text are not
logged at all, the server only logs method, path, status, timing and error codes. This module is
the second layer. Every log line is scrubbed against

  * the secret values of the request being served (apiHash, session, code, password, phone),
    registered with `register_secrets`, in raw and JSON-escaped form, and
  * patterns: long opaque tokens (sessions) and '+<digits>' phones.

Third-party loggers (Telethon, asyncio) go through the same handler.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import traceback
from collections.abc import Iterable
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, TextIO

REDACTED = "[redacted]"
SECRET_KEYS = frozenset({"apiHash", "session", "code", "password", "phone"})
_MIN_SECRET_LENGTH = 4
_MAX_DEPTH = 6

correlation_id: ContextVar[str] = ContextVar("agencyos_correlation_id", default="-")
_request_secrets: ContextVar[frozenset[str]] = ContextVar("agencyos_secrets", default=frozenset())

_PATTERNS = (
    re.compile(r"\+\d[\d \-().]{6,}\d"),  # a phone number written with a leading +
    re.compile(r"[A-Za-z0-9_\-]{80,}={0,2}"),  # a session string or any other long opaque token
)

logger = logging.getLogger("agencyos.worker")


def secrets_in(payload: Any) -> set[str]:
    """Secret string values found anywhere in a request body (by key name), plus phone digits."""
    found: set[str] = set()

    def walk(node: Any, depth: int) -> None:
        if depth > _MAX_DEPTH:  # no valid request is nested this deep
            return
        if isinstance(node, dict):
            for key, value in node.items():
                if key in SECRET_KEYS and isinstance(value, str):
                    found.add(value)
                    if key == "phone":
                        digits = re.sub(r"\D", "", value)
                        found.update({digits, "+" + digits})
                else:
                    walk(value, depth + 1)
        elif isinstance(node, list):
            for item in node:
                walk(item, depth + 1)

    walk(payload, 0)
    return {s for s in found if len(s) >= _MIN_SECRET_LENGTH}


def register_secrets(values: Iterable[str]) -> None:
    """Scrub these values from every log line written in the current request context."""
    _request_secrets.set(frozenset(v for v in values if len(v) >= _MIN_SECRET_LENGTH))


def scrub(text: str) -> str:
    for secret in sorted(_request_secrets.get(), key=len, reverse=True):
        text = text.replace(secret, REDACTED)
        escaped = json.dumps(secret)[1:-1]
        if escaped != secret:
            text = text.replace(escaped, REDACTED)
    for pattern in _PATTERNS:
        text = pattern.sub(REDACTED, text)
    return text


def _scrub_value(value: Any) -> Any:
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, dict):
        return {str(k): _scrub_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_scrub_value(v) for v in value]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return scrub(str(value))


def _summarize_exception(exc_info: tuple) -> dict:
    """Exception class and the code locations only: never the exception text or source lines."""
    exc_type, _, tb = exc_info
    frames = traceback.extract_tb(tb)[-6:] if tb else []
    return {
        "type": getattr(exc_type, "__name__", "Exception"),
        "stack": [f"{os.path.basename(f.filename)}:{f.lineno}:{f.name}" for f in frames],
    }


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        fields = getattr(record, "fields", None)
        entry: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname.lower(),
        }
        if fields is not None:
            entry["event"] = record.msg if isinstance(record.msg, str) else "log"
        else:
            entry["event"] = "log"
            entry["logger"] = record.name
            entry["message"] = record.getMessage()
        entry["correlationId"] = correlation_id.get()
        if fields:
            entry.update(fields)
        line = json.dumps(_scrub_value(entry), ensure_ascii=True, separators=(",", ":"))
        return scrub(line)


_installed_factory = False


def configure_logging(stream: TextIO | None = None, level: int = logging.INFO) -> logging.Handler:
    """Send every log record, ours and third parties', through the scrubbing JSON handler."""
    global _installed_factory
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
    logging.getLogger("telethon").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)

    if not _installed_factory:
        previous = logging.getLogRecordFactory()

        def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
            record = previous(*args, **kwargs)
            # Scrub the text at the source so that any handler, not only ours, sees clean text.
            try:
                message = record.getMessage()
            except Exception:
                message = str(record.msg)
            record.msg, record.args = scrub(message), None
            if record.exc_info and record.exc_info[0] is not None:
                # Never let a raw exception (and its text) travel with a record to any handler.
                summary = _summarize_exception(record.exc_info)
                where = ", ".join(summary["stack"][-2:])
                record.msg = f"{record.msg} [{summary['type']} at {where}]"
                record.exc_info = record.exc_text = None
            return record

        logging.setLogRecordFactory(factory)
        _installed_factory = True
    return handler


def event(name: str, level: int = logging.INFO, *, exc_info: Any = None, **fields: Any) -> None:
    """Log a named event with structured, non-secret fields.

    `exc_info` is reduced to the exception class and code locations before it is logged: the
    exception object itself, whose text may hold a secret, never reaches a log record.
    """
    if exc_info:
        fields["exception"] = _summarize_exception(exc_info)
    logger.log(level, name, extra={"fields": fields})
