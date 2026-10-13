"""Transport behaviour of the real HTTP server (in-memory backend): health, token, Host, body
limit, correlation id, shape validation, in-flight limit, graceful drain."""

import asyncio
import json
import socket
import threading

from harness import ACCOUNT, TOKEN, WorkerHarness

from agencyos_telegram import limits
from agencyos_telegram.fake_backend import MemoryBackend


def status_body():
    return {"account": ACCOUNT}


# ---- health and auth ---------------------------------------------------------------------------
def test_health_is_unauthenticated_and_shaped(worker):
    response = worker.request("GET", "/health", token=None)
    assert response.status == 200 and response.ok
    for key in ("version", "telethon", "python", "uptimeSeconds", "pendingLogins", "clients"):
        assert key in response.body
    assert response.body["pendingLogins"] == 0 and response.body["clients"] == 0
    assert response.headers["content-type"].startswith("application/json")


def test_missing_token_is_401(worker):
    response = worker.post("/v1/account/status", status_body(), token=None)
    assert response.status == 401
    assert response.body == {"ok": False, "error": {"code": "BAD_REQUEST", "message": "missing or invalid worker token"}}


def test_wrong_token_is_401_and_nothing_runs(worker, backend):
    response = worker.post("/v1/account/status", status_body(), token=TOKEN + "x")
    assert response.status == 401
    assert backend.calls == []


def test_token_is_compared_in_constant_time():
    import inspect

    from agencyos_telegram import server

    source = inspect.getsource(server.WorkerServer._check_token)
    assert "hmac.compare_digest" in source


def test_unknown_route_and_wrong_method(worker):
    assert worker.post("/v1/nope", {}).status == 404
    assert worker.request("GET", "/v1/account/status").status == 405
    # without a token a route does not even reveal that it exists
    assert worker.post("/v1/nope", {}, token=None).status == 401


# ---- Host header -----------------------------------------------------------------------------------
def test_host_check_allows_loopback_names_only(worker):
    for host in (f"127.0.0.1:{worker.port}", f"localhost:{worker.port}", f"LOCALHOST:{worker.port}"):
        assert worker.request("GET", "/health", token=None, headers={"Host": host}).status == 200
    for host in ("evil.example", f"evil.example:{worker.port}", "127.0.0.1", f"127.0.0.1:{worker.port + 1}", "[::1]:80"):
        response = worker.request("GET", "/health", token=None, headers={"Host": host})
        assert response.status == 421, host
        assert response.body["ok"] is False
    # the check also guards authenticated routes
    assert worker.post("/v1/account/status", status_body(), headers={"Host": "evil.example"}).status == 421


# ---- body limit and JSON shape -------------------------------------------------------------------------
def test_body_over_256_kib_is_413(worker, backend):
    big = b'{"pad":"' + b"a" * (256 * 1024) + b'"}'
    response = worker.request("POST", "/v1/account/status", raw_body=big)
    assert response.status == 413
    assert backend.calls == []


def test_body_at_the_limit_is_read_and_validated_not_refused(worker):
    padding = "a" * (limits.BODY_LIMIT_BYTES - 200)
    body = json.dumps({"account": ACCOUNT, "pad": padding}).encode()
    assert len(body) <= limits.BODY_LIMIT_BYTES
    response = worker.request("POST", "/v1/account/status", raw_body=body)
    assert response.status == 400  # unknown field "pad": validated, not 413


def test_invalid_json_is_400(worker):
    for raw in (b"{not json", b"", b"[1,2", b'{"a": NaN}', b"\xff\xfe"):
        response = worker.request("POST", "/v1/account/status", raw_body=raw)
        assert response.status == 400, raw
        assert response.error["code"] == "BAD_REQUEST"


def test_deeply_nested_json_is_400_not_a_crash(worker):
    response = worker.request("POST", "/v1/account/status", raw_body=b"[" * 5000 + b"]" * 5000)
    assert response.status == 400


def test_wrong_content_type_is_400(worker):
    response = worker.request("POST", "/v1/account/status", raw_body=b"{}", content_type="text/plain")
    assert response.status == 400 and response.error["code"] == "BAD_REQUEST"


def test_chunked_bodies_are_refused(worker):
    sock = socket.create_connection(("127.0.0.1", worker.port), timeout=10)
    try:
        sock.sendall(
            (
                "POST /v1/account/status HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{worker.port}\r\nX-AgencyOS-Worker-Token: {TOKEN}\r\n"
                "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
            ).encode()
        )
        data = sock.recv(4096)
    finally:
        sock.close()
    assert data.startswith(b"HTTP/1.1 400")


def test_shape_errors_are_400_with_a_named_field(worker):
    cases = [
        ({}, "account is required"),
        ({"account": []}, "account must be a JSON object"),
        ({"account": {**ACCOUNT, "apiId": "1"}}, "account.apiId must be an integer"),
        ({"account": {**ACCOUNT, "apiId": True}}, "account.apiId must be an integer"),
        ({"account": {**ACCOUNT, "apiId": 0}}, "account.apiId must be between"),
        ({"account": {**ACCOUNT, "session": ""}}, "account.session must not be empty"),
        ({"account": {**ACCOUNT, "extra": 1}}, "unknown field: account.extra"),
        ({"account": ACCOUNT, "userIds": [1, 2]}, "unknown field: userIds"),
        ([], "body must be a JSON object"),
    ]
    for body, fragment in cases:
        response = worker.post("/v1/account/status", body)
        assert response.status == 400, body
        assert response.error["code"] == "BAD_REQUEST"
        assert fragment in response.error["message"], (body, response.error)


VALID_BODIES = {
    "/v1/communities/join": {"account": ACCOUNT, "ref": "@agencyos_news"},
    "/v1/communities/resolve": {"account": ACCOUNT, "ref": "@agencyos_news"},
    "/v1/communities/leave": {"account": ACCOUNT, "ref": "@agencyos_chat"},
    "/v1/communities/update": {"account": ACCOUNT, "ref": "@agencyos_news", "title": "t"},
    "/v1/communities/refresh": {"account": ACCOUNT, "refs": ["@agencyos_news"]},
    "/v1/communities/join-requests": {"account": ACCOUNT, "ref": "@agencyos_news"},
    "/v1/messages/send": {"account": ACCOUNT, "ref": "@agencyos_news", "ad": {"html": "hello"}},
    "/v1/communities/create": {"account": ACCOUNT, "kind": "group", "title": "t"},
}


def test_no_endpoint_accepts_a_list_of_users(worker):
    for path, valid in VALID_BODIES.items():
        for field in ("userIds", "users", "members", "phones", "usernames", "participants"):
            response = worker.post(path, {**valid, field: [1, 2, 3]})
            assert response.status == 400, (path, field)
            assert f"unknown field: {field}" in response.error["message"], (path, response.error)


# ---- correlation id -----------------------------------------------------------------------------------------
def test_correlation_id_is_echoed(worker):
    response = worker.post("/v1/account/status", status_body(), headers={"X-Correlation-Id": "req-42.a:b_c"})
    assert response.headers["x-correlation-id"] == "req-42.a:b_c"


def test_correlation_id_is_generated_and_unsafe_ones_are_replaced(worker):
    generated = worker.request("GET", "/health", token=None).headers["x-correlation-id"]
    assert len(generated) >= 16
    replaced = worker.request("GET", "/health", token=None, headers={"X-Correlation-Id": "bad id with spaces\t"})
    assert replaced.headers["x-correlation-id"] != "bad id with spaces\t"
    long = worker.request("GET", "/health", token=None, headers={"X-Correlation-Id": "x" * 65})
    assert long.headers["x-correlation-id"] != "x" * 65


def test_correlation_id_is_echoed_on_errors_too(worker):
    response = worker.post("/v1/account/status", status_body(), token="nope", headers={"X-Correlation-Id": "abc-1"})
    assert response.status == 401 and response.headers["x-correlation-id"] == "abc-1"


# ---- in-flight limit ---------------------------------------------------------------------------------------------
def test_the_server_listens_on_loopback_only(worker):
    sockets = worker.server._server.sockets
    assert [s.getsockname()[0] for s in sockets] == ["127.0.0.1"]


def test_defaults_match_the_contract():
    from agencyos_telegram.server import ServerConfig

    config = ServerConfig(token="x" * 16)
    assert config.host == "127.0.0.1"
    assert config.max_inflight == 4
    assert config.inflight_wait_seconds == 5.0 and config.inflight_retry_after == 5
    assert config.max_body_bytes == 256 * 1024


def test_fifth_request_waits_then_gets_rate_limited(tmp_path):
    backend = MemoryBackend.with_demo_data()
    harness = WorkerHarness(backend, server_options={"inflight_wait_seconds": 0.3}).start()
    try:
        async def make_gate():
            backend.gate = asyncio.Event()

        harness.run_in_loop(make_gate())
        results: list = []

        def slow_call():
            results.append(harness.post("/v1/account/status", status_body()))

        threads = [threading.Thread(target=slow_call) for _ in range(4)]
        for thread in threads:
            thread.start()
        deadline = 0
        import time

        while backend.entered < 4 and deadline < 200:
            time.sleep(0.05)
            deadline += 1
        assert backend.entered == 4

        fifth = harness.post("/v1/account/status", status_body())
        assert fifth.status == 200
        assert fifth.body["ok"] is False
        assert fifth.error["code"] == "RATE_LIMITED" and fifth.error["retryAfterSeconds"] == 5
        assert backend.entered == 4  # the fifth never reached the backend

        # health is not counted as a request in flight
        assert harness.request("GET", "/health", token=None).status == 200

        harness.loop.call_soon_threadsafe(backend.gate.set)
        for thread in threads:
            thread.join(10)
        assert [r.status for r in results] == [200, 200, 200, 200]
    finally:
        harness.stop()


def test_waiting_request_is_served_when_a_slot_frees_up():
    backend = MemoryBackend.with_demo_data()
    harness = WorkerHarness(backend, server_options={"inflight_wait_seconds": 5.0}).start()
    try:
        async def make_gate():
            backend.gate = asyncio.Event()

        harness.run_in_loop(make_gate())
        results: list = []
        threads = [
            threading.Thread(target=lambda: results.append(harness.post("/v1/account/status", status_body())))
            for _ in range(5)
        ]
        for thread in threads:
            thread.start()
        import time

        while backend.entered < 4:
            time.sleep(0.02)
        time.sleep(0.2)
        assert backend.entered == 4  # the fifth is waiting for a slot
        harness.loop.call_soon_threadsafe(backend.gate.set)
        for thread in threads:
            thread.join(10)
        assert len(results) == 5 and all(r.ok for r in results)
    finally:
        harness.stop()


# ---- graceful drain ----------------------------------------------------------------------------------------------------
def test_shutdown_lets_an_inflight_request_finish():
    backend = MemoryBackend.with_demo_data()
    harness = WorkerHarness(backend).start()
    try:
        async def make_gate():
            backend.gate = asyncio.Event()

        harness.run_in_loop(make_gate())
        results: list = []
        caller = threading.Thread(target=lambda: results.append(harness.post("/v1/account/status", status_body())))
        caller.start()
        import time

        while backend.entered < 1:
            time.sleep(0.02)
        stopper = threading.Thread(target=harness.stop)
        stopper.start()
        time.sleep(0.3)
        assert stopper.is_alive()  # waiting for the request in flight
        harness.loop.call_soon_threadsafe(backend.gate.set)
        caller.join(10)
        stopper.join(10)
        assert results and results[0].ok
        assert backend.shut_down  # every client was disconnected
    finally:
        harness.stop()


def test_requests_cut_off_by_shutdown_say_so():
    """Past the grace period a request is cancelled: a send reports OUTCOME_UNKNOWN, others 503."""
    backend = MemoryBackend.with_demo_data()
    harness = WorkerHarness(backend, server_options={"shutdown_grace": 0.1}).start()
    try:
        async def make_gate():
            backend.gate = asyncio.Event()  # never opened

        harness.run_in_loop(make_gate())
        results: dict = {}
        send_body = {"account": ACCOUNT, "ref": "@agencyos_news", "ad": {"html": "hi"}}
        threads = [
            threading.Thread(target=lambda: results.__setitem__("send", harness.post("/v1/messages/send", send_body))),
            threading.Thread(target=lambda: results.__setitem__("status", harness.post("/v1/account/status", status_body()))),
        ]
        for thread in threads:
            thread.start()
        import time

        while backend.entered < 2:
            time.sleep(0.02)
        harness.stop()
        for thread in threads:
            thread.join(10)
        assert results["send"].status == 200 and results["send"].error["code"] == "OUTCOME_UNKNOWN"
        assert results["status"].status == 503
        assert backend.outbox == []
    finally:
        harness.stop()
