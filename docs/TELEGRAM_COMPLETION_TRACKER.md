# Telegram completion tracker

Every Telegram requirement in `RULES.md` (and the completion brief that followed it), mapped to what the
source actually does today. Written from the code and the test runs, not from the plan. Update the row,
not the prose, when something changes.

**Status words**

| Word                    | Meaning                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `EXISTING`              | In the source and working, but its tests are thin or it is not the whole requirement                                                     |
| `PARTIAL`               | Works with a stated limit                                                                                                                |
| `MISSING`               | Not built yet                                                                                                                            |
| `IMPLEMENTED`           | Built, not yet covered by tests                                                                                                          |
| `TESTED`                | Built and covered by automated tests (Linux: Jest against PostgreSQL, HTTP end-to-end, launcher tests; Python: pytest)                   |
| `LIVE_VERIFIED`         | Exercised against the real service by a person or a run on real infrastructure. **Nothing in the Telegram column is at this level yet.** |
| `RESTRICTED`            | `RULES.md` asks for it; AgencyOS does not build it, and the reason is written down. See `AGENCYOS_RULES_CONFLICT.md`                     |
| `EXTERNAL_PREREQUISITE` | Cannot be completed from the code alone (credentials, a certificate, a real account, a vendor site)                                      |

A mock proves our code against our idea of Telegram. It never moves a row to `LIVE_VERIFIED`.

## 0. The position on the `RULES.md` features that harm other people

`RULES.md` (rules 1–7 of the primary aim) lists harvesting members, bulk-adding people, unattended
joining of groups, evasive account rotation and account warm-up. AgencyOS keeps the _purposes_ behind them
(reach communities, post advertising where it is allowed, grow an owned audience, keep a campaign going when a
sending account has a technical problem) and builds the permitted way to each. The five forbidden methods
stay `RESTRICTED` and stay listed here so nobody has to wonder whether they were forgotten. `RULES.md` itself is
not edited; the conflict is explained in `docs/AGENCYOS_RULES_CONFLICT.md`.

| Not built                                                                         | Why                                                                   | What is built instead                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading member lists, phone numbers or other personal details of people in groups | Those people never agreed; Telegram's terms and privacy law forbid it | Public community metadata and a person reading public messages on screen; lead capture from people who start the bot themselves                                                                                                          |
| Bulk-adding scraped or uploaded users to groups                                   | Same people, plus unsolicited contact                                 | Create groups and channels you own; invite links; review join requests from people who asked                                                                                                                                             |
| Unattended background auto-join of lists of groups with randomized "human" delays | Evades the abuse detection the delays imitate                         | One deliberate, authorized join per action, by a named operator, with a recorded reason                                                                                                                                                  |
| Switching to another account when one is banned or limited                        | Ban evasion                                                           | A restriction pauses that account's jobs and says so; an operator reassigns on purpose to an account that is authorized for that destination. Backup **bots** that the chat's administrators authorized keep their consent-safe failover |
| Account warm-up that ramps activity to avoid spam detection                       | Designed to defeat anti-abuse systems                                 | Nothing. New accounts are used the way their owner uses them                                                                                                                                                                             |

## 1. `RULES.md` checklist

### Dashboard

| Requirement                                                  | Status   | Files / evidence                                                                                                                   | Limit / next                                                                                                                      |
| ------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Overview of all active Telegram accounts and their status    | PARTIAL  | Bots: `agency.telegram.bots.service.ts`, `dashboard.component.tsx` (Bots and chats card), `agency.dashboard.int.spec.ts` (TESTED). | User accounts have no model yet → section 2 and 8                                                                                 |
| Live job queue: pending / running / failed                   | TESTED   | `agency.repository.ts getDashboardMetrics`, 5 tests in `agency.dashboard.int.spec.ts`                                              |                                                                                                                                   |
| Account health: active, rate-limited, blocked, shadow-banned | PARTIAL  | Bot states and chat counts (ready, lost, slowed by Telegram) are shown                                                             | Telegram reports no shadow-ban state, so none is shown (`EXTERNAL_PREREQUISITE` by nature). User-account health follows section 2 |
| Quick actions for every core workflow                        | EXISTING | Dashboard action row                                                                                                               | New workflows (research, communities, accounts) get their entry as they land                                                      |
| Admin sees all, sales sees own campaigns                     | TESTED   | 8 roles, permission matrix tests, owner scoping                                                                                    |                                                                                                                                   |

### Ad creation and campaigns

| Requirement                                                | Status      | Files / evidence                                                                                                                             | Limit / next                                                                      |
| ---------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Rich text composer with media; server-rendered preview     | TESTED      | `campaign-form.component.tsx`, preview test asserts the exact HTML sent                                                                      |                                                                                   |
| Campaign builder: name, budget, destinations, schedule     | TESTED      | `agency.service.ts`, `campaign.dto.ts`                                                                                                       | Budget is recorded, not spent: AgencyOS buys no ads                               |
| Account rotation inside a campaign                         | PARTIAL     | Backup bots: failover, round robin, least used, manual (`agency.telegram.backup.int.spec.ts`, 14 tests)                                      | User accounts: manual assignment and permitted load distribution only (section 8) |
| Template library                                           | TESTED      | `AdTemplate`, `agency.templates.int.spec.ts` (7) + 1 HTTP test                                                                               |                                                                                   |
| A/B variants per campaign                                  | IMPLEMENTED | Migration `a1_agency_variants_schedule`, `agency.publishing.*` (labels A–D rotated across destinations, covered by the approval fingerprint) | Tests, composer tabs and per-variant report are the next task                     |
| Lifecycle Draft → Scheduled → Running → Paused → Completed | TESTED      | Publishing scenarios 1–13                                                                                                                    |                                                                                   |
| Revision history of content                                | PARTIAL     | `revision` counted; no stored versions                                                                                                       | `CampaignVersion` table is planned (section 7)                                    |

### Group join (`RULES.md`: "Group Auto-Join")

| Requirement                                          | Status                  | Files / evidence | Limit / next                                                                                    |
| ---------------------------------------------------- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| Input: list of links / usernames / invite codes      | MISSING → planned       |                  | Becomes _research import_: a list is resolved to public metadata, nothing is joined (section 3) |
| Background worker that joins groups unattended       | RESTRICTED              |                  | Replaced by the permission-aware join workflow (section 5): one deliberate join per action      |
| Delay randomization to mimic human behaviour         | RESTRICTED              |                  | Evasion by design. Pacing for _our_ sends stays as honest minimum intervals and caps            |
| Success / failure report per group with reason codes | MISSING → planned       |                  | Join attempts record the worker's error code and a plain explanation (section 5)                |
| Retry queue with backoff for failed joins            | RESTRICTED as automatic |                  | A person retries a join; `RATE_LIMITED` shows when to retry                                     |

### Auto-post

| Requirement                                                 | Status        | Files / evidence                                                                                     | Limit / next                                                      |
| ----------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Select campaign + destinations + sending account            | TESTED (bots) | Destination registry with consent, `/authorize`, delivery through the chat's own bot (16 + 27 tests) | User accounts as senders: section 7                               |
| Schedule: one-time, recurring, drip                         | IMPLEMENTED   | `PostingJob.occurrence`, `cleanSchedule` in `agency.service.ts`, ONCE/REPEAT/DRIP in publishing      | Tests and composer UI are the next task                           |
| Per-destination throttle (min interval, windows, daily cap) | TESTED        | Window tests                                                                                         |                                                                   |
| Fallback to next account if the posting account is blocked  | PARTIAL       | Bots only, and only to a backup the chat's admins authorized                                         | For user accounts a ban pauses jobs; no re-routing (`RESTRICTED`) |
| Post receipt with the Telegram message id                   | TESTED        | Receipt in `PostingJob`, report tests                                                                | Real message ids are `LIVE_VERIFIED: no`                          |
| Ambiguous send → reconciliation, never resent               | TESTED        | "Needs check" state                                                                                  |                                                                   |

### Scraper (`RULES.md`: "Usernames & Discussions")

| Requirement                                                 | Status            | Files / evidence                               | Limit / next                                                                                                    |
| ----------------------------------------------------------- | ----------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Scrape members of a group                                   | RESTRICTED        |                                                | See section 0                                                                                                   |
| Scrape discussions for keyword matches (bulk)               | RESTRICTED        |                                                | Replaced by a person reading the most recent public messages of a public community on screen (≤ 20, not stored) |
| Public community discovery by keyword, name, username, link | MISSING → planned | Contract: `/v1/communities/search`, `/resolve` | Section 3                                                                                                       |
| Export CSV / JSON / clipboard                               | MISSING → planned |                                                | Of _saved public community metadata_, never people                                                              |
| Deduplication                                               | MISSING → planned |                                                | By Telegram id and by normalized username                                                                       |
| Respect rate limits with automatic throttling               | MISSING → planned | Worker spacing and `RATE_LIMITED` pass-through | Never slept through                                                                                             |

### Group creator and user adder

| Requirement                                              | Status            | Files / evidence                   | Limit / next                                                |
| -------------------------------------------------------- | ----------------- | ---------------------------------- | ----------------------------------------------------------- |
| Create groups and channels from the dashboard            | MISSING → planned | Contract: `/v1/communities/create` | Section 6                                                   |
| Bulk-add scraped or uploaded users                       | RESTRICTED        |                                    | See section 0; invite links and join-request review instead |
| Delay randomization on adds                              | RESTRICTED        |                                    |                                                             |
| Per-user "cannot be added" errors; added/failed tracking | RESTRICTED        |                                    | Nobody is added                                             |

### Account manager

| Requirement                                           | Status               | Files / evidence                                     | Limit / next                                     |
| ----------------------------------------------------- | -------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Add accounts by phone + OTP (+ 2FA)                   | MISSING → planned    | Contract: `/v1/login/*`                              | Section 2. QR login is not planned               |
| Sessions encrypted at rest (AES-256)                  | TESTED for bots      | Bot tokens sealed AES-256-GCM (HKDF of `JWT_SECRET`) | User sessions reuse the same design              |
| Rotation: round robin, least used, manual             | TESTED for bots      | `agency.telegram.backup.int.spec.ts`                 |                                                  |
| Auto-detect blocked / rate-limited accounts and pause | TESTED for bots      | Scenario 8                                           | User accounts: section 2                         |
| Promote the next account automatically on failure     | PARTIAL / RESTRICTED | Bots with authorization: yes                         | A banned user account is never replaced silently |
| Account warm-up scheduler                             | RESTRICTED           |                                                      | See section 0                                    |

## 2. User-account provider (Python / Telethon, MTProto)

Details, limits and what is tested: [`AGENCYOS_TELEGRAM_USER_ACCOUNTS.md`](AGENCYOS_TELEGRAM_USER_ACCOUNTS.md).

| Requirement                                                                                              | Status              | Files / evidence                                                                                                                         | Limit / next                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Loopback, authenticated, typed worker with health, structured errors, correlation ids, graceful shutdown | TESTED              | `apps/telegram-worker/` (16 modules), `docs/TELEGRAM_WORKER_CONTRACT.md`; 602 pytest tests incl. real HTTP server and process start/stop | The real Telethon calls were only run through a stub client: **LIVE_VERIFICATION_REQUIRED** (list in the worker README) |
| Phone login with OTP; optional 2FA; wrong code retried (5 tries)                                         | TESTED (fake)       | `agency.telegram.users.service.ts`, `telegram.user.gateway.ts`; `agency.telegram.users.int.spec.ts` (17), HTTP e2e, browser run          | Needs the operator's `api_id`/`api_hash` (`EXTERNAL_PREREQUISITE`); no live login done                                  |
| Session encrypted at rest; never in an API, log or page                                                  | TESTED              | AES-256-GCM, own HKDF context; tests dump the row, the audit trail and every response                                                    |                                                                                                                         |
| Explicit connect / logout / revoke                                                                       | TESTED              | logout ends the login at Telegram, wipes the sealed value, switches permissions off                                                      | If offline, the user is told to end it in Telegram → Devices                                                            |
| Several independently authorized accounts; account-level permissions                                     | TESTED              | research on by default; join/publish/manage granted by owners/admins; checked on every use                                               |                                                                                                                         |
| Health, rate-limit status, error classification, audit and event history                                 | TESTED              | `recordFailure` maps `SESSION_INVALID`/`ACCOUNT_RESTRICTED`/`RATE_LIMITED`; activity dialog                                              | No shadow-ban state exists at Telegram to show                                                                          |
| User accounts distinct from bots                                                                         | TESTED              | separate models, gateway, send path; bot gateway untouched                                                                               |                                                                                                                         |
| Never create accounts; never switch accounts to evade enforcement                                        | TESTED (by absence) | tests: after a restriction or limit no other account is asked or used; no endpoint creates an account                                    |                                                                                                                         |

## 3. Public community discovery and research

| Requirement                                                                                                                    | Status              | Files / evidence                                                                                                                                      | Limit / next                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Search by keyword, name, username, link                                                                                        | TESTED (fake)       | `/agency/communities/search`, `/import`, `/validate`; Telegram's own public search, ≤ 50 results                                                      | Category and language are the agency's labels, not Telegram's |
| Directory storing only permitted public metadata; no invented counts                                                           | TESTED              | `Community` model; a count Telegram did not return stays empty (asserted)                                                                             |                                                               |
| Relation OWNED / ADMINISTERED / MEMBER / PUBLIC_NOT_JOINED / RESTRICTED / UNAVAILABLE                                          | TESTED (fake)       | derived by the worker from entity flags                                                                                                               | Flag semantics **LIVE_VERIFICATION_REQUIRED**                 |
| Research page: search, filters, URL import, saved results, dedupe, bookmarks, sort, CSV/JSON export, errors, refresh           | TESTED              | `communities.component.tsx`; browser run; HTTP e2e                                                                                                    |                                                               |
| Bounded refresh with backoff; availability monitoring                                                                          | TESTED              | ≤ 20 per call, ≥ 1 s apart (worker), stops on a limit; optional quiet refresh `AGENCY_COMMUNITY_REFRESH=true` through the first research account only | Off by default                                                |
| Human-operated public message viewing                                                                                          | TESTED              | ≤ 20 messages, 2000 chars, not stored, throttled 10/min, audited without text                                                                         |                                                               |
| Tags, category, language, notes, advertising-policy review, link validation, metadata comparison, duplicate detection, history | TESTED              | `CommunityHistory` records each refresh diff; duplicates by normalized title                                                                          |                                                               |
| No member lists, phones, personal data, private-group scraping                                                                 | TESTED (by absence) | no worker endpoint exists; guard tests in both languages                                                                                              |                                                               |
| Telegram content never used to train/tune/benchmark AI                                                                         | By design           | messages are never stored; no AI job reads Telegram data                                                                                              |                                                               |

## 4. Join workflow, community administration, accounts

| Requirement                                                                                                                                                         | Status        | Evidence                                                                                                                                               | Limit / next                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| States DISCOVERED / REVIEW_REQUIRED / JOIN_REQUEST_PENDING / JOINED / ADVERTISING_ALLOWED / PUBLISHING_AUTHORIZED / NOT_ELIGIBLE / BLOCKED with audited transitions | TESTED        | `MOVES` table; `agency.communities.int.spec.ts`                                                                                                        |                                                                                                                                   |
| Join only by deliberate authorized action; leave                                                                                                                    | TESTED        | reason + confirmation + account permission + daily cap; no list-join                                                                                   |                                                                                                                                   |
| Register permitted ad destinations; advertising permission is a recorded human review                                                                               | TESTED        | review needs the rules text and both ticks; authorization lasts 90 days                                                                                | Only communities with a public @name                                                                                              |
| Publishing through an account                                                                                                                                       | TESTED (fake) | `agency.telegram.useraccount.publishing.int.spec.ts` (12): receipts, limits waited out, restriction blocks, unknown outcome not repeated, no rerouting | Real Telegram behaviour **LIVE_VERIFICATION_REQUIRED**                                                                            |
| Create group/channel; title, description; invite link; review join requests one by one                                                                              | TESTED (fake) | `/agency/communities/create`, `/managed`, `/invite-link`, `/join-requests`                                                                             | No bulk approve, no adding people (`RESTRICTED`)                                                                                  |
| Unified accounts view: accounts and bots, health, restrictions, errors, manual assignment                                                                           | PARTIAL       | `Telegram accounts` page: accounts with status/permissions/activity, bots listed with their state                                                      | Rate-limit state per bot and per-chat assignment screen are not on this page; assignment is chosen when a community is authorized |

## 5. Local AI, Antigravity, WhatsApp, desktop

| Requirement                                                                             | Status      | Files / evidence                                                                 | Limit / next                                                                                        |
| --------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Local LLM through the existing Ollama runtime; detect installed models, RAM, GPU, disk  | TESTED      | `installer/launcher/lib/{hardware,models,ollama,ai}.mjs`, 26 + 21 + 9 + 11 tests | Tiers use Gemma first; qwen3.5 `2b`/`4b` are fallbacks only                                         |
| Default `qwen3.5:4b`, lower `2b`, higher `9b`; selectable in Settings                   | PARTIAL     | Model manager can download any named model                                       | Make qwen3.5 the stated default per hardware class                                                  |
| Copy generation, variations, grammar, briefs, templates, JSON                           | PARTIAL     | `agency.ai.service.ts` (copy, improve, Copilot, agent)                           | Output validation exists for copy; extend to the new jobs                                           |
| User approval before publishing AI-written ads                                          | TESTED      | Approval workflow; AI never publishes                                            |                                                                                                     |
| Local AI failure never stops operations                                                 | TESTED      | Publishing scenario 11                                                           |                                                                                                     |
| Antigravity CLI provider                                                                | PARTIAL     | `agency.ai.gateway.service.ts`, `cli-tools.mjs`                                  | Flags follow vendor docs; not run against a real install                                            |
| MCP server + `.agents/mcp_config.json`, READ/DRAFT/WRITE scopes, no shell, no send/join | MISSING     |                                                                                  | Approval for anything that sends, joins, changes accounts or deletes                                |
| WhatsApp free local workspace                                                           | IN PROGRESS | `docs/AGENCYOS_WHATSAPP.md` when it lands                                        | Human-operated only; no delivery claims; no group scraping; Business Cloud API interface disabled   |
| Windows packaging of the Python worker                                                  | MISSING     |                                                                                  | Embeddable Python + vendored wheels in the stage; if it cannot be built reliably the report says so |

## 6. Verification limits that do not go away

- Nothing here has talked to real Telegram. Anything in this file that says `TESTED` was run against a fake
  that behaves like Telegram, never against Telegram.
- A user account needs the operator's own `api_id` and `api_hash` from <https://my.telegram.org>. Without them
  the feature is off and says so.
- Telegram can limit or ban any account for behaviour we cannot predict. AgencyOS reports and pauses; it
  does not hide or work around it.
- Vendor installers (Claude Code, Codex, Antigravity, Ollama) and their browser sign-ins are not verified from the
  build sandbox; the Windows run covers starting them.

## 7. Resume point

Updated whenever work stops. **Now:** Python worker (agent, `apps/telegram-worker`) and WhatsApp workspace
(agent, migration `12_agency_whatsapp`) are being built in separate worktrees. **Next, in this order:** finish
variants and schedules (tests, composer, report) → migration `11` `TelegramUserAccount` + gateway client →
community directory and research → join workflow and community administration → publishing with user
accounts → accounts view → pages → qwen3.5 selection → MCP server → Windows packaging → tracker update.
