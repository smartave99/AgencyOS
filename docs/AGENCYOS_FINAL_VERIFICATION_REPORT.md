# AgencyOS — final verification report

Written 2026-10-23 for the "Telegram + WhatsApp + local AI master completion" brief. It says what exists, what was
tested, what was **not** tested, and what was deliberately not built. The row-by-row detail is in
[`TELEGRAM_COMPLETION_TRACKER.md`](./TELEGRAM_COMPLETION_TRACKER.md); this is the summary a person can read in one sitting.

**Shipped:** `windows-v1.4.0` (from `8fd7b1d`) and `windows-v1.5.0` (from `db91cc4`). Both were published only after a full
smoke test on a clean GitHub-hosted Windows machine passed. The branch `claude/sleepy-hamilton-cp5cqt` is at the same
code plus documentation.

**The one sentence to keep in mind:** nothing in this report has been exercised against the real Telegram service, a
real WhatsApp, a signed-in Antigravity/Claude/Codex account, or a real Windows laptop. Everything is tested against
fakes that follow our reading of those services, plus a clean Windows build machine for the installer.

## 1. Requirements implemented

| Brief phase                                                        | State                   | Where                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracker, resume point                                              | Done                    | `docs/TELEGRAM_COMPLETION_TRACKER.md`                                                                                                                                                           |
| Telegram user-account provider (Python / Telethon, phone + code)   | Done, **not live**      | `apps/telegram-worker`, `docs/TELEGRAM_WORKER_CONTRACT.md`, `docs/AGENCYOS_TELEGRAM_USER_ACCOUNTS.md`                                                                                           |
| Sealed sessions, 2FA, health, several accounts, permissions        | Done, **not live**      | Session, api hash and login are one AES-256-GCM value no API returns; per-account permissions; a limit/restriction/ended login pauses that account only                                         |
| Public community discovery and directory                           | Done                    | Communities page (`/agency/communities`), directory, labels, notes, duplicates, CSV/JSON export                                                                                                 |
| Research module                                                    | Done                    | Search, import by @name/link, refresh, availability, policy review, history; no member lists, no phone numbers, no private-group scraping                                                       |
| Permission-aware join workflow (8 states)                          | Done                    | DISCOVERED → REVIEW_REQUIRED → JOIN_REQUEST_PENDING/JOINED → ADVERTISING_ALLOWED → PUBLISHING_AUTHORIZED, plus NOT_ELIGIBLE and BLOCKED; audited; deliberate action with a reason; daily cap 20 |
| Community administration                                           | Done, **not live**      | Create, invite links, review join requests one by one; no bulk adding                                                                                                                           |
| Ad automation on the existing queue                                | Done                    | Templates, A/B versions (up to 4), repeat and drip schedules, receipts, reconciliation instead of re-sending, restrictions pause jobs and never reassign an identity                            |
| Unified accounts view                                              | Done                    | `GET /agency/telegram/overview`, top of the Telegram accounts page                                                                                                                              |
| Local LLM through the existing Ollama runtime                      | Done                    | Qwen 3.5 `2b` / `4b` (default) / `9b` by memory and processor; Gemma kept for 8 GB graphics cards and small laptops; hand download of any size in Settings → System → Local AI                  |
| Antigravity CLI + MCP, READ/DRAFT scopes, approvals, no shell tool | Done (DRAFT, not WRITE) | `apps/agent-mcp`, `/agency/agent-integrations`, `docs/AGENCYOS_AGENT_INTEGRATIONS.md`                                                                                                           |
| WhatsApp free local workspace                                      | Done                    | `/agency/whatsapp`, `docs/AGENCYOS_WHATSAPP.md`; consent-based, manual sending only                                                                                                             |
| Frontend pages                                                     | Done (names differ)     | See section 6                                                                                                                                                                                   |
| Isolated Python worker                                             | Done                    | Loopback, token-authenticated, typed contract, health, supervised, graceful shutdown                                                                                                            |
| Additive Prisma migrations                                         | Done                    | Section 5                                                                                                                                                                                       |
| Windows desktop integration of the Python sidecar                  | Done, tested on Windows | Section 10                                                                                                                                                                                      |
| Tests for everything                                               | Done within the limits  | Section 11                                                                                                                                                                                      |

**One deviation from the brief:** agent integrations have READ and DRAFT scopes only. A draft is a proposal that a
person approves in the app; it then runs once, as that person. There is no WRITE scope. The brief's own safety rules
(no send, join, schedule, delete or shell) are why.

## 2. Discovery and research added

- Search public communities by words, import by `@name` or `t.me` link, refresh the public facts Telegram publishes
  (title, @name, description, member count when public, flags, slow mode, linked chat).
- Labels, notes, bookmarks, category, duplicate detection, availability and link validation, history of changes.
- A recorded human review of each community's advertising rules before it can reach ADVERTISING_ALLOWED; the review
  needs the rules text and two ticks, and lasts 90 days.
- Optional quiet refresh in the scheduler (`AGENCY_COMMUNITY_REFRESH=true`): first research account only, at most every
  six hours, at most ten communities per agency per pass. Off by default.
- Public messages are read only on request. No call lists members, reads private groups or collects phone numbers.
- Telegram content never reaches any AI model. `agency.ai.boundary.spec.ts` checks that the AI services import nothing
  that reads communities or accounts, and the other way round. It is a source-level guard, not a data-flow proof.

## 3. Preserved features

Nothing existing was removed. Bots, backup bots, destinations and authorization (/authorize, /revoke), approvals,
campaigns, templates, reports, CRM, leads, the dashboard, the Copilot and in-app agent, the AI gateway with its
providers, the local model manager, storage move, the desktop shell and the social scheduler all pass their existing
tests, and Windows runs 40, 41, 43, 44 and 46 passed the smoke test on top of them. User accounts are an addition
beside bots: publishing through a bot behaves as before, and a user-account job never falls back to a bot.

## 4. Python files

`apps/telegram-worker/agencyos_telegram/`: `__init__`, `__main__`, `ads`, `backend`, `errors`, `fake_backend`,
`limits`, `logs`, `models`, `refs`, `schemas`, `server`, `service`, `telethon_backend`, `telethon_convert`
(15 files). Tests in `apps/telegram-worker/tests/` (13 test files plus `conftest`, `harness`, `stub_telethon`).
Pinned runtime packages in `requirements.lock.txt` with SHA-256 hashes: `telethon 1.45.0`, `pyaes 1.6.1`, `rsa 4.9.1`,
`pyasn1 0.6.4` (all pure Python; `cryptg` deliberately left out).

## 5. Migrations

Prisma applies migrations in alphabetical folder order (`10_` sorts before `1_`), so new ones are `a1_`, `a2_`, …
A guard test (`migrations.order.spec.ts`) and `migrations/README.md` enforce that.

`a1_agency_variants_schedule`, `a2_agency_telegram_user_accounts`, `a3_agency_whatsapp`,
`a4_agency_agent_integrations` — all additive. All 14 migrations apply to an **empty** database and
`prisma migrate diff --exit-code` reports no drift (checked on the merged tree).

## 6. Frontend pages

| Brief name         | Where it is                                                                             |
| ------------------ | --------------------------------------------------------------------------------------- |
| Research           | `/agency/communities` (search, directory, detail at `/agency/communities/[id]`)         |
| Accounts           | `/agency/telegram/accounts` (accounts, bots, at-a-glance counts, activity, permissions) |
| Campaigns          | `/agency/campaigns` (templates, versions, schedules in the composer)                    |
| Communities        | `/agency/communities`                                                                   |
| WhatsApp           | `/agency/whatsapp`                                                                      |
| Local AI           | Settings → System → Local AI (inside Settings, not its own route)                       |
| Agent Integrations | `/agency/agent-integrations`                                                            |

All are reachable from the sidebar; each has a feature-guide entry (a launcher test fails otherwise).

## 7. Local AI configuration

Chosen automatically only when the person switches automatic setup on (a new install downloads no model). Tiers, best
first: Ultra/Max/High (Gemma 4, NVIDIA video memory 10 GB and up), Advanced (Qwen 3.5 9B; 24 GB memory and 12 threads, or
a 9 GB+ card), Enhanced (Gemma 4 E4B; 8 GB card), **Balanced (Qwen 3.5 4B, the default; 12 GB and 6 threads, or a 6 GB
card)**, Compact (Qwen 3.5 2B; 10 GB and 4 threads), Light (Gemma 3 1B; 8 GB). Each tier lists fallbacks; a tag the Ollama
library no longer has falls through to the next. The engine measures real speed and steps down a tier if the machine is
too slow. Thinking is off for ad copy and the Copilot unless the person turns it on per task.

Seen on Windows (run 46): the 16 GB / 4-thread runner chose Compact, `qwen3.5:2b`, **13 tokens/s**; ad copy took 23 s
and a Copilot answer 8 s (the earlier `gemma3:1b` took 5 s and 2 s). Qwen 3.5 `4b` and `9b` have never been downloaded
or run by us. Their sizes came from an earlier reading of the library and could not be re-checked from the sandbox.

## 8. Antigravity and MCP

- Antigravity CLI is the default AI provider on the desktop; setup installs it (Windows run 40 installed 1.3.4).
- `apps/agent-mcp/server.mjs`: JSON-RPC over standard input/output, no dependencies, loopback only, never logs the token.
  The installer copies it to `app/agent-mcp/server.mjs`, and the settings the page shows use the installed Node.js.
- Tokens: `agt_` + 32 random bytes, only the SHA-256 stored, shown once; at most 10 working tokens; 90-day default expiry;
  60 calls a minute per token (in memory, per process). A token opens only the three gateway routes.
- Tools: read tools reuse the in-app agent's; draft tools create a proposal only. A test pins the allowlist: no tool can
  send, schedule, approve, join, authorize, delete, run a shell, touch files, make HTTP requests or read secrets. A proposal
  runs once, as the approver, after a fresh role check. Client e-mail addresses and deal contact names are withheld.
- **Not verified:** the `.agents/mcp_config.json` name and layout follow the common MCP convention only; vendor
  documentation was unreachable. No real MCP client or Antigravity install has used it. The page and the doc say so.

## 9. WhatsApp

Contacts with a consent record, imports checked before saving, segments, templates with an opt-out line, one task per
person with **Open in WhatsApp / Copy message / Mark sent, skipped or replied**, reminders, an unsubscribed list that
survives erasure. There is **no sender, no queue, no timer, no "send all"**, no delivery or read status, no group
scraping. The Business Cloud API interface exists and is disabled. Tested with 35 integration tests and 4 HTTP end-to-end
tests; opening `wa.me` links on a phone has not been tried.

## 10. Windows packaging

- Python: the PSF's CPython 3.13.16 from the NuGet package, SHA-256 pinned in `installer/runtimes.json`; packages
  installed with `--require-hashes`; pip removed; the build proves the **staged** worker starts and answers `/health`.
- The launcher runs it as the optional `telegram-worker` service on `127.0.0.1`, with a random token shared only with
  the app's server, the uploads folder as its only media folder and no database address. If it is missing or fails,
  AgencyOS starts anyway and the Telegram accounts page says the service is not running.
- Windows runs on a GitHub-hosted Windows Server 2025 machine: **40, 41, 43 (1.4.0), 44, 46 (1.5.0) passed**. Runs 38 and
  39 failed and were fixed (PowerShell 7's module path breaking `Get-FileHash`; a file-size check racing the live database).
  The run proves the worker starts on Windows and the server reaches it. It does not prove Telegram accepts it.
- The installer is **not code-signed**. The signing pipeline is built and proven with a throwaway certificate.

## 11. Test commands and results (this tree, 2026-10-23)

| Suite                                         | Command (from the repo root unless noted)                                                                                                                                                | Result                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Backend/libraries (real PostgreSQL, fakes)    | `AGENCYOS_TEST_DATABASE_URL=… DATABASE_URL=… npx jest --runInBand --testPathIgnorePatterns=/.claude/`                                                                                    | **448 passed, 28 suites**                                                  |
| HTTP end-to-end (compiled backend + Postgres) | `cd apps/backend && AGENCYOS_TEST_DATABASE_URL=… REDIS_URL=… node --experimental-require-module --test --test-force-exit --test-concurrency=1 ./e2e/*.test.mjs` (after `pnpm run build`) | **49 passed**                                                              |
| Telegram worker (Python)                      | `cd apps/telegram-worker && python -m pytest tests -q`                                                                                                                                   | **602 passed, 1 skipped**                                                  |
| Launcher, installer, desktop policy           | `node --test installer/launcher/test/*.test.mjs installer/desktop/test/policy.test.js`                                                                                                   | **198 passed** (one earlier run had a single, unreproduced failure, below) |
| MCP server                                    | `node --test apps/agent-mcp/test/*.test.mjs`                                                                                                                                             | **23 passed**                                                              |
| Types                                         | `tsc --noEmit -p apps/backend/tsconfig.build.json`; `cd apps/frontend && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`                                                          | clean (checked on the merged tree before the last docs-only commits)       |
| Empty-database migration                      | `prisma migrate deploy` then `prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --exit-code`                                                                        | 14 applied, no drift                                                       |
| Windows smoke test                            | `windows-installer.yml` (`publish=false`, `sign_selftest=true`; and the two publish runs)                                                                                                | passed on runs 40, 41, 43, 44, 46                                          |

Things to know about these numbers:

- **One intermittent launcher failure, not reproduced.** On one of four full runs on 2026-10-23 a single launcher/desktop
  test failed. I kept only the pass/fail counts of that run, not its log, so I do not know which test it was. Since then
  the same suite passed 21 whole-suite runs (6 of them with 8 CPU-burning processes on 4 cores, 6 straight after the
  Python suite), and each of the 12 launcher test files passed 15 runs on its own (180 runs). Two suspects were hardened anyway, without proof they were the cause: the status-server test now lets the system pick
  its port (the server accepts port 0 and reports the port it bound), and the `services.test.mjs` timing limit went from
  4 s to 15 s with the test ending its own background process. If it happens again, save the whole output
  (`node --test … > run.log 2>&1`) and read the `not ok` lines first.
- The backend build needs a larger heap on this sandbox (`NODE_OPTIONS=--max-old-space-size=6144`); the default ran out
  of memory once.
- Tests run against fakes: a fake worker for the NestJS side, an in-memory backend and a stub Telethon client built from
  real TL types for the Python side. None of that is Telegram. The new Telegram rows never leave `TESTED`.
- Browser walkthroughs (Playwright, Chromium only) covered the accounts, communities and agent-integrations screens
  against local servers. No other browsers, touch devices or screen readers.

## 12. Live verification still required

- **Telegram, everything:** login with code and two-step password, which entity flags decide a relation or "may post",
  invite previews, join requests, creating communities, album and caption behaviour, flood-wait and restriction behaviour in
  practice. The worker README lists each under `LIVE_VERIFICATION_REQUIRED`. It needs an `api_id`/`api_hash` from
  <https://my.telegram.org> and a phone that can receive the code.
- **Telegram bots** at scale: several bots, backups and turn-taking are tested against a simulated Telegram only.
- **Vendor tools:** Claude Code, Codex and Antigravity installers and complete browser sign-ins on a real machine
  (the CI run downloads and starts a sign-in; nobody can finish one there).
- **Qwen 3.5 `4b` and `9b`** on real hardware; NVIDIA GPUs; Windows on ARM; other Windows versions.
- **MCP / Antigravity:** the configuration file layout against Antigravity or any real MCP client.
- **WhatsApp:** `wa.me` links on a phone.
- **A person using the installed app:** the window start-up screen, tray entry and folder picker are checked by logic and in
  a browser plus the CI smoke test, not by someone at a real desktop.

## 13. Restricted and blocked requirements

Not built, and not planned, because the harm lands on people who never agreed: **auto-joining groups, scraping member
lists or usernames, bulk-adding people, rotating or warming up accounts to get around bans, and sending "whether or not
permission was given."** Asking for them with a different model, a user account instead of a bot, or a stated
authorization does not change that. `RULES.md` is unedited; `docs/AGENCYOS_RULES_CONFLICT.md` records the position.

Also by the brief's own rules: no account creation or purchase, no switching account to evade enforcement, no CAPTCHA
bypass, no automatic WhatsApp sending, no Telegram content to any model.

**Blocked by something other than a decision:** a code-signing certificate (only the owner can obtain one).

## 14. Remaining work

1. Live Telegram verification (section 12) — the largest remaining risk.
2. A code-signing certificate, so SmartScreen stops warning (`docs/AGENCYOS_SIGNING.md`).
3. A licence review of the Postiz-derived code before commercial distribution.
4. Catch the intermittent launcher test failure (not reproduced in 200+ runs; see section 11).
5. ~~Per-bot rate-limit state and a chat assignment screen~~ — added after 1.5.0 (migration `a5_agency_bot_rate_limit`, the
   "Which bot posts where" card). Not in a published release yet; the server bot's own slow-downs are not recorded.
6. Output checking for the newer AI jobs (copy generation has it; variations, briefs and JSON jobs are partial).
7. Check the agent configuration file layout against Antigravity's documentation; the agent rate limit is per process.
8. No automatic updates: a newer setup file is installed over the old one.
9. The 1.5.0 release notes contain one stray line, "pythonPackages undefined (undefined)". The script is fixed (`0e1a48e`);
   the published page can only be edited by hand.
