import asyncio
import hashlib

import pytest
from harness import FakeClock

from agencyos_telegram import limits
from agencyos_telegram.backend import Account


def test_bounds_match_the_contract():
    assert limits.SEARCH_MAX == 50 and limits.REFRESH_MAX_REFS == 20 and limits.MESSAGES_MAX == 20
    assert limits.DIALOGS_MAX == 200 and limits.JOIN_REQUESTS_MAX == 50 and limits.PUBLIC_MESSAGE_TEXT_MAX == 2000
    assert limits.REFRESH_SPACING_SECONDS >= 1.0
    assert limits.MAX_INFLIGHT == 4 and limits.INFLIGHT_WAIT_SECONDS == 5 and limits.INFLIGHT_RETRY_AFTER_SECONDS == 5
    assert limits.BODY_LIMIT_BYTES == 256 * 1024
    assert limits.CLIENT_IDLE_SECONDS == 120 and limits.LOGIN_TTL_SECONDS == 600


def test_clamp():
    assert [limits.clamp(v, 1, 50) for v in (-3, 0, 1, 25, 50, 51, 10**9)] == [1, 1, 1, 25, 50, 50, 50]


def test_the_pool_key_is_the_sha256_of_the_session_and_not_the_session():
    key = limits.session_key("some-session")
    assert key == hashlib.sha256(b"some-session").hexdigest() and "some-session" not in key
    assert Account(1, "hash", "some-session").key == key


def test_account_repr_hides_secrets():
    text = repr(Account(1, "very-secret-hash", "very-secret-session"))
    assert "very-secret" not in text and "api_id=1" in text


def test_spacer_keeps_a_minimum_gap_between_starts():
    clock = FakeClock()

    async def scenario():
        spacer = limits.Spacer(1.0, clock, clock.sleep)
        starts = []
        for _ in range(3):
            await spacer.wait()
            starts.append(clock())
            clock.advance(0.25)  # the "lookup" itself takes a quarter second
        return starts

    starts = asyncio.run(scenario())
    assert [round(b - a, 2) for a, b in zip(starts, starts[1:])] == [1.0, 1.0]
    assert clock.sleeps == [0.75, 0.75]  # only the remainder is waited


def test_spacer_does_not_wait_when_enough_time_passed():
    clock = FakeClock()

    async def scenario():
        spacer = limits.Spacer(1.0, clock, clock.sleep)
        await spacer.wait()
        clock.advance(5)
        await spacer.wait()

    asyncio.run(scenario())
    assert clock.sleeps == []


class Conn:
    def __init__(self, name):
        self.name, self.closed = name, False


def make_pool(clock, **kwargs):
    closed = []

    async def close(conn):
        conn.closed = True
        closed.append(conn.name)
        if kwargs.pop("fail_close", False):
            raise RuntimeError("close failed")

    return limits.ClientPool(close, idle_seconds=120, clock=clock), closed


def test_pool_creates_once_per_key_even_under_concurrency():
    clock = FakeClock()
    pool, _ = make_pool(clock)
    created = []

    async def create():
        created.append(1)
        await asyncio.sleep(0.01)
        return Conn("a")

    async def use():
        async with pool.lease("key", create) as conn:
            return conn

    async def scenario():
        return await asyncio.gather(*(use() for _ in range(5)))

    clients = asyncio.run(scenario())
    assert len(created) == 1 and len({id(c) for c in clients}) == 1 and len(pool) == 1


def test_pool_disconnects_after_idle_and_never_while_in_use():
    clock = FakeClock()
    pool, closed = make_pool(clock)

    async def scenario():
        async def create():
            return Conn("a")

        async with pool.lease("k", create):
            clock.advance(500)
            assert await pool.sweep() == 0  # busy: untouched however long it has been
            assert closed == []
        clock.advance(119)
        assert await pool.sweep() == 0
        clock.advance(1)  # exactly 120 s idle
        assert await pool.sweep() == 1 and closed == ["a"] and len(pool) == 0
        async with pool.lease("k", create) as conn:  # a new one is created on demand
            assert conn.closed is False

    asyncio.run(scenario())


def test_using_a_client_resets_its_idle_clock():
    clock = FakeClock()
    pool, closed = make_pool(clock)

    async def scenario():
        async def create():
            return Conn("a")

        async with pool.lease("k", create):
            pass
        clock.advance(100)
        async with pool.lease("k", create):
            pass
        clock.advance(100)
        assert await pool.sweep() == 0  # 100 s since last use
        clock.advance(21)
        assert await pool.sweep() == 1

    asyncio.run(scenario())


def test_a_failing_create_leaves_nothing_behind_and_can_be_retried():
    clock = FakeClock()
    pool, _ = make_pool(clock)
    attempts = []

    async def create():
        attempts.append(1)
        if len(attempts) == 1:
            raise ConnectionError("down")
        return Conn("a")

    async def scenario():
        with pytest.raises(ConnectionError):
            async with pool.lease("k", create):
                pass
        assert len(pool) == 0
        async with pool.lease("k", create):
            pass
        assert len(pool) == 1

    asyncio.run(scenario())


def test_close_failures_do_not_stop_a_sweep_or_shutdown():
    clock = FakeClock()
    pool, closed = make_pool(clock, fail_close=False)

    async def bad_close(conn):
        raise RuntimeError("boom")

    pool._close = bad_close

    async def scenario():
        async def create():
            return Conn("a")

        for key in ("a", "b"):
            async with pool.lease(key, create):
                pass
        clock.advance(500)
        assert await pool.sweep() == 2
        async with pool.lease("c", create):
            pass
        await pool.close_all()
        assert len(pool) == 0

    asyncio.run(scenario())


def test_discard_and_close_all():
    clock = FakeClock()
    pool, closed = make_pool(clock)

    async def scenario():
        async def create():
            return Conn("x")

        for key in ("a", "b", "c"):
            async with pool.lease(key, create):
                pass
        await pool.discard("a")
        await pool.discard("missing")
        assert len(pool) == 2
        await pool.close_all()
        assert len(pool) == 0 and len(closed) == 3

    asyncio.run(scenario())
