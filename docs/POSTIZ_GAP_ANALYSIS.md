# Postiz → AgencyOS: Gap Analysis

This compares what Postiz provides with what an advertising-agency platform needs, based
on the code in this repository, and records what AgencyOS now adds. The first version of
this document was a plan written before the work; it has been replaced with what was
found and what was built. The module-by-module result is in
[`AGENCYOS_IMPLEMENTATION_STATUS.md`](AGENCYOS_IMPLEMENTATION_STATUS.md).

## What Postiz provides (verified by reading the code)

| Capability | Where | Use for AgencyOS |
| --- | --- | --- |
| NestJS backend, Next.js (App Router) frontend, Prisma on PostgreSQL, Redis | `apps/*`, `libraries/*` | The base stack. |
| Organizations with `SUPERADMIN` / `ADMIN` / `USER` and invitations | `Organization`, `UserOrganization` | Tenant boundary. The agency role model is layered on top; the Postiz role is only a fallback. |
| Scheduling and publishing of social posts to many networks | `Post`, `Integration`, providers, Temporal workflows (`apps/orchestrator`) | Left as is. Campaign publishing does **not** reuse it (see below). |
| A Telegram provider that posts text/media with a bot token | `telegram.provider.ts` | Not reused for campaigns: it has no consent model, receipts or retry semantics. |
| `Customer` (a name tag on integrations and posts) | `schema.prisma` | Extended into the agency client. |
| Calendar, media library, AI helpers, analytics, billing for Postiz plans | various | Unchanged. The media library is reused by the composer. |

Postiz does **not** provide: an approval workflow, a destination consent model, delivery
receipts per destination, a CRM, invoices, a client-facing portal, an audit trail,
fine-grained roles, or tests for any of these.

## What the agency domain needed, and what was done

| Need | Postiz | AgencyOS |
| --- | --- | --- |
| Multi-tenant agencies | Organizations exist | Every agency query and write is scoped by `orgId`; tests prove one agency cannot read or change another's data. |
| Roles beyond admin/user | Three roles | `AgencyMember` with 8 roles and a permission matrix; a client role restricted to a portal. |
| Campaign with a lifecycle | Standalone posts | `Campaign`, `CampaignDestination`, workflow-only status changes, content frozen after approval. |
| Approvals | None | Submit / review / send back, four-eyes, optional client sign-off, audit. |
| Authorized Telegram destinations | One bot token, no consent | Registry with admin-proven consent (`/authorize CODE`), `/revoke`, expiry, health, pause on loss of access. |
| Reliable publishing | Temporal workflows for social posts | A database-backed queue (`PostingJob`): idempotent, restart-safe, retried with backoff, dead-lettered, never auto-resent when uncertain. |
| Reporting | Social analytics | Publishing reports from stored send results and tracked clicks. |
| Sales pipeline and invoices | None | Deals and invoices (records). |
| Client experience | None | Portal with the exact ad preview and approvals. |
| Honest operations | n/a | A banner when no bot or no dispatcher is running. |

### Why the queue is not Temporal

Temporal is already required for Postiz to start and was considered for campaign
publishing. A database queue was chosen because the properties that matter here
(unique key per destination, claim guarded by a single `UPDATE`, lease, a distinct
"uncertain" state, and cancellation by status) are simple to state and test directly
against PostgreSQL, and because the Temporal server could not be run in the build
environment. The trade-off is that the dispatcher is a polling loop that must be enabled
(`AGENCY_SCHEDULER_ENABLED=true`).

## Requests that cannot be built as originally written

Some requirements in the project's own `RULES.md` ask for scraping group members,
joining groups automatically, adding scraped users to groups, and rotating accounts when
one is blocked. These are not implemented. The Telegram Bot API has no sanctioned way to do
the first three at scale, and the last exists to avoid a platform's enforcement. What was
built instead is **authorized** discussion analysis (a knowledge base the team loads
itself, with an attestation that the source authorized it) and the consent registry. See
[`AGENCYOS_RULES_CONFLICT.md`](AGENCYOS_RULES_CONFLICT.md).

## Remaining gaps against the original brief

* Social networks as campaign destinations (only Telegram dispatches).
* Lead-capture funnel, invite links with QR codes, conversion tracking.
* Recurring schedules; campaign content version history.
* Per-agency bot tokens and encrypted storage of per-tenant secrets.
* Server-generated PDF reports and PDF invoices.
* Vector search with a vector database; meaning-based search currently needs Ollama.
* A separate identity for clients that is not a workspace login.
* Billing integrations; invoice sending.

## Compatibility with upstream Postiz

* Schema changes are additive, except that existing columns on `TelegramDestination` and
  `CampaignDestination` introduced for this project were tightened by migration.
* Edits to Postiz-owned code are limited to: the navigation (`top.menu.tsx`), the auth
  middleware (portal-only clients), global styles (design tokens, print and motion rules in
  `colors.scss` / `global.scss`), `pm2-run` and the new migration script, module
  registrations (`api.module.ts`, `database.module.ts`), the Prisma schema, and the GitHub
  workflow files, which an earlier commit in this repository moved to `.github/ci-workflows`.
* Merging upstream changes that touch the schema requires adding a migration for them,
  because the project now uses migrations.
