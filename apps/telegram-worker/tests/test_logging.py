"""No secret reaches a log. A full login + send flow runs through the real HTTP server while every
log record (our own and a noisy third-party logger) is captured, then each secret is searched for."""

import io
import json
import logging

import pytest
from harness import TOKEN, WorkerHarness, configure_test_logging
from stub_telethon import StubWorld, channel, full, rpc, valid_session_string
from telethon.tl import types

from agencyos_telegram import logs
from agencyos_telegram.fake_backend import LOGIN_CODE, TWO_STEP_PASSWORD, MemoryBackend
from agencyos_telegram.telethon_backend import TelethonBackend

API_ID = 777001
API_HASH = "d3adb33fd3adb33fd3adb33fd3adb33f"
PHONE = "+4915112345678"
PHONE_DIGITS = "4915112345678"
WRONG_CODE = "48291"
WRONG_PASSWORD = "wrong-Pässwörd-77\"\\"
BODY = "Confidential ad copy: ZXCV-qwerty-launch-secret"


@pytest.fixture
def captured():
    root = logging.getLogger()
    saved = (root.handlers[:], root.level, logging.getLogger("telethon").level)
    stream = io.StringIO()
    capture = configure_test_logging(stream)
    yield stream, capture
    root.handlers[:] = saved[0]
    root.setLevel(saved[1])
    logging.getLogger("telethon").setLevel(saved[2])


def assert_clean(stream, capture, secrets):
    written = stream.getvalue()
    seen = capture.text()
    assert written.strip(), "nothing was logged: the test would prove nothing"
    for secret in secrets:
        assert secret not in written, f"{secret!r} reached the log output"
        assert secret not in seen, f"{secret!r} reached a log record"
        escaped = json.dumps(secret)[1:-1]
        assert escaped not in written, f"{secret!r} (escaped) reached the log output"
    for line in written.strip().splitlines():
        json.loads(line)  # every line is one JSON object


def full_flow(harness, *, session_for_send):
    """login (wrong code, wrong password, then the right ones) -> status -> resolve -> send.

    The phone has two-step verification on, so every login ends in a password step.
    """
    api = {"apiId": API_ID, "apiHash": API_HASH}
    login_id = harness.post("/v1/login/start", {**api, "phone": PHONE}).body["loginId"]
    assert harness.post("/v1/login/code", {"loginId": login_id, "code": WRONG_CODE}).error["code"] == "CODE_INVALID"

    login_id = harness.post("/v1/login/start", {**api, "phone": PHONE}).body["loginId"]
    assert harness.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE}).body["status"] == "password_required"
    wrong = harness.post("/v1/login/password", {"loginId": login_id, "password": WRONG_PASSWORD})
    assert wrong.error["code"] == "PASSWORD_INVALID"

    login_id = harness.post("/v1/login/start", {**api, "phone": PHONE}).body["loginId"]
    harness.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE})
    done = harness.post("/v1/login/password", {"loginId": login_id, "password": TWO_STEP_PASSWORD})
    assert done.body["status"] == "authorized"
    new_session = done.body["session"]

    account = {**api, "session": new_session}
    assert harness.post("/v1/account/status", {"account": account}).body["authorized"] is True
    account = {**api, "session": session_for_send}
    assert harness.post("/v1/communities/resolve", {"account": account, "ref": "@agencyos_news"}).ok
    sent = harness.post("/v1/messages/send", {"account": account, "ref": "@agencyos_news", "ad": {"html": f"<b>{BODY}</b>"}})
    assert sent.ok, sent.body
    return new_session


def test_memory_backend_flow_logs_no_secret(captured, tmp_path):
    stream, capture = captured
    long_session = "1" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_" * 9
    backend = MemoryBackend.with_demo_data()
    backend.two_step_phones.add(PHONE)
    backend.add_account(long_session)
    backend.accounts[long_session].me = backend.accounts["memory-session-1"].me
    backend.communities["agencyos_news"].owner = "memory-session-1"
    backend.communities["agencyos_news"].admins.add(long_session)

    harness = WorkerHarness(backend).start()
    try:
        new_session = full_flow(harness, session_for_send=long_session)
    finally:
        harness.stop()

    assert_clean(
        stream, capture,
        [API_HASH, long_session, new_session, WRONG_CODE, LOGIN_CODE, WRONG_PASSWORD, TWO_STEP_PASSWORD, PHONE, PHONE_DIGITS, BODY, "ZXCV-qwerty"],
    )
    # what *is* logged: masked phone, request lines with codes and timings
    written = stream.getvalue()
    assert "login_started" in written and "+49\\u2022\\u2022\\u2022\\u2022\\u20225678" in written
    requests = [json.loads(line) for line in written.splitlines() if '"event":"request"' in line]
    assert any(r["path"] == "/v1/messages/send" and r["status"] == 200 and r["ok"] for r in requests)
    assert all({"method", "path", "status", "durationMs", "correlationId"} <= set(r) for r in requests)


def test_telethon_backend_flow_logs_no_secret(captured):
    """Same flow through TelethonBackend's own code paths (stub client, real-looking session strings)."""
    stream, capture = captured
    world = StubWorld()
    world.sign_in_script = [rpc("PhoneCodeInvalidError"), rpc("SessionPasswordNeededError"), rpc("PasswordHashInvalidError"), rpc("SessionPasswordNeededError")]
    entity = channel(1001, broadcast=True, creator=True)
    world.on("ResolveUsernameRequest", types.contacts.ResolvedPeer(peer=types.PeerChannel(1001), chats=[entity], users=[]))
    world.on("GetFullChannelRequest", full())
    backend = TelethonBackend(client_factory=world.factory)
    sending_session = valid_session_string()

    harness = WorkerHarness(backend).start()
    try:
        api = {"apiId": API_ID, "apiHash": API_HASH}
        login_id = harness.post("/v1/login/start", {**api, "phone": PHONE}).body["loginId"]
        assert harness.post("/v1/login/code", {"loginId": login_id, "code": WRONG_CODE}).error["code"] == "CODE_INVALID"
        login_id = harness.post("/v1/login/start", {**api, "phone": PHONE}).body["loginId"]
        assert harness.post("/v1/login/code", {"loginId": login_id, "code": "12345"}).body["status"] == "password_required"
        assert harness.post("/v1/login/password", {"loginId": login_id, "password": WRONG_PASSWORD}).error["code"] == "PASSWORD_INVALID"
        login_id = harness.post("/v1/login/start", {**api, "phone": PHONE}).body["loginId"]
        harness.post("/v1/login/code", {"loginId": login_id, "code": "12345"})
        done = harness.post("/v1/login/password", {"loginId": login_id, "password": "hunter2-demo"})
        assert done.ok and done.body["status"] == "authorized"
        new_session = done.body["session"]
        assert len(new_session) > 300  # a real-looking StringSession

        sent = harness.post(
            "/v1/messages/send",
            {"account": {**api, "session": sending_session}, "ref": "@agencyos_news", "ad": {"html": f"<b>{BODY}</b>"}},
        )
        assert sent.ok, sent.body
        failed = harness.post("/v1/communities/search", {"account": {**api, "session": sending_session}, "query": "x"})
        assert failed.status == 200
    finally:
        harness.stop()

    assert_clean(stream, capture, [API_HASH, sending_session, new_session, WRONG_CODE, "12345", WRONG_PASSWORD, "hunter2-demo", PHONE, PHONE_DIGITS, BODY, "ZXCV-qwerty"])


def test_third_party_logging_with_a_secret_inside_is_scrubbed(captured):
    """A library that logs a session/phone/hash mid-request must not get it past the scrubber."""
    stream, capture = captured
    session = "1" + "Zz9" * 120
    backend = MemoryBackend.with_demo_data()
    backend.add_account(session)

    async def chatty(account, query, limit):
        noisy = logging.getLogger("telethon.network.mtprotosender")
        noisy.warning("connected with auth for %s via %s using %s", account.session, PHONE, account.api_hash)
        noisy.error("raw: %s | %r", PHONE_DIGITS, session)
        raise RuntimeError(f"failed for {account.session} {account.api_hash} {PHONE}")

    backend.search_communities = chatty
    harness = WorkerHarness(backend).start()
    try:
        response = harness.post(
            "/v1/communities/search",
            {"account": {"apiId": 1, "apiHash": API_HASH, "session": session}, "query": "x"},
        )
    finally:
        harness.stop()
    assert response.error["code"] == "UNKNOWN" and session not in response.raw.decode()
    # the phone arrives in a request the secret registry has not seen, so only the pattern catches '+digits'
    assert_clean(stream, capture, [API_HASH, session, PHONE])
    assert "unexpected_exception" in stream.getvalue() and "RuntimeError" in stream.getvalue()
    assert "telethon.network.mtprotosender" in stream.getvalue()  # the third-party record was logged, scrubbed


def test_the_worker_token_is_never_logged(captured):
    stream, capture = captured
    harness = WorkerHarness(MemoryBackend.with_demo_data()).start()
    try:
        harness.request("GET", "/health", token=None)
        harness.post("/v1/account/status", {"account": {"apiId": 1, "apiHash": API_HASH, "session": "memory-session-1"}})
        harness.post("/v1/account/status", {"account": {"apiId": 1, "apiHash": API_HASH, "session": "memory-session-1"}}, token="wrong-token-attempt")
    finally:
        harness.stop()
    written = stream.getvalue()
    assert TOKEN not in written and "wrong-token-attempt" not in written
    assert "auth_failed" in written


def test_no_files_are_written(captured, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    world = StubWorld()
    backend = TelethonBackend(client_factory=world.factory)
    harness = WorkerHarness(backend).start()
    try:
        api = {"apiId": API_ID, "apiHash": API_HASH}
        login_id = harness.post("/v1/login/start", {**api, "phone": PHONE}).body["loginId"]
        assert harness.post("/v1/login/code", {"loginId": login_id, "code": "12345"}).body["status"] == "authorized"
        harness.post("/v1/account/status", {"account": {**api, "session": valid_session_string()}})
    finally:
        harness.stop()
    assert list(tmp_path.iterdir()) == []  # no session file, no cache, nothing


# ---- the scrubber itself ----------------------------------------------------------------------------------------------------------
def test_scrub_removes_registered_secrets_in_raw_and_escaped_form():
    token = logs._request_secrets.set(frozenset())
    try:
        logs.register_secrets(["hunter2-secret", 'quo"te\\andé'])
        text = logs.scrub('pw=hunter2-secret and "quo\\"te\\\\and\\u00e9" and quo"te\\andé end')
        assert "hunter2-secret" not in text and "quo" not in text.replace("[redacted]", "")
        assert logs.scrub("nothing to see") == "nothing to see"
    finally:
        logs._request_secrets.reset(token)


def test_scrub_patterns_catch_unregistered_phones_and_sessions():
    assert logs.scrub("call +49 151 1234 5678 now") == "call [redacted] now"
    assert logs.scrub("+4915112345678") == "[redacted]"
    long_token = "1" + "Ab-_9" * 40
    assert logs.scrub(f"session {long_token} end") == "session [redacted] end"
    assert logs.scrub("masked +49•••••1234 stays") == "masked +49•••••1234 stays"
    assert logs.scrub("2026-10-13T10:06:00.123Z 1700000000 request 42") == "2026-10-13T10:06:00.123Z 1700000000 request 42"


def test_secrets_in_finds_secrets_by_key_and_ignores_the_rest():
    body = {"account": {"apiId": 123456, "apiHash": "H" * 32, "session": "S" * 50}, "phone": "+49 151 123", "code": "12345",
            "password": "pw-1234", "ref": "@public_name", "ad": {"html": "hello"}, "short": 1}
    found = logs.secrets_in(body)
    assert {"H" * 32, "S" * 50, "+49 151 123", "49151123", "+49151123", "12345", "pw-1234"} <= found
    assert "@public_name" not in found and "hello" not in found and "123456" not in found
    deep = {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"password": "deep-secret-pw"}}}}}}}}}
    assert logs.secrets_in(deep) == set()  # absurd nesting is ignored, not recursed into forever


def test_exceptions_are_logged_as_class_and_location_only(captured):
    stream, capture = captured
    try:
        raise ValueError("secret detail 0123456789abcdef")
    except ValueError:
        import sys

        logs.event("oops", logging.ERROR, exc_info=sys.exc_info())
    line = json.loads(stream.getvalue().strip().splitlines()[-1])
    assert line["exception"]["type"] == "ValueError"
    assert "secret detail" not in stream.getvalue()
    assert all(":" in frame for frame in line["exception"]["stack"])
