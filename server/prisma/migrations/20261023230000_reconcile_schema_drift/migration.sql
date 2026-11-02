-- Reconcile fields and relations introduced by db-push-era schema changes.
-- Existing template rows are backfilled before the required name column is
-- enforced, and all changes retain existing inspection and distribution data.

ALTER TABLE "DistributionTemplateItem"
  ADD COLUMN "name" TEXT;

UPDATE "DistributionTemplateItem" AS item
SET "name" = COALESCE(NULLIF(medicine."name", ''), 'Imported item')
FROM "Medicine" AS medicine
WHERE item."medicineId" = medicine."id"
  AND item."name" IS NULL;

UPDATE "DistributionTemplateItem"
SET "name" = 'Imported item'
WHERE "name" IS NULL;

ALTER TABLE "DistributionTemplateItem"
  ALTER COLUMN "name" SET NOT NULL,
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "DistributionTemplateItem"
  DROP CONSTRAINT IF EXISTS "DistributionTemplateItem_medicineId_fkey";
ALTER TABLE "DistributionTemplateItem"
  ADD CONSTRAINT "DistributionTemplateItem_medicineId_fkey"
  FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InspectionItem"
  ADD COLUMN "checkedDetail" JSONB;

CREATE TABLE "InspectionItemReason" (
  "id" TEXT NOT NULL,
  "inspectionItemId" TEXT NOT NULL,
  "reasonCode" TEXT,
  "quantity" INTEGER NOT NULL,
  "notes" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InspectionItemReason_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InspectionItemReason_inspectionItemId_idx"
  ON "InspectionItemReason"("inspectionItemId");
CREATE INDEX "InspectionItemReason_reasonCode_idx"
  ON "InspectionItemReason"("reasonCode");

ALTER TABLE "InspectionItemReason"
  ADD CONSTRAINT "InspectionItemReason_inspectionItemId_fkey"
  FOREIGN KEY ("inspectionItemId") REFERENCES "InspectionItem"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionItemReason"
  ADD CONSTRAINT "InspectionItemReason_reasonCode_fkey"
  FOREIGN KEY ("reasonCode") REFERENCES "StockReason"("code")
  ON DELETE SET NULL ON UPDATE CASCADE;
