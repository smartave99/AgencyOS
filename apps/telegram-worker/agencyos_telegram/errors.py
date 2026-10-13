"""Telethon (and network) exceptions -> the error codes of the worker contract.

Nothing in here sleeps, retries or re-routes: a restriction is reported, never worked around.
Every message returned to callers is a fixed string written here; exception text is never
copied into a response, because it could carry request details.
"""

from __future__ import annotations

import asyncio
import re

from telethon import errors as tl_errors
from telethon.errors import rpcbaseerrors as tl_base

# ---- contract error codes -------------------------------------------------------------------
SESSION_INVALID = "SESSION_INVALID"
PHONE_INVALID = "PHONE_INVALID"
CODE_INVALID = "CODE_INVALID"
CODE_EXPIRED = "CODE_EXPIRED"
PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
PASSWORD_INVALID = "PASSWORD_INVALID"
LOGIN_NOT_FOUND = "LOGIN_NOT_FOUND"
RATE_LIMITED = "RATE_LIMITED"
ACCOUNT_RESTRICTED = "ACCOUNT_RESTRICTED"
FORBIDDEN = "FORBIDDEN"
NOT_FOUND = "NOT_FOUND"
PRIVATE = "PRIVATE"
INVALID_REF = "INVALID_REF"
NETWORK = "NETWORK"
OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN"
UNSUPPORTED = "UNSUPPORTED"
UNKNOWN = "UNKNOWN"

ERROR_CODES = frozenset(
    {
        SESSION_INVALID, PHONE_INVALID, CODE_INVALID, CODE_EXPIRED, PASSWORD_REQUIRED,
        PASSWORD_INVALID, LOGIN_NOT_FOUND, RATE_LIMITED, ACCOUNT_RESTRICTED, FORBIDDEN,
        NOT_FOUND, PRIVATE, INVALID_REF, NETWORK, OUTCOME_UNKNOWN, UNSUPPORTED, UNKNOWN,
    }
)

# Telegram gives no duration for these flood-style errors; this is a deliberately long floor so
# a caller does not hammer the account. It is a hint, not a promise.
UNTIMED_FLOOD_RETRY_SECONDS = 3600
TRANSPORT_THROTTLE_RETRY_SECONDS = 60


class WorkerError(Exception):
    """A domain failure that is reported as HTTP 200 {"ok": false, "error": {...}}."""

    def __init__(self, code: str, message: str, retry_after_seconds: int | None = None):
        if code not in ERROR_CODES:
            raise ValueError(f"unknown error code {code!r}")
        if code == RATE_LIMITED:
            retry_after_seconds = max(1, int(retry_after_seconds or 1))
        else:
            retry_after_seconds = None
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after_seconds = retry_after_seconds

    def to_json(self) -> dict:
        error: dict = {"code": self.code, "message": self.message}
        if self.retry_after_seconds is not None:
            error["retryAfterSeconds"] = self.retry_after_seconds
        return error


class BadRequest(Exception):
    """A malformed request: HTTP 400 with error.code BAD_REQUEST (never a Telegram failure)."""


# ---- the table: Telethon class name -> (code, fixed message) --------------------------------
_GROUPS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (SESSION_INVALID, "The session was revoked, expired or was never authorized.", (
        "AuthKeyUnregisteredError", "AuthKeyInvalidError", "AuthKeyPermEmptyError",
        "AuthKeyDuplicatedError", "SessionRevokedError", "SessionExpiredError",
        "UserDeactivatedError", "UserDeactivatedBanError",
    )),
    (PHONE_INVALID, "Telegram does not accept this phone number.", (
        "PhoneNumberInvalidError", "PhoneNumberUnoccupiedError", "PhoneNotOccupiedError",
        "PhoneNumberAppSignupForbiddenError", "PhoneNumberOccupiedError",
    )),
    (CODE_INVALID, "The login code is wrong.", (
        "PhoneCodeInvalidError", "PhoneCodeEmptyError", "CodeInvalidError", "CodeEmptyError",
    )),
    (CODE_EXPIRED, "The login code expired. Start the login again.", (
        "PhoneCodeExpiredError", "PhoneHashExpiredError", "PhoneCodeHashEmptyError",
        "CodeHashInvalidError", "EmailHashExpiredError",
    )),
    (PASSWORD_REQUIRED, "Two-step verification is enabled: a password is required.", (
        "SessionPasswordNeededError",
    )),
    (PASSWORD_INVALID, "The two-step verification password is wrong.", (
        "PasswordHashInvalidError", "PasswordEmptyError", "SrpIdInvalidError",
        "SrpPasswordChangedError",
    )),
    (ACCOUNT_RESTRICTED, "Telegram has limited this account. Nothing was retried or re-routed.", (
        "PeerFloodError", "UserRestrictedError", "UserBannedInChannelError",
        "PhoneNumberBannedError", "UserKickedError",
    )),
    (FORBIDDEN, "This account is not allowed to do that here.", (
        "ChatAdminRequiredError", "ChatAdminInviteRequiredError", "ChatForbiddenError",
        "ChatGuestSendForbiddenError", "ChatSendGameForbiddenError", "ChatSendInlineForbiddenError",
        "ChatSendVoicesForbiddenError", "ChatSendPollForbiddenError", "ChatSendStickersForbiddenError",
        "ChatSendGifsForbiddenError", "ChatSendMediaForbiddenError", "ChatSendPhotosForbiddenError",
        "ChatSendVideosForbiddenError", "ChatSendPlainForbiddenError", "ChatWriteForbiddenError",
        "ChatRestrictedError", "BroadcastForbiddenError", "ChannelBannedError", "RightForbiddenError",
        "UserNotParticipantError", "UserCreatorError", "UsersTooMuchError", "ChannelsTooMuchError",
        "UserChannelsTooMuchError", "ChannelsAdminPublicTooMuchError",
        "ChannelsAdminLocatedTooMuchError", "PremiumAccountRequiredError", "SessionTooFreshError",
        "PasswordTooFreshError", "FreshChangeAdminsForbiddenError", "PasswordRequiredError",
        "PasswordMissingError", "MessageDeleteForbiddenError", "UserBlockedError",
        "UserIsBlockedError", "YouBlockedUserError", "UserPrivacyRestrictedError",
        "ApiIdPublishedFloodError", "InviteRequestSentError", "ChatForwardsRestrictedError",
        "PinRestrictedError", "ChannelTooLargeError", "ChannelTooBigError", "ChatTooBigError",
        "SlowModeMultiMsgsDisabledError", "VoiceMessagesForbiddenError", "NotAllowedError",
    )),
    (NOT_FOUND, "Nothing matches that name or link.", (
        "UsernameNotOccupiedError", "UsernameInvalidError", "ChannelInvalidError",
        "ChannelIdInvalidError", "ChatIdInvalidError", "ChatInvalidError", "PeerIdInvalidError",
        "UserIdInvalidError", "UserInvalidError", "HideRequesterMissingError",
        "ParticipantJoinMissingError", "MsgIdInvalidError", "MessageIdInvalidError",
        "ChannelPublicGroupNaError", "UserDeletedError",
    )),
    (PRIVATE, "This community is private or the invite is invalid: there is nothing public to show.", (
        "ChannelPrivateError", "InviteHashExpiredError", "InviteHashInvalidError",
        "InviteHashEmptyError", "InviteRevokedMissingError",
    )),
    (UNSUPPORTED, "This is not available for this kind of community or this Telethon version.", (
        "TypeNotFoundError", "ConnectionLayerInvalidError", "UpdateAppToLoginError",
        "ChannelForumMissingError", "MegagroupRequiredError", "BroadcastRequiredError",
        "ChatDiscussionUnallowedError", "FilterNotSupportedError", "PollUnsupportedError",
    )),
    (NETWORK, "Connection problem. It is safe to retry.", (
        "AuthRestartError", "TimedOutError", "TimeoutError", "TimedoutError", "InterdcCallErrorError",
        "InterdcCallRichErrorError", "RpcCallFailError", "RpcMcgetFailError", "HistoryGetFailedError",
        "CdnUploadTimeoutError", "WorkerBusyTooLongRetryError", "ChpCallFailError",
    )),
)

# Errors that carry a Telegram-supplied wait (`.seconds`).
_TIMED_FLOOD = (
    "FloodWaitError", "FloodPremiumWaitError", "SlowModeWaitError", "FloodTestPhoneWaitError",
    "TakeoutInitDelayError",
)
# Flood-style errors Telegram gives no duration for.
_UNTIMED_FLOOD = ("PhoneNumberFloodError", "PhonePasswordFloodError", "SendCodeUnavailableError")

# Write-permission errors that mean "this account is banned/restricted there" when the caller
# knows the account itself has a ban in that community (hint from the entity), else FORBIDDEN.
_WRITE_FORBIDDEN = frozenset(
    {
        "ChatWriteForbiddenError", "ChatRestrictedError", "ChatSendMediaForbiddenError",
        "ChatSendPhotosForbiddenError", "ChatSendVideosForbiddenError", "ChatSendPlainForbiddenError",
        "ChatSendGifsForbiddenError", "ChatSendStickersForbiddenError", "ChatSendPollForbiddenError",
        "ChatSendVoicesForbiddenError", "ChatSendGameForbiddenError", "ChatSendInlineForbiddenError",
        "ChatGuestSendForbiddenError",
    }
)

_API_REJECTED = ("ApiIdInvalidError", "ConnectionApiIdInvalidError")

_BY_NAME: dict[str, tuple[str, str]] = {}
for _code, _message, _names in _GROUPS:
    for _name in _names:
        _BY_NAME[_name] = (_code, _message)

_RPC_NAME = re.compile(r"^[A-Z0-9_]{1,64}$")
_CLASS_NAME = re.compile(r"^[A-Za-z0-9_]{1,64}$")

# Network-level exceptions raised by sockets/asyncio/Telethon's transport (not by Telegram).
_NETWORK_EXCEPTIONS: tuple[type[BaseException], ...] = (
    ConnectionError, OSError, EOFError, asyncio.TimeoutError, asyncio.IncompleteReadError,
    tl_errors.common.ReadCancelledError,
)


def _timed_seconds(exc: BaseException) -> int:
    try:
        return max(1, int(getattr(exc, "seconds", 0) or 0))
    except (TypeError, ValueError):
        return 1


def _is_definitive_rpc(exc: BaseException) -> bool:
    """True when Telegram itself answered and refused: the request did not take effect."""
    if not isinstance(exc, tl_base.RPCError):
        return False
    return not isinstance(exc, (tl_base.ServerError, tl_base.TimedOutError))


def _rpc_label(exc: BaseException) -> str:
    message = getattr(exc, "message", None)
    if isinstance(message, str) and _RPC_NAME.match(message):
        return message
    name = type(exc).__name__
    return name if _CLASS_NAME.match(name) else "Error"


def _classify(exc: BaseException, *, restricted: bool) -> WorkerError:
    # 1. the most specific listed class wins (walk the MRO)
    for klass in type(exc).__mro__:
        name = klass.__name__
        if name in _TIMED_FLOOD:
            return WorkerError(RATE_LIMITED, "Telegram asked this account to wait.", _timed_seconds(exc))
        if name in _UNTIMED_FLOOD:
            return WorkerError(
                RATE_LIMITED, "Telegram limited this request and gave no duration.",
                UNTIMED_FLOOD_RETRY_SECONDS,
            )
        if name in _API_REJECTED:
            return WorkerError(UNKNOWN, "Telegram rejected the API ID / API hash.")
        if name in _WRITE_FORBIDDEN and restricted:
            code, message = _BY_NAME["PeerFloodError"]
            return WorkerError(code, message)
        hit = _BY_NAME.get(name)
        if hit is not None:
            return WorkerError(hit[0], hit[1])

    # 2. transport-level problems
    if isinstance(exc, tl_errors.common.InvalidBufferError):
        code = getattr(exc, "code", None)
        if code == 404:
            return WorkerError(SESSION_INVALID, _BY_NAME["AuthKeyUnregisteredError"][1])
        if code == 429:
            return WorkerError(
                RATE_LIMITED, "Telegram throttled this connection.", TRANSPORT_THROTTLE_RETRY_SECONDS
            )
        return WorkerError(NETWORK, _BY_NAME["TimedOutError"][1])
    if isinstance(exc, _NETWORK_EXCEPTIONS):
        return WorkerError(NETWORK, _BY_NAME["TimedOutError"][1])

    # 3. families of RPC errors that are not listed individually
    if isinstance(exc, tl_base.FloodError):
        return WorkerError(RATE_LIMITED, "Telegram asked this account to wait.", _timed_seconds(exc))
    if isinstance(exc, tl_base.UnauthorizedError):
        return WorkerError(SESSION_INVALID, _BY_NAME["AuthKeyUnregisteredError"][1])
    if isinstance(exc, tl_base.ForbiddenError):
        return WorkerError(FORBIDDEN, _BY_NAME["ChatAdminRequiredError"][1])
    if isinstance(exc, tl_base.NotFoundError):
        return WorkerError(NOT_FOUND, _BY_NAME["UsernameNotOccupiedError"][1])
    if isinstance(exc, (tl_base.ServerError, tl_base.TimedOutError, tl_base.InvalidDCError)):
        # (a *_MIGRATE error means the request went to the wrong data center and was not run;
        # Telethon has already switched, so asking again works)
        return WorkerError(NETWORK, _BY_NAME["TimedOutError"][1])
    if isinstance(exc, tl_base.RPCError):
        return WorkerError(UNKNOWN, f"Telegram rejected the request ({_rpc_label(exc)}).")

    name = type(exc).__name__
    return WorkerError(UNKNOWN, f"Unexpected error ({name if _CLASS_NAME.match(name) else 'Error'}).")


def map_exception(
    exc: BaseException, *, sending: bool = False, restricted: bool = False
) -> WorkerError:
    """Translate any exception to a WorkerError.

    sending     the exception happened during a request that must not be repeated (a message send,
                or creating a community). Unless Telegram itself answered with a definitive
                refusal, it may have taken effect, so the result is OUTCOME_UNKNOWN, which callers
                must never retry automatically.
    restricted  the caller knows from the community entity that this account carries a ban or
                restriction there; write-permission errors then mean ACCOUNT_RESTRICTED.
    """
    if isinstance(exc, WorkerError):
        return exc
    mapped = _classify(exc, restricted=restricted)
    if sending and not _is_definitive_rpc(exc):
        return WorkerError(
            OUTCOME_UNKNOWN,
            "The connection was interrupted during a request that must not be repeated blindly. It may "
            "or may not have taken effect: check the community before trying again.",
        )
    return mapped
