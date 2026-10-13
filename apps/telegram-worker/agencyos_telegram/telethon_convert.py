"""Telethon objects -> the worker's shapes. Pure functions: no connection, no I/O.

Everything here reads fields Telegram already put on a community entity (or on the account's own
user). Relation and canPost are derived from the flags the entity carries *for this account*
(creator, admin_rights, banned_rights, default_banned_rights, left); nothing here asks Telegram
who else is in a community.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from telethon.tl import types

from .limits import PUBLIC_MESSAGE_TEXT_MAX
from .models import (
    ADMINISTERED, KIND_BROADCAST_CHANNEL, KIND_CHANNEL, KIND_GROUP, KIND_SUPERGROUP, MEMBER, OWNED,
    JOINED_RELATIONS, PUBLIC_NOT_JOINED, RESTRICTED, UNAVAILABLE, CanPost, Community,
    JoinRequest, Me, PublicMessage, iso_utc, mask_phone,
)

COMMUNITY_ENTITIES = (types.Channel, types.Chat, types.ChannelForbidden, types.ChatForbidden)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def username_of(entity: Any) -> str | None:
    """The public username of a user or community, including collectible ones."""
    direct = getattr(entity, "username", None)
    if direct:
        return direct
    for item in getattr(entity, "usernames", None) or []:
        if getattr(item, "active", False) and getattr(item, "username", None):
            return item.username
    return None


def kind_of(entity: Any) -> str:
    if isinstance(entity, (types.Chat, types.ChatForbidden)):
        return KIND_GROUP
    if getattr(entity, "megagroup", False):
        return KIND_SUPERGROUP
    if getattr(entity, "broadcast", False):
        return KIND_BROADCAST_CHANNEL
    return KIND_CHANNEL


def restriction_reasons(entity: Any) -> tuple[str, ...]:
    """'<platform>:<reason>' for each restriction Telegram lists (e.g. 'all:terms')."""
    reasons = getattr(entity, "restriction_reason", None) or []
    return tuple(f"{r.platform}:{r.reason}" for r in reasons)


def entity_to_community(entity: Any, full: Any = None) -> Community:
    """A community from its entity; `full` is the ChannelFull from GetFullChannel when fetched."""
    username = username_of(entity)
    base = dict(
        telegram_id=str(entity.id),
        kind=kind_of(entity),
        title=getattr(entity, "title", "") or "",
        username=username,
        link=f"https://t.me/{username}" if username else None,
    )
    if isinstance(entity, (types.ChannelForbidden, types.ChatForbidden)):
        return Community(**base)
    if isinstance(entity, types.Chat):
        return Community(**base, member_count=entity.participants_count, has_linked_chat=False)

    count = getattr(full, "participants_count", None)
    linked = getattr(full, "linked_chat_id", None)
    return Community(
        **base,
        description=getattr(full, "about", None) or None,
        member_count=count if count is not None else getattr(entity, "participants_count", None),
        verified=bool(entity.verified),
        scam=bool(entity.scam),
        fake=bool(entity.fake),
        join_request_required=bool(entity.join_request),
        slow_mode_seconds=getattr(full, "slowmode_seconds", None),
        has_linked_chat=bool(entity.has_link) or linked is not None,
        restriction_reasons=restriction_reasons(entity),
    )


def invite_to_community(invite: types.ChatInvite) -> Community:
    """The public preview behind an invite link. It has no id and no username.

    The preview also carries a few member profiles (`invite.participants`); they are never read.
    """
    if invite.broadcast:
        kind = KIND_BROADCAST_CHANNEL
    elif invite.megagroup:
        kind = KIND_SUPERGROUP
    elif invite.channel:
        kind = KIND_CHANNEL
    else:
        kind = KIND_GROUP
    return Community(
        telegram_id=None,
        kind=kind,
        title=invite.title or "",
        description=invite.about or None,
        member_count=invite.participants_count,
        verified=bool(invite.verified),
        scam=bool(invite.scam),
        fake=bool(invite.fake),
        join_request_required=bool(invite.request_needed),
    )


# ---- rights ----------------------------------------------------------------------------------
def _rights_active(rights: Any, now: datetime) -> bool:
    if rights is None:
        return False
    until = getattr(rights, "until_date", None)
    if until is None:
        return True  # no end date: permanent
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until > now


def _blocked(entity: Any, now: datetime, *flags: str) -> set[str]:
    """Which of `flags` are denied by the account's own restrictions or the group defaults."""
    denied: set[str] = set()
    for rights in (getattr(entity, "banned_rights", None), getattr(entity, "default_banned_rights", None)):
        if _rights_active(rights, now):
            denied.update(f for f in flags if getattr(rights, f, False))
    return denied


def banned_for_account(entity: Any, now: datetime | None = None) -> bool:
    """True when this account itself is banned or barred from writing in the community."""
    now = now or _now()
    own = getattr(entity, "banned_rights", None)
    return bool(
        isinstance(entity, (types.ChannelForbidden, types.ChatForbidden))
        or (_rights_active(own, now) and (own.view_messages or own.send_messages or own.send_plain))
    )


def derive_relation(entity: Any, now: datetime | None = None) -> str:
    now = now or _now()
    if isinstance(entity, (types.ChannelForbidden, types.ChatForbidden)):
        return RESTRICTED
    if isinstance(entity, types.Chat):
        if entity.deactivated or entity.migrated_to is not None or entity.left:
            return UNAVAILABLE
        if entity.creator:
            return OWNED
        return ADMINISTERED if entity.admin_rights is not None else MEMBER
    if isinstance(entity, types.Channel):
        own = entity.banned_rights
        if _rights_active(own, now) and own.view_messages:
            return RESTRICTED
        if entity.restricted and entity.restriction_reason:
            return RESTRICTED
        if entity.left:
            return PUBLIC_NOT_JOINED if username_of(entity) else UNAVAILABLE
        if entity.creator:
            return OWNED
        return ADMINISTERED if entity.admin_rights is not None else MEMBER
    return UNAVAILABLE


def derive_can_post(entity: Any, slow_mode_seconds: int | None, now: datetime | None = None) -> CanPost | None:
    """What this account may do in a community it has joined; None otherwise."""
    now = now or _now()
    relation = derive_relation(entity, now)
    if relation not in JOINED_RELATIONS:
        return None
    creator = relation == OWNED
    admin_rights = getattr(entity, "admin_rights", None)
    is_admin = creator or admin_rights is not None
    if isinstance(entity, types.Channel) and entity.broadcast:
        posts = creator or bool(getattr(admin_rights, "post_messages", False))
        return CanPost(posts, posts, is_admin, posts, slow_mode_seconds)
    if is_admin:
        return CanPost(True, True, True, False, slow_mode_seconds)
    denied = _blocked(
        entity, now, "send_messages", "send_plain", "send_media", "send_photos", "send_videos"
    )
    send_messages = not ({"send_messages", "send_plain"} & denied)
    send_media = send_messages and "send_media" not in denied and not {"send_photos", "send_videos"} <= denied
    return CanPost(send_messages, send_media, False, False, slow_mode_seconds)


# ---- the account, login, messages, join requests -----------------------------------------------------
def me_from_user(user: Any) -> Me:
    return Me(
        id=str(user.id),
        username=username_of(user),
        first_name=getattr(user, "first_name", None) or None,
        last_name=getattr(user, "last_name", None) or None,
        premium=bool(getattr(user, "premium", False)),
        phone_masked=mask_phone(getattr(user, "phone", None)),
    )


def code_delivery(sent_type: Any) -> str:
    """Where Telegram sent the login code: app | sms | call | other."""
    name = type(sent_type).__name__
    if name == "SentCodeTypeApp":
        return "app"
    if name.startswith("SentCodeTypeSms") or name in ("SentCodeTypeFragmentSms", "SentCodeTypeFirebaseSms"):
        return "sms"
    if name in ("SentCodeTypeCall", "SentCodeTypeFlashCall", "SentCodeTypeMissedCall"):
        return "call"
    return "other"


def message_from(message: Any) -> PublicMessage | None:
    """Id, date, text (<= 2000 characters) and views. No sender, no media. Empty text is skipped."""
    text = getattr(message, "message", None)
    if not isinstance(text, str) or not text.strip():
        return None
    views = getattr(message, "views", None)
    return PublicMessage(
        id=str(message.id),
        date=iso_utc(getattr(message, "date", None)),
        text=text[:PUBLIC_MESSAGE_TEXT_MAX],
        views=views if isinstance(views, int) else None,
    )


def join_request_from(importer: Any, users_by_id: dict[int, Any]) -> JoinRequest:
    """One entry of an administrator's pending join requests: id, username, date and bio."""
    user = users_by_id.get(importer.user_id)
    return JoinRequest(
        user_id=str(importer.user_id),
        username=username_of(user) if user is not None else None,
        date=iso_utc(importer.date),
        bio=getattr(importer, "about", None) or None,
    )
