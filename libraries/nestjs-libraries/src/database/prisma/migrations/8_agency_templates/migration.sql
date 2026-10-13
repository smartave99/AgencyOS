-- CreateTable
CREATE TABLE "AdTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentTitle" TEXT,
    "contentBody" TEXT NOT NULL,
    "contentMedia" TEXT,
    "ctaLink" TEXT,
    "ctaText" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdTemplate_orgId_idx" ON "AdTemplate"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "AdTemplate_orgId_name_key" ON "AdTemplate"("orgId", "name");

-- AddForeignKey
ALTER TABLE "AdTemplate" ADD CONSTRAINT "AdTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
