"""Guard rails for the product owner's hard rules.

The worker has no operation that lists the people in a community, looks up other users, adds or
invites anyone, switches or rotates accounts, or works around a restriction. These tests fail the
build if the interface, the route table or the source ever grows one.

The forbidden words are assembled from fragments so that this file does not trip its own scan.
"""

import inspect
import re
from pathlib import Path

import pytest

from agencyos_telegram.backend import TelegramBackend
from agencyos_telegram.fake_backend import MemoryBackend
from agencyos_telegram.service import ROUTES
from agencyos_telegram.telethon_backend import TelethonBackend

PACKAGE = Path(__file__).resolve().parents[1] / "agencyos_telegram"
TESTS = Path(__file__).resolve().parent

# ---- forbidden in the *names* of routes and backend operations -----------------------------------------------
FORBIDDEN_NAME_PARTS = [
    "partici" + "pant", "add_" + "user", "add" + "user", "invite_" + "user", "invite" + "user",
    "add_" + "member", "invite_" + "member", "member_" + "list", "get_" + "members", "iter_" + "members",
    "scra" + "pe", "ro" + "tate", "switch_" + "account", "fail" + "over", "capt" + "cha", "by" + "pass",
    "bulk", "mass_", "broadcast_to", "contacts", "import_" + "contact", "phone_" + "of", "lookup_" + "user",
    "find_" + "user", "get_" + "user",
]
# ---- forbidden anywhere in the package source (Telethon API names) -------------------------------------------------
FORBIDDEN_SOURCE = [
    "iter_" + "participants", "get_" + "participants", "Get" + "Participants", "Get" + "Participant",
    "Add" + "ChatUser", "Invite" + "ToChannel", "Create" + "ChatRequest", "Import" + "Contacts",
    "Get" + "Contacts", "Get" + "FullUser", "Get" + "FullChat", "Get" + "CommonChats", "Edit" + "Banned",
    "Edit" + "Admin", "Edit" + "Creator", "Get" + "AdminedPublic", "get_" + "permissions", "iter_" + "admin_log",
    "Capt" + "cha", "capt" + "cha",
]


def public_methods(cls):
    return [name for name, member in inspect.getmembers(cls) if callable(member) and not name.startswith("_")]


def violations(names):
    return [(n, p) for n in names for p in FORBIDDEN_NAME_PARTS if p in n.lower()]


@pytest.mark.parametrize("cls", [TelegramBackend, MemoryBackend, TelethonBackend])
def test_no_backend_operation_is_named_like_a_people_operation(cls):
    assert violations(public_methods(cls)) == []


def test_no_route_is_named_like_a_people_operation():
    names = [path.replace("-", "_").replace("/", "_") for path in ROUTES] + [r.name for r in ROUTES.values()] + [r.handler for r in ROUTES.values()]
    assert violations(names) == []
    assert all(path.startswith("/v1/") for path in ROUTES)


def test_the_route_table_is_exactly_the_contracts_endpoints():
    assert set(ROUTES) == {
        "/v1/login/start", "/v1/login/code", "/v1/login/password", "/v1/login/cancel",
        "/v1/account/status", "/v1/account/logout",
        "/v1/communities/search", "/v1/communities/resolve", "/v1/communities/refresh",
        "/v1/communities/messages", "/v1/communities/mine", "/v1/communities/permissions",
        "/v1/communities/join", "/v1/communities/leave", "/v1/communities/create", "/v1/communities/update",
        "/v1/communities/invite-link", "/v1/communities/join-requests", "/v1/communities/join-requests/decide",
        "/v1/messages/send",
    }


def test_the_interface_cannot_name_more_than_one_person():
    """Every parameter of every operation: the account, one ref, one phone (the account's own), ..."""
    allowed = {
        "self", "account", "creds", "phone", "handle", "code", "password", "query", "limit", "ref", "kind",
        "title", "about", "username", "user_id", "approve", "plan",
    }
    for name in public_methods(TelegramBackend):
        for parameter in inspect.signature(getattr(TelegramBackend, name)).parameters:
            assert parameter in allowed, f"{name}({parameter}) is not an allowed parameter"
    # `user_id` is one requester of a community the account administers; `phone` is the account's own
    users = [n for n in public_methods(TelegramBackend) if "user_id" in inspect.signature(getattr(TelegramBackend, n)).parameters]
    assert users == ["decide_join_request"]
    phones = [n for n in public_methods(TelegramBackend) if "phone" in inspect.signature(getattr(TelegramBackend, n)).parameters]
    assert phones == ["login_start"]
    for name in public_methods(TelegramBackend):
        hints = inspect.signature(getattr(TelegramBackend, name)).parameters.values()
        assert not any("list[" in str(p.annotation) and p.name != "self" for p in hints), name


def test_the_package_source_never_mentions_a_forbidden_api():
    hits = []
    for path in sorted(PACKAGE.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_SOURCE:
            if token in text:
                hits.append((path.name, token))
    assert hits == []


def test_tests_and_fixtures_never_call_a_people_api():
    pattern = re.compile(r"\b(iter_" + "participants|get_" + "participants|add_" + "user|invite_" + "user)\\b|(Get" + "Participants|Invite" + "ToChannel|Add" + "ChatUser)\\w*\\(")
    skip = {"test_guard.py", "stub_telethon.py"}  # the guard itself and the stub's refusal list
    hits = []
    for path in sorted(TESTS.glob("*.py")):
        if path.name in skip:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if pattern.search(line):
                hits.append((path.name, number))
    assert hits == []


def test_no_account_switching_exists_in_the_service():
    """The service handles each request with the one account it names; it never holds a second one."""
    source = (PACKAGE / "service.py").read_text(encoding="utf-8").lower()
    for banned in ("fallback", "next_account", "other_account", "alternate", "round_robin", "least_used"):
        assert banned not in source
    # every operation of the backend takes one `account`, never a list of them
    for name in public_methods(TelegramBackend):
        parameters = inspect.signature(getattr(TelegramBackend, name)).parameters
        assert "accounts" not in parameters


def test_telethon_client_never_auto_retries_or_sleeps():
    source = (PACKAGE / "telethon_backend.py").read_text(encoding="utf-8")
    assert "flood_sleep_threshold=0" in source and "request_retries=0" in source
    assert "asyncio.sleep" not in source and "time.sleep" not in source
    for name in ("service.py", "telethon_backend.py", "telethon_convert.py", "server.py"):
        text = (PACKAGE / name).read_text(encoding="utf-8")
        # the only deliberate sleeps live in the injectable Spacer and the maintenance loop
        assert "time.sleep" not in text, name
