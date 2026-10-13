"""`python -m agencyos_telegram --port <n>`: start the worker on 127.0.0.1.

Environment:
    AGENCYOS_WORKER_TOKEN   required, at least 16 characters; sent by the supervisor in
                            X-AgencyOS-Worker-Token on every request except GET /health
    AGENCYOS_WORKER_PORT    the port, unless --port is given. There is NO default.
    AGENCYOS_MEDIA_ROOT     directory media files must live in (media is refused when unset)

Port 0 asks the OS for a free port; the chosen port is printed as one JSON line on stdout:
    {"event":"listening","port":54321}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import threading

from . import logs
from .backend import TelegramBackend
from .server import ServerConfig, WorkerServer
from .service import ServiceConfig, WorkerService

EXIT_USAGE = 2
MIN_TOKEN_LENGTH = 16
HARD_EXIT_SECONDS = 4.5  # SIGTERM must end the process within 5 s, whatever Telethon is doing


class StartupError(Exception):
    pass


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m agencyos_telegram",
        description="AgencyOS Telegram user-account worker (loopback only).",
    )
    parser.add_argument("--port", help="port to listen on (0 = pick a free one); or AGENCYOS_WORKER_PORT")
    parser.add_argument(
        "--backend", choices=("telethon", "memory"), default="telethon",
        help="'memory' is an in-memory fake for integration tests: it never talks to Telegram",
    )
    return parser.parse_args(argv)


def read_settings(args: argparse.Namespace) -> tuple[ServerConfig, ServiceConfig]:
    raw_port = args.port if args.port is not None else os.environ.get("AGENCYOS_WORKER_PORT")
    if raw_port is None or str(raw_port).strip() == "":
        raise StartupError("no port: pass --port <n> or set AGENCYOS_WORKER_PORT (there is no default)")
    try:
        port = int(str(raw_port).strip())
    except ValueError:
        raise StartupError(f"the port must be an integer, got {raw_port!r}") from None
    if not 0 <= port <= 65535:
        raise StartupError("the port must be between 0 and 65535")
    token = os.environ.get("AGENCYOS_WORKER_TOKEN", "")
    if len(token) < MIN_TOKEN_LENGTH:
        raise StartupError(
            f"AGENCYOS_WORKER_TOKEN must be set to a random secret of at least {MIN_TOKEN_LENGTH} characters"
        )
    media_root = os.environ.get("AGENCYOS_MEDIA_ROOT") or None
    return ServerConfig(token=token, port=port), ServiceConfig(media_root=media_root)


def make_backend(name: str) -> TelegramBackend:
    if name == "memory":
        from .fake_backend import MemoryBackend

        logs.event("memory_backend_active", logging.WARNING, note="no Telegram connection is made")
        return MemoryBackend.with_demo_data()
    from .telethon_backend import TelethonBackend

    return TelethonBackend()


def install_signal_handlers(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    """SIGTERM/SIGINT everywhere; CTRL_BREAK_EVENT (SIGBREAK) on Windows."""
    if sys.platform == "win32":
        def request_stop(*_: object) -> None:
            loop.call_soon_threadsafe(stop.set)

        for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
            number = getattr(signal, name, None)
            if number is not None:
                signal.signal(number, request_stop)
    else:
        for number in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(number, stop.set)


def _hard_exit() -> None:
    logs.event("shutdown_forced", logging.WARNING)
    os._exit(0)


async def run(server_config: ServerConfig, service_config: ServiceConfig, backend: TelegramBackend) -> int:
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    install_signal_handlers(loop, stop)

    server = WorkerServer(server_config, WorkerService(backend, service_config))
    port = await server.start()
    print(json.dumps({"event": "listening", "port": port}, separators=(",", ":")), flush=True)
    logs.event("listening", port=port, backend=backend.name, media=bool(service_config.media_root))

    await stop.wait()
    logs.event("shutdown_started")
    watchdog = threading.Timer(HARD_EXIT_SECONDS, _hard_exit)
    watchdog.daemon = True
    watchdog.start()
    await server.shutdown()
    logs.event("shutdown_complete")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
    logs.configure_logging()
    args = parse_args(argv)
    try:
        server_config, service_config = read_settings(args)
    except StartupError as err:
        logs.event("startup_failed", logging.ERROR, message=str(err))
        return EXIT_USAGE
    return asyncio.run(run(server_config, service_config, make_backend(args.backend)))


if __name__ == "__main__":
    sys.exit(main())
