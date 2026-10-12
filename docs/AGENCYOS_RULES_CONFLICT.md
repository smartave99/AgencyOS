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

The brief's rules were followed. Concretely:

| `RULES.md` feature | Status | What exists instead |
| --- | --- | --- |
| Auto-join | Not built | Chats join the registry only when their administrator authorizes the bot. |
| Scraper (members, usernames) | Not built | A knowledge base the agency fills itself, requiring an attestation that the source authorized collection and members were told. Keyword search over it. |
| Bulk add users | Not built | None. |
| Account switching | Not built | One bot; a disconnected destination is paused and flagged, never worked around. |
| Surface every failure, log account events, retries with backoff, dead-letter queue, confirm destructive actions | Built | Throughout. |

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
