# AgencyOS — Enterprise AI-Powered Advertising Agency Platform

## 1. System Architecture Overview

**AgencyOS** transforms the Postiz social management platform into an enterprise operating system built for advertising agencies, media buyers, sales teams, and multi-client campaign managers.

### Organizational Hierarchy & Multi-Tenancy
```
Platform Owner
  └── Agency (Tenant / Organization)
        └── Team / Sales Representatives
              └── Client (Customer)
                    └── Advertising Campaigns
                          ├── Target Destinations (Telegram & Social)
                          ├── Approval Governance (4-Eyes Review)
                          ├── Autonomous Dispatch Queue
                          ├── Attribution Tracking Funnel
                          └── Financial Invoices
```

All database queries strictly isolate data by `organizationId`. Clients and campaigns are completely quarantined between separate agency tenants.

---

## 2. Complete Module Matrix

| Module | Route / Component | Description & Capabilities |
| :--- | :--- | :--- |
| **Module A — Agency Hub** | `/agency/dashboard` | Executive KPI cockpit: Active campaigns, Gross spend, Destination counts, Pending approvals, Link clicks, Live revenue metrics. |
| **Module B — Multi-Tenant Clients** | `/agency/clients` | Full client lifecycle: Business profiles, contacts, assigned sales reps, campaign history, and renewal statuses. |
| **Module C — Campaign Builder** | `/agency/campaigns/new` | 5-step campaign creation wizard: Objective, copy, media uploads, CTA, budget, estimated reach/CPM calculator, and live Telegram message card preview. |
| **Module D — Telegram Advertising** | `/agency/telegram` | Authorized group & channel destination registry with real `node-telegram-bot-api` bot admin permission verification, idempotency locks (`camp_X_dest_Y`), and delivery logs. |
| **Module E — Discussion Analytics** | `/agency/intelligence` | 128-dimensional dense vector embeddings, cosine similarity semantic search, aggregate audience sentiment (-1.0 to +1.0), and topic clustering across authorized community feeds. |
| **Module F — Community Growth** | Public `/l/:code` & `/agency/crm` | Privacy-first referral & tracking funnel with SHA-256 IP anonymization (zero raw IP persistence), UTM preservation, and lead qualification. |
| **Module G & H — Platforms & Accounts** | `/agency/accounts` | Official technical capability registry across 8 networks (Telegram, X, LinkedIn, FB, IG, YouTube, TikTok, Pinterest) + connection health diagnostics. |
| **Module I — Approvals & Governance** | `/agency/approvals` | 4-eyes review workflow gating campaigns through `DRAFT` $\to$ `SUBMITTED` $\to$ `APPROVED` / `REJECTED`. |
| **Module J — AI Marketing Copilot** | `/agency/ai` & Wizard Embed | Multi-tier copywriting assistant supporting local Ollama (`qwen2.5:3b`), OpenAI API, and 100% offline heuristic fallback. |
| **Module K — Analytics & CSV Export** | `/agency/campaigns` & CSV API | Live click tracking, performance analytics, and one-click campaign CSV export reports. |
| **Module L — Sales Pipeline & CRM** | `/agency/crm` | Interactive Kanban pipeline with drag-and-drop deal stages (`LEAD`, `PROPOSAL`, `WON`, `LOST`), deal values, and client associations. |
| **Module M — Billing & Invoices** | `/agency/billing` | Invoice generation, revenue tracking, accounts receivable tracking, and payment reconciliation. |
| **Client Portal** | `/agency/portal` | Isolated client-facing view with creative approval controls, performance summaries, and print/PDF presentation export. |
| **Autonomous Scheduler** | `AgencySchedulerService` | Autonomous background interval runner polling every 60s for `SCHEDULED` campaigns and dispatching posts at execution time. |

---

## 3. Local Development on a 16 GB RAM Laptop

AgencyOS is specifically optimized to run locally on a developer laptop with 16 GB RAM without exhausting memory.

### Prerequisites
* Node.js v22 or v24
* pnpm v10 (`npm install -g pnpm`)
* PostgreSQL 16
* Redis 7
* *(Optional)* Ollama for local LLM inference

### Step-by-Step Local Setup

1. **Clone & Install Dependencies:**
   ```bash
   cd postiz-app-main
   pnpm install
   ```

2. **Configure Environment:**
   Copy `.env.agencyos.example` to `.env` in the root:
   ```bash
   cp .env.agencyos.example .env
   ```

3. **Generate Prisma Client:**
   ```bash
   pnpm exec prisma generate --schema=libraries/nestjs-libraries/src/database/prisma/schema.prisma
   ```

4. **Run Unit & Integration Tests:**
   ```bash
   pnpm exec jest libraries/nestjs-libraries/src/database/prisma/agency/ --runInBand
   ```
   *Expected result: 44/44 tests passing.*

5. **Start Development Servers:**
   ```bash
   pnpm run dev
   ```
   * Backend runs at: `http://localhost:3000`
   * Frontend runs at: `http://localhost:5000`

---

## 4. Inexpensive VPS Production Deployment ($10-$20/mo)

AgencyOS can be deployed on an inexpensive cloud VPS (Ubuntu 22.04 / 24.04 with 4 GB - 8 GB RAM) using Docker Compose.

### Quick Start with Docker Compose:

1. **Upload codebase to your VPS:**
   ```bash
   git clone <your-repo> /opt/agencyos
   cd /opt/agencyos
   ```

2. **Set your environment variables:**
   ```bash
   cp .env.agencyos.example .env
   nano .env
   ```

3. **Spin up the complete production stack:**
   ```bash
   docker compose -f docker-compose.agencyos.yml up -d --build
   ```

4. **Verify container health:**
   ```bash
   docker compose -f docker-compose.agencyos.yml ps
   ```

To enable the local Ollama AI model inside the container stack:
```bash
docker compose -f docker-compose.agencyos.yml --profile with-ai up -d
docker exec -it agencyos-ollama ollama pull qwen2.5:3b
docker exec -it agencyos-ollama ollama pull nomic-embed-text
```

---

## 5. Telegram Bot API Integration Guide

### 1. Create your Telegram Bot
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot` and follow the prompts to choose a bot name and username (e.g. `@MyAgencyAdsBot`).
3. Copy the HTTP API Token provided by BotFather.
4. Set `TELEGRAM_TOKEN=123456789:ABC...` in your `.env` file.

### 2. Onboard a Client Group or Channel
1. Add your bot as an **Administrator** in the target group or channel.
2. Grant the bot **Post Messages** permissions.
3. In AgencyOS, navigate to `/agency/telegram`.
4. Click **"+ Connect Destination"** and enter the group or channel's Chat ID (e.g., `-1001234567890` or `@channel_username`).
5. Click **"Verify Bot Permissions"**. AgencyOS calls Telegram's `getChatAdministrators` API to cryptographically confirm active administrator rights before allowing the destination in any campaign.

---

## 6. Security, Privacy & Anti-Spam Compliance

* **Zero Unauthorized Scraping:** AgencyOS strictly adheres to official platform APIs. No unsolicited member scraping, harvesting, or bulk unsolicited direct messaging is permitted.
* **Deterministic Idempotency:** Every broadcast post generates an idempotency key (`camp_${campaign.id}_dest_${dest.id}`). Duplicate broadcast jobs are blocked deterministically.
* **Privacy-Preserving Click Attribution:** The tracking gateway (`/l/:code`) computes a truncated SHA-256 hash of incoming IP addresses (`sha256(ip).substring(0, 16)`) for unique click counting. No raw IP addresses are ever written to disk or the database.
* **Multi-Tier AI Fallback:** When Ollama or OpenAI APIs are unreachable, AgencyOS automatically switches to its deterministic direct-response copywriting engine and vector projection, guaranteeing 100% operational uptime.
