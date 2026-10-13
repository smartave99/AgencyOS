"""Community references: a public username, a t.me link or an invite link. Anything else is INVALID_REF.

Accepted forms:
    @name   name   https://t.me/name   t.me/name   https://t.me/name/123 (a message link)
    https://t.me/s/name   https://t.me/+HASH   https://t.me/joinchat/HASH
    tg://resolve?domain=name   tg://join?invite=HASH
The host may be t.me, telegram.me or telegram.dog. Phone numbers, bare ``+HASH`` and every other
path (stickers, proxies, private ``/c/`` message links, ...) are refused.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from .errors import INVALID_REF, WorkerError

USERNAME = "username"
INVITE = "invite"

_USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,30}[A-Za-z0-9]$")  # 4..32 characters
_INVITE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_HOSTS = frozenset({"t.me", "telegram.me", "telegram.dog"})
# First path segments of t.me links that are not communities.
_RESERVED = frozenset(
    {
        "addstickers", "addemoji", "addtheme", "setlanguage", "share", "proxy", "socks", "login",
        "confirmphone", "boost", "c", "m", "giftcode", "invoice", "contact", "bg", "iv", "addlist",
        "folder", "msg", "joinchat", "s", "web", "k", "a",
    }
)
_MAX_LENGTH = 256
_FORBIDDEN_CHARS = re.compile(r"[\s\x00-\x1f\x7f<>\"'\\`]")


@dataclass(frozen=True)
class Ref:
    kind: str  # USERNAME or INVITE
    value: str  # username without '@', or the invite hash

    @property
    def is_invite(self) -> bool:
        return self.kind == INVITE


def _invalid() -> WorkerError:
    return WorkerError(
        INVALID_REF, "Expected a public username, a t.me link or a t.me invite link."
    )


def _username(value: str) -> Ref:
    if not _USERNAME_RE.match(value) or value.lower() in _RESERVED:
        raise _invalid()
    return Ref(USERNAME, value)


def _invite(value: str) -> Ref:
    if not _INVITE_RE.match(value):
        raise _invalid()
    return Ref(INVITE, value)


def parse_ref(text: object) -> Ref:
    """Parse a community reference or raise WorkerError(INVALID_REF)."""
    if not isinstance(text, str):
        raise _invalid()
    raw = text.strip()
    if not raw or len(raw) > _MAX_LENGTH or _FORBIDDEN_CHARS.search(raw):
        raise _invalid()
    if raw.startswith("@"):
        return _username(raw[1:])
    lowered = raw.lower()
    if lowered.startswith("tg:"):
        return _parse_tg(raw)
    if "/" in raw or "." in raw or ":" in raw:
        return _parse_link(raw)
    return _username(raw)


def _parse_tg(raw: str) -> Ref:
    parts = urlsplit(raw)
    if parts.scheme.lower() != "tg":
        raise _invalid()
    query = parse_qs(parts.query, keep_blank_values=False)
    action = parts.netloc.lower() or parts.path.strip("/").lower()
    if action == "resolve" and len(query.get("domain", [])) == 1:
        return _username(query["domain"][0])
    if action == "join" and len(query.get("invite", [])) == 1:
        return _invite(query["invite"][0])
    raise _invalid()


def _parse_link(raw: str) -> Ref:
    candidate = raw if "://" in raw else f"https://{raw}"
    try:
        parts = urlsplit(candidate)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError as exc:
        raise _invalid() from exc
    if parts.scheme.lower() not in ("http", "https") or host not in _HOSTS:
        raise _invalid()
    if port is not None or parts.username or parts.password:
        raise _invalid()
    path = parts.path
    if not path.startswith("/"):
        raise _invalid()
    segments = path[1:].split("/")
    if segments and segments[-1] == "":
        segments.pop()  # one trailing slash is fine
    if not segments or any(not s for s in segments):
        raise _invalid()

    first = segments[0]
    if first.startswith("+") and len(segments) == 1:
        return _invite(first[1:])
    if first.lower() == "joinchat" and len(segments) == 2:
        return _invite(segments[1])
    if first.lower() == "s" and len(segments) == 2:
        return _username(segments[1])
    if len(segments) == 1:
        return _username(first)
    if len(segments) == 2 and segments[1].isdigit():
        return _username(first)  # a message link: the community it belongs to
    raise _invalid()
