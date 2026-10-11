-- Manual rollback for 2_agency_crm. Prisma does not run this file. Back up first: deals are lost.
BEGIN;
DROP TABLE IF EXISTS "Deal";
DROP TYPE IF EXISTS "DealStage";
COMMIT;
