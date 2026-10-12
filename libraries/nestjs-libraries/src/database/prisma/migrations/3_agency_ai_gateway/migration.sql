-- CreateTable
CREATE TABLE "AgencyAiConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "activeProvider" TEXT NOT NULL DEFAULT 'local',
    "thinking" TEXT NOT NULL DEFAULT 'auto',
    "providers" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyAiConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgencyAiConfig_orgId_key" ON "AgencyAiConfig"("orgId");

-- AddForeignKey
ALTER TABLE "AgencyAiConfig" ADD CONSTRAINT "AgencyAiConfig_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
