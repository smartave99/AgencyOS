-- CreateEnum
CREATE TYPE "TelegramBotStrategy" AS ENUM ('FAILOVER', 'ROUND_ROBIN', 'LEAST_USED');

-- AlterTable
ALTER TABLE "PublishingEvent" ADD COLUMN     "botUsername" TEXT;

-- AlterTable
ALTER TABLE "TelegramDestination" ADD COLUMN     "backupBotIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "botStrategy" "TelegramBotStrategy" NOT NULL DEFAULT 'FAILOVER',
ADD COLUMN     "lastBotId" TEXT;

