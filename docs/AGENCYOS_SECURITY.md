# AgencyOS — Security and Privacy

What is enforced in the code today, how it is tested, and what is not covered. This
replaces an earlier version that described controls that were not implemented (for example
encryption of bot tokens in the database and Redis-backed idempotency); neither exists.

Nothing here has had an external penetration test or audit.

## Controls that exist

### Identity and tenant isolation
* Authentication is a signed session (JWT): the signature is verified and the user is re-read from the
  database on every request; token claims are not trusted.
* The desktop app on a person's own computer has no sign-in screen. The app server opens the one local
  workspace with a per-install key (`AGENCYOS_LOCAL_KEY`) that never reaches the browser, and the sign-in,
  sign-up and password-reset routes are switched off while it runs. Tests: the session route refuses a
  missing or wrong key and creates nothing; the same session works on the real API; the switched-off
  routes create no account.
* The agency (`orgId`) always comes from the authenticated session, never from a request
  body. The validation pipe whitelists DTO fields and drops the rest.
* Every agency repository write is org-scoped in the `where` clause, so a missed permission
  check still cannot touch another agency (`updateMany`/`deleteMany` with `orgId`).
  Tests: one agency cannot read, change, cancel, export, approve, bill, or attach resources
  of another; the same Telegram chat can be registered independently by two agencies and
  neither inherits the other's consent.
* Another agency's resource ids return 404, not 403, so ids cannot be probed.

### Roles
* Eight agency roles and one permission matrix (`AGENCY_PERMISSIONS`). Anything not listed is
  denied. Approving is a smaller set than authoring; sales executives and content editors
  cannot approve; analysts are read-only.
* People without an assigned role never default to an approver.
* Role changes are admin-only, cannot target yourself, only an owner can grant Owner, and a
  client role must name a client. They take effect on the next request and are audited.
* A **CLIENT** sees a purpose-built portal view (client-safe fields only; no budgets, internal
  notes, other clients or CRM data), can act only on their own client's campaigns, and staff can
  preview the portal but cannot act as the client. The auth middleware also
  refuses a client's calls to the workspace's own APIs (connected accounts, posts,
  notifications), answering 403 without logging them out.

### Workflow integrity
* Status cannot be set through a normal update; only workflow methods change it, with guarded
  updates so concurrent actions produce one winner.
* Content is locked after approval and a fingerprint is checked again immediately before every
  send; edited content is blocked, not sent.
* Four-eyes review (owners/admins may self-approve, recorded), optional client sign-off,
  mandatory explanation when sending back.
* Every state change, role change, deal change, invoice action and approval is written to the
  audit table with actor, role, action, entity and summary. The table is append-only in the
  code (no update or delete path) but it is not tamper-evident at the database level.

### Telegram
* Messages go only to chats whose **administrator** authorized the bot with a one-time code
  (`/authorize AOS-XXXXXXXX`). The bot verifies the sender is an administrator and that it can
  post. Codes are stored as hashes, are single-use, expire after 72 hours, and work only in
  the chat they were issued for. Wrong, malformed and expired codes are ignored silently so
  guessing gets no feedback.
* Consent can be withdrawn by an admin (`/revoke`) or staff at any time; it expires after 365
  days by default; losing the bot or its right to post disconnects the destination and pauses
  its queue. Authorization is re-checked at send time, not only when scheduling.
* Any number of bots can be connected in the app (Settings → Telegram bots). A bot token is a
  password for its bot: it is sealed with AES-256-GCM (key derived from the install's
  `JWT_SECRET` with HKDF, its own context string), never returned by any API, never put in the
  audit trail or logs, and wiped when the bot is removed. Only owners and admins may connect,
  pause or remove a bot (`bot:manage`); staff can see names and states. The same token cannot be
  connected twice. The bot named in the server settings (`AGENCY_TELEGRAM_BOT_TOKEN`) keeps
  working and is shown read-only as the server bot.
* Each chat belongs to exactly one bot. Only that bot's listener acts on its `/authorize` (a code
  heard by another bot does nothing), and only that bot posts. A paused, removed or rejected bot
  stops its chats with a stated reason; a chat is never switched to another bot. A chat admin's
  `/revoke` stops every agency's registration of the chat, whichever bot heard it.
* The webhook requires a secret header (constant-time comparison), accepts nothing if no
  secret is configured, never throws, and always answers 200.
* A chat can have backup bots of the same agency and the bots can take turns, but only among
  bots the chat's administrator has made administrators (checked live at every send). Switching
  never happens because a chat removed the main bot or because Telegram asked for a slowdown, the
  chat's posting windows and caps apply whichever bot sends, and every change of bot is audited
  with time, reason and campaign.
* No member lists are read, no private messages are sent, and no mechanism exists to add
  people to chats or to take over a chat that removed the agency.

### Content and output safety
* The ad is rendered by one server function that escapes everything and restores a fixed
  allow-list of attribute-free tags plus a validated `http(s)` link. The browser preview uses
  that same server HTML.
* Links in campaigns and tracking links must be `http` or `https`; `javascript:` and `data:`
  are rejected, and a stored value that somehow became unsafe is never redirected to.
* CSV exports neutralise spreadsheet formulas in user text (`=`, `+`, `-`, `@`, tab, CR).
* Tracking-link visits store a salted SHA-256 of the IP address (never the address itself),
  the user agent and the referrer. Link-preview bots are not counted.

### Privacy
* The Bot API gives no phone numbers; none are collected. Contact details held for clients and
  deals are ordinary business data entered by the team.
* Knowledge-base documents require the person adding them to attest that the source authorized
  collection and its members were told; the attestation is audited. The knowledge base
  supports deletion of one document and purge by type or age.
* Text is **not** sent to a third-party AI service unless someone with the `ai:configure` permission
  (owners and admins) chooses one in Settings → AI and Copilot. On a server the operator must also
  set `AGENCY_ALLOW_EXTERNAL_AI=true` first; on the desktop app the person using it is the
  operator. By default the desktop app uses Antigravity CLI (nothing is downloaded); a local Ollama model is used only if the operator turns it on, and without any model AgencyOS says so and works without one.
* AI provider keys are sealed with AES-256-GCM (key derived from the install's `JWT_SECRET` with HKDF),
  never returned by any API, and kept out of the audit trail and logs. A key that cannot be opened
  (for example after a reinstall with a new secret) is treated as missing and the person is asked
  for it again.
* Command-line AI tools (Claude Code, Codex CLI, Antigravity CLI) are only used when
  `AGENCYOS_LOCAL=true`. They are started by fixed name with fixed arguments (no shell, every
  argument checked), with the prompt on stdin, in an empty scratch folder, with their own tools
  switched off where the program allows it, and without the database, Redis, session and Temporal
  secrets in their environment. Two run at a time at most, each with a timeout.
* The same tools are kept current by running their own update command (`claude update`,
  `codex update`, `agy update`) once a day, claimed in the database so only one process does it,
  never while a request is using the tool. `AGENCY_AI_TOOL_UPDATES=off` disables updates entirely.
* Each tool is also asked which models it offers and how hard each can think; the answer is cached
  and only shown, never executed. Asking uses the same fixed arguments and scratch folder.
* The Copilot's agent mode is a loop of one model call per request. Reading tools run at once under the
  person's own role; every change is returned as a proposal and runs only when the person presses
  Approve, again under their own role, and is audited. There is no tool to approve a campaign,
  schedule or send anything, delete anything or authorize a chat. What tools return is treated as
  data, never as instructions.

### Desktop app: System settings
* The desktop app's System settings reach the launcher through the app's own server
  (`/api/system/...`), never from the browser directly. The launcher's token stays in the app
  server's environment (not in the backend's or the orchestrator's); a request is answered only
  if it comes from the app's own page (`Sec-Fetch-Site`, Host check), carries a valid session of
  an owner or admin, and names one of a short list of actions (status, check/move/clean up
  storage, restart, and the local AI controls: switch automatic setup on or off, download, cancel, try and delete a model, install/start/stop the engine). Model names are checked against a strict pattern in both the app and the launcher before they reach the engine, one such operation runs at a time, and a delete asks for confirmation. Shutting down and the old token form are not reachable.

### Operations
* Jobs are idempotent (unique key per campaign revision and destination), retried with
  backoff, dead-lettered after a limit, and a send that may have happened but cannot be
  confirmed is marked "Needs check" for a person instead of being resent.
* The dashboard says plainly when no bot or no dispatcher is running.
* `docker-compose.agencyos.yml` and `.env.agencyos.example` contain no default secrets; the
  compose file refuses to start without them.

## What is not covered

| Gap | Impact | Direction |
| --- | --- | --- |
| Social-network OAuth tokens are stored as the platform has always stored them; AgencyOS neither encrypts nor reads them (a test asserts agency code never loads tokens) | A database leak exposes them | Encrypt at rest in the platform core or use a secrets manager |
| Bot tokens are decryptable by anyone who holds the install's `JWT_SECRET` and the database | A stolen copy of both exposes the bots | A hardware- or OS-backed key store |
| All bots share one dispatch loop (about one post per second in total) | Many bots do not add sending speed | Per-bot pacing, if the rate ever matters |
| A client is still a workspace user with a login (restricted by middleware) | A flaw in that allow-list would widen access | A separate portal identity (magic link) |
| The org-level API key of the public API is not tied to agency roles | Whoever holds the key can use the public API for posts | Scope or disable the key for agency workspaces |
| The audit trail is not tamper-evident | A database administrator can alter it | Hash-chain or ship to write-once storage |
| Click-event data has no automatic retention limit | Hashes accumulate | Scheduled purge |
| Rate limiting is the platform's global throttling only | No per-agency or per-endpoint limits | Add limits on `/agency/*` |
| No external penetration test, dependency audit or secret scan was run for this work | Unknown unknowns | Run them before production |
| Accessibility has not been tested with assistive technology | Possible barriers | Test with screen readers |

## Reporting a vulnerability

Follow `SECURITY.md` at the repository root.
