"""Strict request validation: types, bounds, unknown fields. Failures are BadRequest (HTTP 400).

`limit` is the one exception to "refuse what is out of range": it is clamped, and the applied
value is echoed in the response (contract: "limit is clamped, never refused"). A limit that is not
an integer is still a malformed request.
"""

from __future__ import annotations

import re
from typing import Any

from . import ads, limits
from .backend import Account, ApiCredentials
from .errors import BadRequest

_MISSING = object()
_API_ID_MAX = 2**31 - 1
_USER_ID_MAX = 2**63 - 1
_LOGIN_ID = re.compile(r"^[A-Za-z0-9_\-]{1,128}$")
_USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,30}[A-Za-z0-9]$")


class Fields:
    """Reads typed values out of a JSON object and refuses anything it was not asked about."""

    def __init__(self, data: Any, where: str = "body") -> None:
        if not isinstance(data, dict):
            raise BadRequest(f"{where} must be a JSON object")
        self._data = dict(data)
        self._where = where

    def _name(self, key: str) -> str:
        return key if self._where == "body" else f"{self._where}.{key}"

    def _pop(self, key: str, optional: bool) -> Any:
        if key not in self._data:
            if optional:
                return _MISSING
            raise BadRequest(f"{self._name(key)} is required")
        value = self._data.pop(key)
        if value is None and optional:
            return _MISSING
        return value

    def string(
        self, key: str, *, max_length: int, optional: bool = False, strip: bool = False,
        allow_empty: bool = False, no_space: bool = False,
    ) -> str | None:
        value = self._pop(key, optional)
        if value is _MISSING:
            return None
        if not isinstance(value, str):
            raise BadRequest(f"{self._name(key)} must be a string")
        if "\x00" in value:
            raise BadRequest(f"{self._name(key)} contains a NUL character")
        if strip:
            value = value.strip()
        if not value and not allow_empty:
            raise BadRequest(f"{self._name(key)} must not be empty")
        if len(value) > max_length:
            raise BadRequest(f"{self._name(key)} is longer than {max_length} characters")
        if no_space and re.search(r"\s", value):
            raise BadRequest(f"{self._name(key)} must not contain whitespace")
        return value

    def integer(self, key: str, *, minimum: int, maximum: int, optional: bool = False) -> int | None:
        value = self._pop(key, optional)
        if value is _MISSING:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise BadRequest(f"{self._name(key)} must be an integer")
        if not minimum <= value <= maximum:
            raise BadRequest(f"{self._name(key)} must be between {minimum} and {maximum}")
        return value

    def boolean(self, key: str) -> bool:
        value = self._pop(key, False)
        if not isinstance(value, bool):
            raise BadRequest(f"{self._name(key)} must be true or false")
        return value

    def limit(self, *, default: int, maximum: int) -> int:
        value = self._pop("limit", True)
        if value is _MISSING:
            return default
        if isinstance(value, bool) or not isinstance(value, int):
            raise BadRequest(f"{self._name('limit')} must be an integer")
        return limits.clamp(value, 1, maximum)

    def obj(self, key: str, optional: bool = False) -> Fields | None:
        value = self._pop(key, optional)
        if value is _MISSING:
            return None
        return Fields(value, self._name(key))

    def array(self, key: str, *, min_items: int, max_items: int, optional: bool = False) -> list | None:
        value = self._pop(key, optional)
        if value is _MISSING:
            return None
        if not isinstance(value, list):
            raise BadRequest(f"{self._name(key)} must be an array")
        if not min_items <= len(value) <= max_items:
            raise BadRequest(f"{self._name(key)} must have between {min_items} and {max_items} items")
        return value

    def raw(self, key: str) -> Any:
        """A required value of any type, for the caller to check."""
        return self._pop(key, False)

    def done(self) -> None:
        if self._data:
            raise BadRequest(f"unknown field: {self._name(sorted(self._data)[0])}")


class Context:
    """Settings the validators need (kept tiny on purpose)."""

    def __init__(self, media_root: str | None = None) -> None:
        self.media_root = media_root


# ---- shared pieces -----------------------------------------------------------------------------
def _account(f: Fields) -> Account:
    a = f.obj("account")
    assert a is not None
    account = Account(
        api_id=a.integer("apiId", minimum=1, maximum=_API_ID_MAX),  # type: ignore[arg-type]
        api_hash=a.string("apiHash", max_length=128, no_space=True),  # type: ignore[arg-type]
        session=a.string("session", max_length=8192, no_space=True),  # type: ignore[arg-type]
    )
    a.done()
    return account


def _ref(f: Fields) -> str:
    return f.string("ref", max_length=256)  # type: ignore[return-value]


def _login_id(f: Fields) -> str:
    value = f.string("loginId", max_length=128)
    if not value or not _LOGIN_ID.match(value):
        raise BadRequest("loginId is malformed")
    return value


def _phone(value: str) -> str:
    cleaned = re.sub(r"[\s\-().]", "", value)
    digits = cleaned[1:] if cleaned.startswith("+") else cleaned
    if not digits.isdigit() or not 5 <= len(digits) <= 15:
        raise BadRequest("phone must be an international phone number")
    return "+" + digits


def _user_id(f: Fields) -> int:
    value = f.raw("userId")
    if isinstance(value, str) and value.isdigit() and len(value) <= 19:
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= _USER_ID_MAX:
        raise BadRequest("userId must be a positive integer (or a numeric string)")
    return value


# ---- one validator per route ------------------------------------------------------------------
def login_start(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    api_id = f.integer("apiId", minimum=1, maximum=_API_ID_MAX)
    api_hash = f.string("apiHash", max_length=128, no_space=True)
    phone = _phone(f.string("phone", max_length=64, strip=True))  # type: ignore[arg-type]
    f.done()
    return {"creds": ApiCredentials(api_id, api_hash), "phone": phone}  # type: ignore[arg-type]


def login_code(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    login_id = _login_id(f)
    code = re.sub(r"[\s\-]", "", f.string("code", max_length=32) or "")
    if not code.isdigit() or not 3 <= len(code) <= 10:
        raise BadRequest("code must be the digits Telegram sent")
    f.done()
    return {"login_id": login_id, "code": code}


def login_password(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    login_id = _login_id(f)
    password = f.string("password", max_length=256)
    f.done()
    return {"login_id": login_id, "password": password}


def login_cancel(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    login_id = _login_id(f)
    f.done()
    return {"login_id": login_id}


def account_only(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    f.done()
    return {"account": account}


def search(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    query = f.string("query", max_length=128, strip=True)
    limit = f.limit(default=20, maximum=limits.SEARCH_MAX)
    f.done()
    return {"account": account, "query": query, "limit": limit}


def account_and_ref(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    ref = _ref(f)
    f.done()
    return {"account": account, "ref": ref}


def refresh(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    refs = f.array("refs", min_items=1, max_items=limits.REFRESH_MAX_REFS)
    assert refs is not None
    for index, item in enumerate(refs):
        if not isinstance(item, str) or len(item) > 256:
            raise BadRequest(f"refs[{index}] must be a string of at most 256 characters")
    f.done()
    return {"account": account, "refs": refs}


def messages(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    ref = _ref(f)
    limit = f.limit(default=10, maximum=limits.MESSAGES_MAX)
    f.done()
    return {"account": account, "ref": ref, "limit": limit}


def mine(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    limit = f.limit(default=100, maximum=limits.DIALOGS_MAX)
    f.done()
    return {"account": account, "limit": limit}


def create(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    kind = f.string("kind", max_length=16)
    if kind not in ("group", "channel"):
        raise BadRequest('kind must be "group" or "channel"')
    title = f.string("title", max_length=128, strip=True)
    about = f.string("about", max_length=255, optional=True, allow_empty=True)
    username = f.string("username", max_length=33, optional=True, strip=True)
    if username is not None:
        username = username.lstrip("@")
        if not _USERNAME.match(username):
            raise BadRequest("username must be 4-32 letters, digits or underscores, starting with a letter")
    f.done()
    return {"account": account, "kind": kind, "title": title, "about": about, "username": username}


def update(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    ref = _ref(f)
    title = f.string("title", max_length=128, optional=True, strip=True)
    about = f.string("about", max_length=255, optional=True, allow_empty=True)
    f.done()
    if title is None and about is None:
        raise BadRequest("give a title or an about text to change")
    return {"account": account, "ref": ref, "title": title, "about": about}


def join_requests(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    ref = _ref(f)
    limit = f.limit(default=20, maximum=limits.JOIN_REQUESTS_MAX)
    f.done()
    return {"account": account, "ref": ref, "limit": limit}


def join_request_decision(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    ref = _ref(f)
    user_id = _user_id(f)
    approve = f.boolean("approve")
    f.done()
    return {"account": account, "ref": ref, "user_id": user_id, "approve": approve}


def send(body: Any, ctx: Context) -> dict:
    f = Fields(body)
    account = _account(f)
    ref = _ref(f)
    a = f.obj("ad")
    assert a is not None
    html = a.string("html", max_length=ads.MAX_HTML_CHARS)
    media_in = a.array("media", min_items=0, max_items=ads.MAX_MEDIA, optional=True) or []
    media: list[tuple[str, str]] = []
    for index, entry in enumerate(media_in):
        m = Fields(entry, f"ad.media[{index}]")
        path = m.string("path", max_length=1024)
        kind = m.string("kind", max_length=8)
        if kind not in ads.MEDIA_KINDS:
            raise BadRequest(f'ad.media[{index}].kind must be "photo" or "video"')
        m.done()
        media.append((path, kind))  # type: ignore[arg-type]
    button_text = a.string("buttonText", max_length=ads.BUTTON_TEXT_MAX, optional=True)
    button_url = a.string("buttonUrl", max_length=ads.BUTTON_URL_MAX, optional=True)
    a.done()
    f.done()
    ad = ads.build_ad(html, media, button_text, button_url, ctx.media_root)
    return {"account": account, "ref": ref, "ad": ad}
