"""A stand-in for telethon.TelegramClient that never touches the network.

It answers the handful of calls TelethonBackend makes, using real Telethon TL types for entities
and requests, and it serialises every TL request it receives (so a malformed request fails here).
It also refuses, at run time, every request type that could list or add people.
"""

from __future__ import annotations

import inspect
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Callable

from telethon import TelegramClient, errors as tl_errors
from telethon.crypto import AuthKey
from telethon.sessions import StringSession
from telethon.tl import types

# Request classes that must never be issued by the worker, whatever the test.
FORBIDDEN_REQUESTS = {
    "GetParticipantsRequest", "GetParticipantRequest", "InviteToChannelRequest", "AddChatUserRequest",
    "CreateChatRequest", "ImportContactsRequest", "GetContactsRequest", "GetFullUserRequest",
    "GetUsersRequest", "GetCommonChatsRequest", "GetFullChatRequest", "GetAdminedPublicChannelsRequest",
    "EditBannedRequest", "EditAdminRequest",
}
DATE = datetime(2026, 1, 1, tzinfo=timezone.utc)


def valid_session_string() -> str:
    session = StringSession()
    session.set_dc(2, "149.154.167.51", 443)
    session.auth_key = AuthKey(os.urandom(256))
    return session.save()


def channel(id=1001, title="News", username="agencyos_news", **flags: Any) -> types.Channel:
    return types.Channel(
        id=id, title=title, photo=types.ChatPhotoEmpty(), date=DATE, access_hash=id * 7, username=username,
        **flags,
    )


def chat(id=2002, title="Old group", **flags: Any) -> types.Chat:
    return types.Chat(id=id, title=title, photo=types.ChatPhotoEmpty(), participants_count=5, date=DATE, version=1, **flags)


def user(id=777, username="demo", **extra: Any) -> types.User:
    return types.User(id=id, access_hash=id * 3, username=username, first_name="Demo", last_name="User", phone="4915112345678", **extra)


def full(**extra: Any) -> SimpleNamespace:
    base = dict(about="About text", participants_count=1234, slowmode_seconds=None, linked_chat_id=None, exported_invite=None)
    return SimpleNamespace(full_chat=SimpleNamespace(**{**base, **extra}))


class StubWorld:
    """Shared script and log for every client the backend creates."""

    def __init__(self) -> None:
        self.requests: list[Any] = []  # TL requests, as received by client(...)
        self.calls: list[str] = []  # helper calls: log_out, send_code_request, sign_in
        self.sent: list[tuple[str, tuple, dict]] = []  # send_message / send_file / sign_in with their kwargs
        self.drop_markup = False  # Telegram "forgets" the inline button on sent messages
        self.connects = 0
        self.disconnects = 0
        self.clients: list[StubClient] = []
        self.handlers: dict[str, Callable[[Any], Any]] = {}
        self.connect_error: BaseException | None = None
        self.me: Any = user()
        self.dialogs: list[Any] = []
        self.history: list[Any] = []
        self.sign_in_script: list[Any] = []  # items raised (exceptions) or returned
        self.send_script: list[Any] = []  # one item per send_message/send_file call
        self.code_type: Any = types.auth.SentCodeTypeApp(length=5)
        self.message_id = 9000
        self.dialog_args: dict = {}
        self.history_args: dict = {}

    def on(self, request_name: str, handler: Callable[[Any], Any] | Any) -> None:
        self.handlers[request_name] = handler if callable(handler) else (lambda _r, value=handler: value)

    def factory(self, api_id: int, api_hash: str, session: StringSession, *, for_login: bool = False) -> StubClient:
        client = StubClient(self, api_id, api_hash, session)
        client.for_login = for_login
        self.clients.append(client)
        return client

    def count(self, request_name: str) -> int:
        return sum(1 for r in self.requests if type(r).__name__ == request_name)

    def names(self) -> list[str]:
        return [type(r).__name__ for r in self.requests]


def check_call(method_name: str, *args: Any, **kwargs: Any) -> None:
    """Fail unless the real TelegramClient method accepts exactly these arguments."""
    inspect.signature(getattr(TelegramClient, method_name)).bind(None, *args, **kwargs)


class _Message:
    def __init__(self, id: int, reply_markup: Any = None) -> None:
        self.id = id
        self.reply_markup = reply_markup


class StubClient:
    def __init__(self, world: StubWorld, api_id: int, api_hash: str, session: StringSession) -> None:
        self.world = world
        self.api_id = api_id
        self.session = session
        self.connected = False
        self.for_login = False

    # ---- connection -------------------------------------------------------------------------------
    async def connect(self) -> None:
        if self.world.connect_error is not None:
            raise self.world.connect_error
        self.world.connects += 1
        self.connected = True

    def is_connected(self) -> bool:
        return self.connected

    async def disconnect(self) -> None:
        if self.connected:
            self.world.disconnects += 1
        self.connected = False

    # ---- raw requests -------------------------------------------------------------------------------------
    async def __call__(self, request: Any) -> Any:
        name = type(request).__name__
        assert name not in FORBIDDEN_REQUESTS, f"the worker must never issue {name}"
        bytes(request)  # the request must be a well-formed TL object
        self.world.requests.append(request)
        handler = self.world.handlers.get(name)
        if handler is None:
            raise AssertionError(f"unexpected request {name}")
        result = handler(request)
        if isinstance(result, BaseException):
            raise result
        return result

    # ---- helpers ------------------------------------------------------------------------------------------------
    async def get_me(self) -> Any:
        check_call("get_me")
        return self.world.me

    async def log_out(self) -> bool:
        check_call("log_out")
        self.world.calls.append("log_out")
        return True

    async def send_code_request(self, phone: str) -> Any:
        check_call("send_code_request", phone)
        self.world.calls.append("send_code_request")
        self.world.sent.append(("send_code_request", (phone,), {}))
        return types.auth.SentCode(type=self.world.code_type, phone_code_hash="hash-123")

    async def sign_in(self, phone=None, code=None, *, password=None, phone_code_hash=None) -> Any:
        check_call("sign_in", phone, code, password=password, phone_code_hash=phone_code_hash)
        self.world.calls.append("sign_in")
        self.world.sent.append(("sign_in", (), {"phone": phone, "code": code, "password": password, "hash": phone_code_hash}))
        step = self.world.sign_in_script.pop(0) if self.world.sign_in_script else self.world.me
        if isinstance(step, BaseException):
            raise step
        self.session.set_dc(2, "149.154.167.51", 443)
        self.session.auth_key = AuthKey(os.urandom(256))
        return step

    def iter_dialogs(self, **kwargs: Any):
        check_call("iter_dialogs", **kwargs)
        self.world.dialog_args = kwargs

        async def generator():
            for dialog in self.world.dialogs[: kwargs.get("limit")]:
                yield dialog

        return generator()

    def iter_messages(self, peer: Any, **kwargs: Any):
        check_call("iter_messages", peer, **kwargs)
        self.world.history_args = {"peer": peer, **kwargs}

        async def generator():
            for message in self.world.history[: kwargs.get("limit")]:
                yield message

        return generator()

    def _next_send(self) -> Any:
        step = self.world.send_script.pop(0) if self.world.send_script else None
        if isinstance(step, BaseException):
            raise step
        return step

    def _markup(self, kwargs: dict) -> Any:
        return object() if kwargs.get("buttons") is not None and not self.world.drop_markup else None

    async def send_message(self, peer: Any, message: str, **kwargs: Any) -> Any:
        check_call("send_message", peer, message, **kwargs)
        self.world.sent.append(("send_message", (peer, message), kwargs))
        self._next_send()
        self.world.message_id += 1
        return _Message(self.world.message_id, self._markup(kwargs))

    async def send_file(self, peer: Any, file: Any, **kwargs: Any) -> Any:
        check_call("send_file", peer, file, **kwargs)
        self.world.sent.append(("send_file", (peer, file), kwargs))
        self._next_send()
        files = file if isinstance(file, list) else [file]
        messages = []
        for _ in files:
            self.world.message_id += 1
            messages.append(_Message(self.world.message_id, self._markup(kwargs)))
        return messages if isinstance(file, list) else messages[0]


def rpc(name: str, **kwargs: Any) -> BaseException:
    """A real Telethon RPC exception by class name."""
    cls = getattr(tl_errors, name)
    try:
        return cls(request=None, **kwargs)
    except TypeError:
        return cls(request=None)
