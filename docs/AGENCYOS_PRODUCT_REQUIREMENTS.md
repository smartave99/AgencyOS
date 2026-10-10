# AgencyOS — Enterprise AI-Powered Advertising Agency Platform
## Product Requirements Document (PRD)

**Document Version:** 1.0.0  
**Status:** Approved for Implementation  
**Target Platform:** AgencyOS (Built upon Postiz open-source core)  
**Primary Users:** Advertising Agencies, Sales Teams, Campaign Managers, Clients, Community Managers, Super Administrators  

---

## 1. Executive Summary & Business Objective

AgencyOS transforms the Postiz social scheduling engine into a unified, multi-tenant enterprise operating system for advertising agencies. 

An agency coordinates advertisements on behalf of multiple clients across authorized Telegram groups, channels, and major social networks (X, LinkedIn, Facebook, Instagram, YouTube, TikTok, Threads, Bluesky, Discord). 

The platform powers the complete commercial lifecycle:
1. **Client Onboarding & CRM:** Client profiles, business details, assigned sales representatives, contracts, and billing agreements.
2. **Campaign Planning & Content Studio:** Campaign objectives, target audiences, multi-channel creative variations, media assets, landing pages, and UTM tracking links.
3. **AI Marketing Copilot:** Human-in-the-loop marketing copy generation, caption rewriting, multilingual adaptation, and audience-targeted calls-to-action (CTA).
4. **Authorized Destination Management:** Explicitly authorized Telegram groups and channels verified through bot administrator privileges, alongside connected social accounts.
5. **Cost Calculation & Invoicing:** Estimated campaign budgets, pricing rules per destination/frequency, and invoice management.
6. **Multi-Stage Approval Workflows:** Enterprise-grade review states (`Draft` → `Submitted` → `Under Review` → `Changes Requested` → `Approved` → `Scheduled` → `Publishing` → `Completed`).
7. **Idempotent Scheduling Engine:** Timezone-aware, throttled background job delivery respecting platform API rate limits with dead-letter queue (DLQ) failover and audit receipts.
8. **Discussion Intelligence & Lead Capture:** Opt-in lead funnels, invite links, QR codes, conversion tracking, and privacy-compliant topic analytics in authorized groups.
9. **Executive Reporting & Renewals:** Transparent client-facing dashboards, performance analytics using authentic metrics, and scheduled PDF/CSV reports.

---

## 2. Personas and Role-Based Access Control (RBAC)

The multi-tenant hierarchy enforces strict data isolation:
$$\text{Platform Owner} \longrightarrow \text{Agency (Tenant)} \longrightarrow \text{Team} \longrightarrow \text{Client} \longrightarrow \text{Campaign}$$

### 2.1 User Roles & Permissions Matrix

| Role | Scope | Key Capabilities | Prohibitions |
| :--- | :--- | :--- | :--- |
| **Super Administrator** | Global Platform | Manage tenant agencies, platform health, global API rate limits, model endpoints. | Cannot access client private data without explicit tenant authorization. |
| **Agency Owner** | Tenant Agency | Full control of agency settings, billing, team memberships, client assignments, white-label configs. | Isolated from other agency tenants. |
| **Agency Administrator** | Tenant Agency | Manage team roles, integration connectors, client accounts, approval policies. | Cannot modify tenant subscription/billing unless granted. |
| **Sales Manager** | Team / Clients | Supervise sales pipelines, approve pricing proposals, assign accounts to sales executives. | Cannot delete authorized platform connectors. |
| **Sales Executive** | Assigned Clients | Onboard clients, create ad campaigns, select approved destinations, submit for approval. | Cannot approve campaigns or publish directly without approval. |
| **Campaign Manager** | Agency Wide | Review submitted campaigns, inspect creative previews, approve or request changes, manage schedules. | Cannot alter global agency billing. |
| **Content Editor** | Assigned Campaigns | Edit ad copy, generate AI variations, upload assets, adjust destination adaptations. | Cannot alter campaign budget or approve publishing. |
| **Analyst** | Agency Wide | View performance metrics, export reports, track conversions and link clicks. | Read-only access to campaign settings and credentials. |
| **Client (External)** | Client Workspace | View campaign progress, live post receipts, aggregate performance stats, and approve creative drafts. | Strict read-only isolation; cannot see internal agency margins or other clients. |

---

## 3. Detailed Functional Modules

### Module A — Enterprise Agency Dashboard
- **Executive KPI Cards:** Active clients, running campaigns, scheduled posts (next 24h / 7d), pending approvals, successful deliveries, failed deliveries, connected accounts, authorized Telegram destinations.
- **Real-Time Job Monitor:** Visualization of Temporal background workers and queue health.
- **Multidimensional Filtering:** Filter entire dashboard by Date Range, Client, Assigned Salesperson, Platform Destination, Campaign Status.
- **Action Inbox:** One-click shortcuts for pending manager approvals, failed post alerts, disconnected account reconnects, and upcoming campaign renewals.

### Module B — Multi-Tenant Client Management
- **Client Registry:** Dedicated directory of onboarded businesses with industry category, primary contact, assigned sales rep, contract tier, and billing status.
- **Client Workspace View:** Overview of all campaigns, associated social connections, authorized Telegram destinations, media vault, and activity logs.
- **Client Notes & Audit Trail:** Chronological timeline of sales notes, campaign revisions, and approval decisions.

### Module C — Advertisement Campaign Builder
- **Multi-Step Guided Wizard:**
  - *Step 1: Campaign Metadata:* Name, Client, Category, Objective (Brand Awareness, Lead Gen, Community Growth, Traffic), Start/End Dates, Budget.
  - *Step 2: Content Composer:* Multi-variant creative builder with headline, body text, formatting (HTML / Markdown), CTA, media attachments (images/videos/documents).
  - *Step 3: Destination Selection:* Selection of authorized Telegram groups/channels and social channels with real-time capability checks.
  - *Step 4: Scheduling & Windows:* Timezone selection, posting frequency (one-time, daily, weekly windows), spacing throttles.
  - *Step 5: Review & Cost Estimate:* Live preview across destination mockups, estimated cost calculation based on pricing rules, submission for approval.
- **Content Variations:** A/B variant support per campaign with automatic rotation or manual assignment.
- **Draft Autosaving:** Resilient draft state saving preventing work loss.

### Module D — Telegram Advertising Management
- **Destination Registry:** Chat ID, Type (Public/Private Channel, Supergroup, Group), Bot Connection, Admin Privileges Verified, Permitted Content Categories, Frequency Rules, Allowed Windows.
- **Bot Verification Workflow:** Step-by-step verification of bot administrator rights (`can_post_messages`, `can_delete_messages`, `can_invite_users`).
- **Publishing Safeguards:** Explicit authorization check prior to queuing, message deduplication hash, message ID receipt capture, permanent link generation (`https://t.me/...`).
- **Zero Spam Policy:** Absolute prohibition on unauthorized scraping or mass unsolicited direct messaging; posting strictly limited to authorized broadcast channels and groups.

### Module E — Authorized Discussion Analytics
- **Privacy-First Ingestion:** Ingestion only with explicit administrator authorization and user notice.
- **Semantic Analysis:** Topic clustering, FAQ discovery, sentiment trends, and common customer inquiries.
- **Embeddings & Search:** Vector storage using pgvector / Mastra / local EmbeddingGemma for semantic discovery across approved campaign docs and discussion topics.

### Module F — Community Growth & Funnel Tracking
- **Opt-In Lead Capture:** Branded landing pages with email/phone opt-in and auto-redirection to Telegram community invite links.
- **Tracking Links & UTMs:** Automatic generation of unique UTM-tagged URLs with click tracking and attribution.
- **Conversion Tracking:** Event logging for click-throughs, join conversions, and qualified inquiries.

### Module G — Cross-Platform Social Management
- **Capability Matrix:** Explicit registry of supported features per platform (e.g. Telegram: channels/groups/media; LinkedIn: company pages/profiles; X: posts/threads; Facebook: pages; Instagram: feed/reels).
- **Graceful Degradation:** Disallow unsupported actions in UI before request submission.

### Module H — Connected Account Health
- **Connection Health Monitor:** Token validity check, expiration timers, status badges (Active, Expiring Soon, Disconnected, Blocked).
- **Auto-Pause on Disconnect:** Automatic freezing of pending jobs targeting disconnected accounts with immediate notification to campaign managers.

### Module I — Approval & Automation Workflows
- **State Machine:**
  $$\text{Draft} \xrightarrow{\text{submit}} \text{Submitted} \xrightarrow{\text{review}} \text{Under Review} \xrightarrow{\text{approve}} \text{Approved} \xrightarrow{\text{schedule}} \text{Scheduled} \xrightarrow{\text{run}} \text{Publishing} \xrightarrow{\text{finish}} \text{Completed}$$
  With rejection branch: $\text{Under Review} \xrightarrow{\text{request changes}} \text{Changes Requested} \xrightarrow{\text{edit}} \text{Submitted}$.
- **Approval Inbox:** Dedicated portal for Campaign Managers with side-by-side diffs, previews, and approval/rejection commentary.

### Module J — AI Marketing Copilot
- **Provider Agnostic Engine:** Pluggable connector architecture supporting local Ollama (e.g. Qwen 2.5 / Gemma 3), OpenAI-compatible APIs, and Mastra agents.
- **Content Tools:** One-click copy generation, tone adjustment (Professional, Promotional, Urgent, Casual), multilingual translation, headline optimization, and CTA suggestions.
- **Human In The Loop:** AI output is always loaded into an editable buffer; never auto-published without human review.
- **Scheduler Decoupling:** AI inference runs asynchronously and does not block background publishing queues.

### Module K — Analytics & Reporting
- **Verifiable Metrics:** Real tracked counts (scheduled, published, failed, clicks, opt-in leads). Zero fabricated engagement numbers.
- **Exporting:** PDF campaign summaries and CSV raw data exports for client distribution.

### Module L — CRM & Sales Management
- **Pipeline Stages:** Prospect → Initial Contact → Proposal Sent → Contract Signed → Active Campaign → Renewal Due.
- **Deal & Quote Tracking:** Estimated impressions, selected destinations, package cost, and target launch dates.

### Module M — Billing, Pricing & Packages
- **Modular Pricing Engine:** Base campaign fee + per-destination fee + volume discounts.
- **Internal Cost Tracking:** Estimated gross margin based on platform operational costs and client billing.
- **Invoicing Records:** Invoice reference generation, payment status tracking (Unpaid, Paid, Overdue).

---

## 4. Non-Functional & Operational Requirements

1. **Hardware Footprint:** Must run smoothly on 16 GB RAM development laptops (Dockerized PostgreSQL, Redis, NestJS, Next.js, Temporal, with optional lightweight Ollama).
2. **Deterministic Scheduling:** No post may be executed more than once (strict idempotency keys based on `campaignId + destinationId + scheduleSlot`).
3. **Auditability:** Complete audit logs for every state transition, approval action, credential modification, and publishing attempt.
4. **Security & Data Isolation:** Multi-tenant database queries strictly scoped by `organizationId`. Credentials encrypted at rest using AES-256. Zero credential leakage to frontend API responses.
