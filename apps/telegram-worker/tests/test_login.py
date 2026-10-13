"""Interactive login over the real HTTP server (in-memory backend): the flow, its errors, the
10-minute expiry (injectable clock) and the cleanup of pending logins."""

import asyncio
import threading
import time

import pytest
from harness import WorkerHarness

from agencyos_telegram import limits
from agencyos_telegram.fake_backend import EXPIRED_CODE, LOGIN_CODE, TWO_STEP_PASSWORD, MemoryBackend

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


def test_wrong_password_ends_the_attempt(worker, backend):
    backend.two_step_phones.add(PHONE)
    login_id = start(worker).body["loginId"]
    worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE})
    wrong = worker.post("/v1/login/password", {"loginId": login_id, "password": "nope"})
    assert wrong.status == 200 and wrong.error["code"] == "PASSWORD_INVALID"
    assert pending(worker) == 0 and backend.logins[0].disposed  # deleted on error
    assert worker.post("/v1/login/password", {"loginId": login_id, "password": TWO_STEP_PASSWORD}).error["code"] == "LOGIN_NOT_FOUND"


@pytest.mark.parametrize(("code", "expected"), [("99999", "CODE_INVALID"), (EXPIRED_CODE, "CODE_EXPIRED")])
def test_wrong_or_expired_code_ends_the_attempt(worker, backend, code, expected):
    login_id = start(worker).body["loginId"]
    response = worker.post("/v1/login/code", {"loginId": login_id, "code": code})
    assert response.status == 200 and response.error["code"] == expected
    assert pending(worker) == 0 and backend.logins[0].disposed
    assert worker.post("/v1/login/code", {"loginId": login_id, "code": LOGIN_CODE}).error["code"] == "LOGIN_NOT_FOUND"


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
