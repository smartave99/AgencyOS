
# Agency OS
### Created by NextGen OS

**Architecture, Features, Implementation Status & Gap Analysis**

Agency OS is an advertising agency management platform developed by **NextGen OS**. It brings campaign management, client relationships, Telegram publishing, approvals, reporting, sales pipelines, and business operations into a unified workspace.

This document outlines the system's existing capabilities, implemented Agency OS modules, architectural decisions, operational limitations, and future development priorities.

For detailed module-by-module implementation status, see [AGENCYOS_IMPLEMENTATION_STATUS.md](AGENCYOS_IMPLEMENTATION_STATUS.md).

---

## 1. Core Platform Architecture

Agency OS combines an established application foundation with agency-specific services and workflows developed by NextGen OS.

| Component | Technology | Purpose |
| --- | --- | --- |
| Backend | NestJS | API services and business logic |
| Frontend | Next.js App Router | Agency dashboard and client portal |
| Database | PostgreSQL | Persistent application data |
| ORM | Prisma | Database models and queries |
| Cache | Redis | Caching and supporting services |
| Background Processing | Database-backed job queue | Campaign delivery and retries |
| Workflow Infrastructure | Temporal | Existing social publishing workflows |
| Multi-Tenancy | Organization-based isolation | Separate agency workspaces |
| Permissions | Role-based access control | Granular access management |
| Media Management | Integrated media library | Campaign assets and content |
| Reporting | Delivery records and click tracking | Campaign performance visibility |

### Existing Foundation Capabilities

The underlying platform provides:

- Organization and user management
- User authentication and invitations
- Social media scheduling and publishing
- Multi-network integrations
- Calendar management
- Media library
- AI-assisted content tools
- Social media analytics
- Subscription and billing infrastructure

Agency OS extends this foundation with advertising-agency operations, client management, approval workflows, authorized Telegram destinations, and campaign delivery tracking.

---

## 2. Agency OS Features & Implementation Status

| Feature | Agency OS Implementation |
| --- | --- |
| Multi-Tenant Agencies | Every agency query and write is scoped by `orgId`, with isolation tests |
| Agency Roles | `AgencyMember` with 8 roles and a permission matrix |
| Campaign Management | Campaign lifecycle, destinations, controlled status changes |
| Approval Workflow | Submit, review, send back, four-eyes review and optional client sign-off |
| Telegram Destination Registry | Authorized destinations with consent verification |
| Campaign Publishing | Database-backed queue with idempotency, retries and delivery safety |
| Reporting | Stored publishing results and tracked clicks |
| CRM | Client records and sales deals |
| Invoicing | Invoice record management |
| Client Portal | Client-facing campaign previews and approvals |
| Audit Trail | Records of significant agency operations |
| Operational Monitoring | Warnings when required publishing services are unavailable |

---

## 3. Campaign Management System

Agency OS introduces a dedicated campaign management model.

### Campaign Lifecycle

1. Create campaign
2. Add campaign content
3. Select authorized destinations
4. Submit for approval
5. Review campaign
6. Approve or return for changes
7. Schedule or dispatch
8. Record delivery results
9. Generate campaign reports

### Campaign Data Models

- `Campaign`
- `CampaignDestination`
- `PostingJob`

### Campaign Safety Controls

- Campaign status changes are workflow-controlled.
- Campaign content is frozen after approval.
- Approval rules can require separate reviewers.
- Optional client sign-off is supported.
- Campaign actions are recorded for auditing.
- Publishing operations use idempotency controls.

---

## 4. Telegram Advertising & Publishing

Agency OS includes a consent-based Telegram campaign delivery system.

### Authorized Destination Management

Telegram destinations are registered through an authorization process.

Supported capabilities include:

- Administrator-proven destination consent
- Authorization using `/authorize CODE`
- Authorization revocation using `/revoke`
- Authorization expiry
- Destination health tracking
- Publishing pause when required access is lost

### Reliable Message Delivery

Campaign delivery uses a PostgreSQL-backed job queue.

Key features:

- Unique delivery keys per destination
- Atomic database job claiming
- Processing leases
- Restart-safe processing
- Retry handling with backoff
- Dead-letter handling
- Explicit uncertain-delivery states
- Cancellation using job status
- Protection against automatic duplicate sending when delivery is uncertain

### Dispatcher Configuration

Campaign publishing requires the dispatcher to be enabled:

`AGENCY_SCHEDULER_ENABLED=true`

If the dispatcher or Telegram bot is unavailable, Agency OS displays an operational warning.

---

## 5. Publishing Architecture

### Database-Backed Publishing Queue

Agency OS uses a dedicated database queue for campaign publishing.

This design provides direct control over:

1. Per-destination idempotency
2. Atomic job claiming
3. Job processing leases
4. Retry behavior
5. Uncertain delivery states
6. Cancellation
7. Dead-letter handling

### Architectural Trade-Off

A database queue was selected for campaign publishing because these behaviors can be directly enforced and tested using PostgreSQL.

The existing Temporal infrastructure continues to support the foundation's social publishing workflows.

The Agency OS campaign dispatcher uses a polling process that must be enabled in the deployment environment.

---

## 6. Security, Permissions & Agency Isolation

Agency OS uses organization-scoped access controls.

### Multi-Tenant Architecture

Each agency operates within its own organization boundary.

- Agency data is scoped by `orgId`.
- Cross-agency access is restricted.
- Agency membership controls permissions.
- Client portal users receive restricted access.
- Tenant-isolation tests verify protection against unauthorized data access.

### Role-Based Access Control

The `AgencyMember` system provides eight agency roles with a dedicated permission matrix.

Agency-specific permissions are applied on top of the existing organization access model.

### Client Portal

Client-facing capabilities include:

- Viewing campaign previews
- Reviewing proposed content
- Approving campaigns where permitted
- Accessing information authorized for that client

Client users are restricted to the client portal.

---

## 7. CRM & Business Operations

### Client Management

Agency OS extends the existing customer model to support agency client relationships.

### Sales Pipeline

The CRM includes sales deal records.

### Invoice Management

Agency OS supports invoice records.

Payment gateway integration, automated invoice delivery, and PDF invoice generation remain future development items.

---

## 8. Reporting & Analytics

Agency OS provides campaign reporting using stored publishing information.

### Implemented Reporting Sources

- Publishing results
- Destination delivery records
- Tracked clicks

### Current Reporting Scope

Reports reflect recorded delivery outcomes and tracked interactions.

Complete conversion attribution, advanced funnel analytics, and additional social-network campaign destinations are not yet implemented.

---

## 9. Responsible Telegram Operations

Agency OS supports authorized Telegram marketing workflows.

The system does not implement:

- Unauthorized scraping of Telegram group members
- Automatic joining of groups without authorization
- Adding scraped users to groups
- Rotating accounts to evade platform restrictions

Instead, Agency OS uses:

- Authorized destination registration
- Consent verification
- Revocation controls
- Access monitoring
- Authorized discussion-data analysis
- Knowledge-base source authorization attestations

For details, see [AGENCYOS_RULES_CONFLICT.md](AGENCYOS_RULES_CONFLICT.md).

---

## 10. Remaining Development Gaps

The following capabilities are not yet fully implemented.

### Campaign & Marketing

- Social networks as additional Agency OS campaign destinations
- Lead-capture funnels
- Invite links and QR code generation
- Conversion tracking and attribution
- Recurring campaign schedules
- Campaign content version history

### Telegram Infrastructure

- Per-agency Telegram bot tokens
- Encrypted storage of tenant-specific credentials

### Reporting & Finance

- Server-generated PDF campaign reports
- PDF invoices
- Integrated payment processing
- Automated invoice sending

### AI & Knowledge Management

- Dedicated vector database
- Native vector search without an external Ollama dependency

### Client Identity

- Independent client authentication separate from workspace logins

---

## 11. Codebase Integration & Compatibility

Agency OS introduces additive functionality while retaining compatibility with its existing application foundation.

### Database Changes

- New agency-specific database models
- Organization-scoped agency records
- Additional campaign and destination fields
- Database migration support
- Schema constraints tightened for selected existing project tables

### Integration Points

Agency OS modifies or extends:

- `top.menu.tsx`
- Authentication middleware
- `colors.scss`
- `global.scss`
- `api.module.ts`
- `database.module.ts`
- Prisma schema
- `pm2-run`
- Migration scripts
- CI workflow configuration

Existing GitHub workflow files were previously moved into `.github/ci-workflows`.

### Upstream Maintenance

The application foundation originates from the Postiz open-source codebase. Agency OS is the agency-specific product layer created by NextGen OS.

Future upstream schema changes must be integrated with appropriate database migrations.

Agency-specific services should remain modular to minimize integration conflicts and simplify maintenance.

---

## 12. Development Priorities

### Priority 1 — Production Readiness

- Secure per-agency bot credentials
- Verify publisher and dispatcher availability
- Strengthen operational monitoring
- Expand tenant isolation and permission tests

### Priority 2 — Campaign Capabilities

- Add additional authorized campaign destinations
- Introduce recurring campaigns
- Implement campaign version history
- Build lead-capture and conversion workflows

### Priority 3 — Reporting & Finance

- Generate downloadable PDF reports
- Generate PDF invoices
- Add invoice delivery
- Integrate billing and payment providers

### Priority 4 — Advanced Intelligence

- Introduce vector-based knowledge search
- Expand authorized discussion analysis
- Improve campaign reporting and analytics
- Extend AI-assisted agency workflows

---

## 13. Product Vision

**Agency OS — Created by NextGen OS**

Agency OS aims to become a unified operating system for advertising agencies.

The platform is designed to connect:

- Campaign planning
- Content management
- Approval workflows
- Authorized message publishing
- Client relationships
- Sales pipeline management
- Invoicing
- Reporting
- AI-assisted operations

The long-term goal is to provide agencies with one workspace for managing campaigns, clients, team collaboration, and business operations.

---

**Agency OS**

**Created by NextGen OS**

**Architecture & Implementation Documentation**
