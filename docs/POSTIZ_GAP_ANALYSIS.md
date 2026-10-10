# Postiz to AgencyOS — Repository Gap Analysis & Migration Strategy

**Document Version:** 1.0.0  
**Inspection Date:** 2026-10-11  
**Target Codebase:** `postiz-app-main` (Postiz core)  

---

## 1. Executive Summary

This gap analysis is based on a direct audit of the `postiz-app-main` codebase. Postiz provides a modern social media scheduling core (Prisma, NestJS, Next.js App Router, Temporal, Redis, PostgreSQL, and multi-platform social connectors including basic Telegram channel publishing).

However, transforming Postiz into **AgencyOS** requires bridging key architectural gaps:
1. Transitioning from generic single-organization social posting to a multi-tenant Agency-Client-Campaign operational model.
2. Elevating Telegram from a simple single-channel destination to an authorized destination registry supporting channels, supergroups, bot verification, throttling, and posting receipts.
3. Adding multi-stage approval workflows (`Draft` → `Submitted` → `Under Review` → `Approved` → `Scheduled`).
4. Creating the lightweight Agency CRM (Clients, Leads, Deals, Quotes) and Campaign Invoicing.
5. Providing an AI Marketing Copilot with local Ollama / OpenAI-compatible backends and discussion intelligence.

---

## 2. Requirement-by-Requirement Gap Classification

| Requirement / Module | Classification | Current State in Postiz | Required AgencyOS Transformation |
| :--- | :--- | :--- | :--- |
| **Multi-Tenant Organizations** | *Supported with configuration* | `Organization`, `UserOrganization`, `User` models exist with basic roles (`SUPERADMIN`, `ADMIN`, `USER`). | Extend role hierarchy to support `SALES_MANAGER`, `SALES_EXECUTIVE`, `CAMPAIGN_MANAGER`, `CLIENT`. |
| **Client Management** | *Partially supported* | `Customer` model exists in Prisma (`orgId`, `name`), but is primarily a tag on `Integration` and `Post`. | Elevate `Customer` to full Agency Client entity (contact info, assigned sales rep, notes, contract status, billing tier). |
| **Ad Campaign Builder** | *Requires a new module* | Postiz only has standalone `Post` models (content, schedule, single integration). | Create `Campaign`, `CampaignDestination`, `CampaignVersion` with multi-destination targeting, objectives, and budget tracking. |
| **Telegram Publishing Core** | *Partially supported* | `telegram.provider.ts` uses `node-telegram-bot-api` to post text/photos/videos/docs/albums via Bot token. | Extend into an authorized Destination Registry (`TelegramDestination`) with bot admin permission checks, rate throttles, and receipts. |
| **Telegram Group Onboarding** | *Partially supported* | Basic `/connect <code_word>` polling in `getBotId`. | Build interactive Onboarding Wizard verifying admin permissions (`can_post_messages`, `can_delete_messages`). |
| **Discussion Scraping / Harvesting** | *Unsupported by external APIs* | Telegram Bot API does not permit unauthorized user harvesting or mass member dumping without explicit admin consent. | Implement privacy-compliant **Authorized Discussion Analytics** for groups where bot is admin; reject unauthorized scraping. |
| **Multi-Stage Approval Engine** | *Requires a new module* | Posts go straight into `QUEUE` or `DRAFT`. | Implement `ApprovalRequest` state machine (`Draft` → `Submitted` → `Under Review` → `Changes Requested` → `Approved` → `Scheduled`). |
| **Executive Agency Dashboard** | *Requires extension* | Dashboard currently shows social calendar (`/launches`) and basic platform analytics. | Build Agency Executive Dashboard with active campaigns, client revenue, pending approvals, job health, and destination statuses. |
| **AI Marketing Copilot** | *Partially supported* | Mastra AI and basic `@copilotkit` are wired, but tightly coupled. | Build modular `AgencyAiService` supporting local Ollama (`Qwen 2.5` / `Gemma 3`) and OpenAI APIs for copy, headlines, and CTAs. |
| **Community Growth & Funnel** | *Requires a new module* | Basic shortlink service exists (`ShortLinkService`). | Build `LeadCapture` forms, campaign-attributed invite links, QR code generator, and conversion tracking. |
| **CRM & Sales Pipeline** | *Requires a new module* | No CRM entities exist in current Postiz. | Build lightweight CRM (`Lead`, `Deal`, `Quote`) connected to Clients and Campaigns. |
| **Billing & Invoicing** | *Partially supported* | Basic Stripe subscription tiers for Postiz SaaS plans. | Add custom Agency Pricing rules (campaign fee + destination fee) and Client Invoice tracking. |
| **Job Scheduling Engine** | *Already supported* | Temporal.io background workflows (`post.workflow.*`, `post.activity.*`) are robust and scalable. | Wrap campaign jobs into Temporal activities with idempotency keys and error-handling policies. |

---

## 3. Detailed Component Impact Assessment

### 3.1 Database Schema (`libraries/nestjs-libraries/src/database/prisma/schema.prisma`)
- **Modify Existing Models:**
  - `Customer`: Add `email`, `phone`, `companyName`, `industry`, `status`, `assignedUserId`, `notes`, `website`, `billingDetails`.
  - `Role` enum: Add `AGENCY_OWNER`, `SALES_MANAGER`, `SALES_EXEC`, `CAMPAIGN_MANAGER`, `CONTENT_EDITOR`, `ANALYST`, `CLIENT`.
- **New Models to Add:**
  - `Campaign`: Core container for ad campaigns (`name`, `objective`, `status`, `budget`, `startDate`, `endDate`, `customerId`, `orgId`).
  - `CampaignDestination`: Mapping campaign to target Telegram destinations and social accounts.
  - `TelegramDestination`: Registered, authorized groups/channels (`chatId`, `title`, `type`, `isAuthorized`, `botPermissions`, `lastVerifiedAt`).
  - `ApprovalRequest`: Audit trail of submissions, reviews, approvals, rejections, notes.
  - `PublishingEvent`: Execution receipt table for post delivery (`externalMessageId`, `releaseUrl`, `status`, `errorReason`).
  - `LeadCapture`: Funnel records for opt-in community leads (`campaignId`, `name`, `email`, `phone`, `source`, `convertedAt`).
  - `AgencyInvoice`: Client invoice tracking (`invoiceNumber`, `amount`, `status`, `dueDate`, `paidAt`).

### 3.2 Backend Services & Controllers (`apps/backend` & `libraries/nestjs-libraries`)
- **New Services in `libraries/nestjs-libraries/src/services/`:**
  - `agency.campaign.service.ts`: Campaign creation, multi-destination fan-out, lifecycle transitions.
  - `agency.approval.service.ts`: Approval requests, state validations, notifications.
  - `agency.telegram.service.ts`: Bot permissions verification, destination registry management, throttling.
  - `agency.crm.service.ts`: Leads, deals, quotes, and client management.
  - `agency.ai.service.ts`: Pluggable AI generation for copy, variations, and summaries.
  - `agency.analytics.service.ts`: Aggregated campaign metrics, click-through calculations, conversion funnels.
- **New Controllers in `apps/backend/src/api/routes/`:**
  - `agency.campaigns.controller.ts`: `/agency/campaigns` endpoints.
  - `agency.approvals.controller.ts`: `/agency/approvals` endpoints.
  - `agency.telegram.controller.ts`: `/agency/telegram` endpoints (onboarding, verification, registry).
  - `agency.clients.controller.ts`: `/agency/clients` endpoints.
  - `agency.crm.controller.ts`: `/agency/crm` endpoints.
  - `agency.ai.controller.ts`: `/agency/ai` endpoints.
  - `agency.dashboard.controller.ts`: `/agency/dashboard` executive aggregation endpoints.

### 3.3 Frontend Application (`apps/frontend`)
- **Navigation & Layout Updates:**
  - Update `apps/frontend/src/components/layout/top.menu.tsx`:
    - Add **Agency Dashboard** (`/agency/dashboard`).
    - Add **Clients** (`/agency/clients`).
    - Add **Campaigns** (`/agency/campaigns`).
    - Add **Approvals** (`/agency/approvals`).
    - Add **Telegram Manager** (`/agency/telegram`).
    - Add **Sales CRM** (`/agency/crm`).
- **New View Components in `apps/frontend/src/components/agency/`:**
  - `dashboard/`: Executive KPI cards, real-time activity stream, status distribution charts.
  - `clients/`: Client directory table, modal for onboarding, client profile drawer.
  - `campaigns/`: Campaign wizard, multi-destination selector, preview tabs, content variations editor.
  - `approvals/`: Manager review queue, diff visualizer, approve/reject with notes modal.
  - `telegram/`: Destination management, bot verification tester, invite link generator.
  - `crm/`: Sales pipeline board, lead capture logs, proposal builder.
  - `ai/`: AI Copilot generator drawer and inline prompt enhancer.

---

## 4. Upstream Compatibility & Safe Migration Plan

To ensure that changes do not break Postiz upstream capabilities:
1. **Additive Schema Strategy:** All new database tables are strictly additive. Existing `Post`, `Integration`, and `User` models remain backward-compatible.
2. **Reusing Existing Sockets:** Temporal workers, Redis connections, and NestJS dependency injection mechanisms are reused directly without modifying core Postiz internals.
3. **Graceful Fallback:** If new features (e.g., local AI or pgvector) are disabled or not installed, the platform operates without downtime.
