"""TelethonBackend against a stub client: which Telegram requests it makes, how failures surface,
and the guarantees around floods, retries, sends and idle clients. No network, no account."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from harness import FakeClock
from stub_telethon import FORBIDDEN_REQUESTS, StubWorld, channel, chat, full, rpc, user, valid_session_string
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl import types

import agencyos_telegram.telethon_backend as tb
from agencyos_telegram import ads
from agencyos_telegram.backend import Account, ApiCredentials
from agencyos_telegram.errors import BadRequest, WorkerError
from agencyos_telegram.refs import parse_ref
from agencyos_telegram.telethon_backend import TelethonBackend

SESSION = valid_session_string()
ACCOUNT = Account(1, "0123456789abcdef0123456789abcdef", SESSION)
NEWS = parse_ref("@agencyos_news")
CHAT = parse_ref("@agencyos_chat")
INVITE = parse_ref("https://t.me/+AbCdEfGhIjKlMnOp")
NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)


@pytest.fixture
def world():
    return StubWorld()


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def backend(world, clock):
    return TelethonBackend(client_factory=world.factory, clock=clock, idle_seconds=120)


def run(scenario):
    return asyncio.run(scenario)


def resolves(world, entity, *, full_chat=None):
    peer = types.PeerChannel(entity.id) if isinstance(entity, types.Channel) else types.PeerChat(entity.id)
    world.on("ResolveUsernameRequest", types.contacts.ResolvedPeer(peer=peer, chats=[entity], users=[user(5)]))
    if full_chat is not None:
        world.on("GetFullChannelRequest", full_chat)


def fails(code_awaitable):
    with pytest.raises(WorkerError) as caught:
        run(code_awaitable)
    return caught.value


# ---- construction -------------------------------------------------------------------------------------
def test_import_and_construction_never_connect():
    backend = TelethonBackend()
    assert backend.client_count() == 0 and backend.name == "telethon"
    assert backend.library_version


def test_client_is_configured_to_surface_everything():
    async def scenario():
        client = tb.new_client(1, "h" * 32, StringSession())
        assert isinstance(client, TelegramClient)
        assert client.flood_sleep_threshold == 0  # a FloodWait is raised, never slept through
        assert client._request_retries == 0  # nothing is repeated behind our back
        assert client._auto_reconnect is False and client._sender._auto_reconnect is False
        assert client._no_updates is True  # receive_updates=False
        assert client._raise_last_call_error is True
        assert not client.is_connected()

    run(scenario())


def test_only_login_clients_may_repeat_a_request_once_to_follow_a_dc_migration():
    async def scenario():
        login = tb.new_client(1, "h" * 32, StringSession(), for_login=True)
        assert login._request_retries == 1 and login.flood_sleep_threshold == 0

    run(scenario())


def test_login_uses_a_login_client_and_accounts_do_not(backend, world):
    async def scenario():
        await backend.login_start(ApiCredentials(1, "h" * 32), "+4915112345678")
        await backend.account_status(ACCOUNT)

    run(scenario())
    assert [c.for_login for c in world.clients] == [True, False]


# ---- requests made per operation --------------------------------------------------------------------------
def test_resolve_a_username_reads_one_channel_and_its_full_record(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full(about="Hi", slowmode_seconds=0))
    view = run(backend.resolve_community(ACCOUNT, NEWS))
    assert world.names() == ["ResolveUsernameRequest", "GetFullChannelRequest"]
    assert world.requests[0].username == "agencyos_news"
    assert view.relation == "OWNED" and view.community.description == "Hi" and view.community.member_count == 1234
    assert view.can_post.is_admin and view.can_post.post_messages_in_channel


def test_resolve_a_person_is_not_found_and_reads_nothing_about_them(backend, world):
    world.on("ResolveUsernameRequest", types.contacts.ResolvedPeer(peer=types.PeerUser(5), chats=[], users=[user(5, "someone")]))
    error = fails(backend.resolve_community(ACCOUNT, parse_ref("@someone")))
    assert error.code == "NOT_FOUND" and "someone" not in error.message
    assert world.names() == ["ResolveUsernameRequest"]


def test_resolve_a_public_channel_the_account_has_not_joined(backend, world):
    resolves(world, channel(1001, broadcast=True, left=True), full_chat=full())
    view = run(backend.resolve_community(ACCOUNT, NEWS))
    assert view.relation == "PUBLIC_NOT_JOINED" and view.can_post is None and view.community.title == "News"


def test_resolve_a_banned_community_skips_the_full_record(backend, world):
    resolves(world, channel(1001, megagroup=True, banned_rights=types.ChatBannedRights(until_date=None, view_messages=True)))
    view = run(backend.resolve_community(ACCOUNT, NEWS))
    assert view.relation == "RESTRICTED" and view.can_post is None
    assert world.names() == ["ResolveUsernameRequest"]


def test_resolve_a_basic_group_makes_no_full_chat_request(backend, world):
    world.on("CheckChatInviteRequest", types.ChatInviteAlready(chat=chat(creator=True)))
    view = run(backend.resolve_community(ACCOUNT, INVITE))
    assert view.relation == "OWNED" and view.community.kind == "GROUP"
    assert world.names() == ["CheckChatInviteRequest"]  # GetFullChat would return a participant list: never asked


def test_resolve_an_invite_link_shows_the_public_preview_only(backend, world):
    preview = types.ChatInvite(title="Private", photo=types.PhotoEmpty(id=0), participants_count=9, color=0, megagroup=True, participants=[user(1)])
    world.on("CheckChatInviteRequest", preview)
    view = run(backend.resolve_community(ACCOUNT, INVITE))
    assert view.relation == "PUBLIC_NOT_JOINED" and view.community.telegram_id is None and view.can_post is None
    assert world.names() == ["CheckChatInviteRequest"] and world.requests[0].hash == "AbCdEfGhIjKlMnOp"


def test_search_returns_communities_only(backend, world):
    found = types.contacts.Found(
        my_results=[], results=[types.PeerUser(5), types.PeerChannel(1001), types.PeerChat(2002)],
        chats=[channel(1001, broadcast=True, participants_count=50), chat(2002)], users=[user(5), user(6)],
    )
    world.on("SearchRequest", found)
    results = run(backend.search_communities(ACCOUNT, "agency", 50))
    assert [c.telegram_id for c in results] == ["1001", "2002"]
    request = world.requests[0]
    assert (request.q, request.limit) == ("agency", 50)
    assert world.count("SearchRequest") == 1  # never more than one call per request


def test_mine_lists_groups_and_channels_and_skips_people_and_bots(backend, world):
    bot = user(8, "helper_bot", bot=True)
    world.dialogs = [
        SimpleNamespace(entity=user(5)), SimpleNamespace(entity=bot),
        SimpleNamespace(entity=channel(1001, broadcast=True, creator=True)),
        SimpleNamespace(entity=channel(1002, megagroup=True)),
        SimpleNamespace(entity=chat(2002)),
        SimpleNamespace(entity=types.ChannelForbidden(id=1003, access_hash=1, title="Banned")),
        SimpleNamespace(entity=None),
    ]
    views = run(backend.list_my_communities(ACCOUNT, 200))
    assert [(v.community.telegram_id, v.relation) for v in views] == [
        ("1001", "OWNED"), ("1002", "MEMBER"), ("2002", "MEMBER"), ("1003", "RESTRICTED"),
    ]
    assert world.dialog_args == {"limit": 200, "ignore_migrated": True}
    assert world.requests == []  # iter_dialogs is the only call


def test_messages_come_from_public_communities_only(backend, world):
    resolves(world, channel(1001, broadcast=True))
    world.history = [
        SimpleNamespace(id=3, date=datetime(2026, 1, 3, tzinfo=timezone.utc), message="third", views=30, from_id=types.PeerUser(1)),
        SimpleNamespace(id=2, date=datetime(2026, 1, 2, tzinfo=timezone.utc), message="", views=20),
        SimpleNamespace(id=1, date=datetime(2026, 1, 1, tzinfo=timezone.utc), message="first", views=None),
    ]
    items = run(backend.recent_messages(ACCOUNT, NEWS, 20))
    assert [i.to_json() for i in items] == [
        {"id": "3", "date": "2026-01-03T00:00:00Z", "text": "third", "views": 30},
        {"id": "1", "date": "2026-01-01T00:00:00Z", "text": "first"},
    ]
    assert world.history_args["limit"] == 20

    private = fails(_messages_of_private(backend, world))
    assert private.code == "PRIVATE"


async def _messages_of_private(backend, world):
    world.on("CheckChatInviteRequest", types.ChatInviteAlready(chat=channel(1002, megagroup=True, username=None)))
    return await backend.recent_messages(ACCOUNT, INVITE, 20)


# ---- joining and leaving ----------------------------------------------------------------------------------------------
def test_join_a_public_channel(backend, world):
    entity = channel(1001, broadcast=True, left=True)
    resolves(world, entity)
    world.on("JoinChannelRequest", types.Updates(updates=[], users=[], chats=[channel(1001, broadcast=True, left=False, title="News!")], date=NOW, seq=0))
    result = run(backend.join_community(ACCOUNT, NEWS))
    assert result.status == "JOINED" and result.community.title == "News!"
    assert world.count("JoinChannelRequest") == 1


def test_join_that_needs_approval_is_a_pending_request(backend, world):
    resolves(world, channel(1001, megagroup=True, left=True, join_request=True))
    world.on("JoinChannelRequest", rpc("InviteRequestSentError"))
    assert run(backend.join_community(ACCOUNT, NEWS)).status == "JOIN_REQUEST_PENDING"


def test_already_a_participant_is_joined_without_asking_telegram(backend, world):
    resolves(world, channel(1001, megagroup=True))
    assert run(backend.join_community(ACCOUNT, NEWS)).status == "JOINED"
    assert world.count("JoinChannelRequest") == 0
    resolves(world, channel(1001, megagroup=True, left=True))
    world.on("JoinChannelRequest", rpc("UserAlreadyParticipantError"))
    assert run(backend.join_community(ACCOUNT, NEWS)).status == "JOINED"


def test_join_by_invite_link(backend, world):
    preview = types.ChatInvite(title="Private", photo=types.PhotoEmpty(id=0), participants_count=9, color=0, megagroup=True)
    world.on("CheckChatInviteRequest", preview)
    world.on("ImportChatInviteRequest", types.Updates(updates=[], users=[], chats=[channel(1002, megagroup=True, title="Private", username=None)], date=NOW, seq=0))
    result = run(backend.join_community(ACCOUNT, INVITE))
    assert result.status == "JOINED" and result.community.telegram_id == "1002"
    assert world.requests[1].hash == "AbCdEfGhIjKlMnOp"
    world.on("ImportChatInviteRequest", rpc("InviteRequestSentError"))
    pending = run(backend.join_community(ACCOUNT, INVITE))
    assert pending.status == "JOIN_REQUEST_PENDING" and pending.community.title == "Private"


def test_join_errors_are_reported_not_retried(backend, world):
    resolves(world, channel(1001, megagroup=True, left=True))
    world.on("JoinChannelRequest", rpc("UserBannedInChannelError"))
    assert fails(backend.join_community(ACCOUNT, NEWS)).code == "ACCOUNT_RESTRICTED"
    world.on("JoinChannelRequest", rpc("FloodWaitError", capture=77))
    flood = fails(backend.join_community(ACCOUNT, NEWS))
    assert (flood.code, flood.retry_after_seconds) == ("RATE_LIMITED", 77)
    assert world.count("JoinChannelRequest") == 2  # one per call, no hidden repeat
    world.on("JoinChannelRequest", rpc("ChannelsTooMuchError"))
    assert fails(backend.join_community(ACCOUNT, NEWS)).code == "FORBIDDEN"


def test_leave_a_channel_and_a_basic_group(backend, world):
    resolves(world, channel(1001, megagroup=True))
    world.on("LeaveChannelRequest", True)
    run(backend.leave_community(ACCOUNT, NEWS))
    assert world.names()[-1] == "LeaveChannelRequest"

    world.on("CheckChatInviteRequest", types.ChatInviteAlready(chat=chat(2002)))
    world.on("DeleteChatUserRequest", True)
    run(backend.leave_community(ACCOUNT, INVITE))
    request = world.requests[-1]
    assert isinstance(request.user_id, types.InputUserSelf) and request.chat_id == 2002  # only the account itself


def test_leaving_needs_a_community_the_account_can_see(backend, world):
    world.on("CheckChatInviteRequest", types.ChatInvite(title="x", photo=types.PhotoEmpty(id=0), participants_count=1, color=0))
    assert fails(backend.leave_community(ACCOUNT, INVITE)).code == "FORBIDDEN"


# ---- creating and editing --------------------------------------------------------------------------------------------------
def created(world, **flags):
    new = channel(5005, title="Mine", username=None, creator=True, **flags)
    world.on("CreateChannelRequest", types.Updates(updates=[], users=[], chats=[new], date=NOW, seq=0))
    world.on("UpdateUsernameRequest", True)
    world.on("ExportChatInviteRequest", types.ChatInviteExported(link="https://t.me/+NewInviteHash", admin_id=1, date=NOW))
    return new


def test_create_a_group_makes_a_supergroup_without_naming_anyone(backend, world):
    created(world, megagroup=True)
    result = run(backend.create_community(ACCOUNT, "group", "Mine", "About", None))
    request = world.requests[0]
    assert (request.title, request.about, request.megagroup, request.broadcast) == ("Mine", "About", True, None)
    assert world.names() == ["CreateChannelRequest", "ExportChatInviteRequest"]
    assert result.community.kind == "SUPERGROUP" and result.invite_link == "https://t.me/+NewInviteHash" and result.warnings == ()


def test_create_a_channel_with_a_username(backend, world):
    created(world, broadcast=True)
    result = run(backend.create_community(ACCOUNT, "channel", "Mine", None, "my_channel"))
    request = world.requests[0]
    assert (request.broadcast, request.megagroup, request.about) == (True, None, "")
    assert world.names() == ["CreateChannelRequest", "UpdateUsernameRequest", "ExportChatInviteRequest"]
    assert world.requests[1].username == "my_channel"
    assert result.community.username == "my_channel" and result.community.link == "https://t.me/my_channel"


def test_create_survives_a_failed_username_and_says_so(backend, world):
    created(world, broadcast=True)
    world.on("UpdateUsernameRequest", rpc("UsernameOccupiedError"))
    result = run(backend.create_community(ACCOUNT, "channel", "Mine", None, "taken_name"))
    assert result.community.username is None and result.community.telegram_id == "5005"
    assert len(result.warnings) == 1 and result.warnings[0].startswith("USERNAME_NOT_SET:")


def test_create_survives_a_failed_invite_link(backend, world):
    created(world, megagroup=True)
    world.on("ExportChatInviteRequest", rpc("FloodWaitError", capture=10))
    result = run(backend.create_community(ACCOUNT, "group", "Mine", None, None))
    assert result.invite_link is None and result.warnings[0].startswith("INVITE_LINK_NOT_CREATED:")


def test_an_interrupted_create_is_outcome_unknown_because_it_may_have_happened(backend, world):
    world.on("CreateChannelRequest", ConnectionResetError())
    error = fails(backend.create_community(ACCOUNT, "group", "Mine", None, None))
    assert error.code == "OUTCOME_UNKNOWN"
    assert world.count("CreateChannelRequest") == 1  # not repeated


def test_a_failure_after_creating_is_not_an_unknown_outcome(backend, world):
    created(world, megagroup=True)
    world.on("UpdateUsernameRequest", ConnectionResetError())
    world.on("ExportChatInviteRequest", ConnectionResetError())
    result = run(backend.create_community(ACCOUNT, "group", "Mine", None, "my_group"))
    assert result.community.telegram_id == "5005" and len(result.warnings) == 2


def test_create_flood_wait_is_returned(backend, world):
    world.on("CreateChannelRequest", rpc("FloodWaitError", capture=600))
    error = fails(backend.create_community(ACCOUNT, "group", "Mine", None, None))
    assert (error.code, error.retry_after_seconds) == ("RATE_LIMITED", 600)
    assert world.count("CreateChannelRequest") == 1


def test_update_title_and_about(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full(about="Fresh about"))
    world.on("EditTitleRequest", rpc("ChatNotModifiedError"))  # unchanged title is fine
    world.on("EditChatAboutRequest", True)
    community = run(backend.update_community(ACCOUNT, NEWS, "New title", "Fresh about"))
    assert community.title == "New title" and community.description == "Fresh about"
    assert world.names() == ["ResolveUsernameRequest", "EditTitleRequest", "EditChatAboutRequest", "GetFullChannelRequest"]
    assert world.requests[2].about == "Fresh about"


def test_update_requires_administrator_rights_from_telegram(backend, world):
    resolves(world, channel(1001, broadcast=True))
    world.on("EditTitleRequest", rpc("ChatAdminRequiredError"))
    assert fails(backend.update_community(ACCOUNT, NEWS, "x", None)).code == "FORBIDDEN"


def test_invite_link_prefers_the_existing_primary_link(backend, world):
    existing = types.ChatInviteExported(link="https://t.me/+Existing", admin_id=1, date=NOW)
    resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full(exported_invite=existing))
    assert run(backend.export_invite_link(ACCOUNT, NEWS)) == "https://t.me/+Existing"
    assert world.count("ExportChatInviteRequest") == 0  # nothing new is created, nothing revoked


def test_invite_link_exports_when_there_is_none(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full(exported_invite=None))
    world.on("ExportChatInviteRequest", types.ChatInviteExported(link="https://t.me/+Fresh", admin_id=1, date=NOW))
    assert run(backend.export_invite_link(ACCOUNT, NEWS)) == "https://t.me/+Fresh"
    assert world.requests[-1].legacy_revoke_permanent is None  # never revokes the previous link


# ---- join requests -----------------------------------------------------------------------------------------------------------------
def importers(*pairs):
    items = [types.ChatInviteImporter(user_id=uid, date=NOW, requested=True, about=bio) for uid, bio in pairs]
    return types.messages.ChatInviteImporters(count=len(items), importers=items, users=[user(uid, f"user{uid}") for uid, _ in pairs])


def test_join_requests_ask_for_pending_requests_only(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    world.on("GetChatInviteImportersRequest", importers((9001, "bio one"), (9002, None)))
    items = run(backend.list_join_requests(ACCOUNT, NEWS, 50))
    request = world.requests[-1]
    assert request.requested is True and request.limit == 50 and request.link is None
    assert [i.to_json() for i in items] == [
        {"userId": "9001", "date": "2026-06-01T00:00:00Z", "username": "user9001", "bio": "bio one"},
        {"userId": "9002", "date": "2026-06-01T00:00:00Z", "username": "user9002"},
    ]


def test_join_requests_for_a_non_admin_are_forbidden(backend, world):
    resolves(world, channel(1001, broadcast=True))
    world.on("GetChatInviteImportersRequest", rpc("ChatAdminRequiredError"))
    assert fails(backend.list_join_requests(ACCOUNT, NEWS, 10)).code == "FORBIDDEN"


def test_deciding_a_request_finds_the_requester_then_decides(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    world.on("GetChatInviteImportersRequest", importers((9001, None), (9002, None)))
    world.on("HideChatJoinRequestRequest", True)
    run(backend.decide_join_request(ACCOUNT, NEWS, 9002, True))
    decision = world.requests[-1]
    assert isinstance(decision.user_id, types.InputUser)
    assert (decision.user_id.user_id, decision.user_id.access_hash, decision.approved) == (9002, 9002 * 3, True)
    run(backend.decide_join_request(ACCOUNT, NEWS, 9001, False))
    assert world.requests[-1].approved is False


def test_deciding_scans_a_bounded_number_of_pages(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    page = importers(*[(10000 + i, None) for i in range(100)])
    world.on("GetChatInviteImportersRequest", page)
    error = fails(backend.decide_join_request(ACCOUNT, NEWS, 424242, True))
    assert error.code == "NOT_FOUND"
    assert world.count("GetChatInviteImportersRequest") == tb.JOIN_REQUEST_SCAN_PAGES
    assert world.count("HideChatJoinRequestRequest") == 0
    second_page = world.requests[-2]
    assert second_page.offset_user.user_id == 10099  # paging continues after the last one seen


def test_a_short_page_ends_the_scan(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    world.on("GetChatInviteImportersRequest", importers((9001, None)))
    assert fails(backend.decide_join_request(ACCOUNT, NEWS, 5, True)).code == "NOT_FOUND"
    assert world.count("GetChatInviteImportersRequest") == 1


# ---- sending -------------------------------------------------------------------------------------------------------------------------------
def plan_for(html="Hello", media=(), caption=True, button=None):
    items = tuple(ads.MediaItem(path, kind) for path, kind in media)
    return ads.SendPlan(
        items,
        html if (items and caption) else None,
        None if (items and caption) else html,
        button[0] if button else None,
        button[1] if button else None,
    )


@pytest.fixture
def files(tmp_path):
    """Real media files (the backend checks they still exist just before sending)."""

    def make(*names):
        paths = []
        for name in names:
            path = tmp_path / name
            path.write_bytes(b"\xff\xd8\xff" + b"0" * 64)
            paths.append(str(path))
        return paths

    return make


def test_text_only_send(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    result = run(backend.send_ad(ACCOUNT, NEWS, plan_for("Hi <b>there</b>")))
    kind, (peer, message), kwargs = world.sent[0]
    assert kind == "send_message" and message == "Hi <b>there</b>"
    assert kwargs["parse_mode"] == "html" and kwargs["buttons"] is None
    assert isinstance(peer, types.InputPeerChannel)
    assert result.message_ids == ("9001",) and result.release_url == "https://t.me/agencyos_news/9001"
    assert result.primary_message_id == "9001"


def test_media_with_a_caption_is_one_message(backend, world, files):
    resolves(world, channel(1001, broadcast=True, creator=True))
    (photo,) = files("a.jpg")
    result = run(backend.send_ad(ACCOUNT, NEWS, plan_for("Caption", media=[(photo, "photo")])))
    kind, (peer, file), kwargs = world.sent[0]
    assert kind == "send_file" and file == photo and kwargs["caption"] == "Caption"
    assert kwargs["parse_mode"] == "html" and kwargs["force_document"] is False and kwargs["supports_streaming"] is False
    assert len(world.sent) == 1 and len(result.message_ids) == 1


def test_long_text_follows_the_media_as_a_reply(backend, world, files):
    resolves(world, channel(1001, broadcast=True, creator=True))
    (photo,) = files("a.jpg")
    result = run(backend.send_ad(ACCOUNT, NEWS, plan_for("L" * 2000, media=[(photo, "photo")], caption=False)))
    assert [s[0] for s in world.sent] == ["send_file", "send_message"]
    assert world.sent[0][2]["caption"] == ""
    assert world.sent[1][2]["reply_to"] == 9001  # the media message
    assert result.message_ids == ("9001", "9002")
    assert result.release_url.endswith("/9001")


def test_album_with_streaming_video(backend, world, files):
    resolves(world, channel(1001, megagroup=True))
    a, b, c = files("a.jpg", "b.mp4", "c.jpg")
    media = [(a, "photo"), (b, "video"), (c, "photo")]
    result = run(backend.send_ad(ACCOUNT, CHAT, plan_for("Album", media=media)))
    kind, (peer, sent_files), kwargs = world.sent[0]
    assert sent_files == [a, b, c] and kwargs["supports_streaming"] is True
    assert result.message_ids == ("9001", "9002", "9003")


def test_url_button_rides_on_the_message_with_the_text(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    result = run(backend.send_ad(ACCOUNT, NEWS, plan_for("Hi", button=("Open", "https://example.com/x"))))
    buttons = world.sent[0][2]["buttons"]
    assert buttons.text == "Open" and buttons.type.url == "https://example.com/x"  # Button.url(...)
    assert result.warnings == ()

    world.drop_markup = True  # Telegram sends it without the button
    again = run(backend.send_ad(ACCOUNT, NEWS, plan_for("Hi", button=("Open", "https://example.com/x"))))
    assert again.warnings and again.warnings[0].startswith("BUTTON_NOT_DELIVERED")


def test_a_media_file_that_vanished_is_a_bad_request_not_an_unknown_outcome(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    with pytest.raises(BadRequest):
        run(backend.send_ad(ACCOUNT, NEWS, plan_for("Hi", media=[("/definitely/not/here.jpg", "photo")])))
    assert world.sent == []


def test_send_to_an_invite_preview_is_refused_before_anything_is_sent(backend, world):
    world.on("CheckChatInviteRequest", types.ChatInvite(title="x", photo=types.PhotoEmpty(id=0), participants_count=1, color=0))
    assert fails(backend.send_ad(ACCOUNT, INVITE, plan_for())).code == "FORBIDDEN"
    assert world.sent == []


def test_a_flood_wait_on_a_send_is_returned_and_not_repeated(backend, world):
    resolves(world, channel(1001, broadcast=True, creator=True))
    world.send_script = [rpc("FloodWaitError", capture=3600)]
    error = fails(backend.send_ad(ACCOUNT, NEWS, plan_for()))
    assert (error.code, error.retry_after_seconds) == ("RATE_LIMITED", 3600)
    assert len(world.sent) == 1


@pytest.mark.parametrize(
    "exc", [ConnectionResetError(), OSError("down"), asyncio.TimeoutError(), rpc("RpcCallFailError"), RuntimeError("late")],
    ids=lambda e: type(e).__name__,
)
def test_an_interrupted_send_is_outcome_unknown_and_not_repeated(backend, world, exc):
    resolves(world, channel(1001, broadcast=True, creator=True))
    world.send_script = [exc]
    error = fails(backend.send_ad(ACCOUNT, NEWS, plan_for()))
    assert error.code == "OUTCOME_UNKNOWN"
    assert len(world.sent) == 1  # exactly one attempt


def test_a_failure_after_part_of_the_ad_went_out_reports_the_ids(backend, world, files):
    resolves(world, channel(1001, broadcast=True, creator=True))
    world.send_script = [None, rpc("FloodWaitError", capture=90)]
    (photo,) = files("a.jpg")
    error = fails(backend.send_ad(ACCOUNT, NEWS, plan_for("L" * 2000, media=[(photo, "photo")], caption=False)))
    assert error.code == "OUTCOME_UNKNOWN" and error.retry_after_seconds is None
    assert "9001" in error.message and "wait 90 seconds" in error.message
    assert len(world.sent) == 2


def test_a_lookup_failure_before_sending_is_an_ordinary_network_error(backend, world):
    world.on("ResolveUsernameRequest", ConnectionResetError())
    assert fails(backend.send_ad(ACCOUNT, NEWS, plan_for())).code == "NETWORK"
    assert world.sent == []


def test_write_errors_mean_account_restricted_only_when_the_account_is_banned_there(backend, world):
    banned = types.ChatBannedRights(until_date=None, send_messages=True)
    resolves(world, channel(1001, megagroup=True, banned_rights=banned))
    world.send_script = [rpc("ChatWriteForbiddenError")]
    assert fails(backend.send_ad(ACCOUNT, NEWS, plan_for())).code == "ACCOUNT_RESTRICTED"
    resolves(world, channel(1001, megagroup=True))
    world.send_script = [rpc("ChatWriteForbiddenError")]
    assert fails(backend.send_ad(ACCOUNT, NEWS, plan_for())).code == "FORBIDDEN"
    world.send_script = [rpc("PeerFloodError")]
    assert fails(backend.send_ad(ACCOUNT, NEWS, plan_for())).code == "ACCOUNT_RESTRICTED"


# ---- clients: reuse, idle disconnect, dead sessions -------------------------------------------------------------------------------------------
def test_a_client_is_reused_and_disconnected_after_120_idle_seconds(backend, world, clock):
    async def scenario():
        resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full())
        await backend.resolve_community(ACCOUNT, NEWS)
        await backend.resolve_community(ACCOUNT, NEWS)
        assert world.connects == 1 and backend.client_count() == 1  # keyed by sha256(session), reused
        clock.advance(119)
        await backend.sweep_idle()
        assert world.disconnects == 0 and backend.client_count() == 1
        clock.advance(2)
        await backend.sweep_idle()
        assert world.disconnects == 1 and backend.client_count() == 0
        await backend.resolve_community(ACCOUNT, NEWS)
        assert world.connects == 2

    run(scenario())


def test_a_dropped_connection_is_reconnected_explicitly_before_the_next_request(backend, world):
    async def scenario():
        resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full())
        await backend.resolve_community(ACCOUNT, NEWS)
        world.clients[0].connected = False  # the link dropped while idle
        await backend.resolve_community(ACCOUNT, NEWS)
        assert world.connects == 2 and len(world.clients) == 1  # same client, reconnected

    run(scenario())


def test_two_accounts_get_two_clients(backend, world):
    async def scenario():
        resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full())
        other = Account(2, "f" * 32, valid_session_string())
        await backend.resolve_community(ACCOUNT, NEWS)
        await backend.resolve_community(other, NEWS)
        assert len(world.clients) == 2 and backend.client_count() == 2

    run(scenario())


def test_shutdown_disconnects_every_client(backend, world):
    async def scenario():
        resolves(world, channel(1001, broadcast=True, creator=True), full_chat=full())
        await backend.resolve_community(ACCOUNT, NEWS)
        await backend.resolve_community(Account(2, "f" * 32, valid_session_string()), NEWS)
        await backend.shutdown()
        assert world.disconnects == 2 and backend.client_count() == 0

    run(scenario())


def test_a_revoked_session_is_session_invalid_and_not_kept(backend, world):
    world.on("SearchRequest", rpc("AuthKeyUnregisteredError"))
    error = fails(backend.search_communities(ACCOUNT, "x", 5))
    assert error.code == "SESSION_INVALID"
    assert backend.client_count() == 0 and world.disconnects == 1


def test_a_malformed_session_never_creates_a_client(backend, world):
    error = fails(backend.search_communities(Account(1, "h" * 32, "not-a-session"), "x", 5))
    assert error.code == "SESSION_INVALID" and world.clients == []
    assert fails(backend.search_communities(Account(1, "h" * 32, "1AAAA"), "x", 5)).code == "SESSION_INVALID"


def test_connection_failures_are_network_errors(backend, world):
    world.connect_error = ConnectionRefusedError()
    assert fails(backend.search_communities(ACCOUNT, "x", 5)).code == "NETWORK"
    assert backend.client_count() == 0


def test_a_flood_wait_is_never_slept_through(backend, world, clock):
    world.on("SearchRequest", rpc("FloodWaitError", capture=86400))
    error = fails(backend.search_communities(ACCOUNT, "x", 5))
    assert (error.code, error.retry_after_seconds) == ("RATE_LIMITED", 86400)
    assert world.count("SearchRequest") == 1 and clock.sleeps == []


def test_account_status(backend, world):
    assert run(backend.account_status(ACCOUNT)).phone_masked == "+49•••••5678"
    world.me = None  # Telethon's get_me() returns None for a session that is not authorized
    assert run(backend.account_status(ACCOUNT)) is None


def test_logout_ends_the_session_and_drops_the_client(backend, world):
    async def scenario():
        await backend.account_status(ACCOUNT)
        await backend.account_logout(ACCOUNT)
        assert "log_out" in world.calls and backend.client_count() == 0

    run(scenario())


# ---- login ------------------------------------------------------------------------------------------------------------------------------------
CREDS = ApiCredentials(123456, "0123456789abcdef0123456789abcdef")


def test_login_with_code(backend, world):
    async def scenario():
        attempt = await backend.login_start(CREDS, "+4915112345678")
        assert attempt.code_delivery == "app" and world.sent[0] == ("send_code_request", ("+4915112345678",), {})
        outcome = await backend.login_code(attempt.handle, "12345")
        assert world.sent[1][2] == {"phone": "+4915112345678", "code": "12345", "password": None, "hash": "hash-123"}
        assert outcome.status == "authorized" and outcome.session  # a real StringSession string
        StringSession(outcome.session)  # parses
        assert outcome.me.phone_masked == "+49•••••5678"
        await backend.login_dispose(attempt.handle)
        assert world.disconnects == 1
        await backend.login_dispose(attempt.handle)  # idempotent
        await backend.login_dispose("not a handle")

    run(scenario())


def test_login_with_two_step_password(backend, world):
    async def scenario():
        world.sign_in_script = [rpc("SessionPasswordNeededError")]
        attempt = await backend.login_start(CREDS, "+4915112345678")
        assert (await backend.login_code(attempt.handle, "12345")).status == "password_required"
        outcome = await backend.login_password(attempt.handle, "hunter2")
        assert world.sent[-1][2]["password"] == "hunter2" and outcome.status == "authorized"

    run(scenario())


@pytest.mark.parametrize(
    ("name", "code"),
    [("PhoneCodeInvalidError", "CODE_INVALID"), ("PhoneCodeExpiredError", "CODE_EXPIRED"), ("FloodWaitError", "RATE_LIMITED")],
)
def test_login_code_errors(backend, world, name, code):
    async def scenario():
        world.sign_in_script = [rpc(name, **({"capture": 30} if name == "FloodWaitError" else {}))]
        attempt = await backend.login_start(CREDS, "+4915112345678")
        await backend.login_code(attempt.handle, "00000")

    assert fails(scenario()).code == code


def test_wrong_password_and_bad_phone(backend, world):
    async def wrong_password():
        world.sign_in_script = [rpc("SessionPasswordNeededError"), rpc("PasswordHashInvalidError")]
        attempt = await backend.login_start(CREDS, "+4915112345678")
        await backend.login_code(attempt.handle, "12345")
        await backend.login_password(attempt.handle, "nope")

    assert fails(wrong_password()).code == "PASSWORD_INVALID"

    async def bad_phone():
        world.connects = 0
        original = world.factory

        def raising_factory(*args, **kwargs):
            client = original(*args, **kwargs)

            async def send_code_request(phone):
                raise rpc("PhoneNumberInvalidError")

            client.send_code_request = send_code_request
            return client

        failing = TelethonBackend(client_factory=raising_factory)
        await failing.login_start(CREDS, "+1000")

    assert fails(bad_phone()).code == "PHONE_INVALID"
    assert world.clients[-1].connected is False  # the temporary client was disconnected


def test_login_code_delivery_kinds(backend, world):
    async def scenario():
        world.code_type = types.auth.SentCodeTypeSms(length=5)
        return (await backend.login_start(CREDS, "+4915112345678")).code_delivery

    assert run(scenario()) == "sms"


# ---- the guard: nothing that lists or adds people is ever requested -----------------------------------------------------------------------------
def test_the_stub_really_refuses_participant_and_invite_requests(world):
    client = world.factory(1, "h", StringSession())
    for name in sorted(FORBIDDEN_REQUESTS):
        request = type(name, (), {})()
        with pytest.raises(AssertionError):
            asyncio.run(client(request))
