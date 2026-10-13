"""Telethon exception -> contract error code. Built from real Telethon exception instances."""

import asyncio
import inspect

import pytest
from telethon import errors as tl
from telethon.errors import common, rpcbaseerrors, rpcerrorlist
from telethon.tl import functions

from agencyos_telegram import errors as worker_errors
from agencyos_telegram.errors import (
    ACCOUNT_RESTRICTED, CODE_EXPIRED, CODE_INVALID, ERROR_CODES, FORBIDDEN, NETWORK, NOT_FOUND,
    OUTCOME_UNKNOWN, PASSWORD_INVALID, PASSWORD_REQUIRED, PHONE_INVALID, PRIVATE, RATE_LIMITED,
    SESSION_INVALID, UNKNOWN, UNSUPPORTED, WorkerError, map_exception,
)

REQUEST = functions.contacts.SearchRequest("q", 1)


def make(cls):
    """An instance of any Telethon error class, whatever its constructor looks like."""
    for kwargs in ({"request": REQUEST}, {"request": REQUEST, "capture": 7}):
        try:
            return cls(**kwargs)
        except TypeError:
            continue
    return cls(REQUEST, "SOME_RPC_ERROR", 400)


def code_of(name_or_exc, **kwargs):
    exc = make(getattr(rpcerrorlist, name_or_exc)) if isinstance(name_or_exc, str) else name_or_exc
    return map_exception(exc, **kwargs).code


# Every Telethon class named in the contract's error table (plus the obvious siblings), by code.
CONTRACT = {
    SESSION_INVALID: [
        "AuthKeyUnregisteredError", "SessionRevokedError", "UserDeactivatedError", "UserDeactivatedBanError",
        "SessionExpiredError", "AuthKeyInvalidError", "AuthKeyPermEmptyError", "AuthKeyDuplicatedError",
    ],
    PHONE_INVALID: ["PhoneNumberInvalidError", "PhoneNumberUnoccupiedError", "PhoneNumberAppSignupForbiddenError"],
    CODE_INVALID: ["PhoneCodeInvalidError", "PhoneCodeEmptyError", "CodeInvalidError"],
    CODE_EXPIRED: ["PhoneCodeExpiredError", "PhoneHashExpiredError", "PhoneCodeHashEmptyError"],
    PASSWORD_REQUIRED: ["SessionPasswordNeededError"],
    PASSWORD_INVALID: ["PasswordHashInvalidError", "PasswordEmptyError", "SrpIdInvalidError"],
    ACCOUNT_RESTRICTED: ["PeerFloodError", "UserRestrictedError", "UserBannedInChannelError", "PhoneNumberBannedError", "UserKickedError"],
    FORBIDDEN: [
        "ChatAdminRequiredError", "ChatWriteForbiddenError", "ChatGuestSendForbiddenError", "ChatSendMediaForbiddenError",
        "ChatSendPlainForbiddenError", "ChatForbiddenError", "BroadcastForbiddenError", "ChannelBannedError",
        "UserNotParticipantError", "UserCreatorError", "UsersTooMuchError", "ChannelsTooMuchError",
        "UserChannelsTooMuchError", "ChannelsAdminPublicTooMuchError", "ChatAdminInviteRequiredError",
    ],
    NOT_FOUND: ["UsernameNotOccupiedError", "UsernameInvalidError", "ChannelInvalidError", "PeerIdInvalidError", "HideRequesterMissingError"],
    PRIVATE: ["ChannelPrivateError", "InviteHashExpiredError", "InviteHashInvalidError", "InviteHashEmptyError"],
    NETWORK: ["TimedOutError", "RpcCallFailError", "InterdcCallErrorError", "AuthRestartError", "CdnUploadTimeoutError"],
}


@pytest.mark.parametrize(
    ("name", "expected"), [(n, c) for c, names in CONTRACT.items() for n in names]
)
def test_contract_table(name, expected):
    mapped = map_exception(make(getattr(rpcerrorlist, name)))
    assert mapped.code == expected
    assert mapped.message and mapped.retry_after_seconds is None


@pytest.mark.parametrize(
    "name",
    ["FloodWaitError", "FloodPremiumWaitError", "SlowModeWaitError", "FloodTestPhoneWaitError", "TakeoutInitDelayError"],
)
def test_flood_waits_carry_their_seconds(name):
    cls = getattr(rpcerrorlist, name)
    mapped = map_exception(cls(request=REQUEST, capture=42))
    assert (mapped.code, mapped.retry_after_seconds) == (RATE_LIMITED, 42)
    assert map_exception(cls(request=REQUEST, capture=0)).retry_after_seconds == 1  # always set, at least 1
    assert map_exception(cls(request=REQUEST, capture=86400)).to_json()["retryAfterSeconds"] == 86400


@pytest.mark.parametrize("name", ["PhoneNumberFloodError", "PhonePasswordFloodError", "SendCodeUnavailableError"])
def test_floods_without_a_duration_still_say_when_to_come_back(name):
    mapped = map_exception(make(getattr(rpcerrorlist, name)))
    assert mapped.code == RATE_LIMITED and mapped.retry_after_seconds == worker_errors.UNTIMED_FLOOD_RETRY_SECONDS


def test_every_name_in_the_table_exists_in_the_pinned_telethon():
    names = set(worker_errors._BY_NAME) | set(worker_errors._TIMED_FLOOD) | set(worker_errors._UNTIMED_FLOOD)
    names |= set(worker_errors._WRITE_FORBIDDEN) | set(worker_errors._API_REJECTED)
    missing = [n for n in sorted(names) if not (hasattr(rpcerrorlist, n) or hasattr(common, n))]
    assert missing == []


def test_the_contract_listed_classes_exist():
    # The names the contract's error table mentions explicitly.
    for name in (
        "AuthKeyUnregisteredError", "SessionRevokedError", "UserDeactivatedError", "PhoneNumberInvalidError",
        "PhoneCodeInvalidError", "PhoneCodeExpiredError", "SessionPasswordNeededError", "PasswordHashInvalidError",
        "FloodWaitError", "PeerFloodError", "UserRestrictedError", "UserBannedInChannelError", "ChatWriteForbiddenError",
        "ChatAdminRequiredError", "UsernameNotOccupiedError", "ChannelPrivateError", "InviteHashExpiredError",
    ):
        assert hasattr(tl, name), name


# ---- totality -----------------------------------------------------------------------------------------------------
ALL_RPC_CLASSES = sorted(
    (c for n, c in inspect.getmembers(rpcerrorlist, inspect.isclass) if issubclass(c, rpcbaseerrors.RPCError)),
    key=lambda c: c.__name__,
)


def test_all_540_rpc_error_classes_are_covered_by_the_scan():
    assert len(ALL_RPC_CLASSES) >= 500


@pytest.mark.parametrize("sending", [False, True])
def test_every_telethon_rpc_error_maps_to_a_contract_code(sending):
    for cls in ALL_RPC_CLASSES:
        mapped = map_exception(make(cls), sending=sending)
        assert mapped.code in ERROR_CODES, cls.__name__
        assert mapped.message, cls.__name__
        if mapped.code == RATE_LIMITED:
            assert mapped.retry_after_seconds and mapped.retry_after_seconds >= 1, cls.__name__
        else:
            assert mapped.retry_after_seconds is None, cls.__name__
        if sending:
            # a definitive refusal stays what it is; only the doubtful cases become OUTCOME_UNKNOWN
            definitive = not issubclass(cls, (rpcbaseerrors.ServerError, rpcbaseerrors.TimedOutError))
            assert (mapped.code == OUTCOME_UNKNOWN) is (not definitive), cls.__name__


def test_real_rpc_error_strings_are_mapped_through_telethons_own_parser():
    class Rpc:
        def __init__(self, code, message):
            self.error_code, self.error_message = code, message

    cases = {
        (420, "FLOOD_WAIT_42"): (RATE_LIMITED, 42),
        (420, "FLOOD_WAIT_3600"): (RATE_LIMITED, 3600),
        (420, "SLOWMODE_WAIT_15"): (RATE_LIMITED, 15),
        (400, "PEER_FLOOD"): (ACCOUNT_RESTRICTED, None),
        (401, "AUTH_KEY_UNREGISTERED"): (SESSION_INVALID, None),
        (401, "SESSION_REVOKED"): (SESSION_INVALID, None),
        (401, "USER_DEACTIVATED"): (SESSION_INVALID, None),
        (401, "USER_DEACTIVATED_BAN"): (SESSION_INVALID, None),
        (401, "SESSION_PASSWORD_NEEDED"): (PASSWORD_REQUIRED, None),
        (400, "PHONE_NUMBER_INVALID"): (PHONE_INVALID, None),
        (400, "PHONE_CODE_INVALID"): (CODE_INVALID, None),
        (400, "PHONE_CODE_EXPIRED"): (CODE_EXPIRED, None),
        (400, "PASSWORD_HASH_INVALID"): (PASSWORD_INVALID, None),
        (400, "USERNAME_NOT_OCCUPIED"): (NOT_FOUND, None),
        (400, "CHANNEL_PRIVATE"): (PRIVATE, None),
        (400, "INVITE_HASH_EXPIRED"): (PRIVATE, None),
        (403, "CHAT_WRITE_FORBIDDEN"): (FORBIDDEN, None),
        (403, "USER_RESTRICTED"): (ACCOUNT_RESTRICTED, None),
        (400, "USER_BANNED_IN_CHANNEL"): (ACCOUNT_RESTRICTED, None),
        (400, "CHAT_ADMIN_REQUIRED"): (FORBIDDEN, None),
        (500, "INTERNAL"): (NETWORK, None),
        (-503, "Timeout"): (NETWORK, None),
        (400, "SOMETHING_TELEGRAM_ADDED_LATER"): (UNKNOWN, None),
        (403, "SOMETHING_FORBIDDEN_ADDED_LATER"): (FORBIDDEN, None),
        (401, "SOMETHING_UNAUTHORIZED_ADDED_LATER"): (SESSION_INVALID, None),
        (420, "FLOOD_SOMETHING_ADDED_LATER"): (RATE_LIMITED, None),
    }
    for (status, message), (code, seconds) in cases.items():
        mapped = map_exception(tl.rpc_message_to_error(Rpc(status, message), REQUEST))
        assert mapped.code == code, message
        if seconds is not None:
            assert mapped.retry_after_seconds == seconds, message


# ---- non-Telethon failures ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "exc",
    [
        ConnectionResetError("reset"), ConnectionRefusedError(), BrokenPipeError(), OSError("network down"),
        TimeoutError(), asyncio.TimeoutError(), EOFError(), asyncio.IncompleteReadError(b"", 5),
        common.ReadCancelledError(), common.InvalidBufferError(b"\x00\x00\x00\x00"),
    ],
    ids=lambda e: type(e).__name__,
)
def test_network_level_failures(exc):
    assert map_exception(exc).code == NETWORK


def test_invalid_buffer_codes():
    from struct import pack

    assert map_exception(common.InvalidBufferError(pack("<i", -404))).code == SESSION_INVALID  # forgotten auth key
    throttled = map_exception(common.InvalidBufferError(pack("<i", -429)))
    assert throttled.code == RATE_LIMITED and throttled.retry_after_seconds > 0


def test_a_migrate_error_means_try_again_on_the_new_data_center():
    for name in ("PhoneMigrateError", "UserMigrateError", "NetworkMigrateError", "FileMigrateError", "StatsMigrateError"):
        assert code_of(name) == NETWORK, name


def test_unsupported_when_telethon_is_too_old():
    assert map_exception(common.TypeNotFoundError(123, b"")).code == UNSUPPORTED
    assert code_of("ConnectionLayerInvalidError") == UNSUPPORTED
    assert code_of("UpdateAppToLoginError") == UNSUPPORTED


def test_unknown_messages_are_sanitized():
    secret = "0123456789abcdef0123456789abcdef"
    mapped = map_exception(RuntimeError(f"boom apiHash={secret} session=1AbC phone=+4915112345678"))
    assert mapped.code == UNKNOWN and mapped.message == "Unexpected error (RuntimeError)."
    odd = map_exception(rpcbaseerrors.BadRequestError(REQUEST, "text with spaces & secret=" + secret, 400))
    assert secret not in odd.message and odd.code == UNKNOWN
    assert map_exception(rpcbaseerrors.BadRequestError(REQUEST, "NEW_ERROR_2", 400)).message == (
        "Telegram rejected the request (NEW_ERROR_2)."
    )
    assert map_exception(ValueError("x" * 500)).message == "Unexpected error (ValueError)."


def test_api_rejection_is_explained_without_echoing_anything():
    for name in ("ApiIdInvalidError", "ConnectionApiIdInvalidError"):
        mapped = map_exception(make(getattr(rpcerrorlist, name)))
        assert mapped.code == UNKNOWN and "API" in mapped.message


def test_worker_errors_pass_through_unchanged():
    original = WorkerError(PRIVATE, "x")
    assert map_exception(original) is original
    assert map_exception(original, sending=True) is original


# ---- sending ---------------------------------------------------------------------------------------------------------------------
def test_an_interrupted_send_is_outcome_unknown():
    for exc in (ConnectionResetError(), OSError(), asyncio.TimeoutError(), EOFError(), RuntimeError("late"), make(rpcerrorlist.RpcCallFailError), make(rpcerrorlist.TimedOutError)):
        mapped = map_exception(exc, sending=True)
        assert mapped.code == OUTCOME_UNKNOWN, type(exc).__name__
        assert "check the community" in mapped.message and "may or may not" in mapped.message


def test_a_definitive_refusal_is_not_an_unknown_outcome():
    assert code_of("FloodWaitError", sending=True) == RATE_LIMITED
    assert code_of("PeerFloodError", sending=True) == ACCOUNT_RESTRICTED
    assert code_of("ChatWriteForbiddenError", sending=True) == FORBIDDEN
    assert code_of("ChatAdminRequiredError", sending=True) == FORBIDDEN
    assert code_of("AuthKeyUnregisteredError", sending=True) == SESSION_INVALID
    assert code_of("MessageTooLongError", sending=True) == UNKNOWN


def test_write_errors_mean_account_restricted_when_the_account_is_banned_there():
    for name in ("ChatWriteForbiddenError", "ChatSendPlainForbiddenError", "ChatSendMediaForbiddenError", "ChatRestrictedError"):
        assert code_of(name, restricted=True) == ACCOUNT_RESTRICTED, name
        assert code_of(name, restricted=False) == FORBIDDEN, name
    assert code_of("ChatAdminRequiredError", restricted=True) == FORBIDDEN  # only write errors are upgraded


def test_worker_error_rules():
    with pytest.raises(ValueError):
        WorkerError("NOT_A_CODE", "x")
    assert WorkerError(RATE_LIMITED, "x").retry_after_seconds == 1
    assert WorkerError(RATE_LIMITED, "x", 0).to_json()["retryAfterSeconds"] == 1
    assert "retryAfterSeconds" not in WorkerError(NETWORK, "x", 30).to_json()
    assert ERROR_CODES == {
        "SESSION_INVALID", "PHONE_INVALID", "CODE_INVALID", "CODE_EXPIRED", "PASSWORD_REQUIRED",
        "PASSWORD_INVALID", "LOGIN_NOT_FOUND", "RATE_LIMITED", "ACCOUNT_RESTRICTED", "FORBIDDEN", "NOT_FOUND",
        "PRIVATE", "INVALID_REF", "NETWORK", "OUTCOME_UNKNOWN", "UNSUPPORTED", "UNKNOWN",
    }  # exactly the contract's table: no invented codes
