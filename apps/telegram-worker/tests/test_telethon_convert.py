"""Pure conversions from Telethon entities: kind, relation, canPost, community fields, previews."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from stub_telethon import DATE, chat, full, channel, user
from telethon.tl import types

from agencyos_telegram import telethon_convert as conv
from agencyos_telegram.models import (
    ADMINISTERED, KIND_BROADCAST_CHANNEL, KIND_CHANNEL, KIND_GROUP, KIND_SUPERGROUP, MEMBER, OWNED,
    PUBLIC_NOT_JOINED, RESTRICTED, UNAVAILABLE, mask_phone,
)

NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)
PAST = NOW - timedelta(days=1)
FUTURE = NOW + timedelta(days=1)


def banned(**flags):
    return types.ChatBannedRights(until_date=flags.pop("until_date", None), **flags)


# ---- kind -------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("entity", "kind"),
    [
        (chat(), KIND_GROUP),
        (channel(megagroup=True), KIND_SUPERGROUP),
        (channel(megagroup=True, gigagroup=True), KIND_SUPERGROUP),
        (channel(broadcast=True), KIND_BROADCAST_CHANNEL),
        (channel(), KIND_CHANNEL),
        (types.ChatForbidden(id=1, title="t"), KIND_GROUP),
        (types.ChannelForbidden(id=1, access_hash=2, title="t", broadcast=True), KIND_BROADCAST_CHANNEL),
    ],
)
def test_kind(entity, kind):
    assert conv.kind_of(entity) == kind


# ---- relation --------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("entity", "relation"),
    [
        (channel(creator=True, broadcast=True), OWNED),
        (channel(broadcast=True, admin_rights=types.ChatAdminRights(post_messages=True)), ADMINISTERED),
        (channel(megagroup=True, left=False), MEMBER),
        (channel(megagroup=True), MEMBER),
        (channel(broadcast=True, left=True), PUBLIC_NOT_JOINED),
        (channel(broadcast=True, left=True, username=None), UNAVAILABLE),
        (channel(megagroup=True, banned_rights=banned(view_messages=True)), RESTRICTED),
        (channel(megagroup=True, banned_rights=banned(view_messages=True, until_date=FUTURE)), RESTRICTED),
        (channel(megagroup=True, banned_rights=banned(view_messages=True, until_date=PAST)), MEMBER),  # expired ban
        (channel(megagroup=True, banned_rights=banned(send_messages=True)), MEMBER),  # muted, still a member
        (
            channel(broadcast=True, restricted=True,
                    restriction_reason=[types.RestrictionReason(platform="all", reason="terms", text="x")]),
            RESTRICTED,
        ),
        (channel(broadcast=True, restricted=True), MEMBER),  # no stated reason: not treated as restricted
        (types.ChannelForbidden(id=1, access_hash=2, title="t"), RESTRICTED),
        (types.ChatForbidden(id=1, title="t"), RESTRICTED),
        (chat(), MEMBER),
        (chat(creator=True), OWNED),
        (chat(admin_rights=types.ChatAdminRights(delete_messages=True)), ADMINISTERED),
        (chat(deactivated=True), UNAVAILABLE),
        (chat(migrated_to=types.InputChannel(1, 2)), UNAVAILABLE),
        (chat(left=True), UNAVAILABLE),
        (user(), UNAVAILABLE),
    ],
)
def test_relation(entity, relation):
    assert conv.derive_relation(entity, NOW) == relation


# ---- canPost ----------------------------------------------------------------------------------------------
def can_post(entity, slow=None):
    result = conv.derive_can_post(entity, slow, NOW)
    return None if result is None else result.to_json()


def test_can_post_in_a_broadcast_channel():
    owner = can_post(channel(broadcast=True, creator=True), 5)
    assert owner == {"sendMessages": True, "sendMedia": True, "isAdmin": True, "postMessagesInChannel": True, "slowModeSeconds": 5}
    poster = can_post(channel(broadcast=True, admin_rights=types.ChatAdminRights(post_messages=True)))
    assert poster["postMessagesInChannel"] is True and poster["isAdmin"] is True
    editor = can_post(channel(broadcast=True, admin_rights=types.ChatAdminRights(edit_messages=True)))
    assert editor == {"sendMessages": False, "sendMedia": False, "isAdmin": True, "postMessagesInChannel": False, "slowModeSeconds": None}
    subscriber = can_post(channel(broadcast=True))
    assert subscriber == {"sendMessages": False, "sendMedia": False, "isAdmin": False, "postMessagesInChannel": False, "slowModeSeconds": None}


def test_can_post_in_a_group():
    member = can_post(channel(megagroup=True))
    assert member == {"sendMessages": True, "sendMedia": True, "isAdmin": False, "postMessagesInChannel": False, "slowModeSeconds": None}
    assert can_post(channel(megagroup=True), 30)["slowModeSeconds"] == 30
    assert can_post(channel(megagroup=True, default_banned_rights=banned(send_messages=True)))["sendMessages"] is False
    assert can_post(channel(megagroup=True, default_banned_rights=banned(send_plain=True)))["sendMessages"] is False
    no_media = can_post(channel(megagroup=True, default_banned_rights=banned(send_media=True)))
    assert no_media["sendMessages"] is True and no_media["sendMedia"] is False
    both = can_post(channel(megagroup=True, banned_rights=banned(send_photos=True, send_videos=True)))
    assert both["sendMedia"] is False
    only_photos = can_post(channel(megagroup=True, banned_rights=banned(send_photos=True)))
    assert only_photos["sendMedia"] is True
    admin = can_post(channel(megagroup=True, admin_rights=types.ChatAdminRights(), default_banned_rights=banned(send_messages=True)))
    assert admin["sendMessages"] is True and admin["isAdmin"] is True
    assert can_post(channel(megagroup=True, banned_rights=banned(send_messages=True, until_date=PAST)))["sendMessages"] is True
    assert can_post(chat())["sendMessages"] is True
    assert can_post(chat(creator=True))["isAdmin"] is True


@pytest.mark.parametrize(
    "entity",
    [channel(left=True), channel(banned_rights=banned(view_messages=True)), types.ChannelForbidden(id=1, access_hash=2, title="t"), chat(left=True)],
)
def test_no_can_post_when_not_a_participant(entity):
    assert can_post(entity) is None


# ---- community fields -------------------------------------------------------------------------------------------
def test_community_from_a_channel_with_the_full_record():
    entity = channel(
        broadcast=True, verified=True, scam=False, fake=True, join_request=True, has_link=True,
        participants_count=999,
        restriction_reason=[types.RestrictionReason(platform="ios", reason="porn", text="t")],
    )
    community = conv.entity_to_community(entity, full(about="Hello", participants_count=1234, slowmode_seconds=10, linked_chat_id=55).full_chat)
    assert community.to_json() == {
        "telegramId": "1001", "kind": "BROADCAST_CHANNEL", "title": "News", "username": "agencyos_news",
        "link": "https://t.me/agencyos_news", "description": "Hello", "memberCount": 1234, "verified": True,
        "scam": False, "fake": True, "joinRequestRequired": True, "slowModeSeconds": 10, "hasLinkedChat": True,
        "restrictionReasons": ["ios:porn"],
    }


def test_nothing_is_invented_when_telegram_did_not_say():
    community = conv.entity_to_community(channel(megagroup=True, username=None))
    json = community.to_json()
    assert json["description"] is None and json["memberCount"] is None and json["slowModeSeconds"] is None
    assert json["username"] is None and json["link"] is None
    assert json["verified"] is False and json["restrictionReasons"] == []
    assert json["hasLinkedChat"] is False  # the entity's own has_link flag says so


def test_member_count_falls_back_to_the_entity_and_usernames_list():
    entity = channel(username=None, participants_count=77, usernames=[types.Username("old", active=False), types.Username("collectible", active=True)])
    community = conv.entity_to_community(entity)
    assert community.member_count == 77 and community.username == "collectible"
    assert community.link == "https://t.me/collectible"


def test_basic_group_and_forbidden_communities():
    group = conv.entity_to_community(chat())
    assert group.kind == KIND_GROUP and group.member_count == 5 and group.username is None and group.description is None
    gone = conv.entity_to_community(types.ChannelForbidden(id=9, access_hash=1, title="Gone", megagroup=True))
    assert gone.telegram_id == "9" and gone.title == "Gone" and gone.kind == KIND_SUPERGROUP and gone.member_count is None


def test_invite_preview_has_no_id_and_ignores_the_people_it_shows():
    invite = types.ChatInvite(
        title="Private", photo=types.PhotoEmpty(id=0), participants_count=42, color=0, channel=True,
        megagroup=True, request_needed=True, about="Welcome", verified=True,
        participants=[user(1, "someone"), user(2, "someone_else")],
    )
    community = conv.invite_to_community(invite)
    assert community.to_json() == {
        "telegramId": None, "kind": "SUPERGROUP", "title": "Private", "username": None, "link": None,
        "description": "Welcome", "memberCount": 42, "verified": True, "scam": False, "fake": False,
        "joinRequestRequired": True, "slowModeSeconds": None, "hasLinkedChat": False, "restrictionReasons": [],
    }
    assert "someone" not in repr(community)
    kinds = {
        (True, False, False): KIND_BROADCAST_CHANNEL, (False, True, False): KIND_SUPERGROUP,
        (False, False, True): KIND_CHANNEL, (False, False, False): KIND_GROUP,
    }
    for (broadcast, megagroup, channel_flag), kind in kinds.items():
        preview = types.ChatInvite(
            title="t", photo=types.PhotoEmpty(id=0), participants_count=1, color=0,
            broadcast=broadcast or None, megagroup=megagroup or None, channel=channel_flag or None,
        )
        assert conv.invite_to_community(preview).kind == kind


# ---- the account, login, messages, join requests -----------------------------------------------------------------
def test_login_code_delivery():
    for sent_type, expected in [
        (types.auth.SentCodeTypeApp(length=5), "app"),
        (types.auth.SentCodeTypeSms(length=5), "sms"),
        (types.auth.SentCodeTypeCall(length=5), "call"),
        (types.auth.SentCodeTypeFlashCall(pattern="x"), "call"),
        (types.auth.SentCodeTypeMissedCall(prefix="+49", length=5), "call"),
        (types.auth.SentCodeTypeEmailCode(email_pattern="a***@x", length=5, reset_available_period=None, reset_pending_date=None, apple_signin_allowed=None, google_signin_allowed=None), "other"),
    ]:
        assert conv.code_delivery(sent_type) == expected


def test_me_masks_the_phone_and_never_returns_it():
    me = conv.me_from_user(user(premium=True))
    assert me.to_json() == {
        "id": "777", "username": "demo", "firstName": "Demo", "lastName": "User", "premium": True,
        "phoneMasked": "+49•••••5678",
    }
    assert "4915112345678" not in repr(me)
    assert conv.me_from_user(user(username=None, usernames=[types.Username("alt", active=True)])).username == "alt"
    no_phone = SimpleNamespace(id=1, username=None, first_name=None, last_name=None, phone=None)
    assert conv.me_from_user(no_phone).phone_masked is None


@pytest.mark.parametrize(
    ("phone", "masked"),
    [
        ("+4915112345678", "+49•••••5678"), ("4915112345678", "+49•••••5678"),
        ("+49 151 1234 5678", "+49•••••5678"), ("+15551234567", "+15•••••4567"),
        ("123456", "+•••••56"), ("12345", "+•••••"), ("", None), (None, None),
    ],
)
def test_phone_masking(phone, masked):
    assert mask_phone(phone) == masked


def test_public_message_has_no_sender_or_media():
    long = SimpleNamespace(id=5, date=DATE, message="x" * 3000, views=12, from_id=types.PeerUser(99), media=object())
    item = conv.message_from(long)
    assert item.to_json() == {"id": "5", "date": "2026-01-01T00:00:00Z", "text": "x" * 2000, "views": 12}
    assert conv.message_from(SimpleNamespace(id=6, date=DATE, message="", views=None)) is None  # media only
    assert conv.message_from(SimpleNamespace(id=7, date=DATE, action=object())) is None  # service message
    assert "views" not in conv.message_from(SimpleNamespace(id=8, date=DATE, message="hi", views=None)).to_json()


def test_join_request_entry():
    importer = SimpleNamespace(user_id=9001, date=DATE, about="I run a shop")
    entry = conv.join_request_from(importer, {9001: user(9001, "alice")})
    assert entry.to_json() == {"userId": "9001", "date": "2026-01-01T00:00:00Z", "username": "alice", "bio": "I run a shop"}
    bare = conv.join_request_from(SimpleNamespace(user_id=9002, date=DATE, about=None), {})
    assert bare.to_json() == {"userId": "9002", "date": "2026-01-01T00:00:00Z"}


def test_banned_for_account():
    assert conv.banned_for_account(channel(banned_rights=banned(send_messages=True)), NOW)
    assert conv.banned_for_account(channel(banned_rights=banned(view_messages=True)), NOW)
    assert not conv.banned_for_account(channel(banned_rights=banned(send_messages=True, until_date=PAST)), NOW)
    assert not conv.banned_for_account(channel(default_banned_rights=banned(send_messages=True)), NOW)  # group-wide rule, not a ban
    assert conv.banned_for_account(types.ChannelForbidden(id=1, access_hash=2, title="t"), NOW)
