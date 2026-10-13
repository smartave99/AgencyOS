# Telegram user-account worker: the contract

The Telegram **Bot API** integration (`TelegramGateway`) stays as it is. This document is the boundary to a
second, separate provider: an authenticated Telegram **user account** (MTProto, Python 3 + Telethon) that
AgencyOS uses for permitted, operator-driven work: public community research, deliberate joining, managing
communities the operator owns or administers, and sending approved campaigns where that is allowed.

The NestJS backend is the application controller. The worker is a small, stateless, loopback-only process the
backend supervises. The frontend never talks to it and never sees a session.

## What the worker is not

* Not a scraper of people. It returns **no participant lists, no phone numbers and no member contact
  details**, and has no endpoint that could.
* Not an account switcher. It acts as exactly the account the request names; it never retries a request as
  another account, and a restriction is reported, not worked around.
* Not a join/send bot. Every join and every send is one request made by the backend for a deliberate,
  authorized action; the worker has no loop of its own.
* Not a place to keep secrets. It never writes a session, API hash, code or password to disk or to a log.

## Process and transport

* `python -m agencyos_telegram` listens on `127.0.0.1:<port>` only (`AGENCYOS_WORKER_PORT`, default 6391 is
  taken by tests, so there is **no** default: the supervisor passes a free port).
* Every request except `GET /health` must carry `X-AgencyOS-Worker-Token: <token>` equal to the
  `AGENCYOS_WORKER_TOKEN` environment variable (constant-time compare). A request whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` is refused with 421.
* Every request may carry `X-Correlation-Id`; it is echoed on the response and in every log line.
* JSON in, JSON out, `Content-Type: application/json`. Bodies over 256 KiB are refused with 413.
* Logs go to stderr as one JSON object per line. They never contain codes, passwords, `apiHash`, sessions,
  phone numbers (masked as `+49•••••1234`), or message bodies.
* `SIGTERM`/`SIGINT` (and `CTRL_BREAK_EVENT` on Windows) disconnect every client and exit 0 within 5 s.

### Account credentials in each request

```json
{ "account": { "apiId": 123456, "apiHash": "…", "session": "<Telethon StringSession>" } }
```

The backend opens the sealed session from its database for the one request and sends it over loopback. The
worker keeps a connected client in memory per `sha256(session)` and disconnects it after 120 s idle. It
never stores the session.

## Envelope

Success: `HTTP 200 {"ok": true, ...fields}`.

Telegram-side or domain failure: `HTTP 200 {"ok": false, "error": {"code": "...", "message": "...",
"retryAfterSeconds"?: n}}`. Transport failures use ordinary statuses: 400 invalid request (`error.code =
"BAD_REQUEST"`), 401 bad token, 413, 421, 500 (`"INTERNAL"`).

Error codes (the backend maps these; do not invent others):

| code | meaning |
| --- | --- |
| `SESSION_INVALID` | the session was revoked, expired or never authorized (AuthKeyUnregistered, SessionRevoked, UserDeactivated…) |
| `PHONE_INVALID` | the phone number is not accepted |
| `CODE_INVALID` / `CODE_EXPIRED` | wrong or expired login code |
| `PASSWORD_REQUIRED` | two-step verification is on (not an error on `/login/code`: see its result) |
| `PASSWORD_INVALID` | wrong two-step password |
| `LOGIN_NOT_FOUND` | the `loginId` is unknown or older than 10 minutes |
| `RATE_LIMITED` | FloodWait: `retryAfterSeconds` is always set |
| `ACCOUNT_RESTRICTED` | PeerFlood, UserRestricted, UserBannedInChannel, ChatWriteForbidden because of a ban: Telegram limited this account; never retried or re-routed |
| `FORBIDDEN` | the account may not do this here (not an admin, writing not allowed, join not allowed) |
| `NOT_FOUND` | the username or link does not exist |
| `PRIVATE` | the community is private or the invite is invalid: nothing public to show |
| `INVALID_REF` | the text is not a username, `t.me` link or invite link |
| `NETWORK` | connection problem; safe to retry |
| `OUTCOME_UNKNOWN` | a send was interrupted after it may have reached Telegram: **must not be retried automatically** |
| `UNSUPPORTED` | not available for this kind of community or this Telethon version |
| `UNKNOWN` | anything else (message is sanitized) |

## Shared shapes

`ref` is a public username (`@name` or `name`), a `https://t.me/name` link, or a `https://t.me/+hash` /
`joinchat` invite link. Anything else is `INVALID_REF`.

`Community` (only what Telegram exposes publicly; absent fields are `null`, never invented):

```json
{
  "telegramId": "1234567890",
  "kind": "GROUP | SUPERGROUP | CHANNEL | BROADCAST_CHANNEL",
  "title": "…", "username": "name|null", "link": "https://t.me/name|null",
  "description": "…|null",
  "memberCount": 1234,
  "verified": false, "scam": false, "fake": false,
  "joinRequestRequired": false, "slowModeSeconds": null, "hasLinkedChat": false,
  "restrictionReasons": []
}
```

`relation` is one of `OWNED`, `ADMINISTERED`, `MEMBER`, `PUBLIC_NOT_JOINED`, `RESTRICTED`, `UNAVAILABLE`.

`Me`: `{ "id": "…", "username": "…|null", "firstName": "…|null", "lastName": "…|null", "premium": false,
"phoneMasked": "+49•••••1234" }`. The full phone number is never returned.

## Endpoints

All `POST` unless noted. Bounds are enforced by the worker and echoed back (`limit` is clamped, never
refused).

### Health
* `GET /health` (no token) → `{ok, version, telethon, python, uptimeSeconds, pendingLogins, clients}`

### Login (interactive, one attempt at a time per `loginId`)
* `/v1/login/start` `{apiId, apiHash, phone}` → `{loginId, codeDelivery: "app|sms|call|other", timeoutSeconds}`
* `/v1/login/code` `{loginId, code}` → `{status: "authorized", session, me}` or `{status: "password_required"}`
* `/v1/login/password` `{loginId, password}` → `{status: "authorized", session, me}`
* `/v1/login/cancel` `{loginId}` → `{cancelled: true}`

`session` is returned **once**, to the backend, on success. Pending logins live in memory for 10 minutes and
are deleted on success, cancel, expiry or any error, except that a wrong code (`CODE_INVALID`) or wrong
two-step password (`PASSWORD_INVALID`) keeps the login so it can be retyped, up to 5 wrong attempts per
`loginId`: the 5th deletes it and returns the same code with a message to start again.

### Account
* `/v1/account/status` `{account}` → `{authorized: true, me}` or `{authorized: false}` (a revoked session is
  `authorized: false`, not an error)
* `/v1/account/logout` `{account}` → `{loggedOut: true}` (ends the authorization at Telegram)

### Communities (public metadata and the account's own communities)
* `/v1/communities/search` `{account, query, limit}` (limit ≤ 50) → `{results: Community[]}`. Telegram's own
  public search (`contacts.Search`) only; never more than one call per request.
* `/v1/communities/resolve` `{account, ref}` → `{community, relation, canPost}` where `canPost` is
  `{sendMessages, sendMedia, isAdmin, postMessagesInChannel, slowModeSeconds}` for the account, or `null`
  when not a participant. A public community the account has not joined is `PUBLIC_NOT_JOINED` and public
  metadata is still returned. A banned or restricted view is `RESTRICTED`; a missing one is `UNAVAILABLE`.
* `/v1/communities/refresh` `{account, refs}` (≤ 20) → `{results: [{ref, ok, community?, relation?, error?}]}`
  with at least 1 s between lookups and an early stop (remaining refs `ok:false, error.code:"RATE_LIMITED"`)
  on a FloodWait.
* `/v1/communities/messages` `{account, ref, limit}` (limit ≤ 20) → `{messages: [{id, date, text, views?}]}`:
  the most recent public messages of a **public** channel/group, for a person to read on screen. Text is
  truncated to 2000 characters; no sender identities, no media. The backend does not store them.
* `/v1/communities/mine` `{account, limit}` (≤ 200) → `{communities: [{community, relation}]}` from the
  account's dialogs, groups and channels only (no private chats, no users).
* `/v1/communities/permissions` `{account, ref}` → `{relation, canPost}` as above.
* `/v1/communities/join` `{account, ref}` → `{status: "JOINED" | "JOIN_REQUEST_PENDING", community}`
  (invite links included). One call is one join; `ALREADY_PARTICIPANT` is reported as `JOINED`.
* `/v1/communities/leave` `{account, ref}` → `{left: true}`
* `/v1/communities/create` `{account, kind: "group"|"channel", title, about?, username?}` →
  `{community, inviteLink?}`
* `/v1/communities/update` `{account, ref, title?, about?}` → `{community}` (owner/admin only)
* `/v1/communities/invite-link` `{account, ref}` → `{link}` (exports the primary invite link; admin only)
* `/v1/communities/join-requests` `{account, ref, limit}` (≤ 50) → `{requests: [{userId, username?, date, bio?}]}`
  for a community the account administers; only what Telegram shows an administrator.
* `/v1/communities/join-requests/decide` `{account, ref, userId, approve}` → `{decided: true}`

### Sending
* `/v1/messages/send` `{account, ref, ad}` →
  `{messageIds: ["…"], primaryMessageId: "…", releaseUrl: "https://t.me/…|null"}`.
  `ad` = `{html, media: [{path, kind: "photo|video"}], buttonText?, buttonUrl?}`; `html` is Telegram HTML limited
  to `b i u s code pre a`. `media[].path` must resolve inside `AGENCYOS_MEDIA_ROOT`. Text longer than the
  limits is split exactly like the Bot API provider does (caption ≤ 1024, message ≤ 4096; media first, then
  the text as a reply when it does not fit). A `FloodWait` is `RATE_LIMITED`, never slept through; an
  interrupted send is `OUTCOME_UNKNOWN`.

## Limits the worker enforces itself

* No endpoint iterates participants, and none accepts a list of users to add or message.
* Search returns ≤ 50 results; refresh ≤ 20 refs with ≥ 1 s spacing; messages ≤ 20; dialogs ≤ 200.
* At most 4 requests are in flight; a 5th waits up to 5 s then gets `RATE_LIMITED` with
  `retryAfterSeconds: 5`.
* A `FloodWait` of any length is returned to the caller, never slept through inside the worker.

## Tests the worker must ship

* Contract tests over the real HTTP server with an in-memory backend: token, Host check, correlation id,
  body limit, every endpoint's success and its error mapping, log redaction (a secret never appears in
  captured logs), pending-login expiry, request bounds, the in-flight limit.
* Error-mapping tests for every Telethon exception class listed in the table above.
* No test may need the network or a Telegram account. Anything only provable live is listed in the
  worker's README as **LIVE_VERIFICATION_REQUIRED**.
