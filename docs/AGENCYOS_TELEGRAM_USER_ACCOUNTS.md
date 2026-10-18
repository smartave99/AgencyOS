# Telegram user accounts and the community directory

AgencyOS posts to Telegram through **bots** (a chat's administrators authorize each one) and, since this
feature, through **Telegram user accounts** a person at the agency signs in with their own phone code. A user
account is for permitted, person-driven work: researching public communities, joining the ones that fit,
running communities the agency owns, and posting an approved campaign where advertising was reviewed and allowed.

The bot integration is unchanged. This document is how the second provider works, what is tested, and what is not.

## The parts

```
Browser ──► Next.js ──► NestJS backend ──loopback HTTP + token──► Python worker (Telethon / MTProto) ──► Telegram
              (pages)    AgencyTelegramUsersService                apps/telegram-worker
                         AgencyCommunitiesService                  (no database, no files, no secrets at rest)
                         AgencyPublishingService (send path)
                         TelegramUserGateway (the only caller of the worker)
```

- The **worker** (`apps/telegram-worker`, contract in `TELEGRAM_WORKER_CONTRACT.md`) is stateless. The backend opens a
  sealed account's login for one request and sends it over loopback; the worker keeps a connected client in memory for
  at most two minutes idle and never writes a session, api hash, code or password anywhere.
- The **backend** owns everything else: accounts and their permissions, the directory, the join workflow, the audit
  trail, and every decision about when a post may go out.
- **No page ever talks to the worker.** No API returns a session, an api hash, a code, a password or a full phone number.

## Accounts

| What        | How                                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in     | Phone number, then the code Telegram sends, then the two-step password if the account has one. The api id and api hash come from the agency's own `my.telegram.org` registration. A wrong code or password can be retried (five wrong attempts end that sign-in). |
| Stored      | One AES-256-GCM value: api id, api hash and login session together, key derived from the install's `JWT_SECRET` with its own context (separate from bot tokens). Only the masked phone (`+49•••••5678`) is kept.                                                  |
| Permissions | Per account: look up public communities (on by default), join/leave, post advertisements, create/manage communities. Owners and admins grant them. Every use checks them again.                                                                                   |
| Health      | Check now asks Telegram. A limit (`RATE_LIMITED` with a time), a restriction, an ended login and a pause are shown, each with an event in the account's activity history and the audit trail.                                                                     |
| Sign out    | Ends the login at Telegram, wipes the sealed value, switches permissions off. If Telegram cannot be reached the local copy is wiped anyway and the activity says to end it from Telegram → Devices.                                                               |

An account is **never replaced by another one**. A restriction pauses that account and the chats that post through it; a
person decides what happens next. AgencyOS does not create Telegram accounts, rotate to another identity after a ban or
limit, or warm accounts up.

## Communities

The directory stores only what Telegram publishes about a public community (title, public name, description, counts
Telegram returned, flags). A number Telegram did not return stays empty. It never stores members, phone numbers or
message text.

- **Find**: Telegram's own public search (not saved until you press Save, which asks Telegram about that community
  again), or a pasted list of `@names` / `t.me` links (checked first, up to 50, each looked up and saved as Telegram shows
  it; private invite links are refused because they have nothing public).
- **Directory**: filters, sort, tags, category, language, notes, bookmarks, CSV/JSON export (metadata only), likely
  repeats, history of what changed on each refresh, and a refresh of up to 20 at a time (at least a second apart; a
  limit stops the run). An optional quiet refresh (`AGENCY_COMMUNITY_REFRESH=true`) looks at communities not seen for a
  week, a few per agency, through the first-connected research account only, and ends if that account is not in good standing.
- **Relation** (to the account that looked): owned, administered, member, public not joined, restricted, unavailable.
- **Reading public messages**: on request, one community at a time, at most 20 recent messages, shown on screen, not
  stored, not sent to any model, rate-limited, and recorded in the audit trail without their text.

### From found to authorized

`Discovered → (Review required) → Join request pending / Joined → Advertising allowed → Publishing authorized`,
with `Not eligible` and `Blocked` as ways out. Every move is one named person's deliberate action:

1. **Join**: one account, one community, a reason (kept in the history), a confirmation tick, an account that was
   given the join permission, and a daily cap per account (`AGENCY_JOIN_DAILY_CAP`, default 20). There is no list-join.
2. **Review the rules**: the person reads the rules from inside, records what they say (a sentence, an optional link),
   and ticks that they read them and that advertising like theirs is allowed. A community Telegram marks as a scam or
   fake cannot be approved.
3. **Allow campaigns to post**: the account must be a member allowed to write there; the chat is registered as a
   destination (consent for 90 days, then the rules are looked at again). A chat already registered with a bot is refused.
4. **Posting** goes through the same approval, content fingerprint, pacing and receipt rules as bots. Before each post:
   the community is still authorized, the review still says allowed, the account is permitted and in good standing.

Leaving, a later "not allowed", a withdrawal, or Telegram showing the community as unusable for the account all stop
posting there at once and pause queued posts.

### Running a community the agency owns

Create a group or channel, edit its name and about text, read its invite link, and see who asked to join and approve or
decline **one request at a time**. Requests are shown as Telegram shows administrators and are not stored. There is no
bulk approve, no adding of people, and no list of members.

## What posting through an account does differently

- Media must be files uploaded to AgencyOS (jpg, png, webp, mp4, mov, webm); a web address is refused rather than
  posted differently. The worker only reads files under `AGENCYOS_MEDIA_ROOT` (= `UPLOAD_DIRECTORY`).
- A rate limit is waited out (the post goes back in the queue for the time Telegram named, the account is marked).
- A restriction or an ended login blocks the chat and its queued posts with the reason. Nothing is retried as someone else.
- A send whose outcome is unknown (`OUTCOME_UNKNOWN`, a timeout, an unreadable answer) is **never repeated**: the post
  is marked "needs check", as with bots.
- Only communities with a public `@name` can receive posts (the worker addresses a community by its public name).

## What is tested and what is not

| Level              | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tested (Linux)     | Backend: 17 account, 25 community and 12 publishing integration tests against PostgreSQL with a fake worker that speaks the contract; 8 client contract tests over real loopback HTTP; an HTTP end-to-end with a stub worker; a migration-order guard. Worker: 602 pytest tests (real HTTP server, in-memory backend, the real Telethon backend through a stub client built from real TL types, log redaction, process start/stop). Browser walkthrough against the real worker's in-memory backend.                                                                                                                                                                                                                                                                                                                                                                                     |
| Not live-verified  | **Everything against real Telegram.** The worker's Telethon calls were never run against Telegram: login with 2FA, entity flags that decide a relation and "may post", invite previews, join requests, creating communities, album and caption behaviour, flood and restriction behaviour in practice. The worker README lists each item under `LIVE_VERIFICATION_REQUIRED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Needs the operator | An `api_id`/`api_hash` from `my.telegram.org`, and a phone that can receive the code. Without the worker the feature is off and says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Windows desktop    | The installer stages the PSF's CPython 3.13.16 (NuGet package, sha256 pinned in `installer/runtimes.json`), installs the four pure-Python packages from `apps/telegram-worker/requirements.lock.txt` with `--require-hashes` (pyaes builds from its source distribution on the build machine), removes pip, and proves on the build machine that the staged worker starts and answers `/health`. The launcher runs it as the optional `telegram-worker` service on `127.0.0.1` with a random token only the app's server shares, the uploads folder as its only media folder and no database address; if it is missing or fails, AgencyOS starts anyway and the Accounts page says the service is not running. The Windows smoke test checks the server reaches it. This packaging is written and unit-tested on Linux; the first Windows run that covers it is recorded in the tracker. |
