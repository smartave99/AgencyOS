-- CreateTable
CREATE TABLE "AgencyAiTool" (
    "id" TEXT NOT NULL,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "message" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyAiTool_pkey" PRIMARY KEY ("id")
);
