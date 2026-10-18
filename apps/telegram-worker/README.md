# AgencyOS Telegram user-account worker

`agencyos_telegram` is a small, **loopback-only, token-authenticated JSON-over-HTTP** process around
[Telethon](https://docs.telethon.dev/) (MTProto user accounts). The NestJS backend supervises it and sends
each account's credentials with every request; the worker keeps nothing on disk. The binding specification is
[`docs/TELEGRAM_WORKER_CONTRACT.md`](../../docs/TELEGRAM_WORKER_CONTRACT.md) and this code follows it. The Bot API
integration (`TelegramGateway`) is a different provider and is untouched.

What it does: public community research, deliberate joining, creating and managing communities the operator owns
or administers, and sending an approved ad to one community per request.

What it deliberately cannot do (the interface has no way to express any of it, and `tests/test_guard.py` fails the
build if one appears):

* list the people in a community, look up other users, read phone numbers or contact details;
* add or invite anyone, or accept a list of users to add or message;
* message anybody who did not message first;
* switch, rotate or fall back to another account, or retry a request as another account;
* work around a FloodWait, PeerFlood or ban (they are returned as `RATE_LIMITED` / `ACCOUNT_RESTRICTED`), or
  anything CAPTCHA-related;
* sleep through a FloodWait, or retry a send (an interrupted send is `OUTCOME_UNKNOWN`).

The only user-level data it ever returns is the account's own profile (`Me`, phone masked) and, for a community
the account administers, the pending join-request entries `{userId, username?, date, bio?}`.

## Layout

```
agencyos_telegram/
  __main__.py        start-up, port/token/env handling, signals, graceful shutdown
  server.py          asyncio HTTP server: token, Host check, body limit, correlation id, in-flight limit
  service.py         route table, pending logins (10 min), refresh spacing/early stop, timeouts
  schemas.py         strict request validation (types, bounds, unknown fields -> 400)
  errors.py          Telethon exception -> contract error code (exhaustive table), WorkerError, BadRequest
  backend.py         TelegramBackend: the whole interface to Telegram, plus Account/result dataclasses
  telethon_backend.py   the real implementation (import-safe, never connects until used)
  telethon_convert.py   pure Telethon-entity -> Community / relation / canPost / Me conversions
  fake_backend.py    in-memory backend for tests (and `--backend memory` for supervisor integration tests)
  refs.py            @name / name / t.me link / invite link -> Ref, else INVALID_REF
  ads.py             Telegram-HTML validation, media confinement, the exact caption/message split
  models.py          Community / CanPost / Me shapes and phone masking
  limits.py          bounds, request spacing, the idle-client pool keyed by sha256(session)
  logs.py            JSON logging to stderr with secret redaction
tests/               pytest suite (no network, no Telegram account)
requirements.lock.txt  exact runtime dependencies, for vendoring wheels
```

## Running it

Python 3.11 or newer.

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.lock.txt        # Windows: .venv\Scripts\pip
export AGENCYOS_WORKER_TOKEN="$(python -c 'import secrets; print(secrets.token_hex(32))')"
export AGENCYOS_MEDIA_ROOT=/path/to/uploads            # optional; media is refused when unset
.venv/bin/python -m agencyos_telegram --port 0         # 0 = let the OS pick a free port
```

The worker prints exactly one JSON line on **stdout** when it is ready, so a supervisor can read the port:

```
{"event":"listening","port":54321}
```

Everything else (logs) goes to **stderr**, one JSON object per line. Connect to `http://127.0.0.1:<port>`, not
`localhost`: the worker binds IPv4 loopback only, and some HTTP clients try `::1` first.

### Environment

| variable | meaning |
| --- | --- |
| `AGENCYOS_WORKER_TOKEN` | **Required**, at least 16 characters (the supervisor should generate 32 random bytes). Sent by the caller as `X-AgencyOS-Worker-Token` on every request except `GET /health`; compared with `hmac.compare_digest`. |
| `AGENCYOS_WORKER_PORT` | The port, when `--port` is not given. **No default**: with neither, the worker exits with status 2 and a clear message. `0` picks a free port. |
| `AGENCYOS_MEDIA_ROOT` | Directory that `ad.media[].path` must resolve into (after `os.path.realpath`, so symlinks cannot escape). Media is refused (`400`) when unset. |

Exit status: `0` after SIGTERM/SIGINT (and `CTRL_BREAK_EVENT` on Windows) within 5 s; `2` for a missing/invalid
port or token.

`--backend memory` starts the in-memory backend instead of Telethon (never touches the network), with demo data
documented at the top of `fake_backend.py` (session `memory-session-1`, login code `12345`). It exists so the
NestJS side can run integration tests without a Telegram account; `/health` reports `"backend": "memory"`, and the
process logs a warning at start. Do not ship it enabled.

### Supervising it (notes for the backend)

* Environment mapping. The backend's client (`TelegramUserGateway`) reads `AGENCYOS_TELEGRAM_WORKER_URL`
  (`http://127.0.0.1:<port>`) and `AGENCYOS_TELEGRAM_WORKER_TOKEN`; the worker reads the same secret as
  `AGENCYOS_WORKER_TOKEN`, so whoever starts the child must pass that value under the worker's name, pass the
  port with `--port` / `AGENCYOS_WORKER_PORT`, and set `AGENCYOS_MEDIA_ROOT` to the backend's `UPLOAD_DIRECTORY`
  (the gateway sends absolute media paths under it). The worker does not read the backend's variable names.
* Windows: start the child with `CREATE_NEW_PROCESS_GROUP` so `CTRL_BREAK_EVENT` can be delivered to it.
* A request that the worker never answered (connection lost) on `/v1/messages/send` must be treated like
  `OUTCOME_UNKNOWN`: check the community, do not retry blindly.
* Every transport failure (`400`, `401`, `404`, `405`, `413`, `421`) carries `error.code = "BAD_REQUEST"`; use the
  HTTP status to tell them apart. `500` carries `"INTERNAL"`; `503` is a request cut off by shutdown.
* The worker is stateless apart from its connected clients and pending logins. After a restart every pending
  `loginId` is gone (`LOGIN_NOT_FOUND`) and the first request per account reconnects.

## Where the contract is silent (decisions made, all visible in the code)

* **`timeoutSeconds`** in `/v1/login/start` is how long the worker keeps that `loginId` (600), not Telegram's
  code-resend timer.
* **A typo is not a restart.** On `/v1/login/code` a `CODE_INVALID` keeps the pending login so the code can
  be typed again; on `/v1/login/password` a `PASSWORD_INVALID` keeps it likewise. At most 5 wrong attempts
  (codes and passwords together) are allowed per `loginId`: the 5th returns the same error code with a message
  saying to start the login again, and deletes the login. **Every other error** (`CODE_EXPIRED`,
  `RATE_LIMITED`, `NETWORK`, `SESSION_INVALID`, `PHONE_INVALID`, `UNKNOWN`, a timeout, ...) deletes it, as do
  success, cancel and expiry. `password_required` is not an error and keeps it. The ten minutes run from
  `login/start` and a wrong attempt does not extend them. Unknown or expired ids, including on `/cancel`, are
  `LOGIN_NOT_FOUND`. The in-memory backend treats `12345` as the right code, `00000` as an expired one and
  anything else as wrong.
* **`telegramId`** is Telethon's raw numeric id (`entity.id`). The Bot API form is `-100<id>` for supergroups and
  channels and `-<id>` for basic groups. For an invite-link preview of a community the account has not joined,
  Telegram gives no id, so `telegramId` is `null` (and `username`/`link` are `null`).
* **`kind`**: basic group `GROUP`; megagroup (including gigagroup) `SUPERGROUP`; broadcast channel
  `BROADCAST_CHANNEL`; a channel that is neither flag `CHANNEL`.
* **`create` with `kind: "group"` makes a supergroup.** Telegram's basic-group call needs other users named in the
  request, which this worker never does.
* **Relation** comes from the flags the entity carries for this account: `creator` -> `OWNED`; `admin_rights` ->
  `ADMINISTERED`; an active `banned_rights.view_messages`, a `*Forbidden` entity, or `restricted` with a stated
  reason -> `RESTRICTED`; `left` -> `PUBLIC_NOT_JOINED` (public) or `UNAVAILABLE`; a deactivated/migrated basic
  group -> `UNAVAILABLE`; otherwise `MEMBER`. An invite-link preview is `PUBLIC_NOT_JOINED`.
* **`canPost`** is derived the same way (no participant lookup): in a broadcast channel `sendMessages`,
  `sendMedia` and `postMessagesInChannel` all equal "creator or admin with post_messages"; in a group
  administrators may send, others follow the account's own and the default banned rights (including their
  expiry). `postMessagesInChannel` is `false` outside broadcast channels.
* **Booleans are never null** (`verified`, `scam`, `fake`, `joinRequestRequired`, `hasLinkedChat`): `false` when
  Telegram shows nothing (for example an invite-link preview has no linked-chat flag).
* **`memberCount`**, `description`, `slowModeSeconds` are only what Telegram returned: basic groups are never
  fully fetched (the full record carries a participant list), so their `description` is `null`.
* **Additive fields** (a lenient reader ignores them): the applied `limit` is echoed by search/messages/mine/
  join-requests; `create` and `send` may carry `warnings: ["USERNAME_NOT_SET: ...", "INVITE_LINK_NOT_CREATED:
  ...", "BUTTON_NOT_DELIVERED: ..."]` when something minor failed after the main action succeeded;
  `/health` adds `backend`.
* **`refresh`** stops early (remaining refs get the same error) on `RATE_LIMITED`, and also on `SESSION_INVALID`,
  `ACCOUNT_RESTRICTED` and `NETWORK`, because every further lookup would fail the same way. A malformed ref is
  `INVALID_REF` for that ref only and costs no lookup or spacing.
* **A send that fails after part of the ad is live** (for example the text after the media) is `OUTCOME_UNKNOWN`,
  with the ids already sent in the message, never `RATE_LIMITED`: a caller must not simply resend.
* **`messages`** returns only public communities (a community without a username is `PRIVATE`, even if the
  account is a member), skips media-only and service messages, and its `limit` bounds the messages fetched.
  **`mine`**'s `limit` bounds the dialogs scanned (people and bots are skipped), so it can return fewer.
* **Decide a join request** looks for the requester in the administrator's pending list (newest first, at most
  three pages of 100) because Telegram needs the requester's access hash; later entries give `NOT_FOUND`.
* **Ad HTML** is limited to `b i u s code pre a` (`<a>` needs one http(s) `href`; `<code class="language-x">`
  inside `<pre>` is allowed); anything else is `400`. Lengths are measured in visible UTF-16 units, as Telegram
  does: caption <= 1024, message <= 4096, media first and the text as a reply when it does not fit; at most 10
  media; a button cannot be combined with an album.
* **Timeouts**: 60 s per Telegram operation, 15 min for a send. A timeout is `NETWORK`, or `OUTCOME_UNKNOWN` for a
  send.
* **`create` is treated like a send**: it is not idempotent, so an interrupted or timed-out creation request is
  `OUTCOME_UNKNOWN` (the community may exist; check the account's communities) rather than a retryable `NETWORK`.
  Failures after the community exists (username, invite link) become `warnings`.
* **Weak tokens** (under 16 characters) are refused at start.

## Telethon configuration

The clients are built so that Telethon itself hides nothing from the caller (see `telethon_backend.new_client`):

* `flood_sleep_threshold=0`: every FloodWait is raised and returned as `RATE_LIMITED` with `retryAfterSeconds`;
  Telethon also refuses locally, without asking Telegram, to repeat a request type that is still flood-waited.
* `request_retries=0` and `auto_reconnect=False`: nothing is repeated behind our back; a dropped connection fails the
  request and the next lease reconnects explicitly. The one exception is a *login* client (`request_retries=1`),
  so that `PHONE_MIGRATE` is followed to the right data center.
* `receive_updates=False`; sessions are `StringSession` (memory only); no `cryptg` (compiled).
* One client per account, kept in memory under `sha256(session)` and disconnected after 120 s idle; it is never
  disconnected while serving a request.

## Security and logging

* Secrets (`apiHash`, `session`, login code, two-step password, phone) are never written to disk, to a log or to
  a returned message. Request bodies and message text are not logged at all; each log line is also scrubbed against
  the secret values of its own request (raw and JSON-escaped) and against patterns (`+<digits>` phones, long
  opaque tokens), and exceptions are logged as class plus code locations only. Phones appear masked
  (`+49•••••1234`). `tests/test_logging.py` runs a full login + send through the real server and searches the
  captured output for every secret.
* Failed token attempts are logged without the token. Error messages returned to callers are fixed strings.
* `Account.__repr__`, `LoginOutcome.__repr__` hide secrets.

## Tests

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.lock.txt pytest==9.1.1
python -m pytest apps/telegram-worker/tests -q          # from the repository root
python -m compileall -q apps/telegram-worker/agencyos_telegram
```

No test needs the network or a Telegram account. What they cover:

* `test_server`, `test_endpoints`, `test_login`, `test_send`: the real HTTP server on port 0 with the in-memory
  backend: health, token, Host, body limit, correlation id, every endpoint's success and error mapping, bounds
  and clamping, the 4-in-flight limit, login expiry on an injectable clock, media confinement, graceful drain.
* `test_errors`: every Telethon RPC error class (all 540) maps to a contract code; the contract's classes are
  asserted one by one; real RPC strings are fed through Telethon's own parser.
* `test_telethon_backend`, `test_telethon_convert`: `TelethonBackend` against a stub `TelegramClient`. The stub uses
  real Telethon TL types, serialises every request it receives, checks every helper call against the real
  `TelegramClient` signatures, and **fails if the backend ever issues a request that lists or adds people**.
* `test_logging`, `test_guard`, `test_process`: redaction, the structural "no people operations" guard, and the
  module run as a subprocess (SIGTERM/SIGINT exit 0 in under 5 s; exit 2 without port/token). The Windows
  `CTRL_BREAK_EVENT` test is skipped on other platforms.

The stub verifies that the worker sends well-formed requests built as intended; it cannot show that Telegram
behaves as assumed. That is the list below.

## Dependencies

All runtime dependencies are pure Python. See `requirements.lock.txt`: it carries SHA-256 hashes, and the Windows installer installs from it with `pip install --require-hashes --no-deps --target <site-packages>`. pyaes has only a source distribution on PyPI, so pip builds it there (the build tools it fetches are used only for that build and are not shipped).

| package | version | Windows installer |
| --- | --- | --- |
| telethon | 1.45.0 | `py3-none-any` wheel on PyPI |
| rsa | 4.9.1 | `py3-none-any` wheel on PyPI |
| pyasn1 | 0.6.4 | `py3-none-any` wheel on PyPI |
| pyaes | 1.6.1 | **sdist only on PyPI** (single pure-Python package): run `pip wheel --no-deps pyaes==1.6.1` once at installer-build time and vendor the resulting `py3-none-any` wheel |

Dev only: `pytest==9.1.1`. `cryptg` (optional Telethon speed-up) is compiled and intentionally not used; Telethon
falls back to `pyaes`, which is slower for large uploads.

## LIVE_VERIFICATION_REQUIRED

Everything below is implemented from Telethon 1.45.0's API and Telegram's documented behaviour, and exercised
against stubs only. **None of it has been run against real Telegram with a real account.** Treat each item as
unverified until someone has done it.

**Login and sessions**

1. The whole login: `send_code_request` -> `sign_in(code)` -> `SessionPasswordNeeded` -> `sign_in(password)`, the
   returned `StringSession` working in a later process, and `codeDelivery`/`Me` values for real accounts. Also
   that Telegram accepts a second `sign_in` with the same `phone_code_hash` after `PHONE_CODE_INVALID`, and a
   second password try after `PASSWORD_HASH_INVALID`, on the same connection (the retry relies on both), and what
   up to 5 wrong tries do to the account's flood limits.
2. `PHONE_MIGRATE` being followed on the first call for a phone that lives on another data center (login clients
   allow one repeat). Also that `UserMigrate`/`NetworkMigrate` on a saved session surfaces as `NETWORK` and the next
   call succeeds.
3. Login variants the code does not handle: e-mail-code or payment-required `SentCode` types, sign-up for an
   unregistered number (mapped to `PHONE_INVALID`), repeated-attempt floods (`PHONE_NUMBER_FLOOD` ->
   `RATE_LIMITED` with a conservative 3600 s, which is our floor, not Telegram's number).
4. `AuthKeyDuplicated` and revoked-session behaviour (a session used from two places), `logout` ending the
   authorization at Telegram, and that `get_me()` returns `None` (not an exception) for every kind of dead session.
5. `device_model="AgencyOS"` / `app_version` showing in the account's active-sessions list and not tripping any
   Telegram abuse check.

**Reading communities**

6. Which flags real entities carry **for a non-member**: `Channel.left`, `banned_rights`, `restricted`,
   `participants_count` in `contacts.Search`, `ResolveUsername` and dialog results. The `relation` and `canPost`
   derivation, in particular `PUBLIC_NOT_JOINED` versus `MEMBER`, depends on them. `min` entities (no access hash)
   are not handled.
7. `GetFullChannel` for a public channel the account has not joined (`about`, `slowmode_seconds`,
   `linked_chat_id`, `participants_count`); `CheckChatInvite` preview fields; `ChatInviteAlready`/`ChatInvitePeek`.
8. `canPost` against what Telegram really lets the account do: the granular banned-rights flags (`send_plain`,
   `send_photos`, `send_videos`), `join_to_send`, forums/topics, slow mode, boosts, Premium differences.
9. `iter_dialogs` (does it include `*Forbidden` entities and archived chats; `ignore_migrated`), and
   `iter_messages` on public channels and groups, `views`, the text/caption field.
10. Real FloodWait values on `resolveUsername`/`search`/`join` and that Telethon's local "still flood-waited"
    refusal returns the remaining seconds.

**Managing communities**

11. Join: `INVITE_REQUEST_SENT` raised for join-request communities (public and invite), `USER_ALREADY_PARTICIPANT`,
    `CHANNELS_TOO_MUCH`, banned accounts.
12. Create: `CreateChannel` (`megagroup` and `broadcast`) returning the new channel in `updates.chats`,
    `UpdateUsername`, `ExportChatInvite` (and the limits on public usernames and on how many channels an
    account may create or create per day).
13. `invite-link`: that `full_chat.exported_invite` is the *primary* link for administrators; when it is absent,
    `ExportChatInvite` without `legacy_revoke_permanent` creates an **additional** link, not necessarily the
    primary one.
14. Join requests: `GetChatInviteImporters(requested=True)` without a `link` returning all pending requests;
    whether `about` is the requester's bio or their message; paging by `(offset_date, offset_user)`; and
    `HideChatJoinRequest` with the access hash taken from the importers' `users`.
15. `update` (`EditTitle`, `EditChatAbout`, `*NotModified` being benign) and `leave` for channels and basic groups
    (`UserCreator` for owners).

**Sending**

16. `parse_mode="html"` rendering of the allowed tags, `<a href>` as a text link, `<pre><code class=...>`.
17. Caption/message limits as enforced for the account (Premium accounts have higher limits; the worker always
    splits at 1024/4096).
18. Photos, videos (no `hachoir`/`ffprobe`, so duration and dimensions are not sent: check the video shows as a
    video), albums (caption on the first item), and the text sent as a reply after media.
19. **Inline URL buttons from a user account.** Telegram may silently drop the button or reject it
    (`REPLY_MARKUP_INVALID`). The worker adds `BUTTON_NOT_DELIVERED` to `warnings` when the sent message has no
    markup, but a rejection would arrive as `UNKNOWN`. Verify before relying on `buttonText`/`buttonUrl`.
20. `releaseUrl` (`https://t.me/<username>/<id>`) opening the message in channels and supergroups.
21. `SlowModeWait`, `FloodWait`, `PeerFlood`, `ChatWriteForbidden` and `UserBannedInChannel` on real sends, and the
    entity-based hint that turns a write error into `ACCOUNT_RESTRICTED` only when the account itself is banned there.
22. `OUTCOME_UNKNOWN` in practice: whether a connection cut mid-send leaves the message delivered or not.

**Process, connections and platform**

23. A pooled client after a long idle: with `auto_reconnect=False`, `is_connected()` may still be true on a socket
    Telegram has closed, so the first request after idling can fail with `NETWORK` and succeed on the caller's retry.
24. Four concurrent requests on one account's client.
25. Windows: `CTRL_BREAK_EVENT` shutdown within 5 s (and the hard-exit watchdog), ProactorEventLoop with asyncio
    streams and Telethon, the `pyaes` wheel built at installer time, no firewall prompt for loopback, UTF-8 logs.
26. That the worker's own time bounds suit the supervisor's: a connect may take about 33 s (Telethon makes three
    attempts, 10 s timeout and 1 s delay each) and an operation is cut off at 60 s (15 min for a send).

## Known limitations

* No QR login, no sign-up, no proxy support, no per-account locks (callers should not send concurrently from one
  account).
* `contacts.Search` and `ResolveUsername` count against Telegram's own limits; the worker adds none of its own beyond
  the 1 s spacing in `refresh`.
* Telethon 1.x is in maintenance mode; the pin is exact because the error table and request shapes were written
  against it.
