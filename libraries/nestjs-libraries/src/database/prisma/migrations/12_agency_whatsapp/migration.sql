-- WhatsApp local workspace. Purely additive: new enums, new tables and their indexes and keys.
-- Nothing that exists is altered, so it does not depend on any other migration beyond "Organization".

-- CreateEnum
CREATE TYPE "WhatsappConsentStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "WhatsappTaskStatus" AS ENUM ('PENDING', 'SENT_BY_USER', 'REPLIED', 'SKIPPED');

-- CreateTable
CREATE TABLE "WhatsappContact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "company" TEXT,
    "language" TEXT,
    "tags" TEXT[],
    "notes" TEXT,
    "consentStatus" "WhatsappConsentStatus" NOT NULL DEFAULT 'OPTED_IN',
    "consentSource" TEXT NOT NULL,
    "consentEvidence" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "consentRecordedById" TEXT NOT NULL,
    "importId" TEXT,
    "optedOutAt" TIMESTAMP(3),
    "optOutMethod" TEXT,
    "optOutReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappImport" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL,
    "importedRows" INTEGER NOT NULL,
    "duplicateRows" INTEGER NOT NULL,
    "invalidRows" INTEGER NOT NULL,
    "missingConsentRows" INTEGER NOT NULL,
    "withdrawnRows" INTEGER NOT NULL,
    "attestation" TEXT NOT NULL,
    "attestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappSegment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tags" TEXT[],
    "languages" TEXT[],
    "consentSources" TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "language" TEXT,
    "link" TEXT,
    "optOutLine" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappTask" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "templateId" TEXT,
    "segmentId" TEXT,
    "label" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "WhatsappTaskStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "note" TEXT,
    "followUpAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappUnsubscribe" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappUnsubscribe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappSettings" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "businessApiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultOptOutLine" TEXT NOT NULL DEFAULT 'Reply STOP to opt out.',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsappContact_orgId_consentStatus_idx" ON "WhatsappContact"("orgId", "consentStatus");

-- CreateIndex
CREATE INDEX "WhatsappContact_orgId_phoneHash_idx" ON "WhatsappContact"("orgId", "phoneHash");

-- CreateIndex
CREATE INDEX "WhatsappContact_importId_idx" ON "WhatsappContact"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappContact_orgId_phone_key" ON "WhatsappContact"("orgId", "phone");

-- CreateIndex
CREATE INDEX "WhatsappImport_orgId_createdAt_idx" ON "WhatsappImport"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsappSegment_orgId_idx" ON "WhatsappSegment"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappSegment_orgId_name_key" ON "WhatsappSegment"("orgId", "name");

-- CreateIndex
CREATE INDEX "WhatsappTemplate_orgId_idx" ON "WhatsappTemplate"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappTemplate_orgId_name_key" ON "WhatsappTemplate"("orgId", "name");

-- CreateIndex
CREATE INDEX "WhatsappTask_orgId_status_idx" ON "WhatsappTask"("orgId", "status");

-- CreateIndex
CREATE INDEX "WhatsappTask_orgId_followUpAt_idx" ON "WhatsappTask"("orgId", "followUpAt");

-- CreateIndex
CREATE INDEX "WhatsappTask_contactId_idx" ON "WhatsappTask"("contactId");

-- CreateIndex
CREATE INDEX "WhatsappTask_templateId_idx" ON "WhatsappTask"("templateId");

-- CreateIndex
CREATE INDEX "WhatsappTask_segmentId_idx" ON "WhatsappTask"("segmentId");

-- CreateIndex
CREATE INDEX "WhatsappUnsubscribe_orgId_phoneHash_idx" ON "WhatsappUnsubscribe"("orgId", "phoneHash");

-- CreateIndex
CREATE INDEX "WhatsappUnsubscribe_orgId_receivedAt_idx" ON "WhatsappUnsubscribe"("orgId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappSettings_orgId_key" ON "WhatsappSettings"("orgId");

-- AddForeignKey
ALTER TABLE "WhatsappContact" ADD CONSTRAINT "WhatsappContact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappContact" ADD CONSTRAINT "WhatsappContact_importId_fkey" FOREIGN KEY ("importId") REFERENCES "WhatsappImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappImport" ADD CONSTRAINT "WhatsappImport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSegment" ADD CONSTRAINT "WhatsappSegment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappTemplate" ADD CONSTRAINT "WhatsappTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappTask" ADD CONSTRAINT "WhatsappTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappTask" ADD CONSTRAINT "WhatsappTask_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "WhatsappContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappTask" ADD CONSTRAINT "WhatsappTask_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WhatsappTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappTask" ADD CONSTRAINT "WhatsappTask_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "WhatsappSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappUnsubscribe" ADD CONSTRAINT "WhatsappUnsubscribe_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSettings" ADD CONSTRAINT "WhatsappSettings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
