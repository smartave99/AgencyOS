# AgencyOS — Architecture

How the agency layer is built on the Postiz monorepo. Everything below describes code that
exists; the places where the original plan was not followed are called out.

## Stack

NestJS backend (`apps/backend`), Next.js 16 App Router frontend (`apps/frontend`), Prisma 6.5
on PostgreSQL, Redis, and Temporal (required by Postiz to start, not used for agency
publishing). Managed with pnpm workspaces. No vector database: PostgreSQL stores embeddings
as JSON and similarity is computed in the service.

## Layers

```
HTTP → AgencyActorGuard → whitelisting validation pipe (DTO) → controller
     → service (permission check, workflow rules) → repository (org-scoped Prisma) → PostgreSQL
                                   ↘ TelegramGateway (the only code that talks to Telegram)
```

* **Controllers** (`apps/backend/src/api/routes/agency.*.controller.ts`) hold routing only.
* **Services** (`libraries/nestjs-libraries/src/database/prisma/agency/`) hold all rules.
  `AgencyAccessService.assert(actor, permission)` is called first in every public method.
* **Repositories** never trust the caller: writes use `updateMany`/`deleteMany` with `orgId`
  in the `where`, so a missed service check still cannot cross tenants.
* **DTOs** (`libraries/nestjs-libraries/src/dtos/agency/`) are validated with a whitelist pipe
  that strips unknown fields (a client cannot smuggle `status` or `orgId`).
* **`TelegramGateway`** (`libraries/nestjs-libraries/src/integrations/telegram/`) renders the
  ad HTML, validates against Telegram's limits, sends, checks bot permissions, reads updates
  and classifies errors (`RATE_LIMITED`, `FORBIDDEN`, `CHAT_NOT_FOUND`, `BAD_REQUEST`, `NETWORK`, …). Nothing else calls
  Telegram. Tests replace it with a fake that can reproduce failures.

| Service | Responsibility |
| --- | --- |
| `AgencyService` | Clients, campaign workflow, approvals, tracking links, CSV, invoices, dashboard, reports |
| `AgencyPublishingService` | Job creation, claim and send, retry/backoff, reconcile, system status, preview |
| `AgencyTelegramService` | Destination consent state machine, `/authorize` `/revoke`, polling/webhook, expiry |
| `AgencyAccessService` | Roles, permission matrix, actor resolution, team, audit |
| `AgencyPortalService` | The client's view; client sign-off |
| `AgencyCrmService` | Deals and stages |
| `AgencyIntelligenceService` | Knowledge base, embeddings, search, retention |
| `AgencyAiService` | Copy suggestions with output validation |
| `AgencyPlatformsService` | Capability registry and stored account status |
| `AgencySchedulerService` | The opt-in dispatch loop and update transport |

## Data model (agency tables)

`Customer` (extended) · `Campaign` · `CampaignDestination` · `TelegramDestination` ·
`ApprovalRequest` · `PostingJob` · `PublishingEvent` · `TrackingLink` · `LinkClickEvent` ·
`AgencyMember` · `AuditEvent` · `LeaderLease` · `Deal` · `AgencyInvoice` ·
`AgencyKnowledgeDocument` · `LeadCapture` (no capture path yet).

* `PostingJob` is the mutable state machine: one row per campaign revision × destination,
  unique `idempotencyKey`, `status`, `attempts`, `lockedUntil`, `lastErrorCode`, receipt.
* `PublishingEvent` is the append-only history of attempts.
* `Campaign` carries `revision`, `approvedContentHash`, `approvedAt`, `requiresAttention`,
  and the client sign-off fields.
* Schema changes go through migrations (`libraries/nestjs-libraries/src/database/prisma/migrations`).

## Campaign workflow

```
DRAFT → SUBMITTED → APPROVED → SCHEDULED → PUBLISHING → COMPLETED
  ↑         │            │         │  ↘ PAUSED ↔ resume      ↘ PARTIALLY_FAILED / FAILED → retry
  └─ CHANGES_REQUESTED ←─┘ (reopen voids approval)           CANCELLED, ARCHIVED
```

* Status is changed only by workflow methods using guarded updates (`WHERE status = …`), so
  two people acting at once produce one winner and one clear error.
* Editing is possible only in `DRAFT` / `CHANGES_REQUESTED`. Approval stores a hash of the
  ad; the send path recomputes it and blocks on mismatch.
* Review rules: a reviewer needs `campaign:approve`; authors cannot approve their own
  submission unless they are owner/admin, which is recorded (`selfApproved`); an optional
  client sign-off must exist first; rejecting requires an explanation.

## Publishing

1. **Schedule / publish now** creates one `PostingJob` per destination for the current
   revision (`createMany … skipDuplicates` on the idempotency key).
2. The **dispatcher** (`dispatchDue`) finds due `PENDING` jobs and claims each with a single
   guarded `UPDATE` (`PENDING → SENDING`, lease set). Only the winner sends.
3. Before sending it re-checks: campaign state, end date, content hash, destination consent
   and expiry, posting window and frequency, and (live) the bot's permission in the chat.
4. The result is recorded: success with Telegram's message id; a retryable error backs off
   (`60 s × 2^(attempt−1)`, or Telegram's `retry_after`); a permanent error dead-letters or
   disconnects the destination; a send that may have partly happened becomes `UNCERTAIN`.
5. `reconcileCampaign` derives the campaign status from its jobs, so a failed destination can
   never leave a campaign looking `COMPLETED`.
6. Expired leases are found at the next pass and surfaced for a person to resolve; a job that
   might have been sent is never re-sent automatically.

The dispatcher is opt-in (`AGENCY_SCHEDULER_ENABLED`). It records a heartbeat each pass; the
dashboard shows "no dispatcher" if the heartbeat is stale.

## Telegram consent

`PENDING_VERIFICATION → ACTIVE` only through a chat administrator sending
`/authorize AOS-XXXXXXXX` in the chat. The bot verifies the sender is an administrator (a
channel post, or an anonymous group admin, counts; a bot account or non-admin does not) and
that it can itself post. Codes are stored as hashes, are single-use, valid 72 hours, and only
work in the chat they were issued for. `/revoke` by an admin, expiry, removal of the bot or
loss of posting rights move the destination to `REVOKED`, `EXPIRED` or `DISCONNECTED` and
block its queued jobs. Re-authorizing needs a fresh admin command; nothing resumes by itself.
Updates arrive by webhook (secret header, constant-time compare, always 200) or by long
polling guarded by a `LeaderLease` so one process polls.

## Access control

* `AGENCY_PERMISSIONS` maps each permission to the roles that hold it (single source of truth,
  with tests that every permission is granted to someone and clients hold only portal rights).
* `resolveActor` takes the explicit `AgencyMember` row if there is one; otherwise it derives
  the least-privileged staff role from the workspace role, never an approver.
* A CLIENT is bound to one `customerId` and sees a purpose-built portal view that selects only
  client-safe fields. The auth middleware also refuses a client's calls to workspace APIs.
* Credential-bearing models are never returned raw (`select` only what is needed).

## Frontend

Routes under `apps/frontend/src/app/(app)/(site)/agency/*`; components in
`apps/frontend/src/components/agency/`. Data comes from named SWR hooks (`agency.hooks.ts`,
one hook per resource) through `useFetch`. All screens compose `agency.ui.tsx` (see
[`AGENCYOS_UI_DESIGN_SYSTEM.md`](AGENCYOS_UI_DESIGN_SYSTEM.md)). Buttons and menu items are
shown only when the signed-in role holds the permission, but the server enforces everything.

## Testing approach

* `agency.test.support.ts` builds the real services over a real PostgreSQL database with a fake
  Telegram gateway, a seeded agency with one user per role, and helpers to create approved or
  scheduled campaigns.
* Integration suites: publishing, security/workflow, Telegram consent, CRM, reports; unit
  suites for the gateway, AI, intelligence and platforms.
* `apps/backend/e2e/` boots the compiled `ApiModule` (Temporal stubbed) and drives it over
  HTTP: authentication boundaries, validation, role and tenant isolation, tracking, webhook,
  reports, client scope.
* Mutation checks were used on critical rules (a test must fail when the rule is removed).

## Deviations from the original plan

| Plan | Built |
| --- | --- |
| Campaign publishing as Temporal workflows | A database-backed queue (see the gap analysis) |
| `pgvector` | JSON embeddings, keyword hashing by default, optional Ollama embeddings |
| `CampaignVersion`, `Quote`, lead funnel | Not built |
| Discussion scraping | Replaced by an attested knowledge base (see the RULES.md note) |
| Separate `agency.*.service.ts` files under `src/services/` | Services live next to their repositories in `database/prisma/agency/`, matching how this repository is organised |
