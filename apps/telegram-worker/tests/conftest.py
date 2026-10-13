import sys
from pathlib import Path

import pytest

# `python -m pytest apps/telegram-worker/tests` is run from the repository root: make the package
# and the shared test helpers importable without installing anything.
WORKER_ROOT = Path(__file__).resolve().parents[1]
for path in (WORKER_ROOT, Path(__file__).resolve().parent):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from harness import ACCOUNT, SESSION, WorkerHarness  # noqa: E402  (needs the sys.path above)
from agencyos_telegram.fake_backend import MemoryBackend  # noqa: E402


@pytest.fixture
def backend() -> MemoryBackend:
    fake = MemoryBackend.with_demo_data()
    return fake


@pytest.fixture
def worker(backend: MemoryBackend, tmp_path):
    harness = WorkerHarness(backend, media_root=str(tmp_path / "media"))
    (tmp_path / "media").mkdir()
    harness.start()
    yield harness
    harness.stop()


@pytest.fixture
def account() -> dict:
    return dict(ACCOUNT)


__all__ = ["ACCOUNT", "SESSION"]
