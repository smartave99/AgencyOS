# AgencyOS — Implementation Status

What exists in this repository, what is only partly there, and what is missing, with the
evidence for each claim. Written from the code and the test runs, not from the plan.
Last full verification: 9 Jest suites / 169 tests and 17 HTTP end-to-end tests passing
against PostgreSQL 16; a scripted real-browser run (31 checks, light/dark/390 px) on a
seeded demo agency.

Legend: **Done** = works end to end and is tested. **Partial** = works, with a stated
limit. **Missing** = not built. **Unverified** = built, but could not be exercised here.

## Verification limits (read these first)

| Not verified | Why | What would verify it |
| --- | --- | --- |
| Live delivery to Telegram | No bot token in the build environment. Delivery is tested against a fake gateway that behaves like Telegram (errors, rate limits, partial sends) and against the real message-rendering code. | Set `AGENCY_TELEGRAM_BOT_TOKEN`, authorize a test chat, send. |
| Full backend boot with Temporal | The Temporal binary download was blocked (HTTP 403 from the sandbox proxy). The HTTP tests boot the real `ApiModule` with a stubbed Temporal client; every agency route works without a Temporal server. | Run against the Temporal in `docker-compose.dev.yaml`. |
| `docker-compose.agencyos.yml` | No container runtime daemon. The file passes `docker compose config` and is built from the repository's working compose file. | `docker compose … up -d --build`. |
| `pnpm lint` | ESLint fails to start on this repository with a circular-structure error in its config, before any of this work. `tsc --noEmit` and Prettier are clean. | Fix the upstream ESLint config. |

## Modules

### Foundation
| Item | Status | Evidence |
| --- | --- | --- |
| Prisma migrations (`0_baseline`, `1_agency_hardening`, `2_agency_crm`) with data fixes and `rollback.sql` | Done | Fresh `migrate deploy` has no drift; an old `db push` install is baselined and upgraded (`var/docker/prisma-migrate.sh`), data preserved, second run is a no-op. |
| Tenant isolation | Done | Every repository write is org-scoped (`updateMany` with `orgId`); tests "9. one agency cannot access another agency's data" (8 cases incl. defence in depth). |
| Roles and permissions (8 roles, ~30 permissions) | Done | `AGENCY_PERMISSIONS` is the single source; matrix tests; HTTP tests for 403/404. |
| Audit trail | Done | State changes, role changes, approvals, client sign-offs, invoices, deals; "every state change is in the audit trail". |
| Client accounts are portal-only | Done | `AuthMiddleware` refuses a CLIENT's calls outside `/agency/me`, `/agency/portal`, `/user/self`, `/user/organizations`, `/announcements` (plain 403); HTTP test. |

### Campaigns and approvals
| Item | Status | Evidence |
| --- | --- | --- |
| Clients (create, edit, search, delete guarded while campaigns are live) | Done | Security and HTTP tests. |
| Campaign composer with server-rendered Telegram preview, limits named, inline validation | Done | Preview test asserts the exact HTML that is sent; browser run. |
| Lifecycle `DRAFT → SUBMITTED → APPROVED → SCHEDULED → PUBLISHING → COMPLETED` plus `CHANGES_REQUESTED`, `PAUSED`, `PARTIALLY_FAILED`, `FAILED`, `CANCELLED`, `ARCHIVED` | Done | Status can only change through workflow methods (the update DTO has no `status`). |
| Four-eyes review; owners/admins may self-approve and it is recorded | Done | Security tests. |
| Optional client sign-off that gates agency approval | Done | "client sign-off … gates the agency approval". |
| Content frozen after approval; fingerprint re-checked at send time | Done | "content edited after approval cannot be sent". |
| Duplicate campaign, reopen (voids approval), archive, retry failed | Done | Publishing tests. |
| Version history of campaign content (`CampaignVersion`) | Missing | Only `revision` is counted. |
| Recurring schedules | Missing | One start time per destination; optional end time. |

### Telegram (authorized-only)
| Item | Status | Evidence |
| --- | --- | --- |
| Destination registry with consent: pending → active by a chat administrator sending `/authorize CODE`; `/revoke`; suspension; expiry (365 days default) | Done | 27 tests in `agency.telegram.int.spec.ts`: non-admins, bots, wrong/expired/replayed codes, wrong chat, anonymous admins, channel posts. |
| Bot removed or permission lost ⇒ destination disconnected, its queued posts pause, campaigns flagged | Done | Scenario 8 tests. |
| Updates by webhook (secret header) or long polling with a leader lease | Done | Transport tests; webhook never throws and always answers 200. |
| One Telegram boundary (`TelegramGateway`) | Done | No other code calls Telegram; error classification tests. |
| Live sending | Unverified | See limits above. |
| Per-agency bot tokens | Missing | One bot token per server (environment variable), never stored in the database. |
| Social networks as campaign destinations | Missing | The registry lists capabilities for 8 networks; campaigns can only dispatch to Telegram, and the composer says so. A campaign with only social destinations is refused at submit. |

### Publishing queue
| Item | Status | Evidence |
| --- | --- | --- |
| One job per campaign × destination with a unique idempotency key | Done | Scenario 6: three racing dispatchers send each ad once. |
| Claim-then-send with lease; crash mid-send ⇒ **Needs check**, never auto-resent | Done | Tests. |
| Retry with exponential backoff, Telegram `retry_after` honoured, dead-letter after max attempts, team notified | Done | Retry tests. |
| Pre-send re-checks: campaign state, end date, content fingerprint, destination consent, live bot permission | Done | Scenarios 3, 4, 8, 12, 13. |
| Posting windows, minimum interval and daily cap per destination | Done | Window tests. |
| Per-destination outcome; one failure never marks the campaign complete | Done | Scenario 7. |
| Truthful system status (dispatcher beating, updates listener) | Done | Dashboard banner; status tests. |
| Dispatcher is **opt-in** (`AGENCY_SCHEDULER_ENABLED=true`) | Partial | Off by default; the dashboard says when it is off. The queue is database-backed, not Temporal. |

### Sales, billing, reporting
| Item | Status | Evidence |
| --- | --- | --- |
| CRM pipeline: deals, five stages, guarded stage moves, lost reason, convert to client once, per-currency totals | Done | 13 tests in `agency.crm.int.spec.ts`; owner scoping for sales executives. |
| Invoices (sequential `INV-YYYY-NNNN`, per-currency totals, payment recorded by hand) | Done | Concurrency test. |
| Not done for invoices: sending, payment processing, overdue tracking | Missing | The screen says so. |
| Publishing report: delivered / failed / paused / queued / needs-check, rate, tracked clicks, per day, campaign, destination; CSV; print or save as PDF | Done | 7 integration tests + HTTP test; a rendered PDF was checked. |
| No impressions, reach or engagement | By design | No verified source exists. |
| Server-generated PDF files | Missing | The browser's print dialog produces the PDF. |
| Tracking links `/l/:code` (public, bot clicks excluded, UTM, salted IP hash, safe redirect) | Done | Tracking tests. |
| Lead capture funnel (forms, invite links, QR, conversion) | Missing | A `LeadCapture` table exists; there is no way to capture a lead. |

### Client portal, knowledge, AI
| Item | Status | Evidence |
| --- | --- | --- |
| Client portal: own campaigns only, no internal fields, unfinished drafts hidden, exact ad preview, approve / request changes | Done | Portal tests + browser run as a client. |
| Knowledge base: ingest with authorization attestation, retention (purge, delete), tenant-isolated | Done | Tests. |
| Search | Partial | Keyword hashing by default (labelled). Meaning-based search only when an Ollama embedding model is reachable, and only when every document has an embedding from the same model. No pgvector. |
| Sentiment | Partial | Word-list score, labelled as such. |
| Copy suggestions | Partial | Local Ollama if reachable; otherwise a template, labelled "Template draft". OpenAI only if `AGENCY_ALLOW_EXTERNAL_AI=true`. Never blocks publishing (scenario 11). |
| Connected accounts and capability registry | Partial | Status read from stored data (labelled "not live"); no OAuth tokens enter agency code; no capability data is invented for unlisted networks. |

### Interface
| Item | Status | Evidence |
| --- | --- | --- |
| Design system (tokens, dialog with focus trap, fields with inline errors, tabs, menu, stepper, skeletons, command palette) | Done | `docs/AGENCYOS_UI_DESIGN_SYSTEM.md`; browser run. |
| Light and dark, mobile (390 px: no horizontal scroll on 9 screens), reduced motion, visible focus | Done | Browser run; screenshots reviewed. |
| Every agency screen has loading, empty and error states and role-aware actions | Done | Browser run. |
| Screen-reader and keyboard audit with assistive technology | Missing | Semantics and keyboard paths were built and spot-checked; no assistive-technology testing was done. |

## The 13 required scenarios

| # | Scenario | Test |
| --- | --- | --- |
| 1 | Sales executive creates a draft | Publishing 1 |
| 2 | Manager approves / rejects | Publishing 2a, 2b |
| 3 | Unapproved campaign cannot publish | Publishing 3 (4 tests, incl. tampered database) |
| 4 | Unauthorized destination cannot receive | Publishing 4 (3 tests) |
| 5 | Approved campaign can be scheduled and delivered | Publishing 5 |
| 6 | Duplicate execution does not duplicate | Publishing 6 (4 tests, 3 racing dispatchers) |
| 7 | Failed destination does not mark all successful | Publishing 7 (4 tests) |
| 8 | Disconnected integration pauses jobs | Publishing 8 (3 tests) |
| 9 | Cross-agency isolation | Security 9 (8 tests) + HTTP isolation tests |
| 10 | Reports use genuine stored metrics | Security 10 (4 tests) + report tests (7) |
| 11 | AI failure does not stop scheduling | Publishing 11 |
| 12 | Cancelled campaign stops | Publishing 12 (4 tests) |
| 13 | Revoked permission prevents publishing | Publishing 13 (3 tests) |

## Known defects and limits

* A full Jest run failed once, and another run of the same suite failed the same way, on a timing race in a test helper (a job is marked done a moment before its campaign is reconciled). The helper now waits for that state; five consecutive full runs after the fix passed. It was a test-synchronization issue; the production code reconciles immediately after the job.
* The Postiz shell still asks the server for connected accounts and notifications when a CLIENT opens the portal; those calls are refused (403) and the portal is unaffected, but the browser console shows the refusals.
* The development server's error overlay in the screenshots comes from Postiz's own chat widget (it cannot reach the backend from the test harness), not from AgencyOS screens.
* `pm2-run` now applies migrations instead of `db push`. Anyone merging upstream Postiz changes that alter the schema must add a migration for them.
