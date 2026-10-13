"""An in-memory TelegramBackend for contract tests and for integration tests of the supervisor.

It never opens a socket. It behaves like a small, well-behaved Telegram: logins with a known
code, communities with owners/admins/members, join requests, a send outbox, and hooks to inject
failures. Like the interface it implements, it has no operation that lists people.

Demo data (`MemoryBackend.with_demo_data()`, used by `--backend memory`):
    phone any international number   login code 12345   two-step password hunter2-demo
    session "memory-session-1" is already authorized
    communities: @agencyos_news (channel, admin), @agencyos_chat (supergroup, member),
                 @agencyos_open (supergroup, not joined), invite https://t.me/+DemoInviteHash01 (private)
"""

from __future__ import annotations

import asyncio
import itertools
import secrets
from dataclasses import dataclass, field, replace
from typing import Any

from .ads import SendPlan, release_url
from .backend import (
    Account, ApiCredentials, CreateResult, JoinResult, LoginAttempt, LoginOutcome, SendResult,
    TelegramBackend,
)
from .errors import (
    ACCOUNT_RESTRICTED, CODE_EXPIRED, CODE_INVALID, FORBIDDEN, NOT_FOUND, PASSWORD_INVALID,
    PHONE_INVALID, PRIVATE, RATE_LIMITED, SESSION_INVALID, WorkerError,
)
from .limits import PUBLIC_MESSAGE_TEXT_MAX
from .models import (
    ADMINISTERED, JOIN_REQUEST_PENDING, JOINED, KIND_BROADCAST_CHANNEL, KIND_SUPERGROUP, MEMBER,
    OWNED, PUBLIC_NOT_JOINED, RESTRICTED, CanPost, Community, CommunityView, JoinRequest, Me,
    PublicMessage, mask_phone,
)
from .refs import INVITE, Ref

LOGIN_CODE = "12345"
EXPIRED_CODE = "00000"
TWO_STEP_PASSWORD = "hunter2-demo"


@dataclass
class FakeAccount:
    me: Me
    restricted: bool = False
    revoked: bool = False


@dataclass
class FakeCommunity:
    community: Community
    invite_hash: str | None = None
    owner: str | None = None
    admins: set[str] = field(default_factory=set)
    members: set[str] = field(default_factory=set)
    banned: set[str] = field(default_factory=set)
    pending_requests: list[JoinRequest] = field(default_factory=list)
    messages: list[PublicMessage] = field(default_factory=list)


@dataclass
class _FakeLogin:
    phone: str
    two_step: bool
    disposed: bool = False


class MemoryBackend(TelegramBackend):
    name = "memory"
    library_version = "memory"

    def __init__(self) -> None:
        self.accounts: dict[str, FakeAccount] = {}
        self.communities: dict[str, FakeCommunity] = {}  # keyed by lower-case username or invite hash
        self.two_step_phones: set[str] = set()
        self.outbox: list[tuple[str, SendPlan]] = []
        self.calls: list[str] = []
        self.logins: list[_FakeLogin] = []
        self.failures: dict[str, list[WorkerError]] = {}
        self.gate: asyncio.Event | None = None  # when set (and not triggered), operations wait here
        self.entered = 0
        self.sweeps = 0
        self.shut_down = False
        self._connected: set[str] = set()
        self._ids = itertools.count(1000)
        self._message_ids = itertools.count(5000)

    # ---- test helpers ----------------------------------------------------------------------------
    def add_account(self, session: str, me: Me | None = None, **flags: bool) -> FakeAccount:
        me = me or Me(str(next(self._ids)), f"user{len(self.accounts)}", "Test", None, False, "+49•••••1234")
        self.accounts[session] = FakeAccount(me, **flags)
        return self.accounts[session]

    def add_community(self, community: Community, *, invite_hash: str | None = None, **parts: Any) -> FakeCommunity:
        fake = FakeCommunity(community, invite_hash=invite_hash, **parts)
        if community.username:
            self.communities[community.username.lower()] = fake
        if invite_hash:
            self.communities[invite_hash] = fake
        return fake

    def fail_next(self, operation: str, error: WorkerError) -> None:
        """Make the next call of `operation` raise `error` (operation = the method name)."""
        self.failures.setdefault(operation, []).append(error)

    @classmethod
    def with_demo_data(cls) -> MemoryBackend:
        backend = cls()
        backend.add_account("memory-session-1", Me("777", "demo_operator", "Demo", "Operator", False, "+49•••••1234"))
        news = Community("101", KIND_BROADCAST_CHANNEL, "AgencyOS News", "agencyos_news", "https://t.me/agencyos_news",
                         "Demo channel", 1200, has_linked_chat=False)
        chat = Community("102", KIND_SUPERGROUP, "AgencyOS Chat", "agencyos_chat", "https://t.me/agencyos_chat",
                         "Demo group", 87, has_linked_chat=True)
        open_group = Community("103", KIND_SUPERGROUP, "AgencyOS Open", "agencyos_open", "https://t.me/agencyos_open",
                               "Not joined yet", 300)
        private = Community(None, KIND_SUPERGROUP, "Private Demo", None, None, "Invite only", 12, join_request_required=True)
        backend.add_community(news, owner="memory-session-1", admins={"memory-session-1"},
                              messages=[PublicMessage("1", "2026-01-01T00:00:00Z", "Hello from the demo channel", 10)])
        backend.add_community(chat, members={"memory-session-1"})
        backend.add_community(open_group)
        backend.add_community(private, invite_hash="DemoInviteHash01")
        return backend

    async def _enter(self, operation: str, account: Account | None = None) -> FakeAccount | None:
        self.calls.append(operation)
        self.entered += 1
        if self.gate is not None:
            await self.gate.wait()
        queue = self.failures.get(operation)
        if queue:
            raise queue.pop(0)
        if account is None:
            return None
        fake = self.accounts.get(account.session)
        if fake is None or fake.revoked:
            raise WorkerError(SESSION_INVALID, "The session was revoked, expired or was never authorized.")
        self._connected.add(account.session)
        return fake

    def _lookup(self, ref: Ref) -> FakeCommunity:
        fake = self.communities.get(ref.value if ref.kind == INVITE else ref.value.lower())
        if fake is None:
            raise WorkerError(NOT_FOUND, "Nothing matches that name or link.")
        return fake

    @staticmethod
    def _relation(session: str, fake: FakeCommunity) -> str:
        if session in fake.banned:
            return RESTRICTED
        if fake.owner == session:
            return OWNED
        if session in fake.admins:
            return ADMINISTERED
        return MEMBER if session in fake.members else PUBLIC_NOT_JOINED

    @staticmethod
    def _can_post(session: str, relation: str, fake: FakeCommunity) -> CanPost | None:
        if relation not in (OWNED, ADMINISTERED, MEMBER):
            return None
        is_admin = relation in (OWNED, ADMINISTERED)
        broadcast = fake.community.kind == KIND_BROADCAST_CHANNEL
        can = is_admin or not broadcast
        return CanPost(can, can, is_admin, broadcast and is_admin, fake.community.slow_mode_seconds)

    def _view(self, session: str, fake: FakeCommunity) -> CommunityView:
        relation = self._relation(session, fake)
        return CommunityView(fake.community, relation, self._can_post(session, relation, fake))

    @staticmethod
    def _require_admin(session: str, fake: FakeCommunity) -> None:
        if session != fake.owner and session not in fake.admins:
            raise WorkerError(FORBIDDEN, "This account is not allowed to do that here.")

    # ---- login -------------------------------------------------------------------------------------
    async def login_start(self, creds: ApiCredentials, phone: str) -> LoginAttempt:
        await self._enter("login_start")
        if phone.endswith("000"):
            raise WorkerError(PHONE_INVALID, "Telegram does not accept this phone number.")
        login = _FakeLogin(phone, phone in self.two_step_phones)
        self.logins.append(login)
        return LoginAttempt(login, "app")

    async def login_code(self, handle: _FakeLogin, code: str) -> LoginOutcome:
        await self._enter("login_code")
        if code == EXPIRED_CODE:
            raise WorkerError(CODE_EXPIRED, "The login code expired. Start the login again.")
        if code != LOGIN_CODE:
            raise WorkerError(CODE_INVALID, "The login code is wrong.")
        if handle.two_step:
            return LoginOutcome("password_required")
        return self._authorize(handle.phone)

    async def login_password(self, handle: _FakeLogin, password: str) -> LoginOutcome:
        await self._enter("login_password")
        if password != TWO_STEP_PASSWORD:
            raise WorkerError(PASSWORD_INVALID, "The two-step verification password is wrong.")
        return self._authorize(handle.phone)

    def _authorize(self, phone: str) -> LoginOutcome:
        session = "fake-session-" + secrets.token_hex(24)
        me = Me(str(next(self._ids)), None, "Fake", "Account", False, mask_phone(phone))
        self.accounts[session] = FakeAccount(me)
        return LoginOutcome("authorized", session, me)

    async def login_dispose(self, handle: Any) -> None:
        if isinstance(handle, _FakeLogin):
            handle.disposed = True

    # ---- account -------------------------------------------------------------------------------------
    async def account_status(self, account: Account) -> Me | None:
        try:
            fake = await self._enter("account_status", account)
        except WorkerError as err:
            if err.code == SESSION_INVALID:
                return None
            raise
        return fake.me if fake else None

    async def account_logout(self, account: Account) -> None:
        await self._enter("account_logout", account)
        self.accounts[account.session].revoked = True
        self._connected.discard(account.session)

    # ---- communities ---------------------------------------------------------------------------------
    async def search_communities(self, account: Account, query: str, limit: int) -> list[Community]:
        await self._enter("search_communities", account)
        needle = query.lower()
        seen: dict[int, Community] = {}
        for fake in self.communities.values():
            text = f"{fake.community.title} {fake.community.username or ''}".lower()
            if needle in text and fake.community.username:
                seen[id(fake)] = fake.community
        return list(seen.values())[:limit]

    async def resolve_community(self, account: Account, ref: Ref) -> CommunityView:
        fake_account = await self._enter("resolve_community", account)
        assert fake_account is not None
        fake = self._lookup(ref)
        return self._view(account.session, fake)

    async def list_my_communities(self, account: Account, limit: int) -> list[CommunityView]:
        await self._enter("list_my_communities", account)
        views: dict[int, CommunityView] = {}
        for fake in self.communities.values():
            relation = self._relation(account.session, fake)
            if relation in (OWNED, ADMINISTERED, MEMBER, RESTRICTED):
                views[id(fake)] = self._view(account.session, fake)
        return list(views.values())[:limit]

    async def recent_messages(self, account: Account, ref: Ref, limit: int) -> list[PublicMessage]:
        await self._enter("recent_messages", account)
        fake = self._lookup(ref)
        if not fake.community.username:
            raise WorkerError(PRIVATE, "This community is private: there is nothing public to show.")
        newest_first = list(reversed(fake.messages))[:limit]
        return [
            PublicMessage(m.id, m.date, m.text[:PUBLIC_MESSAGE_TEXT_MAX], m.views) for m in newest_first
        ]

    async def join_community(self, account: Account, ref: Ref) -> JoinResult:
        fake_account = await self._enter("join_community", account)
        assert fake_account is not None
        fake = self._lookup(ref)
        session = account.session
        if fake_account.restricted or session in fake.banned:
            raise WorkerError(ACCOUNT_RESTRICTED, "Telegram has limited this account. Nothing was retried or re-routed.")
        if self._relation(session, fake) in (OWNED, ADMINISTERED, MEMBER):
            return JoinResult(JOINED, fake.community)
        if fake.community.join_request_required:
            if not any(r.user_id == fake_account.me.id for r in fake.pending_requests):
                fake.pending_requests.append(
                    JoinRequest(fake_account.me.id, fake_account.me.username, "2026-01-01T00:00:00Z", None)
                )
            return JoinResult(JOIN_REQUEST_PENDING, fake.community)
        fake.members.add(session)
        return JoinResult(JOINED, fake.community)

    async def leave_community(self, account: Account, ref: Ref) -> None:
        await self._enter("leave_community", account)
        fake = self._lookup(ref)
        if fake.owner == account.session or account.session not in fake.members | fake.admins:
            raise WorkerError(FORBIDDEN, "This account is not allowed to do that here.")
        fake.members.discard(account.session)
        fake.admins.discard(account.session)

    async def create_community(
        self, account: Account, kind: str, title: str, about: str | None, username: str | None
    ) -> CreateResult:
        await self._enter("create_community", account)
        warnings: list[str] = []
        if username and username.lower() in self.communities:
            warnings.append("USERNAME_NOT_SET: that username is taken")
            username = None
        community = Community(
            str(next(self._ids)), KIND_BROADCAST_CHANNEL if kind == "channel" else KIND_SUPERGROUP, title,
            username, f"https://t.me/{username}" if username else None, about or None, 1,
            has_linked_chat=False,
        )
        self.add_community(community, owner=account.session, admins={account.session})
        return CreateResult(community, f"https://t.me/+fake{secrets.token_hex(6)}", tuple(warnings))

    async def update_community(
        self, account: Account, ref: Ref, title: str | None, about: str | None
    ) -> Community:
        await self._enter("update_community", account)
        fake = self._lookup(ref)
        self._require_admin(account.session, fake)
        changes: dict[str, Any] = {}
        if title is not None:
            changes["title"] = title
        if about is not None:
            changes["description"] = about or None
        fake.community = replace(fake.community, **changes)
        return fake.community

    async def export_invite_link(self, account: Account, ref: Ref) -> str:
        await self._enter("export_invite_link", account)
        fake = self._lookup(ref)
        self._require_admin(account.session, fake)
        return f"https://t.me/+{fake.invite_hash or 'FakeInviteHash0001'}"

    async def list_join_requests(self, account: Account, ref: Ref, limit: int) -> list[JoinRequest]:
        await self._enter("list_join_requests", account)
        fake = self._lookup(ref)
        self._require_admin(account.session, fake)
        return list(fake.pending_requests)[:limit]

    async def decide_join_request(self, account: Account, ref: Ref, user_id: int, approve: bool) -> None:
        await self._enter("decide_join_request", account)
        fake = self._lookup(ref)
        self._require_admin(account.session, fake)
        match = [r for r in fake.pending_requests if r.user_id == str(user_id)]
        if not match:
            raise WorkerError(NOT_FOUND, "Nothing matches that name or link.")
        fake.pending_requests.remove(match[0])

    # ---- sending ---------------------------------------------------------------------------------------
    async def send_ad(self, account: Account, ref: Ref, plan: SendPlan) -> SendResult:
        fake_account = await self._enter("send_ad", account)
        assert fake_account is not None
        fake = self._lookup(ref)
        if fake_account.restricted:
            raise WorkerError(ACCOUNT_RESTRICTED, "Telegram has limited this account. Nothing was retried or re-routed.")
        relation = self._relation(account.session, fake)
        can = self._can_post(account.session, relation, fake)
        if can is None or not can.send_messages:
            raise WorkerError(FORBIDDEN, "This account is not allowed to do that here.")
        parts = len(plan.media) + (1 if plan.text_html is not None and plan.media else 0) or 1
        ids = tuple(str(next(self._message_ids)) for _ in range(parts))
        self.outbox.append((fake.community.username or "", plan))
        return SendResult(ids, release_url(fake.community.username, ids[0]))

    def rate_limit_next(self, operation: str, seconds: int) -> None:
        self.fail_next(operation, WorkerError(RATE_LIMITED, "Telegram asked this account to wait.", seconds))

    # ---- housekeeping ---------------------------------------------------------------------------------------
    def client_count(self) -> int:
        return len(self._connected)

    async def sweep_idle(self) -> None:
        self.sweeps += 1
        self._connected.clear()

    async def shutdown(self) -> None:
        self.shut_down = True
        self._connected.clear()
