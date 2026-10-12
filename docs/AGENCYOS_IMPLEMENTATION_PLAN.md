# AgencyOS — Implementation Plan

What was delivered, in the order it was done, and what comes next. Dates are omitted on
purpose: this is a record of scope, not a forecast.

## Delivered

### Phase 0 — Inspection and honest baseline
Read the repository, ran the existing agency code, and found it did not meet its own claims:
campaigns were marked complete without sending, the "authorization" of Telegram destinations
was a flag any user could set, the tracking route sat behind login, the CRM was in-memory
fake data, "semantic" search was a keyword hash, and there were no migrations. These were
treated as defects, not features.

### Phase 1 — Foundations
Prisma migration baseline plus agency hardening; roles and permission matrix; tenant-scoped
repositories; audit trail; validated DTOs; workflow-only status changes.

### Phase 2 — Campaign workflow
Composer with a server-rendered preview; approvals with four-eyes and client sign-off;
content locked after approval; duplicate, pause, resume, cancel, reopen, archive.

### Phase 3 — Authorized Telegram and reliable publishing
Consent by chat administrators (`/authorize`, `/revoke`), expiry, disconnect handling;
`TelegramGateway` as the only Telegram boundary; a database-backed queue with idempotent jobs,
leases, retries with backoff, dead-letter, "needs check", reconcile; truthful system status.

### Phase 4 — Sales and client experience
Real CRM pipeline; invoices; client portal with exact preview and sign-off; tracking links;
publishing reports (CSV and print/PDF).

### Phase 5 — AI (optional)
Copy suggestions with output validation and a template fallback that is labelled; knowledge
base with attestation, retention, tenant isolation; embeddings only from a reachable model.

### Phase 6 — Production readiness (partly done)
Done: migrations applied at startup with a safe upgrade path for old installs, no default
secrets in the example environment or compose file, client accounts confined to the portal,
HTTP end-to-end tests, a stability loop on the test suite, an interface standard with a design
system, a browser verification script.
Not done: see below.

## Test plan (as executed)

| Layer | What | Result |
| --- | --- | --- |
| Unit | Telegram gateway (rendering, validation, error classification), AI service, intelligence, platforms | passing |
| Integration (real PostgreSQL, fake Telegram) | Publishing (43), security/workflow (46), Telegram consent (27), CRM (13), reports (7) | passing |
| HTTP end-to-end (compiled backend, real routing/guards/pipes) | Authentication boundaries, validation, roles, tenant and client isolation, tracking, webhook, reports, client scope | 17 passing |
| Browser (real Chromium, real backend) | 31 checks: validation, preview, palette, dialogs, approvals, client approval, 390 px layout; dark and light reviewed | passing |
| Migration | Fresh deploy has no drift; old `db push` install baselined and upgraded; data preserved | verified |
| Not run | Live Telegram, Temporal boot, Docker Compose, ESLint, assistive technology, penetration test | see status document |

## Next

Ordered by value to a real agency.

1. **Live pilot with one bot and one real channel** (30 minutes): set the token, authorize,
   send, and confirm receipts. This is the largest unverified area.
2. **Social destinations from campaigns** (reuse Postiz providers behind the same job model so
   the idempotency, retry and uncertainty rules apply).
3. **Lead funnel**: opt-in landing page, invite links with QR codes, conversion tracking,
   using the existing tracking links and `LeadCapture`.
4. **Per-agency bot tokens** stored encrypted; per-tenant secrets.
5. **Separate client identity** (magic-link portal login) and removal of the workspace login.
6. **Recurring schedules**, content version history and A/B variants.
7. **Server-generated PDFs** and scheduled report emails.
8. **Hardening**: per-endpoint rate limits, tamper-evident audit, click-data retention,
   dependency and secret scanning in CI, external penetration test, assistive-technology audit.
9. **Decide the `RULES.md` question** ([`AGENCYOS_RULES_CONFLICT.md`](AGENCYOS_RULES_CONFLICT.md)).
