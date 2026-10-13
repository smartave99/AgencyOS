"""The real TelegramBackend: Telethon over MTProto, acting as the one account each request names.

Import-safe: importing this module (or constructing TelethonBackend) never connects. Every
operation leases a connected client from the pool, makes the Telegram requests it needs, and maps
any failure with errors.map_exception. Clients are configured so that Telethon itself never hides
anything from the caller:

    flood_sleep_threshold=0   a FloodWait is raised (-> RATE_LIMITED), never slept through
    request_retries=0         no request is repeated behind our back (a login client gets one
                              repeat, to follow a PHONE_MIGRATE to the right data center)
    auto_reconnect=False      a dropped connection fails the request (-> NETWORK, or
                              OUTCOME_UNKNOWN while sending); the next lease reconnects explicitly
    receive_updates=False     the worker is request/response only

There is no code path here that lists the people in a community, looks up other users, adds or
invites anyone, or tries another account. The only user-level data read is the account's own
profile and, for communities the account administers, the pending join requests Telegram shows an
administrator.
"""

from __future__ import annotations

import contextlib
import inspect
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

import telethon
from telethon import TelegramClient, errors as tl_errors, utils
from telethon.sessions import StringSession
from telethon.tl import functions, types
from telethon.tl.custom import Button

from . import __version__
from .ads import SendPlan, release_url
from .backend import (
    Account, ApiCredentials, CreateResult, JoinResult, LoginAttempt, LoginOutcome, SendResult,
    TelegramBackend,
)
from .errors import (
    FORBIDDEN, NOT_FOUND, OUTCOME_UNKNOWN, PRIVATE, SESSION_INVALID, UNSUPPORTED, BadRequest,
    WorkerError, map_exception,
)
from .limits import CLIENT_IDLE_SECONDS, ClientPool
from .models import (
    JOIN_REQUEST_PENDING, JOINED, JOINED_RELATIONS, PUBLIC_NOT_JOINED, RESTRICTED, Community,
    CommunityView, JoinRequest, Me, PublicMessage,
)
from .refs import Ref
from .telethon_convert import (
    COMMUNITY_ENTITIES, banned_for_account, code_delivery, derive_can_post, derive_relation,
    entity_to_community, invite_to_community, join_request_from, me_from_user, message_from,
    username_of,
)

CONNECTION_RETRIES = 2  # Telethon then makes up to three attempts to connect
CONNECT_TIMEOUT_SECONDS = 10
JOIN_REQUEST_PAGE = 100  # Telegram's maximum page size
JOIN_REQUEST_SCAN_PAGES = 3  # deciding a request looks at most this far down the pending list

ClientFactory = Callable[..., Any]  # (api_id, api_hash, session, *, for_login=False) -> client


def new_client(api_id: int, api_hash: str, session: StringSession, *, for_login: bool = False) -> TelegramClient:
    """A Telethon client that surfaces floods and drops instead of handling them.

    A login client may make one more attempt of a request: a phone number that lives on another
    data center is answered with PHONE_MIGRATE, and Telethon follows it by switching data center
    and repeating the request once. Nothing else is repeated, and logins never send messages.
    """
    return TelegramClient(
        session, api_id, api_hash,
        receive_updates=False,
        flood_sleep_threshold=0,
        request_retries=1 if for_login else 0,
        raise_last_call_error=True,
        auto_reconnect=False,
        connection_retries=CONNECTION_RETRIES,
        timeout=CONNECT_TIMEOUT_SECONDS,
        device_model="AgencyOS",
        app_version=__version__,
        lang_code="en",
        system_lang_code="en",
    )


async def _disconnect(client: Any) -> None:
    result = client.disconnect()
    if inspect.isawaitable(result):
        await result


async def _quiet_disconnect(client: Any) -> None:
    with contextlib.suppress(Exception):
        await _disconnect(client)


class _Target:
    """What a ref points at: a community entity (visible to the account) or an invite preview."""

    def __init__(self, entity: Any = None, invite: types.ChatInvite | None = None) -> None:
        self.entity = entity
        self.invite = invite


class _LoginState:
    def __init__(self, client: Any, phone: str, code_hash: str) -> None:
        self.client = client
        self.phone = phone
        self.code_hash = code_hash


def _require_entity(target: _Target) -> Any:
    if target.entity is None:
        raise WorkerError(FORBIDDEN, "Join the community first: this link only shows a public preview.")
    return target.entity


class TelethonBackend(TelegramBackend):
    name = "telethon"

    def __init__(
        self,
        *,
        client_factory: ClientFactory | None = None,
        clock: Callable[[], float] | None = None,
        idle_seconds: float = CLIENT_IDLE_SECONDS,
    ) -> None:
        self.library_version = telethon.__version__
        self._factory = client_factory or new_client
        pool_args: dict[str, Any] = {"idle_seconds": idle_seconds}
        if clock is not None:
            pool_args["clock"] = clock
        self._pool: ClientPool[Any] = ClientPool(_disconnect, **pool_args)

    # ---- connection plumbing -----------------------------------------------------------------
    async def _open(self, account: Account) -> Any:
        try:
            session = StringSession(account.session)
        except Exception:  # malformed string: it cannot be a live session
            raise WorkerError(SESSION_INVALID, "The session was revoked, expired or was never authorized.") from None
        client = self._factory(account.api_id, account.api_hash, session)
        try:
            await client.connect()
        except BaseException:
            await _quiet_disconnect(client)
            raise
        return client

    @asynccontextmanager
    async def _lease(self, account: Account) -> AsyncIterator[Any]:
        async with self._pool.lease(account.key, lambda: self._open(account)) as client:
            if not client.is_connected():
                await client.connect()
            yield client

    async def _run(
        self, account: Account, operation: Callable[[Any], Awaitable[Any]], hint: dict | None = None
    ) -> Any:
        """Run `operation(client)` as `account`; any failure becomes a WorkerError.

        `hint` lets the operation tell the error mapping what it knows: "sending" once a message
        may have left, "restricted" when the entity shows this account is barred from writing.
        """
        hint = hint if hint is not None else {}
        try:
            async with self._lease(account) as client:
                return await operation(client)
        except BadRequest:
            raise  # the caller's mistake, not a Telegram failure
        except Exception as exc:
            mapped = map_exception(exc, sending=hint.get("sending", False), restricted=hint.get("restricted", False))
            if mapped.code == SESSION_INVALID:
                await self._pool.discard(account.key)  # a dead session must not stay cached
            raise mapped from None

    async def _target(self, client: Any, ref: Ref) -> _Target:
        if ref.is_invite:
            preview = await client(functions.messages.CheckChatInviteRequest(ref.value))
            if isinstance(preview, (types.ChatInviteAlready, types.ChatInvitePeek)):
                return _Target(entity=preview.chat)
            return _Target(invite=preview)
        found = await client(functions.contacts.ResolveUsernameRequest(ref.value))
        peer = found.peer
        if isinstance(peer, types.PeerChannel):
            wanted = peer.channel_id
        elif isinstance(peer, types.PeerChat):
            wanted = peer.chat_id
        else:
            raise WorkerError(NOT_FOUND, "That name belongs to a person or a bot, not to a group or channel.")
        for chat in found.chats:  # (found.users is never read)
            if getattr(chat, "id", None) == wanted and isinstance(chat, COMMUNITY_ENTITIES):
                return _Target(entity=chat)
        raise WorkerError(NOT_FOUND, "That name does not belong to a group or channel.")

    async def _full(self, client: Any, entity: Any) -> Any:
        """GetFullChannel for channels and supergroups (about, slow mode, linked chat, count)."""
        if not isinstance(entity, types.Channel):
            return None
        result = await client(functions.channels.GetFullChannelRequest(utils.get_input_channel(entity)))
        return result.full_chat

    # ---- login ---------------------------------------------------------------------------------------
    async def login_start(self, creds: ApiCredentials, phone: str) -> LoginAttempt:
        client = self._factory(creds.api_id, creds.api_hash, StringSession(), for_login=True)
        try:
            await client.connect()
            sent = await client.send_code_request(phone)
        except Exception as exc:
            await _quiet_disconnect(client)
            raise map_exception(exc) from None
        return LoginAttempt(_LoginState(client, phone, sent.phone_code_hash), code_delivery(sent.type))

    async def login_code(self, handle: _LoginState, code: str) -> LoginOutcome:
        try:
            await handle.client.sign_in(phone=handle.phone, code=code, phone_code_hash=handle.code_hash)
        except tl_errors.SessionPasswordNeededError:
            return LoginOutcome("password_required")
        except Exception as exc:
            raise map_exception(exc) from None
        return await self._authorized(handle.client)

    async def login_password(self, handle: _LoginState, password: str) -> LoginOutcome:
        try:
            await handle.client.sign_in(password=password)
        except Exception as exc:
            raise map_exception(exc) from None
        return await self._authorized(handle.client)

    @staticmethod
    async def _authorized(client: Any) -> LoginOutcome:
        try:
            user = await client.get_me()
            return LoginOutcome("authorized", client.session.save(), me_from_user(user))
        except Exception as exc:
            raise map_exception(exc) from None

    async def login_dispose(self, handle: Any) -> None:
        if isinstance(handle, _LoginState):
            await _quiet_disconnect(handle.client)

    # ---- the account ---------------------------------------------------------------------------------
    async def account_status(self, account: Account) -> Me | None:
        async def operation(client: Any) -> Me | None:
            user = await client.get_me()  # None when the session is not authorized
            return me_from_user(user) if user is not None else None

        return await self._run(account, operation)

    async def account_logout(self, account: Account) -> None:
        async def operation(client: Any) -> None:
            await client.log_out()

        await self._run(account, operation)
        await self._pool.discard(account.key)

    # ---- communities -----------------------------------------------------------------------------------
    async def search_communities(self, account: Account, query: str, limit: int) -> list[Community]:
        async def operation(client: Any) -> list[Community]:
            found = await client(functions.contacts.SearchRequest(q=query, limit=limit))
            return [
                entity_to_community(chat) for chat in found.chats if isinstance(chat, (types.Channel, types.Chat))
            ][:limit]  # (found.users is never read)

        return await self._run(account, operation)

    async def resolve_community(self, account: Account, ref: Ref) -> CommunityView:
        async def operation(client: Any) -> CommunityView:
            target = await self._target(client, ref)
            if target.invite is not None:
                return CommunityView(invite_to_community(target.invite), PUBLIC_NOT_JOINED, None)
            entity = target.entity
            relation = derive_relation(entity)
            full = await self._full(client, entity) if relation != RESTRICTED else None
            slow_mode = getattr(full, "slowmode_seconds", None)
            can_post = derive_can_post(entity, slow_mode) if relation in JOINED_RELATIONS else None
            return CommunityView(entity_to_community(entity, full), relation, can_post)

        return await self._run(account, operation)

    async def list_my_communities(self, account: Account, limit: int) -> list[CommunityView]:
        async def operation(client: Any) -> list[CommunityView]:
            views: list[CommunityView] = []
            async for dialog in client.iter_dialogs(limit=limit, ignore_migrated=True):
                entity = dialog.entity
                if isinstance(entity, COMMUNITY_ENTITIES):  # people and bots are skipped
                    views.append(CommunityView(entity_to_community(entity), derive_relation(entity), None))
            return views

        return await self._run(account, operation)

    async def recent_messages(self, account: Account, ref: Ref, limit: int) -> list[PublicMessage]:
        async def operation(client: Any) -> list[PublicMessage]:
            target = await self._target(client, ref)
            entity = target.entity
            if entity is None or not username_of(entity):
                raise WorkerError(PRIVATE, "This community is private: there is nothing public to show.")
            found: list[PublicMessage] = []
            async for message in client.iter_messages(utils.get_input_peer(entity), limit=limit):
                item = message_from(message)
                if item is not None:
                    found.append(item)
            return found

        return await self._run(account, operation)

    async def join_community(self, account: Account, ref: Ref) -> JoinResult:
        async def operation(client: Any) -> JoinResult:
            target = await self._target(client, ref)
            if target.invite is not None:
                try:
                    updates = await client(functions.messages.ImportChatInviteRequest(ref.value))
                except tl_errors.InviteRequestSentError:
                    return JoinResult(JOIN_REQUEST_PENDING, invite_to_community(target.invite))
                except tl_errors.UserAlreadyParticipantError:
                    return JoinResult(JOINED, invite_to_community(target.invite))
                joined = next((c for c in updates.chats if isinstance(c, COMMUNITY_ENTITIES)), None)
                community = entity_to_community(joined) if joined is not None else invite_to_community(target.invite)
                return JoinResult(JOINED, community)

            entity = target.entity
            if derive_relation(entity) in JOINED_RELATIONS:
                return JoinResult(JOINED, entity_to_community(entity))  # nothing to do
            if not isinstance(entity, (types.Channel, types.ChannelForbidden)):
                raise WorkerError(UNSUPPORTED, "Only channels and supergroups can be joined by name.")
            try:
                updates = await client(functions.channels.JoinChannelRequest(utils.get_input_channel(entity)))
            except tl_errors.InviteRequestSentError:
                return JoinResult(JOIN_REQUEST_PENDING, entity_to_community(entity))
            except tl_errors.UserAlreadyParticipantError:
                return JoinResult(JOINED, entity_to_community(entity))
            joined = next((c for c in updates.chats if getattr(c, "id", None) == entity.id), entity)
            return JoinResult(JOINED, entity_to_community(joined))

        return await self._run(account, operation)

    async def leave_community(self, account: Account, ref: Ref) -> None:
        async def operation(client: Any) -> None:
            entity = _require_entity(await self._target(client, ref))
            if isinstance(entity, types.Channel):
                await client(functions.channels.LeaveChannelRequest(utils.get_input_channel(entity)))
            elif isinstance(entity, types.Chat):
                # Leaving: the only user ever named in this request is the account itself.
                await client(functions.messages.DeleteChatUserRequest(entity.id, types.InputUserSelf()))
            else:
                raise WorkerError(UNSUPPORTED, "The account cannot leave this kind of community.")

        await self._run(account, operation)

    async def create_community(
        self, account: Account, kind: str, title: str, about: str | None, username: str | None
    ) -> CreateResult:
        # "group" is a supergroup: a basic group cannot be created without naming other users,
        # and this worker never names or invites anyone.
        hint: dict = {}

        async def operation(client: Any) -> CreateResult:
            # Creating is not idempotent: an interrupted request may have created the community,
            # so it is reported like an interrupted send and must not be repeated blindly.
            hint["sending"] = True
            updates = await client(
                functions.channels.CreateChannelRequest(
                    title=title, about=about or "",
                    broadcast=True if kind == "channel" else None,
                    megagroup=True if kind == "group" else None,
                )
            )
            hint["sending"] = False
            chat = next((c for c in updates.chats if isinstance(c, types.Channel)), None)
            if chat is None:
                raise WorkerError(
                    OUTCOME_UNKNOWN, "Telegram did not return the new community: check the account's dialogs."
                )
            warnings: list[str] = []
            if username:
                try:
                    await client(functions.channels.UpdateUsernameRequest(utils.get_input_channel(chat), username))
                    chat.username = username
                except Exception as exc:
                    warnings.append(f"USERNAME_NOT_SET: {map_exception(exc).message}")
            invite_link = None
            try:
                exported = await client(functions.messages.ExportChatInviteRequest(utils.get_input_peer(chat)))
                invite_link = getattr(exported, "link", None)
            except Exception as exc:
                warnings.append(f"INVITE_LINK_NOT_CREATED: {map_exception(exc).message}")
            return CreateResult(entity_to_community(chat), invite_link, tuple(warnings))

        return await self._run(account, operation, hint)

    async def update_community(
        self, account: Account, ref: Ref, title: str | None, about: str | None
    ) -> Community:
        async def operation(client: Any) -> Community:
            entity = _require_entity(await self._target(client, ref))
            if not isinstance(entity, (types.Channel, types.Chat)):
                raise WorkerError(UNSUPPORTED, "This kind of community cannot be edited.")
            if title is not None:
                if isinstance(entity, types.Channel):
                    title_request: Any = functions.channels.EditTitleRequest(utils.get_input_channel(entity), title)
                else:
                    title_request = functions.messages.EditChatTitleRequest(entity.id, title)
                with contextlib.suppress(tl_errors.ChatNotModifiedError):
                    await client(title_request)
                entity.title = title
            if about is not None:
                with contextlib.suppress(tl_errors.ChatAboutNotModifiedError):
                    await client(functions.messages.EditChatAboutRequest(utils.get_input_peer(entity), about))
            full = await self._full(client, entity)
            return entity_to_community(entity, full)

        return await self._run(account, operation)

    async def export_invite_link(self, account: Account, ref: Ref) -> str:
        async def operation(client: Any) -> str:
            entity = _require_entity(await self._target(client, ref))
            full = await self._full(client, entity)
            existing = getattr(getattr(full, "exported_invite", None), "link", None)
            if isinstance(existing, str) and existing:
                return existing  # the community's current primary link: nothing is revoked or created
            exported = await client(functions.messages.ExportChatInviteRequest(utils.get_input_peer(entity)))
            link = getattr(exported, "link", None)
            if not isinstance(link, str) or not link:
                raise WorkerError(UNSUPPORTED, "Telegram returned no invite link for this community.")
            return link

        return await self._run(account, operation)

    async def list_join_requests(self, account: Account, ref: Ref, limit: int) -> list[JoinRequest]:
        async def operation(client: Any) -> list[JoinRequest]:
            entity = _require_entity(await self._target(client, ref))
            page = await client(
                functions.messages.GetChatInviteImportersRequest(
                    peer=utils.get_input_peer(entity), offset_date=None,
                    offset_user=types.InputUserEmpty(), limit=limit, requested=True,
                )
            )
            users = {user.id: user for user in page.users}
            return [join_request_from(importer, users) for importer in page.importers][:limit]

        return await self._run(account, operation)

    async def decide_join_request(self, account: Account, ref: Ref, user_id: int, approve: bool) -> None:
        async def operation(client: Any) -> None:
            entity = _require_entity(await self._target(client, ref))
            peer = utils.get_input_peer(entity)
            requester = await self._find_requester(client, peer, user_id)
            await client(
                functions.messages.HideChatJoinRequestRequest(
                    peer=peer, user_id=types.InputUser(requester.id, requester.access_hash), approved=approve
                )
            )

        await self._run(account, operation)

    @staticmethod
    async def _find_requester(client: Any, peer: Any, user_id: int) -> Any:
        """The pending requester's profile (Telegram needs its access hash to decide a request).

        Reads the administrator's own pending-requests list, newest first, a bounded number of
        pages; nothing else about anyone is fetched.
        """
        offset_date: Any = None
        offset_user: Any = types.InputUserEmpty()
        for _ in range(JOIN_REQUEST_SCAN_PAGES):
            page = await client(
                functions.messages.GetChatInviteImportersRequest(
                    peer=peer, offset_date=offset_date, offset_user=offset_user,
                    limit=JOIN_REQUEST_PAGE, requested=True,
                )
            )
            users = {user.id: user for user in page.users}
            for importer in page.importers:
                requester = users.get(importer.user_id)
                if importer.user_id == user_id and getattr(requester, "access_hash", None) is not None:
                    return requester
            if len(page.importers) < JOIN_REQUEST_PAGE:
                break
            last = page.importers[-1]
            last_user = users.get(last.user_id)
            offset_date = last.date
            if getattr(last_user, "access_hash", None) is None:
                break
            offset_user = types.InputUser(last_user.id, last_user.access_hash)
        raise WorkerError(NOT_FOUND, "There is no pending join request from that user.")

    # ---- sending ------------------------------------------------------------------------------------------
    async def send_ad(self, account: Account, ref: Ref, plan: SendPlan) -> SendResult:
        hint: dict = {}

        async def operation(client: Any) -> SendResult:
            target = await self._target(client, ref)
            if target.entity is None:
                raise WorkerError(FORBIDDEN, "Join the community first: this link only shows a public preview.")
            entity = target.entity
            peer = utils.get_input_peer(entity)
            hint["restricted"] = banned_for_account(entity)
            for item in plan.media:
                if not os.path.isfile(item.path):  # checked while nothing has been sent yet
                    raise BadRequest("ad.media[].path is no longer a file")
            button = Button.url(plan.button_text, plan.button_url) if plan.button_text and plan.button_url else None

            sent: list[Any] = []
            hint["sending"] = True  # from here on, an interrupted request may have been delivered
            try:
                if not plan.media:
                    sent.append(
                        await client.send_message(peer, plan.text_html, parse_mode="html", buttons=button)
                    )
                else:
                    paths = [item.path for item in plan.media]
                    media = await client.send_file(
                        peer, paths if len(paths) > 1 else paths[0],
                        caption=plan.caption_html or "", parse_mode="html", buttons=button,
                        force_document=False,
                        supports_streaming=any(item.kind == "video" for item in plan.media),
                    )
                    sent.extend(media if isinstance(media, list) else [media])
                    if plan.text_html is not None:
                        sent.append(
                            await client.send_message(
                                peer, plan.text_html, parse_mode="html", reply_to=sent[0].id, buttons=button
                            )
                        )
            except Exception as exc:
                if sent:
                    raise _partial_send(exc, [m.id for m in sent]) from None
                raise

            warnings: list[str] = []
            if button is not None and not any(getattr(m, "reply_markup", None) for m in sent):
                warnings.append("BUTTON_NOT_DELIVERED: Telegram sent the message without the button.")
            ids = tuple(str(m.id) for m in sent)
            return SendResult(ids, release_url(username_of(entity), ids[0]), tuple(warnings))

        return await self._run(account, operation, hint)

    # ---- housekeeping ------------------------------------------------------------------------------------------
    def client_count(self) -> int:
        return len(self._pool)

    async def sweep_idle(self) -> None:
        await self._pool.sweep()

    async def shutdown(self) -> None:
        await self._pool.close_all()


def _partial_send(exc: Exception, sent_ids: list[int]) -> WorkerError:
    """Part of an ad is already live: report it as an unknown outcome so nothing retries blindly."""
    detail = ""
    mapped = map_exception(exc)
    if mapped.retry_after_seconds:
        detail = f" Telegram also asked the account to wait {mapped.retry_after_seconds} seconds."
    return WorkerError(
        OUTCOME_UNKNOWN,
        "Part of the ad was already sent (message ids: "
        + ", ".join(str(i) for i in sent_ids)
        + ") and the rest did not go out. Check the community before sending again." + detail,
    )
