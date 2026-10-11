-- Manual rollback for 1_agency_hardening. Prisma does not run this file.
-- Take a backup first. Rolling back discards posting jobs, audit events, agency
-- roles and Telegram consent records. The 'PARTIALLY_FAILED' enum value cannot be
-- dropped from CampaignStatus without recreating the type; move rows off it first:
--   UPDATE "Campaign" SET status = 'FAILED' WHERE status = 'PARTIALLY_FAILED';
-- and leave the (unused) enum label in place.
BEGIN;
DROP TABLE IF EXISTS "LeaderLease";
DROP TABLE IF EXISTS "AuditEvent";
DROP TABLE IF EXISTS "AgencyMember";
ALTER TABLE "PublishingEvent" DROP COLUMN IF EXISTS "postingJobId", DROP COLUMN IF EXISTS "attempt";
DROP TABLE IF EXISTS "PostingJob";
DROP TYPE IF EXISTS "PostingJobStatus";
DROP TYPE IF EXISTS "AgencyRole";
DROP INDEX IF EXISTS "CampaignDestination_campaignId_telegramDestinationId_key";
DROP INDEX IF EXISTS "CampaignDestination_campaignId_integrationId_key";
ALTER TABLE "CampaignDestination" DROP COLUMN IF EXISTS "scheduledAt";
ALTER TABLE "ApprovalRequest" DROP COLUMN IF EXISTS "selfApproved";
ALTER TABLE "TelegramDestination"
  DROP COLUMN IF EXISTS "authorizationStatus", DROP COLUMN IF EXISTS "consentExpiresAt",
  DROP COLUMN IF EXISTS "consentGrantedAt", DROP COLUMN IF EXISTS "consentRevokedAt",
  DROP COLUMN IF EXISTS "consentedByName", DROP COLUMN IF EXISTS "consentedByTelegramId",
  DROP COLUMN IF EXISTS "lastSuccessfulPostAt", DROP COLUMN IF EXISTS "ownerContact",
  DROP COLUMN IF EXISTS "ownerName", DROP COLUMN IF EXISTS "revokedReason",
  DROP COLUMN IF EXISTS "timezone", DROP COLUMN IF EXISTS "verificationCodeHash",
  DROP COLUMN IF EXISTS "verificationExpiresAt",
  ALTER COLUMN "isAuthorized" SET DEFAULT true;
DROP TYPE IF EXISTS "DestinationAuthStatus";
ALTER TABLE "Campaign"
  DROP COLUMN IF EXISTS "approvedAt", DROP COLUMN IF EXISTS "approvedByUserId",
  DROP COLUMN IF EXISTS "approvedContentHash", DROP COLUMN IF EXISTS "attentionReason",
  DROP COLUMN IF EXISTS "requiresAttention", DROP COLUMN IF EXISTS "revision",
  DROP COLUMN IF EXISTS "requiresClientApproval", DROP COLUMN IF EXISTS "clientApprovedAt",
  DROP COLUMN IF EXISTS "clientApprovedByUserId";
COMMIT;
