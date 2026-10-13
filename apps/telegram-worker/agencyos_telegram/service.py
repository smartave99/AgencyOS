"""The route table and the logic between HTTP and the backend.

Owns what is not Telegram-specific: pending logins (10-minute expiry, deleted on success, cancel,
error or expiry), refresh spacing with an early stop, response shapes, and timeouts. It never
retries, never sleeps through a flood wait and never chooses between accounts.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from . import __version__, limits, logs, schemas
from .ads import plan_send
from .backend import Account, LoginOutcome, TelegramBackend
from .errors import (
    ACCOUNT_RESTRICTED, CODE_INVALID, LOGIN_NOT_FOUND, NETWORK, PASSWORD_INVALID, RATE_LIMITED,
    SESSION_INVALID, BadRequest, WorkerError, map_exception,
)
from .models import mask_phone
from .refs import parse_ref
from .schemas import Context

STAGE_CODE = "code"
STAGE_PASSWORD = "password"
# The one error each login step can be retried after: a typo. Anything else ends the login.
_RETRYABLE_ERROR = {STAGE_CODE: CODE_INVALID, STAGE_PASSWORD: PASSWORD_INVALID}
# A failed lookup with one of these codes would fail the same way for every remaining ref.
_REFRESH_STOP_CODES = frozenset({RATE_LIMITED, SESSION_INVALID, ACCOUNT_RESTRICTED, NETWORK})


@dataclass(frozen=True)
class Route:
    name: str
    validate: Callable[[Any, Context], dict]
    handler: str  # name of the WorkerService coroutine that serves it


ROUTES: dict[str, Route] = {
    "/v1/login/start": Route("login.start", schemas.login_start, "login_start"),
    "/v1/login/code": Route("login.code", schemas.login_code, "login_code"),
    "/v1/login/password": Route("login.password", schemas.login_password, "login_password"),
    "/v1/login/cancel": Route("login.cancel", schemas.login_cancel, "login_cancel"),
    "/v1/account/status": Route("account.status", schemas.account_only, "account_status"),
    "/v1/account/logout": Route("account.logout", schemas.account_only, "account_logout"),
    "/v1/communities/search": Route("communities.search", schemas.search, "communities_search"),
    "/v1/communities/resolve": Route("communities.resolve", schemas.account_and_ref, "communities_resolve"),
    "/v1/communities/refresh": Route("communities.refresh", schemas.refresh, "communities_refresh"),
    "/v1/communities/messages": Route("communities.messages", schemas.messages, "communities_messages"),
    "/v1/communities/mine": Route("communities.mine", schemas.mine, "communities_mine"),
    "/v1/communities/permissions": Route(
        "communities.permissions", schemas.account_and_ref, "communities_permissions"
    ),
    "/v1/communities/join": Route("communities.join", schemas.account_and_ref, "communities_join"),
    "/v1/communities/leave": Route("communities.leave", schemas.account_and_ref, "communities_leave"),
    "/v1/communities/create": Route("communities.create", schemas.create, "communities_create"),
    "/v1/communities/update": Route("communities.update", schemas.update, "communities_update"),
    "/v1/communities/invite-link": Route(
        "communities.invite-link", schemas.account_and_ref, "communities_invite_link"
    ),
    "/v1/communities/join-requests": Route(
        "communities.join-requests", schemas.join_requests, "communities_join_requests"
    ),
    "/v1/communities/join-requests/decide": Route(
        "communities.join-requests.decide", schemas.join_request_decision, "communities_decide_join_request"
    ),
    "/v1/messages/send": Route("messages.send", schemas.send, "messages_send"),
}


@dataclass
class ServiceConfig:
    media_root: str | None = None
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    refresh_spacing: float = limits.REFRESH_SPACING_SECONDS
    login_ttl: float = limits.LOGIN_TTL_SECONDS
    operation_timeout: float = limits.OPERATION_TIMEOUT_SECONDS
    send_timeout: float = limits.SEND_TIMEOUT_SECONDS


@dataclass
class _PendingLogin:
    handle: Any
    created: float
    stage: str = STAGE_CODE
    wrong_attempts: int = 0  # wrong codes and wrong passwords together
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _authorized(outcome: LoginOutcome) -> dict:
    assert outcome.session is not None and outcome.me is not None
    return {"status": "authorized", "session": outcome.session, "me": outcome.me.to_json()}


class WorkerService:
    def __init__(self, backend: TelegramBackend, config: ServiceConfig | None = None) -> None:
        self.backend = backend
        self.config = config or ServiceConfig()
        self.context = Context(media_root=self.config.media_root)
        self._logins: dict[str, _PendingLogin] = {}
        self._started = self.config.clock()

    # ---- infrastructure ----------------------------------------------------------------------
    def health(self) -> dict:
        now = self.config.clock()
        return {
            "ok": True,
            "version": __version__,
            "telethon": self.backend.library_version,
            "python": platform.python_version(),
            "uptimeSeconds": int(now - self._started),
            "pendingLogins": sum(1 for p in self._logins.values() if not self._expired(p, now)),
            "clients": self.backend.client_count(),
            "backend": self.backend.name,
        }

    async def serve(self, route: Route, args: dict) -> dict:
        return await getattr(self, route.handler)(args)

    async def maintenance(self) -> None:
        """Periodic housekeeping: drop expired pending logins, disconnect idle clients."""
        await self._purge_expired_logins()
        await self.backend.sweep_idle()

    async def close(self) -> None:
        pending, self._logins = list(self._logins.values()), {}
        await asyncio.gather(
            *(self.backend.login_dispose(p.handle) for p in pending), return_exceptions=True
        )
        await self.backend.shutdown()

    async def _bounded(self, awaitable: Awaitable, *, sending: bool = False) -> Any:
        timeout = self.config.send_timeout if sending else self.config.operation_timeout
        try:
            return await asyncio.wait_for(awaitable, timeout)
        except (WorkerError, BadRequest):
            raise
        except Exception as exc:
            if not isinstance(exc, (OSError, EOFError)) and not _is_telethon(exc):
                logs.event(
                    "unexpected_exception", logging.ERROR, errorType=type(exc).__name__,
                    exc_info=(type(exc), exc, exc.__traceback__),
                )
            raise map_exception(exc, sending=sending) from None

    # ---- login ----------------------------------------------------------------------------------
    def _expired(self, pending: _PendingLogin, now: float | None = None) -> bool:
        return (now if now is not None else self.config.clock()) - pending.created > self.config.login_ttl

    async def _drop_login(self, login_id: str) -> None:
        pending = self._logins.pop(login_id, None)
        if pending is not None:
            await self.backend.login_dispose(pending.handle)

    async def _purge_expired_logins(self) -> None:
        now = self.config.clock()
        for login_id in [i for i, p in self._logins.items() if self._expired(p, now)]:
            logs.event("login_expired")
            await self._drop_login(login_id)

    async def _pending(self, login_id: str) -> _PendingLogin:
        pending = self._logins.get(login_id)
        if pending is None:
            raise WorkerError(LOGIN_NOT_FOUND, "Unknown or expired login. Start the login again.")
        if self._expired(pending):
            logs.event("login_expired")
            await self._drop_login(login_id)
            raise WorkerError(LOGIN_NOT_FOUND, "Unknown or expired login. Start the login again.")
        return pending

    async def login_start(self, a: dict) -> dict:
        await self._purge_expired_logins()
        attempt = await self._bounded(self.backend.login_start(a["creds"], a["phone"]))
        login_id = secrets.token_urlsafe(24)
        self._logins[login_id] = _PendingLogin(attempt.handle, self.config.clock())
        while len(self._logins) > limits.MAX_PENDING_LOGINS:
            oldest = min(self._logins, key=lambda i: self._logins[i].created)
            await self._drop_login(oldest)
        logs.event("login_started", phone=mask_phone(a["phone"]), codeDelivery=attempt.code_delivery)
        return {
            "loginId": login_id,
            "codeDelivery": attempt.code_delivery,
            "timeoutSeconds": int(self.config.login_ttl),
        }

    async def _login_step(self, login_id: str, stage: str, run: Callable[[Any], Awaitable]) -> dict:
        pending = await self._pending(login_id)
        async with pending.lock:  # one attempt at a time per loginId
            if self._logins.get(login_id) is not pending:
                raise WorkerError(LOGIN_NOT_FOUND, "Unknown or expired login. Start the login again.")
            if pending.stage != stage:
                raise BadRequest(
                    "send the code first" if stage == STAGE_PASSWORD
                    else "the code was accepted: send the two-step password"
                )
            try:
                outcome: LoginOutcome = await self._bounded(run(pending.handle))
            except WorkerError as err:
                if err.code == _RETRYABLE_ERROR[stage]:
                    pending.wrong_attempts += 1
                    if pending.wrong_attempts < limits.MAX_WRONG_LOGIN_ATTEMPTS:
                        raise  # a typo: the login stays so the person can type it again
                    await self._drop_login(login_id)
                    logs.event("login_too_many_wrong_attempts")
                    raise WorkerError(
                        err.code, f"{err.message} Too many wrong attempts: start the login again."
                    ) from None
                await self._drop_login(login_id)  # every other error ends the login
                raise
            except BaseException:
                await self._drop_login(login_id)
                raise
            if outcome.status == "password_required":
                pending.stage = STAGE_PASSWORD
                return {"status": "password_required"}
            await self._drop_login(login_id)  # deleted on success
            logs.event("login_authorized")
            return _authorized(outcome)

    async def login_code(self, a: dict) -> dict:
        return await self._login_step(
            a["login_id"], STAGE_CODE, lambda handle: self.backend.login_code(handle, a["code"])
        )

    async def login_password(self, a: dict) -> dict:
        return await self._login_step(
            a["login_id"], STAGE_PASSWORD, lambda handle: self.backend.login_password(handle, a["password"])
        )

    async def login_cancel(self, a: dict) -> dict:
        await self._pending(a["login_id"])
        await self._drop_login(a["login_id"])
        logs.event("login_cancelled")
        return {"cancelled": True}

    # ---- account ------------------------------------------------------------------------------------
    async def account_status(self, a: dict) -> dict:
        try:
            me = await self._bounded(self.backend.account_status(a["account"]))
        except WorkerError as err:
            if err.code != SESSION_INVALID:
                raise
            me = None  # a revoked session is "not authorized", not an error
        return {"authorized": True, "me": me.to_json()} if me is not None else {"authorized": False}

    async def account_logout(self, a: dict) -> dict:
        try:
            await self._bounded(self.backend.account_logout(a["account"]))
        except WorkerError as err:
            if err.code != SESSION_INVALID:
                raise  # an already-dead session is as logged out as it can be
        logs.event("account_logged_out")
        return {"loggedOut": True}

    # ---- communities -------------------------------------------------------------------------------
    async def communities_search(self, a: dict) -> dict:
        found = await self._bounded(self.backend.search_communities(a["account"], a["query"], a["limit"]))
        return {"results": [c.to_json() for c in found[: a["limit"]]], "limit": a["limit"]}

    async def communities_resolve(self, a: dict) -> dict:
        view = await self._bounded(self.backend.resolve_community(a["account"], parse_ref(a["ref"])))
        return {
            "community": view.community.to_json(),
            "relation": view.relation,
            "canPost": view.can_post.to_json() if view.can_post else None,
        }

    async def communities_permissions(self, a: dict) -> dict:
        view = await self._bounded(self.backend.resolve_community(a["account"], parse_ref(a["ref"])))
        return {"relation": view.relation, "canPost": view.can_post.to_json() if view.can_post else None}

    async def communities_refresh(self, a: dict) -> dict:
        account: Account = a["account"]
        spacer = limits.Spacer(self.config.refresh_spacing, self.config.clock, self.config.sleep)
        results: list[dict] = []
        stopped: WorkerError | None = None
        for raw in a["refs"]:
            entry: dict = {"ref": raw}
            if stopped is not None:
                results.append({**entry, "ok": False, "error": stopped.to_json()})
                continue
            try:
                ref = parse_ref(raw)  # a malformed ref costs no lookup
            except WorkerError as err:
                results.append({**entry, "ok": False, "error": err.to_json()})
                continue
            await spacer.wait()
            try:
                view = await self._bounded(self.backend.resolve_community(account, ref))
            except WorkerError as err:
                if err.code in _REFRESH_STOP_CODES:
                    stopped = err
                results.append({**entry, "ok": False, "error": err.to_json()})
                continue
            results.append(
                {**entry, "ok": True, "community": view.community.to_json(), "relation": view.relation}
            )
        return {"results": results}

    async def communities_messages(self, a: dict) -> dict:
        found = await self._bounded(
            self.backend.recent_messages(a["account"], parse_ref(a["ref"]), a["limit"])
        )
        return {"messages": [m.to_json() for m in found[: a["limit"]]], "limit": a["limit"]}

    async def communities_mine(self, a: dict) -> dict:
        views = await self._bounded(self.backend.list_my_communities(a["account"], a["limit"]))
        return {
            "communities": [
                {"community": v.community.to_json(), "relation": v.relation} for v in views[: a["limit"]]
            ],
            "limit": a["limit"],
        }

    async def communities_join(self, a: dict) -> dict:
        result = await self._bounded(self.backend.join_community(a["account"], parse_ref(a["ref"])))
        logs.event("community_join", status=result.status)
        return {"status": result.status, "community": result.community.to_json()}

    async def communities_leave(self, a: dict) -> dict:
        await self._bounded(self.backend.leave_community(a["account"], parse_ref(a["ref"])))
        return {"left": True}

    async def communities_create(self, a: dict) -> dict:
        created = await self._bounded(  # not idempotent: a timeout is an unknown outcome, like a send
            self.backend.create_community(a["account"], a["kind"], a["title"], a["about"], a["username"]),
            sending=True,
        )
        response: dict = {"community": created.community.to_json()}
        if created.invite_link:
            response["inviteLink"] = created.invite_link
        if created.warnings:
            response["warnings"] = list(created.warnings)
        return response

    async def communities_update(self, a: dict) -> dict:
        community = await self._bounded(
            self.backend.update_community(a["account"], parse_ref(a["ref"]), a["title"], a["about"])
        )
        return {"community": community.to_json()}

    async def communities_invite_link(self, a: dict) -> dict:
        link = await self._bounded(self.backend.export_invite_link(a["account"], parse_ref(a["ref"])))
        return {"link": link}

    async def communities_join_requests(self, a: dict) -> dict:
        found = await self._bounded(
            self.backend.list_join_requests(a["account"], parse_ref(a["ref"]), a["limit"])
        )
        return {"requests": [r.to_json() for r in found[: a["limit"]]], "limit": a["limit"]}

    async def communities_decide_join_request(self, a: dict) -> dict:
        await self._bounded(
            self.backend.decide_join_request(a["account"], parse_ref(a["ref"]), a["user_id"], a["approve"])
        )
        return {"decided": True}

    # ---- sending -----------------------------------------------------------------------------------
    async def messages_send(self, a: dict) -> dict:
        ref = parse_ref(a["ref"])
        plan = plan_send(a["ad"])
        result = await self._bounded(self.backend.send_ad(a["account"], ref, plan), sending=True)
        logs.event("message_sent", parts=len(result.message_ids), messageIds=list(result.message_ids))
        response: dict = {
            "messageIds": list(result.message_ids),
            "primaryMessageId": result.primary_message_id,
            "releaseUrl": result.release_url,
        }
        if result.warnings:
            response["warnings"] = list(result.warnings)
        return response


def _is_telethon(exc: BaseException) -> bool:
    return type(exc).__module__.startswith("telethon.")
