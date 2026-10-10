# AgencyOS — Enterprise Security, Compliance & Data Isolation Architecture

**Document Version:** 1.0.0  
**Security Classification:** Enterprise SaaS Standard  
**Compliance Scope:** Multi-Tenant Isolation, Credential Protection, Platform API Compliance, Auditability  

---

## 1. Multi-Tenant Isolation & Zero Data Leakage

AgencyOS is designed for multi-agency, multi-client SaaS operations where data contamination between competing agencies or unrelated clients represents a critical failure mode.

### 1.1 Server-Side Tenant Scoping
- **Context Injection:** Every authenticated HTTP request is validated through JWT auth guards (`AuthGuard`) and extracts the verified `Organization` (Agency) context via `@GetOrgFromRequest()`.
- **Query Hardening:** Database queries in Prisma repositories must explicitly filter by `organizationId`:
  ```typescript
  // Strict tenant scoping example
  const campaign = await this.prisma.campaign.findFirst({
    where: {
      id: campaignId,
      orgId: organization.id, // Mandatory tenant constraint
    },
  });
  if (!campaign) {
    throw new NotFoundException('Campaign not found or access denied');
  }
  ```
- **Prohibition on Client-Supplied Tenant IDs:** The client application is never trusted to supply the tenant ID in request bodies. The tenant context is strictly derived from the validated cryptographic JWT session token.

### 1.2 Cross-Client Separation within an Agency
- External **Client (Guest)** users assigned to a specific `Customer` record are restricted to records matching `customerId: user.customerId`.
- Internal agency staff (Sales, Campaign Managers) can view assigned client portfolios governed by CASL role policies (`CheckPolicies`).

---

## 2. Cryptographic Storage & Credential Handling

### 2.1 Encryption at Rest (AES-256-GCM)
- All platform secrets, including Telegram Bot tokens, OAuth access tokens, and refresh tokens, are encrypted at rest using AES-256-GCM prior to database persistence.
- Cryptographic keys are derived from a high-entropy secret environment variable (`ENCRYPTION_SECRET` / `JWT_SECRET`) and rotated via standard key derivation (HKDF / PBKDF2).

### 2.2 Strict API Response Sanitization
- Database models holding credentials (`Integration`, `TelegramDestination`, `User`) must **never** be returned raw from NestJS controllers.
- Controllers and services enforce strict Prisma `select` clauses or DTO mapping:
  ```typescript
  // Example sanitized response
  return destinations.map(dest => ({
    id: dest.id,
    title: dest.title,
    chatId: dest.chatId,
    type: dest.type,
    isAuthorized: dest.isAuthorized,
    lastVerifiedAt: dest.lastVerifiedAt,
    // Sensitive tokens (botToken, webhookSecrets) are strictly omitted
  }));
  ```

---

## 3. Platform Compliance & Zero Spam Architecture

### 3.1 Telegram API Boundary Adherence
- **Explicit Administrator Consent:** AgencyOS only broadcasts to Telegram channels and groups where the agency's registered bot has been granted explicit administrative status by the destination owner.
- **Verification on Demand:** Before every scheduled broadcast, the worker verifies that bot admin permissions remain active. If the bot has been revoked or demoted, the job is aborted immediately, flagged with `UNAUTHORIZED_REVOKED`, and the campaign manager is alerted.
- **Prohibition of Prohibited Operations:**
  - No scraping of user profiles or mass harvest of usernames.
  - No automated DM broadcasting to unconsenting users.
  - No programmatic account rotation designed to evade platform anti-spam filters.
  - All audience growth utilizes voluntary opt-in landing pages and direct join invite links.

### 3.2 Idempotency & Rate Limit Defense
- Duplicate message prevention: Every publishing job generates an idempotency key:
  $$\text{Key} = \text{SHA256}(\text{campaignId} + \text{destinationId} + \text{scheduledTimestamp} + \text{content})$$
  Logged in Redis with a 24-hour TTL and verified in the database `PublishingEvent` table prior to dispatch.
- Automatic rate throttling prevents hitting Telegram HTTP 429 limits.

---

## 4. Comprehensive Audit Trail

Every state change across the campaign and financial lifecycle is immutably logged:
1. **Campaign Life Transitions:** Timestamp, User ID, Previous State, New State, and Reason (e.g. `"Approved by Campaign Manager [ID: 9812]"`).
2. **Credential Updates:** Timestamp, User ID, Destination ID, and Operation Type (Created, Reverified, Deleted).
3. **Publishing Receipts:** Timestamp, Job ID, Destination Chat ID, Telegram External Message ID, HTTP response code, and generated public link.

---

## 5. Input Sanitization & Safe File Handling

1. **HTML & Tag Stripping:** Telegram messages and captions are sanitized using `striptags` to ensure only supported Telegram HTML tags (`<b>`, `<i>`, `<u>`, `<a>`, `<code>`) are forwarded to the API, preventing injection vulnerabilities.
2. **File Upload Security:**
   - Strict MIME-type validation against allowed images (`image/jpeg`, `image/png`, `image/webp`) and videos (`video/mp4`, `video/quicktime`).
   - Size quotas enforced at both API gateway (Multer) and database level.
   - Files stored with non-executable permissions with content hashes as filenames.
