# AgencyOS — Security and Privacy

What is enforced in the code today, how it is tested, and what is not covered. This
replaces an earlier version that described controls that were not implemented (for example
encryption of bot tokens in the database and Redis-backed idempotency); neither exists.

Nothing here has had an external penetration test or audit.

## Controls that exist

### Identity and tenant isolation
* Authentication is Postiz's: the JWT signature is verified and the user is re-read from the
  database on every request; token claims are not trusted.
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
* The bot token is an environment variable only. It is never stored in the database, returned
  by any API, or sent to the browser.
* The webhook requires a secret header (constant-time comparison), accepts nothing if no
  secret is configured, never throws, and always answers 200.
* No member lists are read, no private messages are sent, and no mechanism exists to add
  people to chats or rotate identities.

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
* Text is **not** sent to a third-party AI service unless the operator sets both
  `AGENCY_ALLOW_EXTERNAL_AI=true` and an API key. By default the embedding and copy features
  use a local Ollama model or work without one.

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
| Postiz stores social-network OAuth tokens as upstream does; AgencyOS neither encrypts nor reads them (a test asserts agency code never loads tokens) | A database leak exposes them | Encrypt at rest in Postiz core or use a secrets manager |
| One bot token for the whole server | All agencies share one bot identity | Per-agency bot tokens, stored encrypted |
| A client is still a workspace user with a login (restricted by middleware) | A flaw in that allow-list would widen access | A separate portal identity (magic link) |
| The org-level API key of Postiz's public API is not tied to agency roles | Whoever holds the key can use Postiz's public API for posts | Scope or disable the key for agency workspaces |
| The audit trail is not tamper-evident | A database administrator can alter it | Hash-chain or ship to write-once storage |
| Click-event data has no automatic retention limit | Hashes accumulate | Scheduled purge |
| Rate limiting is Postiz's global throttling only | No per-agency or per-endpoint limits | Add limits on `/agency/*` |
| No external penetration test, dependency audit or secret scan was run for this work | Unknown unknowns | Run them before production |
| Accessibility has not been tested with assistive technology | Possible barriers | Test with screen readers |

## Reporting a vulnerability

Follow `SECURITY.md` at the repository root.
