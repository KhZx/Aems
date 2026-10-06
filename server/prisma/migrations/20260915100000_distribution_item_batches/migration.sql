-- Distribution template items now mirror the app "Add Item" form (medicine
-- fields: name, category, location, serial, size, DCAS/barcode, notes,
-- technicalNotes). Quantities/batches move to a child table so each item
-- supports MULTIPLE batches (expiry/lot/qty rows), like the app pages.
--
-- NOTE: DB is kept in sync via `prisma db push` (not Prisma Migrate), so this
-- file is kept as a record. In the dev database the old item columns likely
-- hold no production data yet; the DROP COLUMNs below remove them.

ALTER TABLE "DistributionTemplateItem"
  ALTER COLUMN "medicineId" DROP NOT NULL,
  ADD COLUMN "category"     "MedicineCategory" NOT NULL DEFAULT 'MEDICATION',
  ADD COLUMN "location"     TEXT,
  ADD COLUMN "serialNumber" TEXT,
  ADD COLUMN "size"         TEXT,
  ADD COLUMN "barcode"      TEXT,
  ADD COLUMN "notes"        TEXT,
  ADD COLUMN "technicalNotes" TEXT,
  ADD COLUMN "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  DROP COLUMN "quantity",
  DROP COLUMN "batchNumber",
  DROP COLUMN "expiryDate",
  DROP COLUMN "receivedDate",
  DROP COLUMN "supplier";

CREATE TABLE "DistributionTemplateBatch" (
  "id"           TEXT NOT NULL,
  "templateItemId" TEXT NOT NULL,
  "batchNumber"  TEXT NOT NULL,
  "expiryDate"   TIMESTAMP(3) NOT NULL,
  "receivedDate" TIMESTAMP(3),
  "supplier"     TEXT,
  "quantity"     INTEGER NOT NULL DEFAULT 1,
  "sortOrder"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DistributionTemplateBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DistributionTemplateBatch_templateItemId_idx" ON "DistributionTemplateBatch"("templateItemId");

ALTER TABLE "DistributionTemplateBatch"
  ADD CONSTRAINT "DistributionTemplateBatch_templateItemId_fkey" FOREIGN KEY ("templateItemId") REFERENCES "DistributionTemplateItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;