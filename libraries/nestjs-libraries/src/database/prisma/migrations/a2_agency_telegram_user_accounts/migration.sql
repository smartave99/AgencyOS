-- CreateEnum
CREATE TYPE "TelegramUserAccountStatus" AS ENUM ('ACTIVE', 'PAUSED', 'RATE_LIMITED', 'RESTRICTED', 'SESSION_INVALID', 'LOGGED_OUT');

-- CreateEnum
CREATE TYPE "TelegramAccountEventKind" AS ENUM ('CONNECTED', 'LOGGED_OUT', 'HEALTH_OK', 'HEALTH_FAILED', 'RATE_LIMITED', 'RESTRICTED', 'SESSION_INVALID', 'PERMISSIONS_CHANGED', 'PAUSED', 'RESUMED', 'ERROR');

-- CreateEnum
CREATE TYPE "CommunityStage" AS ENUM ('DISCOVERED', 'REVIEW_REQUIRED', 'JOIN_REQUEST_PENDING', 'JOINED', 'ADVERTISING_ALLOWED', 'PUBLISHING_AUTHORIZED', 'NOT_ELIGIBLE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CommunityRelation" AS ENUM ('OWNED', 'ADMINISTERED', 'MEMBER', 'PUBLIC_NOT_JOINED', 'RESTRICTED', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "TelegramDestination" ADD COLUMN     "communityId" TEXT,
ADD COLUMN     "senderKind" TEXT NOT NULL DEFAULT 'BOT',
ADD COLUMN     "userAccountId" TEXT;

-- CreateTable
CREATE TABLE "TelegramUserAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT,
    "phoneMasked" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "status" "TelegramUserAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "rateLimitedUntil" TIMESTAMP(3),
    "canResearch" BOOLEAN NOT NULL DEFAULT true,
    "canJoin" BOOLEAN NOT NULL DEFAULT false,
    "canPublish" BOOLEAN NOT NULL DEFAULT false,
    "canManage" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorCode" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramUserAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramAccountEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "TelegramAccountEventKind" NOT NULL,
    "code" TEXT,
    "message" TEXT NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramAccountEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Community" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "telegramId" TEXT,
    "kind" TEXT,
    "username" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "memberCount" INTEGER,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "scam" BOOLEAN NOT NULL DEFAULT false,
    "fake" BOOLEAN NOT NULL DEFAULT false,
    "joinRequestRequired" BOOLEAN NOT NULL DEFAULT false,
    "slowModeSeconds" INTEGER,
    "language" TEXT,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "relation" "CommunityRelation" NOT NULL DEFAULT 'PUBLIC_NOT_JOINED',
    "available" BOOLEAN NOT NULL DEFAULT true,
    "lastErrorCode" TEXT,
    "stage" "CommunityStage" NOT NULL DEFAULT 'DISCOVERED',
    "stageReason" TEXT,
    "operatingAccountId" TEXT,
    "adReview" TEXT NOT NULL DEFAULT 'NOT_REVIEWED',
    "adReviewNote" TEXT,
    "adReviewEvidenceUrl" TEXT,
    "adReviewedById" TEXT,
    "adReviewedAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3),
    "source" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityHistory" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStage" "CommunityStage",
    "toStage" "CommunityStage",
    "summary" TEXT NOT NULL,
    "changes" JSONB,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramUserAccount_orgId_idx" ON "TelegramUserAccount"("orgId");

-- CreateIndex
CREATE INDEX "TelegramUserAccount_orgId_telegramUserId_idx" ON "TelegramUserAccount"("orgId", "telegramUserId");

-- CreateIndex
CREATE INDEX "TelegramAccountEvent_accountId_createdAt_idx" ON "TelegramAccountEvent"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramAccountEvent_orgId_idx" ON "TelegramAccountEvent"("orgId");

-- CreateIndex
CREATE INDEX "Community_orgId_stage_idx" ON "Community"("orgId", "stage");

-- CreateIndex
CREATE INDEX "Community_operatingAccountId_idx" ON "Community"("operatingAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Community_orgId_telegramId_key" ON "Community"("orgId", "telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Community_orgId_username_key" ON "Community"("orgId", "username");

-- CreateIndex
CREATE INDEX "CommunityHistory_communityId_createdAt_idx" ON "CommunityHistory"("communityId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityHistory_orgId_idx" ON "CommunityHistory"("orgId");

-- CreateIndex
CREATE INDEX "TelegramDestination_userAccountId_idx" ON "TelegramDestination"("userAccountId");

-- CreateIndex
CREATE INDEX "TelegramDestination_communityId_idx" ON "TelegramDestination"("communityId");

-- AddForeignKey
ALTER TABLE "TelegramDestination" ADD CONSTRAINT "TelegramDestination_userAccountId_fkey" FOREIGN KEY ("userAccountId") REFERENCES "TelegramUserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramDestination" ADD CONSTRAINT "TelegramDestination_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUserAccount" ADD CONSTRAINT "TelegramUserAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramAccountEvent" ADD CONSTRAINT "TelegramAccountEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramUserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Community" ADD CONSTRAINT "Community_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Community" ADD CONSTRAINT "Community_operatingAccountId_fkey" FOREIGN KEY ("operatingAccountId") REFERENCES "TelegramUserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityHistory" ADD CONSTRAINT "CommunityHistory_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

