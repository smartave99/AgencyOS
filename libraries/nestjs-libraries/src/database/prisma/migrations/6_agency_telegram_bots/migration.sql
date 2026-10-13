-- CreateEnum
CREATE TYPE "TelegramBotStatus" AS ENUM ('ACTIVE', 'DISABLED', 'INVALID');

-- AlterTable
ALTER TABLE "TelegramDestination" ADD COLUMN     "botId" TEXT;

-- CreateTable
CREATE TABLE "TelegramBot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenSealed" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "telegramBotId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" "TelegramBotStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramBot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramBot_orgId_idx" ON "TelegramBot"("orgId");

-- CreateIndex
CREATE INDEX "TelegramBot_tokenHash_idx" ON "TelegramBot"("tokenHash");

-- CreateIndex
CREATE INDEX "TelegramDestination_botId_idx" ON "TelegramDestination"("botId");

-- AddForeignKey
ALTER TABLE "TelegramBot" ADD CONSTRAINT "TelegramBot_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramDestination" ADD CONSTRAINT "TelegramDestination_botId_fkey" FOREIGN KEY ("botId") REFERENCES "TelegramBot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

