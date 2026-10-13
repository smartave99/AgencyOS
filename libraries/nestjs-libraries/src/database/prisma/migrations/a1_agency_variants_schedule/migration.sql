-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "intervalMinutes" INTEGER,
ADD COLUMN     "occurrences" INTEGER,
ADD COLUMN     "scheduleKind" TEXT NOT NULL DEFAULT 'ONCE';

-- AlterTable
ALTER TABLE "PostingJob" ADD COLUMN     "occurrence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "variantLabel" TEXT;

-- CreateTable
CREATE TABLE "CampaignVariant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "contentTitle" TEXT,
    "contentBody" TEXT NOT NULL,
    "contentMedia" TEXT,
    "ctaLink" TEXT,
    "ctaText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignVariant_campaignId_label_key" ON "CampaignVariant"("campaignId", "label");

-- AddForeignKey
ALTER TABLE "CampaignVariant" ADD CONSTRAINT "CampaignVariant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
