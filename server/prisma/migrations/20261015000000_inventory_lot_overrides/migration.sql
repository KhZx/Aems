-- Per-unit lot overrides.
-- Admin publishes the shared MedicineBatch (the template). Each ambulance may
-- correct the lot number / expiry / supplier / received date for its own stock
-- row without rewriting the shared batch that every other unit points at.
-- A NULL override means "inherit the shared batch value".

-- AlterTable
ALTER TABLE "Inventory" ADD COLUMN     "overrideBatchNumber" TEXT,
                        ADD COLUMN     "overrideExpiryDate" TIMESTAMP(3),
                        ADD COLUMN     "overrideSupplier" TEXT,
                        ADD COLUMN     "overrideReceivedDate" TIMESTAMP(3);
