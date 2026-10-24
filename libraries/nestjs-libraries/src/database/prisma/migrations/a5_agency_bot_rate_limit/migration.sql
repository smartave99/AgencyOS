-- When Telegram last asked a bot to slow down, and until when. Additive: both columns are nullable.
ALTER TABLE "TelegramBot" ADD COLUMN "rateLimitedUntil" TIMESTAMP(3),
ADD COLUMN "lastRateLimitedAt" TIMESTAMP(3);
