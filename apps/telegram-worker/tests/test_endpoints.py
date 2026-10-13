"""Every account and community endpoint over the real HTTP server (in-memory backend):
the success shape, the contract's error mapping and the request bounds."""

import pytest
from harness import ACCOUNT, SESSION

from agencyos_telegram.errors import (
    ACCOUNT_RESTRICTED, FORBIDDEN, NETWORK, NOT_FOUND, PRIVATE, RATE_LIMITED, SESSION_INVALID,
    UNKNOWN, UNSUPPORTED, WorkerError,
)
from agencyos_telegram.models import JoinRequest, PublicMessage

NEWS = "@agencyos_news"
CHAT = "https://t.me/agencyos_chat"
OPEN = "agencyos_open"
INVITE = "https://t.me/+DemoInviteHash01"


def body(**extra):
    return {"account": ACCOUNT, **extra}


# ---- account --------------------------------------------------------------------------------------
def test_account_status_authorized(worker):
    response = worker.post("/v1/account/status", body())
    assert response.status == 200 and response.ok
    assert response.body["authorized"] is True
    assert response.body["me"] == {
        "id": "777", "username": "demo_operator", "firstName": "Demo", "lastName": "Operator",
        "premium": False, "phoneMasked": "+49•••••1234",
    }


def test_revoked_or_unknown_session_is_not_authorized_not_an_error(worker):
    unknown = worker.post("/v1/account/status", {"account": {**ACCOUNT, "session": "never-seen"}})
    assert unknown.ok and unknown.body == {"ok": True, "authorized": False}


def test_logout_ends_the_session(worker):
    assert worker.post("/v1/account/logout", body()).body == {"ok": True, "loggedOut": True}
    assert worker.post("/v1/account/status", body()).body == {"ok": True, "authorized": False}
    # logging out a dead session is as done as it can be
    assert worker.post("/v1/account/logout", body()).body == {"ok": True, "loggedOut": True}


# ---- search ---------------------------------------------------------------------------------------------
def test_search_returns_communities_and_echoes_the_limit(worker):
    response = worker.post("/v1/communities/search", body(query="agencyos", limit=2))
    assert response.ok and response.body["limit"] == 2
    assert len(response.body["results"]) == 2
    first = response.body["results"][0]
    assert set(first) == {
        "telegramId", "kind", "title", "username", "link", "description", "memberCount", "verified",
        "scam", "fake", "joinRequestRequired", "slowModeSeconds", "hasLinkedChat", "restrictionReasons",
    }


@pytest.mark.parametrize(
    ("sent", "applied"), [(999, 50), (51, 50), (50, 50), (1, 1), (0, 1), (-7, 1)]
)
def test_search_limit_is_clamped_never_refused(worker, sent, applied):
    response = worker.post("/v1/communities/search", body(query="agencyos", limit=sent))
    assert response.status == 200 and response.body["limit"] == applied


@pytest.mark.parametrize("limit", ["5", 2.5, True, [1], {"a": 1}])
def test_search_limit_must_be_an_integer(worker, limit):
    assert worker.post("/v1/communities/search", body(query="x", limit=limit)).status == 400


def test_search_needs_a_query(worker):
    assert worker.post("/v1/communities/search", body(query="   ")).status == 400
    assert worker.post("/v1/communities/search", body()).status == 400
    assert worker.post("/v1/communities/search", body(query="q" * 129)).status == 400


# ---- resolve / permissions ----------------------------------------------------------------------------
def test_resolve_owned_channel(worker):
    response = worker.post("/v1/communities/resolve", body(ref=NEWS))
    assert response.ok
    assert response.body["relation"] == "OWNED"
    assert response.body["community"]["kind"] == "BROADCAST_CHANNEL"
    assert response.body["community"]["link"] == "https://t.me/agencyos_news"
    assert response.body["canPost"] == {
        "sendMessages": True, "sendMedia": True, "isAdmin": True, "postMessagesInChannel": True,
        "slowModeSeconds": None,
    }


def test_resolve_member_group_and_public_not_joined(worker):
    member = worker.post("/v1/communities/resolve", body(ref=CHAT))
    assert member.body["relation"] == "MEMBER"
    assert member.body["canPost"]["sendMessages"] is True and member.body["canPost"]["isAdmin"] is False
    assert member.body["canPost"]["postMessagesInChannel"] is False

    outside = worker.post("/v1/communities/resolve", body(ref=OPEN))
    assert outside.body["relation"] == "PUBLIC_NOT_JOINED"
    assert outside.body["canPost"] is None
    assert outside.body["community"]["title"] == "AgencyOS Open"  # public metadata is still returned


def test_resolve_invite_link_shows_only_the_public_preview(worker):
    response = worker.post("/v1/communities/resolve", body(ref=INVITE))
    assert response.ok and response.body["relation"] == "PUBLIC_NOT_JOINED" and response.body["canPost"] is None
    assert response.body["community"]["telegramId"] is None  # a preview has no id: never invented


def test_resolve_restricted_relation(worker, backend):
    backend.communities["agencyos_chat"].banned.add(SESSION)
    response = worker.post("/v1/communities/resolve", body(ref=CHAT))
    assert response.body["relation"] == "RESTRICTED" and response.body["canPost"] is None


def test_permissions_is_relation_and_can_post_only(worker):
    response = worker.post("/v1/communities/permissions", body(ref=NEWS))
    assert response.ok and set(response.body) == {"ok", "relation", "canPost"}
    assert response.body["relation"] == "OWNED" and response.body["canPost"]["isAdmin"] is True


@pytest.mark.parametrize("path", ["/v1/communities/resolve", "/v1/communities/permissions"])
def test_ref_errors(worker, path):
    assert worker.post(path, body(ref="@nobody_here")).error["code"] == NOT_FOUND
    for bad in ("+4915112345678", "https://example.com/x", "hello world", "https://t.me/addstickers/Pack", "t.me/c/123/4"):
        response = worker.post(path, body(ref=bad))
        assert response.status == 200 and response.error["code"] == "INVALID_REF", bad
    assert worker.post(path, body(ref=5)).status == 400
    assert worker.post(path, body(ref="")).status == 400


# ---- refresh -------------------------------------------------------------------------------------------------
def test_refresh_returns_one_result_per_ref_in_order(worker):
    response = worker.post(
        "/v1/communities/refresh", body(refs=[NEWS, "@nobody_here", "not a ref", CHAT, INVITE])
    )
    assert response.ok
    results = response.body["results"]
    assert [r["ref"] for r in results] == [NEWS, "@nobody_here", "not a ref", CHAT, INVITE]
    assert [r["ok"] for r in results] == [True, False, False, True, True]
    assert results[0]["relation"] == "OWNED" and results[0]["community"]["username"] == "agencyos_news"
    assert results[1]["error"]["code"] == NOT_FOUND
    assert results[2]["error"]["code"] == "INVALID_REF"
    assert "canPost" not in results[0]


def test_refresh_spaces_lookups_by_at_least_one_second(worker, backend):
    worker.post("/v1/communities/refresh", body(refs=[NEWS, CHAT, OPEN, "agencyos_news"]))
    # three gaps between four lookups; the injected sleep recorded each wait instead of sleeping
    assert worker.clock.sleeps == [1.0, 1.0, 1.0]
    assert backend.calls.count("resolve_community") == 4


def test_refresh_without_lookups_does_not_wait(worker):
    worker.post("/v1/communities/refresh", body(refs=["bad one", "another bad"]))
    assert worker.clock.sleeps == []


def test_refresh_stops_early_on_a_flood_wait(worker, backend):
    backend.rate_limit_next("resolve_community", 37)
    response = worker.post("/v1/communities/refresh", body(refs=[NEWS, CHAT, OPEN, INVITE]))
    results = response.body["results"]
    assert response.ok and len(results) == 4
    for result in results:
        assert result["ok"] is False
        assert result["error"] == {
            "code": RATE_LIMITED, "message": "Telegram asked this account to wait.", "retryAfterSeconds": 37,
        }
    assert backend.calls.count("resolve_community") == 1  # nothing was asked after the flood wait


def test_refresh_keeps_going_after_an_ordinary_failure(worker, backend):
    backend.fail_next("resolve_community", WorkerError(NOT_FOUND, "Nothing matches that name or link."))
    results = worker.post("/v1/communities/refresh", body(refs=[NEWS, CHAT])).body["results"]
    assert [r["ok"] for r in results] == [False, True]


def test_refresh_stops_when_the_session_is_dead(worker, backend):
    results = worker.post(
        "/v1/communities/refresh", {"account": {**ACCOUNT, "session": "dead"}, "refs": [NEWS, CHAT]}
    ).body["results"]
    assert [r["error"]["code"] for r in results] == [SESSION_INVALID, SESSION_INVALID]
    assert backend.calls.count("resolve_community") == 1


def test_refresh_refuses_more_than_twenty_refs(worker, backend):
    assert worker.post("/v1/communities/refresh", body(refs=[NEWS] * 20)).ok
    too_many = worker.post("/v1/communities/refresh", body(refs=[NEWS] * 21))
    assert too_many.status == 400 and too_many.error["code"] == "BAD_REQUEST"
    assert "between 1 and 20" in too_many.error["message"]
    assert worker.post("/v1/communities/refresh", body(refs=[])).status == 400
    assert worker.post("/v1/communities/refresh", body(refs=[NEWS, 5])).status == 400
    assert worker.post("/v1/communities/refresh", body(refs="@a")).status == 400


# ---- messages ------------------------------------------------------------------------------------------------------
def test_messages_of_a_public_channel(worker, backend):
    backend.communities["agencyos_news"].messages = [
        PublicMessage(str(i), "2026-01-01T00:00:00Z", f"post {i}", i) for i in range(1, 31)
    ]
    response = worker.post("/v1/communities/messages", body(ref=NEWS, limit=500))
    assert response.ok and response.body["limit"] == 20  # clamped, echoed
    assert len(response.body["messages"]) == 20
    assert response.body["messages"][0] == {"id": "30", "date": "2026-01-01T00:00:00Z", "text": "post 30", "views": 30}
    assert set(response.body["messages"][0]) <= {"id", "date", "text", "views"}  # no sender, no media


def test_messages_text_is_truncated_to_2000_characters(worker, backend):
    backend.communities["agencyos_news"].messages = [PublicMessage("1", None, "x" * 5000)]
    message = worker.post("/v1/communities/messages", body(ref=NEWS)).body["messages"][0]
    assert len(message["text"]) == 2000


def test_messages_refuses_private_communities(worker):
    response = worker.post("/v1/communities/messages", body(ref=INVITE))
    assert response.status == 200 and response.error["code"] == PRIVATE


# ---- mine ------------------------------------------------------------------------------------------------------------------
def test_mine_lists_the_accounts_own_communities(worker):
    response = worker.post("/v1/communities/mine", body(limit=1000))
    assert response.ok and response.body["limit"] == 200
    mine = {c["community"]["username"]: c["relation"] for c in response.body["communities"]}
    assert mine == {"agencyos_news": "OWNED", "agencyos_chat": "MEMBER"}
    assert set(response.body["communities"][0]) == {"community", "relation"}


# ---- join / leave -----------------------------------------------------------------------------------------------------------
def test_join_public_and_again(worker):
    first = worker.post("/v1/communities/join", body(ref=OPEN))
    assert first.ok and first.body["status"] == "JOINED" and first.body["community"]["username"] == "agencyos_open"
    again = worker.post("/v1/communities/join", body(ref=OPEN))
    assert again.body["status"] == "JOINED"  # ALREADY_PARTICIPANT is reported as JOINED


def test_join_with_an_invite_that_needs_approval(worker, backend):
    response = worker.post("/v1/communities/join", body(ref=INVITE))
    assert response.ok and response.body["status"] == "JOIN_REQUEST_PENDING"
    assert len(backend.communities["DemoInviteHash01"].pending_requests) == 1


def test_join_by_a_restricted_account_is_reported_not_worked_around(worker, backend):
    backend.accounts[SESSION].restricted = True
    response = worker.post("/v1/communities/join", body(ref=OPEN))
    assert response.status == 200 and response.error["code"] == ACCOUNT_RESTRICTED
    assert backend.calls.count("join_community") == 1  # no second attempt, no other account


def test_leave(worker):
    assert worker.post("/v1/communities/leave", body(ref=CHAT)).body == {"ok": True, "left": True}
    assert worker.post("/v1/communities/leave", body(ref=CHAT)).error["code"] == FORBIDDEN
    assert worker.post("/v1/communities/leave", body(ref=NEWS)).error["code"] == FORBIDDEN  # the owner cannot leave


# ---- create / update / invite link -------------------------------------------------------------------------------------------
def test_create_group_and_channel(worker):
    group = worker.post("/v1/communities/create", body(kind="group", title="  My Group ", about="About it"))
    assert group.ok and group.body["community"]["title"] == "My Group"
    assert group.body["community"]["kind"] == "SUPERGROUP"
    assert group.body["inviteLink"].startswith("https://t.me/+")
    assert "warnings" not in group.body

    channel = worker.post("/v1/communities/create", body(kind="channel", title="Ads", username="@my_ads_channel"))
    assert channel.body["community"]["kind"] == "BROADCAST_CHANNEL"
    assert channel.body["community"]["username"] == "my_ads_channel"
    assert channel.body["community"]["link"] == "https://t.me/my_ads_channel"


def test_create_reports_a_username_that_could_not_be_set(worker):
    response = worker.post("/v1/communities/create", body(kind="channel", title="Ads", username="agencyos_news"))
    assert response.ok and response.body["community"]["username"] is None
    assert response.body["warnings"] and response.body["warnings"][0].startswith("USERNAME_NOT_SET")


@pytest.mark.parametrize(
    "bad",
    [
        {"kind": "supergroup", "title": "t"},
        {"kind": "group", "title": ""},
        {"kind": "group", "title": "t" * 129},
        {"kind": "group", "title": "t", "about": "a" * 256},
        {"kind": "group", "title": "t", "username": "no"},
        {"kind": "group", "title": "t", "username": "1starts_with_digit"},
        {"kind": "group"},
    ],
)
def test_create_validation(worker, bad):
    assert worker.post("/v1/communities/create", body(**bad)).status == 400


def test_update_title_and_about(worker):
    response = worker.post("/v1/communities/update", body(ref=NEWS, title="New title", about="New about"))
    assert response.ok
    assert response.body["community"]["title"] == "New title" and response.body["community"]["description"] == "New about"
    assert worker.post("/v1/communities/update", body(ref=NEWS, about="")).body["community"]["description"] is None


def test_update_is_for_administrators_and_needs_a_change(worker):
    assert worker.post("/v1/communities/update", body(ref=CHAT, title="Mine now")).error["code"] == FORBIDDEN
    assert worker.post("/v1/communities/update", body(ref=NEWS)).status == 400


def test_invite_link(worker):
    assert worker.post("/v1/communities/invite-link", body(ref=NEWS)).body["link"].startswith("https://t.me/+")
    assert worker.post("/v1/communities/invite-link", body(ref=CHAT)).error["code"] == FORBIDDEN


# ---- join requests ----------------------------------------------------------------------------------------------------------------
@pytest.fixture
def with_requests(backend):
    backend.communities["agencyos_news"].pending_requests = [
        JoinRequest("9001", "alice", "2026-01-01T10:00:00Z", "I run a shop"),
        JoinRequest("9002", None, "2026-01-02T10:00:00Z", None),
    ]
    return backend


def test_join_requests_for_an_administrator(worker, with_requests):
    response = worker.post("/v1/communities/join-requests", body(ref=NEWS, limit=1000))
    assert response.ok and response.body["limit"] == 50
    assert response.body["requests"] == [
        {"userId": "9001", "date": "2026-01-01T10:00:00Z", "username": "alice", "bio": "I run a shop"},
        {"userId": "9002", "date": "2026-01-02T10:00:00Z"},
    ]
    assert worker.post("/v1/communities/join-requests", body(ref=CHAT)).error["code"] == FORBIDDEN


def test_decide_a_join_request(worker, with_requests):
    approve = worker.post("/v1/communities/join-requests/decide", body(ref=NEWS, userId=9001, approve=True))
    assert approve.body == {"ok": True, "decided": True}
    deny = worker.post("/v1/communities/join-requests/decide", body(ref=NEWS, userId="9002", approve=False))
    assert deny.body == {"ok": True, "decided": True}
    gone = worker.post("/v1/communities/join-requests/decide", body(ref=NEWS, userId=9001, approve=True))
    assert gone.error["code"] == NOT_FOUND
    assert worker.post("/v1/communities/join-requests/decide", body(ref=CHAT, userId=9001, approve=True)).error["code"] == FORBIDDEN


@pytest.mark.parametrize(
    "bad",
    [{"userId": 0, "approve": True}, {"userId": -5, "approve": True}, {"userId": "abc", "approve": True},
     {"userId": 1.5, "approve": True}, {"userId": [1, 2], "approve": True}, {"userId": 1, "approve": "yes"},
     {"userId": 1}, {"approve": True}],
)
def test_decide_validation(worker, bad):
    assert worker.post("/v1/communities/join-requests/decide", body(ref=NEWS, **bad)).status == 400


# ---- error mapping at the HTTP boundary -----------------------------------------------------------------------------------------------
ACCOUNT_ROUTES = [
    ("/v1/communities/search", {"query": "a"}),
    ("/v1/communities/resolve", {"ref": NEWS}),
    ("/v1/communities/permissions", {"ref": NEWS}),
    ("/v1/communities/messages", {"ref": NEWS}),
    ("/v1/communities/mine", {}),
    ("/v1/communities/join", {"ref": OPEN}),
    ("/v1/communities/leave", {"ref": CHAT}),
    ("/v1/communities/create", {"kind": "group", "title": "t"}),
    ("/v1/communities/update", {"ref": NEWS, "title": "t"}),
    ("/v1/communities/invite-link", {"ref": NEWS}),
    ("/v1/communities/join-requests", {"ref": NEWS}),
    ("/v1/communities/join-requests/decide", {"ref": NEWS, "userId": 1, "approve": True}),
    ("/v1/messages/send", {"ref": NEWS, "ad": {"html": "hi"}}),
]


@pytest.mark.parametrize(("path", "extra"), ACCOUNT_ROUTES)
def test_a_revoked_session_is_session_invalid_everywhere(worker, path, extra):
    response = worker.post(path, {"account": {**ACCOUNT, "session": "revoked-one"}, **extra})
    assert response.status == 200 and response.body["ok"] is False
    assert response.error["code"] == SESSION_INVALID


@pytest.mark.parametrize(("path", "extra"), ACCOUNT_ROUTES)
@pytest.mark.parametrize(
    "error",
    [
        WorkerError(RATE_LIMITED, "Telegram asked this account to wait.", 90),
        WorkerError(NETWORK, "Connection problem. It is safe to retry."),
        WorkerError(ACCOUNT_RESTRICTED, "Telegram has limited this account."),
        WorkerError(FORBIDDEN, "nope"),
        WorkerError(UNSUPPORTED, "nope"),
        WorkerError(UNKNOWN, "odd"),
    ],
    ids=lambda e: e.code,
)
def test_backend_errors_reach_the_caller_with_their_code(worker, backend, path, extra, error):
    operation = {
        "/v1/communities/search": "search_communities", "/v1/communities/resolve": "resolve_community",
        "/v1/communities/permissions": "resolve_community", "/v1/communities/messages": "recent_messages",
        "/v1/communities/mine": "list_my_communities", "/v1/communities/join": "join_community",
        "/v1/communities/leave": "leave_community", "/v1/communities/create": "create_community",
        "/v1/communities/update": "update_community", "/v1/communities/invite-link": "export_invite_link",
        "/v1/communities/join-requests": "list_join_requests",
        "/v1/communities/join-requests/decide": "decide_join_request", "/v1/messages/send": "send_ad",
    }[path]
    backend.fail_next(operation, error)
    response = worker.post(path, body(**extra))
    assert response.status == 200 and response.body["ok"] is False
    assert response.error["code"] == error.code
    if error.code == RATE_LIMITED:
        assert response.error["retryAfterSeconds"] == 90  # always set
    else:
        assert "retryAfterSeconds" not in response.error


def test_an_unexpected_backend_exception_is_unknown_with_a_sanitized_message(worker, backend):
    async def boom(*args, **kwargs):
        raise RuntimeError("secret-looking detail 0123456789abcdef0123456789abcdef")

    backend.search_communities = boom
    response = worker.post("/v1/communities/search", body(query="x"))
    assert response.status == 200 and response.error["code"] == UNKNOWN
    assert response.error["message"] == "Unexpected error (RuntimeError)."
    assert "secret-looking" not in response.raw.decode()


# ---- the NestJS gateway (libraries/.../telegram.user.gateway.ts) speaks to this worker ---------------------------------
def test_requests_shaped_like_the_backend_gateway_are_accepted(worker, backend):
    """Bodies and headers exactly as TelegramUserGateway builds them (ids as strings, optional
    fields left out, a 16-hex correlation id, media as an empty array)."""
    backend.communities["agencyos_news"].pending_requests = [JoinRequest("9001", "alice", "2026-01-01T10:00:00Z", None)]
    headers = {"X-Correlation-Id": "0123456789abcdef"}
    news = "@agencyos_news"
    calls = [
        ("/v1/communities/search", {"account": ACCOUNT, "query": "agency", "limit": 20}),
        ("/v1/communities/resolve", {"account": ACCOUNT, "ref": news}),
        ("/v1/communities/refresh", {"account": ACCOUNT, "refs": [news, "@agencyos_chat"]}),
        ("/v1/communities/messages", {"account": ACCOUNT, "ref": news, "limit": 10}),
        ("/v1/communities/mine", {"account": ACCOUNT, "limit": 200}),
        ("/v1/communities/permissions", {"account": ACCOUNT, "ref": news}),
        ("/v1/communities/join", {"account": ACCOUNT, "ref": "@agencyos_open"}),
        ("/v1/communities/leave", {"account": ACCOUNT, "ref": "@agencyos_open"}),
        ("/v1/communities/create", {"account": ACCOUNT, "kind": "group", "title": "T"}),
        ("/v1/communities/create", {"account": ACCOUNT, "kind": "channel", "title": "T", "about": "a", "username": "my_new_chan"}),
        ("/v1/communities/update", {"account": ACCOUNT, "ref": news, "title": "T2"}),
        ("/v1/communities/update", {"account": ACCOUNT, "ref": news, "about": "A2"}),
        ("/v1/communities/invite-link", {"account": ACCOUNT, "ref": news}),
        ("/v1/communities/join-requests", {"account": ACCOUNT, "ref": news, "limit": 50}),
        ("/v1/communities/join-requests/decide", {"account": ACCOUNT, "ref": news, "userId": "9001", "approve": True}),
        ("/v1/messages/send", {"account": ACCOUNT, "ref": news, "ad": {"html": "<b>Hi</b>", "media": []}}),
        ("/v1/messages/send", {"account": ACCOUNT, "ref": news, "ad": {"html": "Hi", "media": [], "buttonText": "Go", "buttonUrl": "https://example.com"}}),
        ("/v1/account/status", {"account": ACCOUNT}),
        ("/v1/account/logout", {"account": ACCOUNT}),
    ]
    for path, body in calls:
        response = worker.post(path, body, headers=headers)
        assert response.status == 200 and response.ok, (path, response.body)
        assert response.headers["x-correlation-id"] == "0123456789abcdef"
