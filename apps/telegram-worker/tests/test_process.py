"""`python -m agencyos_telegram` as a real process: startup contract, port handling and shutdown."""

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

WORKER_ROOT = Path(__file__).resolve().parents[1]
TOKEN = "process-test-token-0123456789"
WINDOWS = sys.platform == "win32"


def environment(**overrides):
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGENCYOS_")}
    env.update({"PYTHONPATH": str(WORKER_ROOT), "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"})
    env.update({k: v for k, v in overrides.items() if v is not None})
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
    return env


_started: list[subprocess.Popen] = []


def spawn(args=(), cwd=None, **env):
    extra = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {}
    process = subprocess.Popen(
        [sys.executable, "-m", "agencyos_telegram", *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        env=environment(**env), cwd=cwd, **extra,
    )
    _started.append(process)
    return process


@pytest.fixture(autouse=True)
def reap_processes():
    """Whatever a test started is stopped and its pipes closed, pass or fail."""
    yield
    while _started:
        process = _started.pop()
        if process.poll() is None:
            process.kill()
        process.wait(10)
        for pipe in (process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()


def read_listening(process, timeout=30):
    watchdog = threading.Timer(timeout, process.kill)
    watchdog.start()
    try:
        line = process.stdout.readline()
    finally:
        watchdog.cancel()
    assert line, f"no listening line; stderr: {process.stderr.read()}"
    return line


def lan_address():
    """This machine's outward-facing IPv4 address, or None when it only has loopback."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))  # TEST-NET-1: nothing is sent, the OS just picks a route
        address = probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()
    return None if address.startswith("127.") or address == "0.0.0.0" else address


def get(port, path, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def finish(process, timeout=10):
    try:
        return process.wait(timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        raise


# ---- startup refusals -------------------------------------------------------------------------------------
def exit_message(process):
    code = finish(process)
    return code, process.stderr.read()


def test_no_port_means_exit_2_with_a_clear_message(tmp_path):
    process = spawn(cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN)
    code, err = exit_message(process)
    assert code == 2
    assert "no port" in err and "AGENCYOS_WORKER_PORT" in err and "no default" in err
    assert TOKEN not in err
    assert process.stdout.read() == ""


@pytest.mark.parametrize("port", ["abc", "-1", "65536", "80.5", " "])
def test_invalid_ports_exit_2(tmp_path, port):
    process = spawn(["--port", port], cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN)
    assert exit_message(process)[0] == 2


@pytest.mark.parametrize("token", [None, "", "short"])
def test_a_missing_or_weak_token_exits_2(tmp_path, token):
    process = spawn(["--port", "0"], cwd=tmp_path, AGENCYOS_WORKER_TOKEN=token if token is not None else None)
    code, err = exit_message(process)
    assert code == 2 and "AGENCYOS_WORKER_TOKEN" in err
    assert process.stdout.read() == ""


# ---- running ----------------------------------------------------------------------------------------------------------
def test_listening_line_health_and_the_port_environment_variable(tmp_path):
    process = spawn(cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN, AGENCYOS_WORKER_PORT="0", AGENCYOS_MEDIA_ROOT=str(tmp_path))
    try:
        line = read_listening(process)
        assert line.strip() == json.dumps({"event": "listening", "port": json.loads(line)["port"]}, separators=(",", ":"))
        port = json.loads(line)["port"]
        assert port > 0
        status, health = get(port, "/health", {"Host": f"127.0.0.1:{port}"})
        assert status == 200 and health["ok"] and health["backend"] == "telethon"
        import telethon

        assert health["telethon"] == telethon.__version__ and health["clients"] == 0 and health["pendingLogins"] == 0
        assert get(port, "/health", {"Host": "evil.example"})[0] == 421
        # loopback only: the port is not open on this machine's other addresses
        lan = lan_address()
        if lan is not None:
            with pytest.raises(OSError):
                socket.create_connection((lan, port), timeout=3).close()
    finally:
        process.kill()
        process.wait(10)


def test_the_command_line_port_wins_over_the_environment(tmp_path):
    process = spawn(["--port", "0"], cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN, AGENCYOS_WORKER_PORT="not-a-port")
    try:
        assert json.loads(read_listening(process))["port"] > 0
    finally:
        process.kill()
        process.wait(10)


def test_memory_backend_is_selectable_for_integration_tests(tmp_path):
    process = spawn(["--port", "0", "--backend", "memory"], cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN)
    try:
        port = json.loads(read_listening(process))["port"]
        assert get(port, "/health", {"Host": f"127.0.0.1:{port}"})[1]["backend"] == "memory"
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        body = json.dumps({"account": {"apiId": 1, "apiHash": "h" * 32, "session": "memory-session-1"}})
        connection.request("POST", "/v1/account/status", body=body, headers={
            "Content-Type": "application/json", "X-AgencyOS-Worker-Token": TOKEN, "X-Correlation-Id": "int-1"})
        response = connection.getresponse()
        assert response.getheader("X-Correlation-Id") == "int-1"
        assert json.loads(response.read())["authorized"] is True
        connection.close()
    finally:
        process.kill()
        process.wait(10)


# ---- graceful shutdown ----------------------------------------------------------------------------------------------------
@pytest.mark.skipif(WINDOWS, reason="POSIX signals; Windows uses CTRL_BREAK_EVENT (see the Windows test below)")
@pytest.mark.parametrize("signal_name", ["SIGTERM", "SIGINT"])
def test_signal_shuts_down_within_five_seconds_with_exit_0(tmp_path, signal_name):
    process = spawn(["--port", "0"], cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN)
    port = json.loads(read_listening(process))["port"]
    assert get(port, "/health", {"Host": f"127.0.0.1:{port}"})[0] == 200
    started = time.monotonic()
    process.send_signal(getattr(signal, signal_name))
    code = finish(process, 5)
    elapsed = time.monotonic() - started
    assert code == 0 and elapsed < 5, (code, elapsed)
    err = process.stderr.read()
    events = [json.loads(line)["event"] for line in err.strip().splitlines()]
    assert "shutdown_started" in events and "shutdown_complete" in events
    assert TOKEN not in err
    with pytest.raises(OSError):  # the port is closed
        get(port, "/health", {"Host": f"127.0.0.1:{port}"})


@pytest.mark.skipif(WINDOWS, reason="needs POSIX signals")
def test_a_second_signal_during_shutdown_is_harmless(tmp_path):
    process = spawn(["--port", "0"], cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN)
    read_listening(process)
    process.send_signal(signal.SIGTERM)
    process.send_signal(signal.SIGTERM)
    assert finish(process, 5) == 0


@pytest.mark.skipif(not WINDOWS, reason="CTRL_BREAK_EVENT exists on Windows only")
def test_ctrl_break_shuts_down_within_five_seconds_on_windows(tmp_path):
    process = spawn(["--port", "0"], cwd=tmp_path, AGENCYOS_WORKER_TOKEN=TOKEN)
    read_listening(process)
    process.send_signal(signal.CTRL_BREAK_EVENT)
    assert finish(process, 5) == 0
