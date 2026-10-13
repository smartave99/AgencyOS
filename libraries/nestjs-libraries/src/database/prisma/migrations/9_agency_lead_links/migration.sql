-- AlterTable
ALTER TABLE "LeadCapture" ADD COLUMN     "consentedAt" TIMESTAMP(3),
ADD COLUMN     "leadLinkId" TEXT,
ADD COLUMN     "optedOutAt" TIMESTAMP(3),
ADD COLUMN     "telegramUserId" TEXT;

-- CreateTable
CREATE TABLE "LeadLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT,
    "label" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "botId" TEXT,
    "welcomeMessage" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LeadLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadLink_code_key" ON "LeadLink"("code");

-- CreateIndex
CREATE INDEX "LeadLink_orgId_idx" ON "LeadLink"("orgId");

-- CreateIndex
CREATE INDEX "LeadLink_campaignId_idx" ON "LeadLink"("campaignId");

-- CreateIndex
CREATE INDEX "LeadCapture_telegramUserId_idx" ON "LeadCapture"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadCapture_leadLinkId_telegramUserId_key" ON "LeadCapture"("leadLinkId", "telegramUserId");

-- AddForeignKey
ALTER TABLE "LeadCapture" ADD CONSTRAINT "LeadCapture_leadLinkId_fkey" FOREIGN KEY ("leadLinkId") REFERENCES "LeadLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadLink" ADD CONSTRAINT "LeadLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadLink" ADD CONSTRAINT "LeadLink_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
