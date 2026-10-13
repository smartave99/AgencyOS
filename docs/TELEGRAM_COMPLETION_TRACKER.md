# Telegram completion tracker

Every Telegram requirement in `RULES.md` (and the completion brief that followed it), mapped to what the
source actually does today. Written from the code and the test runs, not from the plan. Update the row,
not the prose, when something changes.

**Status words**

| Word | Meaning |
| --- | --- |
| `EXISTING` | In the source and working, but its tests are thin or it is not the whole requirement |
| `PARTIAL` | Works with a stated limit |
| `MISSING` | Not built yet |
| `IMPLEMENTED` | Built, not yet covered by tests |
| `TESTED` | Built and covered by automated tests (Linux: Jest against PostgreSQL, HTTP end-to-end, launcher tests; Python: pytest) |
| `LIVE_VERIFIED` | Exercised against the real service by a person or a run on real infrastructure. **Nothing in the Telegram column is at this level yet.** |
| `RESTRICTED` | `RULES.md` asks for it; AgencyOS does not build it, and the reason is written down. See `AGENCYOS_RULES_CONFLICT.md` |
| `EXTERNAL_PREREQUISITE` | Cannot be completed from the code alone (credentials, a certificate, a real account, a vendor site) |

A mock proves our code against our idea of Telegram. It never moves a row to `LIVE_VERIFIED`.

## 0. The position on the `RULES.md` features that harm other people

`RULES.md` (rules 1–7 of the primary aim) lists harvesting members, bulk-adding people, unattended
joining of groups, evasive account rotation and account warm-up. AgencyOS keeps the *purposes* behind them
(reach communities, post advertising where it is allowed, grow an owned audience, keep a campaign going when a
sending account has a technical problem) and builds the permitted way to each. The five forbidden methods
stay `RESTRICTED` and stay listed here so nobody has to wonder whether they were forgotten. `RULES.md` itself is
not edited; the conflict is explained in `docs/AGENCYOS_RULES_CONFLICT.md`.

| Not built | Why | What is built instead |
| --- | --- | --- |
| Reading member lists, phone numbers or other personal details of people in groups | Those people never agreed; Telegram's terms and privacy law forbid it | Public community metadata and a person reading public messages on screen; lead capture from people who start the bot themselves |
| Bulk-adding scraped or uploaded users to groups | Same people, plus unsolicited contact | Create groups and channels you own; invite links; review join requests from people who asked |
| Unattended background auto-join of lists of groups with randomized "human" delays | Evades the abuse detection the delays imitate | One deliberate, authorized join per action, by a named operator, with a recorded reason |
| Switching to another account when one is banned or limited | Ban evasion | A restriction pauses that account's jobs and says so; an operator reassigns on purpose to an account that is authorized for that destination. Backup **bots** that the chat's administrators authorized keep their consent-safe failover |
| Account warm-up that ramps activity to avoid spam detection | Designed to defeat anti-abuse systems | Nothing. New accounts are used the way their owner uses them |

## 1. `RULES.md` checklist

### Dashboard

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Overview of all active Telegram accounts and their status | PARTIAL | Bots: `agency.telegram.bots.service.ts`, `dashboard.component.tsx` (Bots and chats card), `agency.dashboard.int.spec.ts` (TESTED). | User accounts have no model yet → section 2 and 8 |
| Live job queue: pending / running / failed | TESTED | `agency.repository.ts getDashboardMetrics`, 5 tests in `agency.dashboard.int.spec.ts` | |
| Account health: active, rate-limited, blocked, shadow-banned | PARTIAL | Bot states and chat counts (ready, lost, slowed by Telegram) are shown | Telegram reports no shadow-ban state, so none is shown (`EXTERNAL_PREREQUISITE` by nature). User-account health follows section 2 |
| Quick actions for every core workflow | EXISTING | Dashboard action row | New workflows (research, communities, accounts) get their entry as they land |
| Admin sees all, sales sees own campaigns | TESTED | 8 roles, permission matrix tests, owner scoping | |

### Ad creation and campaigns

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Rich text composer with media; server-rendered preview | TESTED | `campaign-form.component.tsx`, preview test asserts the exact HTML sent | |
| Campaign builder: name, budget, destinations, schedule | TESTED | `agency.service.ts`, `campaign.dto.ts` | Budget is recorded, not spent: AgencyOS buys no ads |
| Account rotation inside a campaign | PARTIAL | Backup bots: failover, round robin, least used, manual (`agency.telegram.backup.int.spec.ts`, 14 tests) | User accounts: manual assignment and permitted load distribution only (section 8) |
| Template library | TESTED | `AdTemplate`, `agency.templates.int.spec.ts` (7) + 1 HTTP test | |
| A/B variants per campaign | IMPLEMENTED | Migration `10_agency_variants_schedule`, `agency.publishing.*` (labels A–D rotated across destinations, covered by the approval fingerprint) | Tests, composer tabs and per-variant report are the next task |
| Lifecycle Draft → Scheduled → Running → Paused → Completed | TESTED | Publishing scenarios 1–13 | |
| Revision history of content | PARTIAL | `revision` counted; no stored versions | `CampaignVersion` table is planned (section 7) |

### Group join (`RULES.md`: "Group Auto-Join")

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Input: list of links / usernames / invite codes | MISSING → planned | | Becomes *research import*: a list is resolved to public metadata, nothing is joined (section 3) |
| Background worker that joins groups unattended | RESTRICTED | | Replaced by the permission-aware join workflow (section 5): one deliberate join per action |
| Delay randomization to mimic human behaviour | RESTRICTED | | Evasion by design. Pacing for *our* sends stays as honest minimum intervals and caps |
| Success / failure report per group with reason codes | MISSING → planned | | Join attempts record the worker's error code and a plain explanation (section 5) |
| Retry queue with backoff for failed joins | RESTRICTED as automatic | | A person retries a join; `RATE_LIMITED` shows when to retry |

### Auto-post

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Select campaign + destinations + sending account | TESTED (bots) | Destination registry with consent, `/authorize`, delivery through the chat's own bot (16 + 27 tests) | User accounts as senders: section 7 |
| Schedule: one-time, recurring, drip | IMPLEMENTED | `PostingJob.occurrence`, `cleanSchedule` in `agency.service.ts`, ONCE/REPEAT/DRIP in publishing | Tests and composer UI are the next task |
| Per-destination throttle (min interval, windows, daily cap) | TESTED | Window tests | |
| Fallback to next account if the posting account is blocked | PARTIAL | Bots only, and only to a backup the chat's admins authorized | For user accounts a ban pauses jobs; no re-routing (`RESTRICTED`) |
| Post receipt with the Telegram message id | TESTED | Receipt in `PostingJob`, report tests | Real message ids are `LIVE_VERIFIED: no` |
| Ambiguous send → reconciliation, never resent | TESTED | "Needs check" state | |

### Scraper (`RULES.md`: "Usernames & Discussions")

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Scrape members of a group | RESTRICTED | | See section 0 |
| Scrape discussions for keyword matches (bulk) | RESTRICTED | | Replaced by a person reading the most recent public messages of a public community on screen (≤ 20, not stored) |
| Public community discovery by keyword, name, username, link | MISSING → planned | Contract: `/v1/communities/search`, `/resolve` | Section 3 |
| Export CSV / JSON / clipboard | MISSING → planned | | Of *saved public community metadata*, never people |
| Deduplication | MISSING → planned | | By Telegram id and by normalized username |
| Respect rate limits with automatic throttling | MISSING → planned | Worker spacing and `RATE_LIMITED` pass-through | Never slept through |

### Group creator and user adder

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Create groups and channels from the dashboard | MISSING → planned | Contract: `/v1/communities/create` | Section 6 |
| Bulk-add scraped or uploaded users | RESTRICTED | | See section 0; invite links and join-request review instead |
| Delay randomization on adds | RESTRICTED | | |
| Per-user "cannot be added" errors; added/failed tracking | RESTRICTED | | Nobody is added |

### Account manager

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Add accounts by phone + OTP (+ 2FA) | MISSING → planned | Contract: `/v1/login/*` | Section 2. QR login is not planned |
| Sessions encrypted at rest (AES-256) | TESTED for bots | Bot tokens sealed AES-256-GCM (HKDF of `JWT_SECRET`) | User sessions reuse the same design |
| Rotation: round robin, least used, manual | TESTED for bots | `agency.telegram.backup.int.spec.ts` | |
| Auto-detect blocked / rate-limited accounts and pause | TESTED for bots | Scenario 8 | User accounts: section 2 |
| Promote the next account automatically on failure | PARTIAL / RESTRICTED | Bots with authorization: yes | A banned user account is never replaced silently |
| Account warm-up scheduler | RESTRICTED | | See section 0 |

## 2. User-account provider (Python / Telethon, MTProto)

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Loopback, authenticated, typed worker | IN PROGRESS | `docs/TELEGRAM_WORKER_CONTRACT.md`; `apps/telegram-worker/` | pytest contract tests; no network in tests |
| Phone login with OTP; optional 2FA | MISSING | Contract `/v1/login/start`, `/code`, `/password`, `/cancel` | Needs the operator's own `api_id` / `api_hash` (`EXTERNAL_PREREQUISITE`) |
| Session sealed at rest; never returned to the browser or logged | MISSING | Same sealing as bot tokens | |
| Explicit connect / logout / revoke | MISSING | Contract `/v1/account/logout` | |
| Several independently authorized accounts; account-level permissions | MISSING | | An account is usable for a destination only when an operator allowed it |
| Health monitoring, rate-limit status, error classification, audit log | MISSING | Error table in the contract | |
| User accounts distinct from bots | MISSING | | Separate model and gateway; the Bot API gateway is untouched |
| Never create accounts, never switch to evade enforcement | By design | No code path does either | |

## 3. Public community discovery and research

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Search by keyword, name, username, link, category, language | MISSING | Contract `/v1/communities/search`, `/resolve` | Telegram's own public search; category and language are operator tags |
| Directory storing only permitted public metadata; no invented counts | MISSING | | Counts come from what Telegram returns, otherwise `null` |
| Relation: OWNED / ADMINISTERED / MEMBER / PUBLIC_NOT_JOINED / RESTRICTED / UNAVAILABLE | MISSING | Contract `relation` | |
| Research page: search, filters, URL import, saved results, dedupe, bookmarks, sort, CSV/JSON export, errors, refresh | MISSING | | |
| Bounded refresh with backoff; availability monitoring | MISSING | Worker: ≤ 20 refs, ≥ 1 s spacing, stop on FloodWait | Manual refresh first; scheduled refresh stays bounded |
| Human-operated public message viewing | MISSING | Contract `/v1/communities/messages` (≤ 20, 2000 chars, no senders, not stored) | |
| Tags, classification, advertising-policy review, link validation, metadata comparison, duplicate detection, history | MISSING | | |
| No member lists, phones, personal data, private-group content | By design | No worker endpoint exists; a guard test will keep it so | |
| Telegram content is never given to a local model for training or tuning | By design | | Messages are not stored and are not sent to any model |

## 4. Join workflow, community administration, accounts (planned)

| Requirement | Status | Next |
| --- | --- | --- |
| States DISCOVERED → REVIEW_REQUIRED → JOIN_REQUEST_PENDING → JOINED → ADVERTISING_ALLOWED → PUBLISHING_AUTHORIZED; NOT_ELIGIBLE, BLOCKED | MISSING | State machine with audited transitions |
| Join only by a deliberate authorized action; leave | MISSING | Worker `/v1/communities/join`, `/leave` |
| Register permitted ad destinations; advertising permission is a recorded human review | MISSING | Destination eligibility attestation |
| Create group/channel; title, description; invite link; review join requests | MISSING | Worker create / update / invite-link / join-requests |
| Unified accounts view: bots + user accounts, health, restrictions, rate limits, errors, manual assignment | MISSING | |

## 5. Local AI, Antigravity, WhatsApp, desktop

| Requirement | Status | Files / evidence | Limit / next |
| --- | --- | --- | --- |
| Local LLM through the existing Ollama runtime; detect installed models, RAM, GPU, disk | TESTED | `installer/launcher/lib/{hardware,models,ollama,ai}.mjs`, 26 + 21 + 9 + 11 tests | Tiers use Gemma first; qwen3.5 `2b`/`4b` are fallbacks only |
| Default `qwen3.5:4b`, lower `2b`, higher `9b`; selectable in Settings | PARTIAL | Model manager can download any named model | Make qwen3.5 the stated default per hardware class |
| Copy generation, variations, grammar, briefs, templates, JSON | PARTIAL | `agency.ai.service.ts` (copy, improve, Copilot, agent) | Output validation exists for copy; extend to the new jobs |
| User approval before publishing AI-written ads | TESTED | Approval workflow; AI never publishes | |
| Local AI failure never stops operations | TESTED | Publishing scenario 11 | |
| Antigravity CLI provider | PARTIAL | `agency.ai.gateway.service.ts`, `cli-tools.mjs` | Flags follow vendor docs; not run against a real install |
| MCP server + `.agents/mcp_config.json`, READ/DRAFT/WRITE scopes, no shell, no send/join | MISSING | | Approval for anything that sends, joins, changes accounts or deletes |
| WhatsApp free local workspace | IN PROGRESS | `docs/AGENCYOS_WHATSAPP.md` when it lands | Human-operated only; no delivery claims; no group scraping; Business Cloud API interface disabled |
| Windows packaging of the Python worker | MISSING | | Embeddable Python + vendored wheels in the stage; if it cannot be built reliably the report says so |

## 6. Verification limits that do not go away

* Nothing here has talked to real Telegram. Anything in this file that says `TESTED` was run against a fake
  that behaves like Telegram, never against Telegram.
* A user account needs the operator's own `api_id` and `api_hash` from <https://my.telegram.org>. Without them
  the feature is off and says so.
* Telegram can limit or ban any account for behaviour we cannot predict. AgencyOS reports and pauses; it
  does not hide or work around it.
* Vendor installers (Claude Code, Codex, Antigravity, Ollama) and their browser sign-ins are not verified from the
  build sandbox; the Windows run covers starting them.

## 7. Resume point

Updated whenever work stops. **Now:** Python worker (agent, `apps/telegram-worker`) and WhatsApp workspace
(agent, migration `12_agency_whatsapp`) are being built in separate worktrees. **Next, in this order:** finish
variants and schedules (tests, composer, report) → migration `11` `TelegramUserAccount` + gateway client →
community directory and research → join workflow and community administration → publishing with user
accounts → accounts view → pages → qwen3.5 selection → MCP server → Windows packaging → tracker update.
