"""The operations the worker's endpoints need, independent of Telethon.

`TelegramBackend` is the whole surface: the HTTP layer and the service know nothing else about
Telegram. There is deliberately no operation that lists the people in a community, looks up other
users, adds or invites anyone, or picks between accounts: the interface cannot express them, and
tests/test_guard.py fails if one is ever added.

Every method acts as exactly the account it is given and either returns or raises WorkerError;
none sleeps through a flood wait, retries, or tries another account.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any

from .ads import SendPlan
from .limits import session_key
from .models import Community, CommunityView, JoinRequest, Me, PublicMessage
from .refs import Ref


@dataclass(frozen=True)
class Account:
    """The credentials the backend sends with one request. Secrets are kept out of repr()."""

    api_id: int
    api_hash: str = field(repr=False)
    session: str = field(repr=False)

    @property
    def key(self) -> str:
        return session_key(self.session)


@dataclass(frozen=True)
class ApiCredentials:
    api_id: int
    api_hash: str = field(repr=False)


@dataclass(frozen=True)
class LoginAttempt:
    handle: Any  # opaque to everything except the backend that made it
    code_delivery: str  # "app" | "sms" | "call" | "other"


@dataclass(frozen=True)
class LoginOutcome:
    status: str  # "authorized" | "password_required"
    session: str | None = field(default=None, repr=False)
    me: Me | None = None


@dataclass(frozen=True)
class JoinResult:
    status: str  # models.JOINED | models.JOIN_REQUEST_PENDING
    community: Community


@dataclass(frozen=True)
class CreateResult:
    community: Community
    invite_link: str | None = None
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class SendResult:
    message_ids: tuple[str, ...]
    release_url: str | None
    warnings: tuple[str, ...] = ()

    @property
    def primary_message_id(self) -> str:
        return self.message_ids[0]


class TelegramBackend(abc.ABC):
    name: str = "abstract"
    library_version: str = "unknown"

    # ---- login (interactive; the service keeps the loginId bookkeeping) ----------------------
    @abc.abstractmethod
    async def login_start(self, creds: ApiCredentials, phone: str) -> LoginAttempt: ...

    @abc.abstractmethod
    async def login_code(self, handle: Any, code: str) -> LoginOutcome: ...

    @abc.abstractmethod
    async def login_password(self, handle: Any, password: str) -> LoginOutcome: ...

    @abc.abstractmethod
    async def login_dispose(self, handle: Any) -> None:
        """Free whatever a pending login holds. Idempotent; never raises."""

    # ---- the account itself --------------------------------------------------------------------
    @abc.abstractmethod
    async def account_status(self, account: Account) -> Me | None:
        """The account's own profile, or None when the session is no longer authorized."""

    @abc.abstractmethod
    async def account_logout(self, account: Account) -> None: ...

    # ---- communities -----------------------------------------------------------------------------
    @abc.abstractmethod
    async def search_communities(self, account: Account, query: str, limit: int) -> list[Community]: ...

    @abc.abstractmethod
    async def resolve_community(self, account: Account, ref: Ref) -> CommunityView: ...

    @abc.abstractmethod
    async def list_my_communities(self, account: Account, limit: int) -> list[CommunityView]: ...

    @abc.abstractmethod
    async def recent_messages(self, account: Account, ref: Ref, limit: int) -> list[PublicMessage]: ...

    @abc.abstractmethod
    async def join_community(self, account: Account, ref: Ref) -> JoinResult: ...

    @abc.abstractmethod
    async def leave_community(self, account: Account, ref: Ref) -> None: ...

    @abc.abstractmethod
    async def create_community(
        self, account: Account, kind: str, title: str, about: str | None, username: str | None
    ) -> CreateResult: ...

    @abc.abstractmethod
    async def update_community(
        self, account: Account, ref: Ref, title: str | None, about: str | None
    ) -> Community: ...

    @abc.abstractmethod
    async def export_invite_link(self, account: Account, ref: Ref) -> str: ...

    @abc.abstractmethod
    async def list_join_requests(self, account: Account, ref: Ref, limit: int) -> list[JoinRequest]: ...

    @abc.abstractmethod
    async def decide_join_request(
        self, account: Account, ref: Ref, user_id: int, approve: bool
    ) -> None: ...

    # ---- sending ------------------------------------------------------------------------------------
    @abc.abstractmethod
    async def send_ad(self, account: Account, ref: Ref, plan: SendPlan) -> SendResult: ...

    # ---- housekeeping ---------------------------------------------------------------------------------
    @abc.abstractmethod
    def client_count(self) -> int:
        """Connected clients currently held in memory (reported by /health)."""

    @abc.abstractmethod
    async def sweep_idle(self) -> None:
        """Disconnect clients that have been idle too long."""

    @abc.abstractmethod
    async def shutdown(self) -> None:
        """Disconnect every client. Called once on SIGTERM/SIGINT."""
