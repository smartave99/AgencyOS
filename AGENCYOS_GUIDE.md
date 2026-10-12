# AgencyOS — Operator Guide

AgencyOS turns this Postiz fork into a workspace for advertising agencies: clients,
campaigns, a review and approval workflow, **authorized** Telegram destinations,
scheduled publishing with delivery receipts, a sales pipeline, invoices, a client
portal and publishing reports.

This guide says what works, what does not, and how to run it. For the module-by-module
record with evidence, read [`docs/AGENCYOS_IMPLEMENTATION_STATUS.md`](docs/AGENCYOS_IMPLEMENTATION_STATUS.md).

## Run it on a Windows laptop

The simplest way to use AgencyOS is the Windows desktop app: one installer, no prerequisites,
its own window (not a browser tab), and local AI models picked automatically for the computer.
See [`docs/AGENCYOS_WINDOWS_INSTALL.md`](docs/AGENCYOS_WINDOWS_INSTALL.md). Servers and
developers can keep using Docker Compose or `pnpm` as described below.

## What it will and will not do

AgencyOS only sends ads to Telegram chats whose **administrators have authorized it**,
using the official Bot API. It does not scrape members, message people who have not
asked for it, add users to groups, or rotate accounts to get around restrictions.
That is a design rule, enforced in code and covered by tests. (It differs from what
`RULES.md` asks for; see [`docs/AGENCYOS_RULES_CONFLICT.md`](docs/AGENCYOS_RULES_CONFLICT.md).)

## What is real today

| Area | State |
| --- | --- |
| Clients, campaigns, composer with server-rendered Telegram preview | Working |
| Approval workflow: submit, review, send back, four-eyes, client sign-off, content locked after approval | Working |
| Telegram destinations: admin-authorized consent (`/authorize CODE`), revoke, expiry, health | Working; needs a bot token to use live |
| Publishing queue: retries with backoff, dead-letter, restart-safe, no duplicate posts, one-by-one receipts | Working; needs the dispatcher turned on |
| Client portal: only their own ads, approve or request changes, exact ad preview | Working |
| Roles and permissions (8 roles), tenant isolation, audit trail | Working |
| Sales pipeline (deals, stages, convert to client) | Working |
| Invoices (records; payment is recorded by hand) | Working |
| Publishing reports (stored results, CSV, print or save as PDF) | Working |
| Knowledge base with keyword search; copy suggestions | Working, labelled honestly (see below) |
| Dashboard and a truthful system banner (no bot, no dispatcher) | Working |

**Not implemented:** lead capture funnel, recurring schedules, publishing to social networks
from campaigns (only Telegram), per-agency bot tokens, campaign version history, PDF files
generated server-side, vector database, billing integrations. See the status document.

**Not verified here:** live delivery to Telegram (no bot token was available), a full
boot with Temporal (the Temporal binary could not be downloaded in the build
environment), and the Docker Compose file (no container runtime was available).
Everything else was exercised against a real PostgreSQL database and a real browser.

## Run it locally

Requirements: Node.js 22, pnpm 10, PostgreSQL 16+, Redis 7, and a Temporal server
(Postiz needs one to start; `docker compose -f docker-compose.dev.yaml up -d` provides it).

```bash
pnpm install
cp .env.agencyos.example .env        # fill in the REQUIRED values
pnpm run prisma-migrate              # applies the migrations (see below)
pnpm run dev                         # backend :3000, frontend :4200
```

Create the first user at <http://localhost:4200>, then open **Agency Hub**.

### The database is managed by migrations

The schema lives in `libraries/nestjs-libraries/src/database/prisma/schema.prisma` and
is changed only through migrations in `migrations/` next to it.

* **New database:** `pnpm run prisma-migrate` creates everything.
* **Existing Postiz install** (created with `prisma db push`): the same command records
  `0_baseline` as already applied, then applies the AgencyOS migrations, including data
  fixes (duplicate campaign destinations are merged; legacy "authorized" Telegram
  destinations are reset to pending until an admin re-authorizes them). **Back up first.**
* Each migration has a `rollback.sql` for emergencies; it is not run automatically.
* Never run `prisma db push` on a database that has migrations.
* When you merge upstream Postiz changes that touch the schema, add a migration for them.

## Turn on publishing

Two things must be true before a scheduled campaign sends anything, and the dashboard
tells you when either is missing:

1. **A Telegram bot.** Create one with `@BotFather` and set `AGENCY_TELEGRAM_BOT_TOKEN`.
2. **The dispatcher.** Set `AGENCY_SCHEDULER_ENABLED=true`. It looks for due posts
   every 15 seconds (`AGENCY_DISPATCH_INTERVAL_MS`). More than one process may run it;
   claims are guarded so a post is never sent twice.

### Connect a chat

1. Add your bot to the group or channel as an administrator that can post messages.
2. **Telegram → Connect a group or channel**, enter the chat ID or public `@username`.
3. AgencyOS shows a one-time code, for example `/authorize AOS-AB12CD34`. A **group
   administrator** sends that message in the chat. The bot checks that the sender really
   is an administrator, then the destination becomes **Authorized**.
4. An administrator can send `/revoke` at any time; posting stops at once. Consent
   expires after 365 days by default (`AGENCY_CONSENT_VALID_DAYS`). If the bot is
   removed or loses permission, the destination is marked disconnected and its queued
   posts pause until it is fixed.

AgencyOS hears these messages by long polling (default) or by a webhook
(`AGENCY_TELEGRAM_WEBHOOK_URL` + `AGENCY_TELEGRAM_WEBHOOK_SECRET`, recommended in
production). The dashboard shows which is active.

### What happens to a post

`Draft → In review → Approved → Scheduled → Publishing → Completed`. Content cannot change
after approval (a fingerprint is checked again at send time). Each destination gets its own
job with a unique key, so retries and restarts never duplicate a post. A failed send is
retried with exponential backoff (`AGENCY_JOB_MAX_ATTEMPTS`, `AGENCY_JOB_BACKOFF_SECONDS`),
then marked failed and the team is notified. If a send might have gone out but cannot be
confirmed, the job is marked **Needs check** and a person decides; it is never guessed.

## Roles

Owner, Admin, Sales manager, Sales executive, Campaign manager, Content editor, Analyst,
Client. Assign them in **Team**. People with no assigned role get one from their workspace
role (admins become Admin, everyone else Sales executive, who cannot approve). A Client is
restricted to the portal: the app also refuses a Client's calls to the workspace's own
APIs (connected accounts, posts, notifications).

## Honest labels you will see

* **Search** is keyword matching unless an Ollama embedding model is reachable; the screen says which.
* **Copy suggestions** come from a local Ollama model if reachable; otherwise a fill-in-the-blank
  template that is labelled "Template draft".
* **Sentiment** is a word-list score, not a trained model.
* **Account health checks** read stored data; they do not contact the network.
* **Reports** count stored send results and tracked-link clicks. There are no impressions or
  reach figures because nothing AgencyOS uses provides a verified source for them.
* **Invoices** are records; payment is marked by a person.

## Tests

```bash
# Unit and real-database integration (needs a throwaway database that already has the schema)
export AGENCYOS_TEST_DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/agencyos_test"
DATABASE_URL=$AGENCYOS_TEST_DATABASE_URL pnpm run prisma-migrate
pnpm exec jest --runInBand --coverage=false --testPathPattern 'prisma/agency|integrations/telegram'

# HTTP end-to-end against the compiled backend (auth, validation, roles, isolation)
pnpm --filter ./apps/backend run build
pnpm --filter ./apps/backend run e2e
```

Without `AGENCYOS_TEST_DATABASE_URL` the database tests skip themselves. The last full run:
9 Jest suites, 169 tests, and 17 HTTP end-to-end tests, all passing (the Jest run
five times in a row). `pnpm lint` is currently broken upstream (a circular-structure error
in the ESLint config); type checking (`tsc`) and Prettier are clean.

## Deploy

`docker-compose.agencyos.yml` brings up the app, PostgreSQL, Redis and Temporal with no
default secrets. It has not been run in the environment it was written in; treat the first
start as a test. Put a TLS proxy in front and back up the `agency_pg_data` volume.

## Where to read next

* [`docs/AGENCYOS_IMPLEMENTATION_STATUS.md`](docs/AGENCYOS_IMPLEMENTATION_STATUS.md): what is done, partial and missing, with evidence
* [`docs/AGENCYOS_ARCHITECTURE.md`](docs/AGENCYOS_ARCHITECTURE.md): how it is built
* [`docs/AGENCYOS_SECURITY.md`](docs/AGENCYOS_SECURITY.md): controls, and known gaps
* [`docs/AGENCYOS_UI_DESIGN_SYSTEM.md`](docs/AGENCYOS_UI_DESIGN_SYSTEM.md): the interface standard
* [`docs/POSTIZ_GAP_ANALYSIS.md`](docs/POSTIZ_GAP_ANALYSIS.md): Postiz versus AgencyOS
* [`docs/AGENCYOS_PRODUCT_REQUIREMENTS.md`](docs/AGENCYOS_PRODUCT_REQUIREMENTS.md) and [`docs/AGENCYOS_IMPLEMENTATION_PLAN.md`](docs/AGENCYOS_IMPLEMENTATION_PLAN.md)
* [`docs/AGENCYOS_RULES_CONFLICT.md`](docs/AGENCYOS_RULES_CONFLICT.md): a decision the project owner needs to make
