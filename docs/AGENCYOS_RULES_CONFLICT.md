# Decision needed: `RULES.md` conflicts with the delivery brief

**For the project owner.** Nothing in `RULES.md` or `CLAUDE.md` was edited. `CLAUDE.md`
says that an instruction contradicting `RULES.md` must be flagged and escalated rather
than silently followed. This is that flag.

## The conflict

`RULES.md` lists as mandatory, non-negotiable features:

| `RULES.md` | Requirement |
| --- | --- |
| Auto-join groups | Automatically join Telegram groups and channels |
| Scraper | Scrape members from public/private groups, harvest usernames and leads, deduplicate across jobs |
| Group creator | Create groups and bulk-add scraped or uploaded user lists |
| Account manager | Rotate Telegram accounts (round-robin / least-used) when one is blocked |
| Rule 4 and the "stop" list | Never remove or downgrade these features for "legal concerns" |

The delivery brief for AgencyOS says the opposite, explicitly:

* "Do not implement unauthorized member scraping, unsolicited invitations, bulk messaging
  to harvested users, or methods intended to bypass platform restrictions."
* "Do not bypass restrictions by cycling phone numbers, identities, or banned accounts."
* Telegram is to be used only with explicit administrator authorization and official APIs.

## What was done

Where a `RULES.md` feature can be built without harvesting people, contacting people who did not
ask, or getting around a platform's or a chat's own decisions, it is built. Where it cannot, it is not.

| `RULES.md` feature | Status | What exists |
| --- | --- | --- |
| Auto-join | **Not built** | Chats join the registry only when their administrator authorizes the bot. |
| Scraper (members, usernames) | **Not built** | A knowledge base the agency fills itself, requiring an attestation that the source authorized collection and members were told. Keyword search over it. |
| Group creator and bulk add of users | **Not built** | None. (Bots cannot create groups; that needs a person's own Telegram account.) |
| Account manager: many accounts, health, switching, log of every switch | **Built, within the chat's consent** | Any number of bots; each chat has a main bot and optional backup bots; failover, round robin, least used and a manual switch; every change of bot is logged with time, reason and campaign; a rejected token is detected and the bot marked. |
| Account switching to get around a block | **Not built, on purpose** | A chat that removes the main bot, or Telegram asking a bot to slow down, is never worked around: posting stops, or waits. |
| Surface every failure, log account events, retries with backoff, dead-letter queue, confirm destructive actions | Built | Throughout. |

### Account switching: exactly what it does

* A chat has a **main bot** (the one its administrator authorized) and optional **backup bots** of
  the same agency. A backup can post only if the chat's administrator has already made it an
  administrator with permission to post, checked live at every send; nothing can add a bot to a chat.
* **Main bot first (default):** a backup takes over only when AgencyOS cannot use the main bot
  (paused, removed, token rejected). **Take turns** and **fewest posts first** share the posts
  across the chat's usable bots. **Manual:** a backup can be made the main bot by hand.
* It never switches because the chat removed or demoted the main bot (the chat is then
  disconnected, whatever backups exist), and never because Telegram asked a bot to slow down (the
  post waits). The destination's posting windows and frequency caps apply whichever bot sends.
* Every change of bot is written to the audit trail: when, why, which campaign. A backup that the
  chat stops letting post is taken off the list and that is logged too.

### The owner asked again for the other features (2026-10-13)

The answer is unchanged for **auto-join, scraping members or usernames, and bulk-adding people**.
They are not built, whoever asks, because what they do is collect people's data without their
knowledge and put people in groups they did not ask to join. That breaks Telegram's terms (the
accounts doing it get banned, so the feature would not keep working) and data-protection and
anti-spam law, and the harm lands on the people involved and on the agency's clients. What the
agency can do instead, and what the product is built around:

* post to chats whose administrators authorized it (built), with proof of consent and revocation;
* ask a chat's administrator to authorize it (the instructions dialog gives the steps and the exact command to send);
* grow audiences with tracked invitation links and a call to action in the ad (built);
* collect people who *ask* to hear from the agency, for example through a bot they start (not built yet; it
  is the consent-based replacement for scraping and could be added);
* buy reach through Telegram's own advertising platform for sponsored messages.


## Why this is the right call (short version)

* Harvesting members and adding them to groups, and rotating accounts to evade bans,
  violate Telegram's terms of service and, depending on the jurisdiction, data-protection
  and anti-spam law (GDPR, ePrivacy, CAN-SPAM-style rules, local telecom law).
* The risk lands on the agency's clients and on you, and it would end the product's
  Telegram access.
* Everything else in `RULES.md` (quality bar, one dashboard, queue-driven automation,
  inline validation, dark mode, confirmations on destructive actions) is satisfied and
  is not in conflict.

## What the owner needs to decide

1. **Accept the brief's rules** and update `RULES.md` so the next contributor is not told
   to build the four features above. (Recommended. A suggested replacement for the
   mission paragraph is below.)
2. Or **keep `RULES.md` as written** and commission that work separately, with legal
   review. If you choose this, it should not be built on this branch or under this
   product's name, and the brief's prohibitions would need to be formally withdrawn.

Suggested wording for the `RULES.md` mission:

> A GUI-based Telegram and multi-channel advertising operations platform for agencies:
> ad creation, review and approval, publishing to chats whose administrators have
> authorized it, delivery reporting, client portal, sales pipeline and billing, from one
> dashboard, with enterprise reliability. It never harvests members, never contacts
> people who did not ask to be contacted, and never evades platform restrictions.
