"""Shapes returned by the worker (contract "Shared shapes") and phone masking.

Only what Telegram exposes publicly about a community, plus the account's own profile and the
join-request entries an administrator is shown. Unknown fields are None, never invented.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

KIND_GROUP = "GROUP"
KIND_SUPERGROUP = "SUPERGROUP"
KIND_CHANNEL = "CHANNEL"
KIND_BROADCAST_CHANNEL = "BROADCAST_CHANNEL"

OWNED = "OWNED"
ADMINISTERED = "ADMINISTERED"
MEMBER = "MEMBER"
PUBLIC_NOT_JOINED = "PUBLIC_NOT_JOINED"
RESTRICTED = "RESTRICTED"
UNAVAILABLE = "UNAVAILABLE"

RELATIONS = (OWNED, ADMINISTERED, MEMBER, PUBLIC_NOT_JOINED, RESTRICTED, UNAVAILABLE)
KINDS = (KIND_GROUP, KIND_SUPERGROUP, KIND_CHANNEL, KIND_BROADCAST_CHANNEL)
# Relations in which the account has joined the community (and so has a canPost answer).
JOINED_RELATIONS = (OWNED, ADMINISTERED, MEMBER)

JOINED = "JOINED"
JOIN_REQUEST_PENDING = "JOIN_REQUEST_PENDING"

_BULLETS = "•" * 5


def mask_phone(phone: str | None) -> str | None:
    """'+4915112345678' -> '+49•••••5678'. Short numbers reveal less; None stays None."""
    if not phone:
        return None
    digits = re.sub(r"\D", "", str(phone))
    if len(digits) >= 9:
        return f"+{digits[:2]}{_BULLETS}{digits[-4:]}"
    if len(digits) >= 6:
        return f"+{_BULLETS}{digits[-2:]}"
    return f"+{_BULLETS}"


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Community:
    telegram_id: str | None
    kind: str
    title: str
    username: str | None = None
    link: str | None = None
    description: str | None = None
    member_count: int | None = None
    verified: bool = False
    scam: bool = False
    fake: bool = False
    join_request_required: bool = False
    slow_mode_seconds: int | None = None
    has_linked_chat: bool = False  # booleans are never null; False when Telegram shows no linked chat
    restriction_reasons: tuple[str, ...] = field(default_factory=tuple)

    def to_json(self) -> dict:
        return {
            "telegramId": self.telegram_id,
            "kind": self.kind,
            "title": self.title,
            "username": self.username,
            "link": self.link,
            "description": self.description,
            "memberCount": self.member_count,
            "verified": self.verified,
            "scam": self.scam,
            "fake": self.fake,
            "joinRequestRequired": self.join_request_required,
            "slowModeSeconds": self.slow_mode_seconds,
            "hasLinkedChat": self.has_linked_chat,
            "restrictionReasons": list(self.restriction_reasons),
        }


@dataclass(frozen=True)
class CanPost:
    send_messages: bool
    send_media: bool
    is_admin: bool
    post_messages_in_channel: bool
    slow_mode_seconds: int | None = None

    def to_json(self) -> dict:
        return {
            "sendMessages": self.send_messages,
            "sendMedia": self.send_media,
            "isAdmin": self.is_admin,
            "postMessagesInChannel": self.post_messages_in_channel,
            "slowModeSeconds": self.slow_mode_seconds,
        }


@dataclass(frozen=True)
class CommunityView:
    """A community as the account sees it: the public metadata, the relation and canPost."""

    community: Community
    relation: str
    can_post: CanPost | None = None


@dataclass(frozen=True)
class Me:
    id: str
    username: str | None
    first_name: str | None
    last_name: str | None
    premium: bool
    phone_masked: str | None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "username": self.username,
            "firstName": self.first_name,
            "lastName": self.last_name,
            "premium": self.premium,
            "phoneMasked": self.phone_masked,
        }


@dataclass(frozen=True)
class JoinRequest:
    user_id: str
    username: str | None
    date: str | None
    bio: str | None

    def to_json(self) -> dict:
        entry: dict = {"userId": self.user_id, "date": self.date}
        if self.username:
            entry["username"] = self.username
        if self.bio:
            entry["bio"] = self.bio
        return entry


@dataclass(frozen=True)
class PublicMessage:
    id: str
    date: str | None
    text: str
    views: int | None = None

    def to_json(self) -> dict:
        entry: dict = {"id": self.id, "date": self.date, "text": self.text}
        if self.views is not None:
            entry["views"] = self.views
        return entry
