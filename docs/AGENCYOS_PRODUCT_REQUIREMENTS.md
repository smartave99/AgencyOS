# AgencyOS — Product Requirements

**Status:** living document. Each requirement carries its current state (**Done**,
**Partial**, **Planned**, **Out of scope**); evidence is in
[`AGENCYOS_IMPLEMENTATION_STATUS.md`](AGENCYOS_IMPLEMENTATION_STATUS.md).

## Purpose

An operating system for advertising agencies built on Postiz: onboard clients, build and
review ads, publish them to **authorized** destinations on a schedule, prove what was
delivered, and run the sales and billing side, with a client-facing portal, from one
dashboard that feels like a premium consumer product and behaves like an enterprise tool.

AI is optional. Nothing about scheduling or publishing depends on it.

## Non-negotiable constraints

1. **Authorized destinations only.** Ads go to Telegram chats whose administrators explicitly
   authorized the bot; consent is recorded, revocable and expiring.
2. **No unauthorized scraping, unsolicited invitations or messages, bulk adds, or evasion of
   platform limits** (including cycling identities or numbers).
3. **No fabricated results.** Delivery, metrics and statuses come from stored facts; unsupported
   capabilities are labelled, not simulated; no non-functional controls.
4. **Isolation and accountability.** Tenant isolation, role-based access, audit trail, consent
   records, secrets only in the environment.
5. **Interface quality.** Light and dark, inline validation, confirmation on destructive
   actions, empty/loading/error states, keyboard reach, responsive layouts.

## Personas and roles

Agency owner, agency admin, sales manager, sales executive, campaign manager, content editor,
analyst, client. The permission matrix lives in `AGENCY_PERMISSIONS` (see the architecture
document). Clients see only their own work; authors cannot approve their own submissions
except owners/admins, which is recorded.

## Requirements by module

### A. Dashboard
| Requirement | Status |
| --- | --- |
| What needs attention first (failed/paused posts, lost destinations, pending reviews) | Done |
| Active clients, in-flight campaigns, awaiting review, authorized destinations | Done |
| Delivery counts from stored results; delivery rate empty until something resolves | Done |
| Truthful system status (no bot, no dispatcher, no update listener) | Done |
| Filters by date range, salesperson, platform; renewals | Planned |

### B. Clients
| Requirement | Status |
| --- | --- |
| Client registry with contact, industry, status; search | Done |
| Assigned sales representative | Partial (stored and used for deals/ownership; no assignment screen) |
| Client workspace view (campaigns, accounts, activity in one place) | Planned |

### C. Campaigns and approvals
| Requirement | Status |
| --- | --- |
| Composer: client, objective, headline, text, media, link, destinations, start/end, time zone | Done |
| Live preview identical to what is sent; limits named; problems explained before review | Done |
| Review workflow with four-eyes, optional client sign-off, send-back with reason | Done |
| Content locked after approval; edits require reopening and re-approval | Done |
| Duplicate, pause, resume, cancel, archive, retry failed | Done |
| Recurring schedules (daily/weekly windows) | Planned |
| A/B variants, content version history, cost estimation from pricing rules | Planned |
| Autosave of drafts | Partial (save draft with Ctrl/⌘+S; no background autosave) |

### D. Telegram
| Requirement | Status |
| --- | --- |
| Destination registry with admin-proven consent, revoke, expiry, health, pause | Done |
| Posting windows, minimum interval, daily cap per destination | Done in the engine and API; no screen to edit them yet |
| Bot permission re-check before every send; disconnect pauses jobs | Done |
| Delivery receipts with Telegram message id and link | Done |
| Per-agency bot tokens | Planned |

### E. Publishing engine
| Requirement | Status |
| --- | --- |
| Idempotent per-destination jobs; no duplicates under concurrency or restart | Done |
| Retry with exponential backoff, dead-letter, team alert | Done |
| Uncertain sends are held for a person, never auto-resent | Done |
| Social networks as destinations | Planned |

### F. Reporting
| Requirement | Status |
| --- | --- |
| Publishing report by period, client, campaign, destination, day; CSV; print/PDF | Done |
| Tracked-link clicks (bot clicks excluded), UTM | Done |
| Impressions / reach / engagement | Out of scope (no verified source) |
| Scheduled report emails, server-generated PDFs | Planned |

### G. Client portal
| Requirement | Status |
| --- | --- |
| Client sees their ads exactly as they will appear, approves or requests changes | Done |
| Client sees delivery and click counts for their campaigns | Done |
| Separate client identity that is not a workspace login | Planned |

### H. Sales and billing
| Requirement | Status |
| --- | --- |
| Pipeline with stages, lost reasons, convert to client, per-currency totals | Done |
| Invoice records and manual payment marking | Done |
| Sending invoices, payment processing, overdue tracking, quotes | Planned |

### I. Knowledge and AI (optional)
| Requirement | Status |
| --- | --- |
| Knowledge base with authorization attestation, search, retention | Done (keyword search by default; meaning-based with Ollama) |
| Copy suggestions that never block work, with honest provider label | Done |
| Lead funnel (opt-in forms, invite links, QR, conversion) | Planned |
| Discussion scraping | Out of scope (conflicts with constraint 2) |

### J. Platform
| Requirement | Status |
| --- | --- |
| Migrations with data fixes and rollback scripts; safe upgrade of existing installs | Done |
| Command palette, light/dark, responsive, reduced motion | Done |
| Accessibility audit with assistive technology | Planned |
| External security review | Planned |

## Success measures

* A sales executive can go from client to a reviewed, scheduled campaign without leaving the
  app and without seeing a control that does nothing.
* A manager can see, at a glance, what is blocked and why.
* A client can approve an ad in under a minute from the portal.
* The 13 acceptance scenarios (draft, approval, unapproved cannot publish, unauthorized
  destination, schedule, duplicate execution, partial failure, disconnection, isolation,
  genuine reports, AI failure, cancellation, revocation) pass automatically.
