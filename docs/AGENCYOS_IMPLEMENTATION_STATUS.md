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
| Full backend boot with Temporal in the Linux sandbox | The Temporal download was blocked there (HTTP 403 from the sandbox proxy), so the HTTP tests use a stubbed Temporal client. The real backend and orchestrator did boot against a real Temporal server in the Windows CI run (see "Windows run"). | Run against the Temporal in `docker-compose.dev.yaml`. |
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
| Ad templates (content only: text, media, link; unique names, per-workspace, audited; composer dialog to save, use and delete with confirmation) | Done | 7 tests in `agency.templates.int.spec.ts`, 1 HTTP end-to-end test |
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
| Backup bots and taking turns: failover, round robin, least used, manual switch; a backup must be a live administrator of the chat; no switching when a chat removes the main bot or Telegram slows a bot down; every change of bot audited with time, reason and campaign; receipts show the bot | Done (against a simulated Telegram) | 14 tests in `agency.telegram.backup.int.spec.ts`. Not run against real Telegram. |
| Any number of bots connected in the app, tokens sealed (AES-256-GCM) in the database and never returned; each chat served by one bot; pause, remove, check; one update listener per bot; the server-settings bot kept as a read-only "server bot" | Done (against a simulated Telegram) | 16 tests in `agency.telegram.bots.int.spec.ts` (sealing, duplicates, roles, tenancy, wrong bot cannot authorize, delivery through the chat's own bot, pause/resume, removal never hands chats to another bot, rejected token) and 2 HTTP tests. Not run against real Telegram. |
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
| Dashboard live queue (sending, needs check, failed, paused, waiting; most urgent first) and bot/chat health (bot states and chat counts; chats ready, lost, slowed by Telegram) | Done (no shadow-ban indicator: Telegram reports none) | 5 tests in `agency.dashboard.int.spec.ts` |
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
| Copy suggestions | Partial | The provider chosen in Settings (Antigravity CLI by default on the desktop app, a local Ollama model otherwise); otherwise a template, labelled "Template draft" with the reason. Never blocks publishing (scenario 11). |
| AI providers (local, Claude Code, Codex CLI, Antigravity CLI, Anthropic, OpenAI, Gemini, OpenAI-compatible), model and thinking-level choice, sealed keys, Test, Copilot chat | Partial | 35 unit/integration tests plus HTTP tests with stand-in programs and mocked APIs. Claude Code's flags were run for real; Codex CLI and API request shapes follow their documentation but were **not** run against the real services here; Antigravity CLI is experimental (third-party-documented flags, known headless hang in some versions). Chat answers are not streamed. |
| Automatic updates for AI command-line tools | Partial | `claude update`, `codex update` and `agy update` once a day with a switch and an Update now button (tested with stand-in programs, not against the real updaters; the Antigravity command follows Google's documentation). |
| Model and thinking-level discovery | Partial | Each tool is asked for its own list: Claude Code through its stream-json initialize reply (run for real), Codex CLI through `codex app-server` `model/list`, Antigravity through `agy models`, Ollama through `/api/show` capabilities. Codex and Antigravity discovery follow third-party or snippet-level documentation and were **not** run against real installs; each falls back to a short built-in list and says so. |
| Per-job model and thinking level (ad copy, text improvement, Copilot, agent) | Done | Unit/integration tests and an HTTP end-to-end test; each job has its own Test button. |
| Copilot agent mode | Partial | One-step-per-request agent loop with read tools and approval-gated change tools; 8 integration tests and an HTTP end-to-end test with a scripted model. Run live once against Claude Code (haiku) and in the browser. No approve, schedule, send, delete or authorize tool exists. Needs a capable model (a very small local model may not follow the step format). Answers are not streamed. |
| Connected accounts and capability registry | Partial | Status read from stored data (labelled "not live"); no OAuth tokens enter agency code; no capability data is invented for unlisted networks. |

### Interface
| Item | Status | Evidence |
| --- | --- | --- |
| Design system (tokens, dialog with focus trap, fields with inline errors, tabs, menu, stepper, skeletons, command palette) | Done | `docs/AGENCYOS_UI_DESIGN_SYSTEM.md`; browser run. |
| Light and dark, mobile (390 px: no horizontal scroll on 9 screens), reduced motion, visible focus | Done | Browser run; screenshots reviewed. |
| Every agency screen has loading, empty and error states and role-aware actions | Done | Browser run. |
| Screen-reader and keyboard audit with assistive technology | Missing | Semantics and keyboard paths were built and spot-checked; no assistive-technology testing was done. |

## Windows desktop installer

AgencyOS can be installed on a Windows laptop with nothing else installed and runs as its own
desktop application (Electron window, tray icon; not a browser tab). Antigravity CLI is the default
AI; a local model, which AgencyOS can choose for the hardware, is optional. How it works: [`installer/README.md`](../installer/README.md); how to use it:
[`AGENCYOS_WINDOWS_INSTALL.md`](AGENCYOS_WINDOWS_INSTALL.md).

| Item | Status | Evidence |
| --- | --- | --- |
| Hardware detection and model selection (EmbeddingGemma + a Gemma text model sized to memory, threads, NVIDIA video memory and free disk; AI off below 4 GB) | Done | 26 unit tests across hardware classes, disk limits, overrides and step-down; model sizes read from `registry.ollama.ai` |
| AI manager: runtime download with resume and checksum, model pulls with progress, embedding check, measured speed, step-down to a lighter model, offline wait, reuse of an existing Ollama | Done | 9 state-machine tests with a scripted Ollama; 21 tests of downloads, the Ollama client and registry lookups |
| Local model manager (opt-in automatic setup that starts off on a new install; download any model by name with progress and cancel; try, delete with confirmation, install/start/stop the engine; deleted models are not downloaded again; one operation at a time; names validated) | Done (launcher logic, proxy and browser run with a stand-in launcher); not run against a real Ollama on Windows until the 1.4.0 smoke run | 11 new launcher tests with a scripted Ollama, a status-server endpoint test, browser walkthrough; the Windows smoke test now downloads and deletes a small model by hand |
| Closing the window shuts AgencyOS down after a confirmation that says no campaign will be sent; minimizing keeps it running | Done (policy text tested); not run on a real Windows desktop | policy test of the notice and buttons |
| Supervisor: ordered start, readiness, restart with backoff, clean stop, leftover cleanup | Done | 11 tests with real child processes; also run on a Windows runner |
| Status page and control API (loopback only, token for state changes, Host check) | Done | 14 tests. The page is now only the failure and data-move view; its Telegram box moved into the app. |
| System and storage settings inside the app (status, local AI, restart, change data and AI folders with plan check, confirmation and folder picker) through an authenticated same-origin proxy; start-up screen instead of the status page; tray opens the in-app settings | Done (logic, proxy and browser run); not run on a real Windows desktop | policy tests (folder picker only for the Settings page, start-up line), launcher test (token only in the app server), 4 live proxy checks (allowed, anonymous, cross-site, wrong host, unlisted actions) and browser screenshots |
| Desktop shell (own window, tray, single instance, hardened navigation: only AgencyOS pages in the window, other web links open in the system browser, no Node access from pages) | Done (policy tested); window behaviour checked on a Windows runner, see below | 8 policy tests |
| Staged app: dependency-closure `node_modules` (3.4 GB to about 1 GB) and standalone frontend | Done | `stage-app.mjs --verify` loads all 666 compiled files with only the staged modules; ran the staged tree on Linux against real PostgreSQL, Redis and the Prisma migrations (a stand-in held the Temporal port) |
| Inno Setup installer, per user, no administrator rights | Done: built, installed, run and uninstalled on a Windows runner | see "Windows run" |

### Windows run

The workflow `windows-installer` builds the installer on a GitHub-hosted `windows-latest` runner
(Windows Server 2025, 4 threads, 16 GB memory, no GPU, an AMD EPYC virtual machine) and then runs
`installer/windows/smoke-test.mjs` against the finished installer. The run for commit `ecfd2d7`
passed all nine steps:

| Step | Result |
| --- | --- |
| Silent per-user install, no administrator prompt | Passed (99 s) |
| First start on a machine with nothing installed: PostgreSQL, Redis, Temporal, migrations, backend, orchestrator, frontend | Passed (63 s to "ready") |
| Every listener is bound to 127.0.0.1 only | Passed |
| Native desktop window (Electron) loaded `http://localhost:4200/auth`; no browser process; the page has no Node access | Passed |
| Product journey through the real server: sign up, sign in, create a client, read the dashboard, load the app's pages | Passed |
| Local AI chose the **Light** tier for this machine (`gemma3:1b` + `embeddinggemma`), downloaded both, measured **38.7 tokens/s** | Passed (25 s) |
| EmbeddingGemma returned 768-dimension vectors; ad copy came from the local model (`providerUsed: ollama`) in 3 s | Passed |
| Quit, services stop cleanly, start again: sign-in works, data and both models kept without downloading | Passed (26 s) |
| Uninstall with data purge: program, shortcuts, start-at-sign-in entry and data folder removed | Passed (14 s) |

The earlier runs found and fixed real defects, in this order: Windows path handling in the launcher,
`pg_ctl` leaving the database wrapper waiting on inherited pipes (first start never finished), a
five-minute wait after a transient 503 from the model registry, ad copy silently falling back to
templates because the prompt never named the JSON keys, and test races (restart status read too
early, uninstall purge checked before it ran). This also means the backend and orchestrator were booted
against a **real Temporal server** on Windows.

### Release

`windows-v1.0.0` was published by the workflow's `release` job (only reachable after the smoke test
passes) from commit `3ca06a5`: https://github.com/smartave99/AgencyOS/releases/tag/windows-v1.0.0
(`AgencyOS-Setup-1.0.0.exe`, 365 MB, SHA-256 `550f80f21c636dd46661d64c09770b73d4fba5ca7993c62b74354d613d1a1d67`,
plus a `.sha256` file). That final run passed all nine steps again; on that runner the Light tier measured
22.7 tokens/s and the first ad-copy request took 95 s (model load plus generation on 4 shared threads).
The build is **not code-signed**, so Windows SmartScreen warns on first run.

One earlier publish attempt (on `584613f`) failed the ad-copy step: the 1B model answered but not in the
expected shape, so the product fell back to template copy. The model is now given a JSON schema and
retried once before the fallback. Because the same 1B model passed on some runs and failed on one, treat
"copy from the local model" on the smallest tier as likely, not guaranteed; the template fallback keeps
the feature working either way.

What this run does **not** show: a Windows machine with a GPU (the NVIDIA and larger-tier paths are
covered by unit tests of the selection logic only), Windows on ARM (the ARM runtime is pinned and its
checksum recorded but was not run), the system-tray behaviour of the desktop shell, a laptop with a
slow disk or a flaky connection, or an upgrade over a previous version.

## Local desktop: where files are stored, and no sign-in

| Capability | State | Evidence |
| --- | --- | --- |
| The person chooses where the data (database, uploads, logs) and, separately, the AI engine and models live; one small file (`locations.json`) tells the launcher, the desktop shell and the uninstaller | Done in the launcher | Tests with real folders: defaults, a saved choice, a damaged or relative pointer is ignored, `AGENCYOS_DATA` freezes the choice, Windows paths, the exact file the installer writes (CRLF, escaped backslashes, with or without a byte-order mark) |
| Moving it later is safe: the folder and free space are checked while typing, services stop, files are copied (large files in chunks, progress shown), the copy is compared with the original, the pointer is switched, a fresh supervisor starts from the new place, and the old copy is removed only on request | Done in the launcher | Tests: moves data and AI files together or separately; a failed copy is rolled back and services restarted; a database that did not stop cleanly is refused; a log line added mid-check does not fail a good copy; the old copy and the pointer survive correctly on cleanup; nothing in use is ever deleted; an unplugged drive stops the start |
| Status page Storage section (inline validation, advanced AI folder, confirmation, progress, "Delete the old copy") and the control API behind it | Done | HTTP tests (token required, bad folder reported with its field); the page script is compiled in a test and every element it uses is checked |
| Native folder picker in the desktop window, answering only the status page | Written | The origin rule is unit tested; **not run in a real Electron window** |
| Installer wizard page (data folder, optional AI folder, validation, free space), silent switches `/DATADIR` `/AIDIR`, an uninstaller that lists the folders before deleting | Written | **Not compiled or run here** (no Inno Setup or Windows in this environment). The Windows CI job compiles it and its smoke test now asserts `locations.json` is created |
| No sign-in on a person's own computer: the app server opens the one local workspace with a per-install key; sign-in, sign-up and password-reset routes are switched off | Done | 5 HTTP tests on the compiled backend with PostgreSQL (wrong or missing key creates nothing, the session works on the real API, asking again gives the same workspace, the closed routes create no account, normal sign-in is untouched outside local mode); the frontend proxy was exercised with a real Next.js server and a stand-in backend (cookie set once, sign-in and logout addresses lead to the workspace) |
| Settings → Storage tab in the app; Logout and the Agents tab hidden in local mode | Done | Type-checked; **not clicked through in a browser** |
| One identity: AgencyOS, created by NextGen OS, in the app, window titles, logos, favicon, translations, emails, installer metadata and docs | Done for everything a person sees | Code identifiers, environment variable names and the `@gitroom/*` import aliases are internal and unchanged |

Because there is no sign-in in this mode, the client portal and per-person roles do not apply to the
desktop app; they remain for server deployments, where sign-in stays on.

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
* The app shell still asks the server for connected accounts and notifications when a CLIENT opens the portal; those calls are refused (403) and the portal is unaffected, but the browser console shows the refusals.
* The development server's error overlay in the screenshots comes from the app's own chat widget (it cannot reach the backend from the test harness), not from AgencyOS screens.
* `pm2-run` now applies migrations instead of `db push`. Any change that alters the schema must come with a migration.
