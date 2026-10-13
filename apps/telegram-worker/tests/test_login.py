"""Interactive login over the real HTTP server (in-memory backend): the flow, its errors, the
10-minute expiry (injectable clock) and the cleanup of pending logins."""

import asyncio
import threading
import time

import pytest
from harness import WorkerHarness
from stub_telethon import StubWorld, rpc

from agencyos_telegram import limits
from agencyos_telegram.errors import (
    ACCOUNT_RESTRICTED, CODE_EXPIRED, CODE_INVALID, NETWORK, PASSWORD_INVALID, PHONE_INVALID, RATE_LIMITED,
    SESSION_INVALID, UNKNOWN, WorkerError,
)
from agencyos_telegram.fake_backend import EXPIRED_CODE, LOGIN_CODE, TWO_STEP_PASSWORD, MemoryBackend
from agencyos_telegram.telethon_backend import TelethonBackend

API = {"apiId": 123456, "apiHash": "0123456789abcdef0123456789abcdef"}
PHONE = "+4915112345678"


def start(worker, phone=PHONE):
    return worker.post("/v1/login/start", {**API, "phone": phone})


def pending(worker) -> int:
    return worker.request("GET", "/health", token=None).body["pendingLogins"]


def test_start_returns_a_random_login_id_and_a_timeout(worker):
    first, second = start(worker), start(worker)
    assert first.ok and first.body["codeDelivery"] == "app"
    assert first.body["timeoutSeconds"] == 600
    assert len(first.body["loginId"]) >= 32 and first.body["loginId"] != second.body["loginId"]
    assert set(first.body) == {"ok", "loginId", "codeDelivery", "timeoutSeconds"}  # the phone is not echoed
    assert pending(worker) == 2


def test_full_login_returns_the_session_once(worker, backend):
    login_id = start(worker).body["loginId"]
    done = worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE})
    assert done.ok and done.body["status"] == "authorized"
    session = done.body["session"]
    assert session.startswith("fake-session-")
    assert done.body["me"]["phoneMasked"] == "+49•••••5678"
    assert "4915112345678" not in done.raw.decode().replace(session, "")

    # the new session works, and nothing else ever hands it out again
    status = worker.post("/v1/account/status", {"account": {**API, "session": session}})
    assert status.body["authorized"] is True and session not in status.raw.decode()
    assert pending(worker) == 0
    assert backend.logins[0].disposed  # deleted on success

    again = worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE})
    assert again.error["code"] == "LOGIN_NOT_FOUND"


def test_two_step_password_flow(worker, backend):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    stage = worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE})
    assert stage.ok and stage.body == {"ok": True, "status": "password_required"}  # not an error
    assert pending(worker) == 1 and not backend.logins[0].disposed
    done = worker.post("/v1/login/password", {"loginId": login_id, "password": TWO_STEP_PASSWORD})
    assert done.ok and done.body["status"] == "authorized" and done.body["session"]
    assert pending(worker) == 0 and backend.logins[0].disposed


# ---- a typo is not a restart ---------------------------------------------------------------------------
WRONG_CODES = ["99999", "11111", "54321", "00001", "98765"]  # anything but 12345 (right) and 00000 (expired)


def code(worker, login_id, value):
    return worker.post("/v1/login/code", {"loginId": login_id, "code": value})


def password(worker, login_id, value):
    return worker.post("/v1/login/password", {"loginId": login_id, "password": value})


def test_a_wrong_code_keeps_the_login_so_it_can_be_retyped(worker, backend):
    login_id = start(worker).body["loginId"]
    wrong = code(worker, login_id, "99999")
    assert wrong.status == 200 and wrong.error["code"] == "CODE_INVALID"
    assert "start the login again" not in wrong.error["message"].lower()
    assert pending(worker) == 1 and not backend.logins[0].disposed  # still there

    done = code(worker, login_id, LOGIN_CODE)
    assert done.ok and done.body["status"] == "authorized" and done.body["session"]
    assert pending(worker) == 0 and backend.logins[0].disposed  # deleted on success


def test_four_wrong_codes_then_the_right_one_still_works(worker):
    login_id = start(worker).body["loginId"]
    for value in WRONG_CODES[:4]:
        assert code(worker, login_id, value).error["code"] == "CODE_INVALID"
        assert pending(worker) == 1
    assert code(worker, login_id, LOGIN_CODE).body["status"] == "authorized"


def test_the_fifth_wrong_code_deletes_the_login(worker, backend):
    login_id = start(worker).body["loginId"]
    for value in WRONG_CODES[:4]:
        assert code(worker, login_id, value).error["code"] == "CODE_INVALID"
    assert pending(worker) == 1 and not backend.logins[0].disposed

    fifth = code(worker, login_id, WRONG_CODES[4])
    assert fifth.status == 200 and fifth.error["code"] == "CODE_INVALID"  # same code: the caller needs no new branch
    assert "start the login again" in fifth.error["message"].lower()
    assert pending(worker) == 0 and backend.logins[0].disposed

    after = code(worker, login_id, LOGIN_CODE)  # even the right code is too late
    assert after.error["code"] == "LOGIN_NOT_FOUND"


def test_the_wrong_attempt_count_belongs_to_one_login_id(worker, backend):
    first = start(worker).body["loginId"]
    for value in WRONG_CODES[:4]:
        code(worker, first, value)
    second = start(worker).body["loginId"]
    for value in WRONG_CODES[:4]:
        assert code(worker, second, value).error["code"] == "CODE_INVALID"
    assert pending(worker) == 2 and not any(login.disposed for login in backend.logins)
    assert code(worker, first, LOGIN_CODE).body["status"] == "authorized"


def test_a_wrong_password_keeps_the_login_so_it_can_be_retyped(worker, backend):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    assert code(worker, login_id, LOGIN_CODE).body["status"] == "password_required"
    wrong = password(worker, login_id, "nope")
    assert wrong.status == 200 and wrong.error["code"] == "PASSWORD_INVALID"
    assert "start the login again" not in wrong.error["message"].lower()
    assert pending(worker) == 1 and not backend.logins[0].disposed

    done = password(worker, login_id, TWO_STEP_PASSWORD)
    assert done.ok and done.body["status"] == "authorized"
    assert pending(worker) == 0 and backend.logins[0].disposed


def test_the_fifth_wrong_password_deletes_the_login(worker, backend):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    code(worker, login_id, LOGIN_CODE)
    for attempt in range(4):
        assert password(worker, login_id, f"nope-{attempt}").error["code"] == "PASSWORD_INVALID"
    assert pending(worker) == 1
    fifth = password(worker, login_id, "nope-4")
    assert fifth.error["code"] == "PASSWORD_INVALID" and "start the login again" in fifth.error["message"].lower()
    assert pending(worker) == 0 and backend.logins[0].disposed
    assert password(worker, login_id, TWO_STEP_PASSWORD).error["code"] == "LOGIN_NOT_FOUND"


def test_wrong_codes_and_wrong_passwords_count_together(worker, backend):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    for value in WRONG_CODES[:3]:
        assert code(worker, login_id, value).error["code"] == "CODE_INVALID"
    assert code(worker, login_id, LOGIN_CODE).body["status"] == "password_required"
    assert password(worker, login_id, "nope-1").error["code"] == "PASSWORD_INVALID"  # the 4th wrong attempt
    assert pending(worker) == 1
    last = password(worker, login_id, "nope-2")  # the 5th
    assert last.error["code"] == "PASSWORD_INVALID" and "start the login again" in last.error["message"].lower()
    assert pending(worker) == 0


def test_a_wrong_attempt_does_not_extend_the_ten_minutes(worker, backend):
    login_id = start(worker).body["loginId"]
    worker.clock.advance(300)
    assert code(worker, login_id, "99999").error["code"] == "CODE_INVALID"
    worker.clock.advance(250)  # 550 s since the start: still fine
    assert code(worker, login_id, "99999").error["code"] == "CODE_INVALID"
    worker.clock.advance(60)  # 610 s
    assert code(worker, login_id, LOGIN_CODE).error["code"] == "LOGIN_NOT_FOUND"
    assert backend.logins[0].disposed


def test_an_expired_code_deletes_the_login(worker, backend):
    login_id = start(worker).body["loginId"]
    response = code(worker, login_id, EXPIRED_CODE)
    assert response.status == 200 and response.error["code"] == "CODE_EXPIRED"
    assert pending(worker) == 0 and backend.logins[0].disposed
    assert code(worker, login_id, LOGIN_CODE).error["code"] == "LOGIN_NOT_FOUND"


@pytest.mark.parametrize(
    "error",
    [
        WorkerError(RATE_LIMITED, "Telegram asked this account to wait.", 120),
        WorkerError(NETWORK, "Connection problem. It is safe to retry."),
        WorkerError(SESSION_INVALID, "The session was revoked."),
        WorkerError(PHONE_INVALID, "Telegram does not accept this phone number."),
        WorkerError(ACCOUNT_RESTRICTED, "Telegram has limited this account."),
        WorkerError(UNKNOWN, "odd"),
        WorkerError(CODE_EXPIRED, "The login code expired."),
        WorkerError(PASSWORD_INVALID, "wrong password reported on the code step"),  # not this step's typo
    ],
    ids=lambda e: e.code,
)
def test_every_other_error_still_deletes_the_login(worker, backend, error):
    login_id = start(worker).body["loginId"]
    backend.fail_next("login_code", error)
    response = code(worker, login_id, LOGIN_CODE)
    assert response.status == 200 and response.error["code"] == error.code
    assert pending(worker) == 0 and backend.logins[0].disposed
    assert code(worker, login_id, LOGIN_CODE).error["code"] == "LOGIN_NOT_FOUND"


@pytest.mark.parametrize(
    "error",
    [
        WorkerError(RATE_LIMITED, "wait", 30),
        WorkerError(NETWORK, "down"),
        WorkerError(UNKNOWN, "odd"),
        WorkerError(CODE_INVALID, "a code error on the password step"),  # not this step's typo
    ],
    ids=lambda e: e.code,
)
def test_every_other_error_on_the_password_step_deletes_the_login_too(worker, backend, error):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    code(worker, login_id, LOGIN_CODE)
    backend.fail_next("login_password", error)
    assert password(worker, login_id, TWO_STEP_PASSWORD).error["code"] == error.code
    assert pending(worker) == 0 and backend.logins[0].disposed


def test_a_timeout_on_a_login_step_deletes_the_login():
    backend = MemoryBackend.with_demo_data()
    harness = WorkerHarness(backend, service_options={"operation_timeout": 0.2}).start()
    try:
        login_id = start(harness).body["loginId"]

        async def make_gate():
            backend.gate = asyncio.Event()  # never opened

        harness.run_in_loop(make_gate())
        assert harness.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE}).error["code"] == "NETWORK"
        assert pending(harness) == 0 and backend.logins[0].disposed
    finally:
        harness.stop()


def test_invalid_phone_creates_no_pending_login(worker):
    response = start(worker, "+4915112345000")
    assert response.status == 200 and response.error["code"] == "PHONE_INVALID"
    assert pending(worker) == 0


def test_cancel(worker, backend):
    login_id = start(worker).body["loginId"]
    assert worker.post("/v1/login/cancel", {"loginId": login_id}).body == {"ok": True, "cancelled": True}
    assert pending(worker) == 0 and backend.logins[0].disposed
    assert worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE}).error["code"] == "LOGIN_NOT_FOUND"
    assert worker.post("/v1/login/cancel", {"loginId": login_id}).error["code"] == "LOGIN_NOT_FOUND"
    assert worker.post("/v1/login/cancel", {"loginId": "never-existed"}).error["code"] == "LOGIN_NOT_FOUND"


# ---- expiry (injectable clock) --------------------------------------------------------------------------
def test_a_login_expires_after_ten_minutes(worker, backend):
    login_id = start(worker).body["loginId"]
    worker.clock.advance(599)
    assert pending(worker) == 1
    worker.clock.advance(2)  # 601 s
    assert pending(worker) == 0  # health no longer counts it
    response = worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE})
    assert response.status == 200 and response.error["code"] == "LOGIN_NOT_FOUND"
    assert backend.logins[0].disposed  # cleaned up when noticed


def test_the_ten_minutes_run_from_the_start_not_from_each_step(worker, backend):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    worker.clock.advance(400)
    assert worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE}).body["status"] == "password_required"
    worker.clock.advance(250)  # 650 s since the start
    response = worker.post("/v1/login/password", {"loginId": login_id, "password": TWO_STEP_PASSWORD})
    assert response.error["code"] == "LOGIN_NOT_FOUND"


def test_housekeeping_frees_expired_logins_without_any_request(worker, backend):
    start(worker), start(worker)
    worker.clock.advance(601)
    worker.run_in_loop(worker.service.maintenance())
    assert all(login.disposed for login in backend.logins)
    assert worker.service._logins == {}
    assert backend.sweeps == 1  # idle clients are swept by the same pass


def test_new_logins_purge_expired_ones(worker, backend):
    start(worker)
    worker.clock.advance(601)
    start(worker)
    assert backend.logins[0].disposed and not backend.logins[1].disposed
    assert pending(worker) == 1


def test_pending_logins_are_capped_and_the_oldest_is_dropped(worker, backend):
    ids = []
    for _ in range(limits.MAX_PENDING_LOGINS + 1):
        ids.append(start(worker).body["loginId"])
        worker.clock.advance(1)
    assert pending(worker) == limits.MAX_PENDING_LOGINS
    assert backend.logins[0].disposed
    assert worker.post("/v1/login/code", {"loginId": ids[0], "code": LOGIN_CODE}).error["code"] == "LOGIN_NOT_FOUND"
    assert worker.post("/v1/login/code", {"loginId": ids[-1], "code": LOGIN_CODE}).ok


# ---- misuse ------------------------------------------------------------------------------------------------------
def test_password_before_the_code_is_a_bad_request_and_keeps_the_login(worker):
    login_id = start(worker).body["loginId"]
    response = worker.post("/v1/login/password", {"loginId": login_id, "password": "x"})
    assert response.status == 400
    assert pending(worker) == 1


def test_code_after_password_required_is_a_bad_request(worker, backend):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE})
    assert worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE}).status == 400


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/v1/login/start", {**API, "phone": "12"}),
        ("/v1/login/start", {**API, "phone": "not a number"}),
        ("/v1/login/start", {**API, "phone": "+" + "1" * 16}),
        ("/v1/login/start", {"apiId": 1, "phone": PHONE}),
        ("/v1/login/start", {**API, "phone": PHONE, "extra": 1}),
        ("/v1/login/code", {"loginId": "id", "code": "abc"}),
        ("/v1/login/code", {"loginId": "id", "code": "1"}),
        ("/v1/login/code", {"loginId": "id", "code": 12345}),
        ("/v1/login/code", {"loginId": "bad id!", "code": "12345"}),
        ("/v1/login/code", {"code": "12345"}),
        ("/v1/login/password", {"loginId": "id", "password": ""}),
        ("/v1/login/password", {"loginId": "id", "password": "p" * 257}),
        ("/v1/login/cancel", {"loginId": ""}),
    ],
)
def test_login_request_validation(worker, path, body):
    assert worker.post(path, body).status == 400


def test_phone_is_normalised_and_codes_may_have_separators(worker, backend):
    login_id = start(worker, "+49 (151) 1234-5678").body["loginId"]
    assert backend.logins[0].phone == "+4915112345678"
    assert worker.post("/v1/login/code", {"loginId": login_id, "code": "12 345"}).body["status"] == "authorized"


def test_one_attempt_at_a_time_per_login_id():
    backend = MemoryBackend.with_demo_data()
    harness = WorkerHarness(backend).start()
    try:
        login_id = start(harness).body["loginId"]

        async def make_gate():
            backend.gate = asyncio.Event()

        harness.run_in_loop(make_gate())
        results: list = []
        threads = [
            threading.Thread(
                target=lambda: results.append(harness.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE}))
            )
            for _ in range(2)
        ]
        for thread in threads:
            thread.start()
        while backend.entered < 2:  # login_start + the first code
            time.sleep(0.02)
        time.sleep(0.2)
        assert backend.entered == 2  # the second code is waiting for the first, not running beside it
        harness.loop.call_soon_threadsafe(backend.gate.set)
        for thread in threads:
            thread.join(10)
        outcomes = sorted(r.body.get("status") or r.error["code"] for r in results)
        assert outcomes == ["LOGIN_NOT_FOUND", "authorized"]
    finally:
        harness.stop()


def test_with_telethon_a_typo_keeps_the_same_connection_and_the_fifth_closes_it():
    """The retry reuses the one Telethon client (same code hash); only the end of the login closes it."""
    world = StubWorld()
    world.sign_in_script = [rpc("PhoneCodeInvalidError"), rpc("PhoneCodeInvalidError")]  # then the default: success
    harness = WorkerHarness(TelethonBackend(client_factory=world.factory)).start()
    try:
        login_id = start(harness).body["loginId"]
        for _ in range(2):
            assert code(harness, login_id, "99999").error["code"] == "CODE_INVALID"
            assert world.disconnects == 0 and len(world.clients) == 1
        done = code(harness, login_id, "12345")
        assert done.body["status"] == "authorized"
        assert [call[2]["hash"] for call in world.sent if call[0] == "sign_in"] == ["hash-123"] * 3
        assert world.disconnects == 1 and pending(harness) == 0

        world.sign_in_script = [rpc("PhoneCodeInvalidError")] * 5
        login_id = start(harness).body["loginId"]
        for _ in range(5):
            last = code(harness, login_id, "99999")
        assert last.error["code"] == "CODE_INVALID" and "start the login again" in last.error["message"].lower()
        assert pending(harness) == 0 and world.disconnects == 2

        world.sign_in_script = [rpc("PhoneCodeExpiredError")]
        login_id = start(harness).body["loginId"]
        assert code(harness, login_id, "12345").error["code"] == "CODE_EXPIRED"
        assert pending(harness) == 0 and world.disconnects == 3
    finally:
        harness.stop()
