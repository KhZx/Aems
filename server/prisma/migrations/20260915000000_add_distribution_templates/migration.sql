-- Admin inventory distribution: reusable templates applied to selected stations.

-- Stores the list names themselves.
CREATE TABLE "DistributionTemplate" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributionTemplate_pkey" PRIMARY KEY ("id")
);

-- Line items of a template (medicine + quantity + batch to add).
CREATE TABLE "DistributionTemplateItem" (
    "id"           TEXT NOT NULL,
    "templateId"   TEXT NOT NULL,
    "medicineId"   TEXT NOT NULL,
    "quantity"     INTEGER NOT NULL DEFAULT 1,
    "batchNumber"  TEXT NOT NULL,
    "expiryDate"   TIMESTAMP(3) NOT NULL,
    "receivedDate" TIMESTAMP(3),
    "supplier"     TEXT,
    "sortOrder"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributionTemplateItem_pkey" PRIMARY KEY ("id")
);

-- One row per template × station applied.
CREATE TABLE "Distribution" (
    "id"          TEXT NOT NULL,
    "templateId"  TEXT NOT NULL,
    "stationId"   TEXT NOT NULL,
    "appliedById" TEXT NOT NULL,
    "appliedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Distribution_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "DistributionTemplate_isActive_idx" ON "DistributionTemplate"("isActive");
CREATE INDEX "DistributionTemplate_updatedAt_idx" ON "DistributionTemplate"("updatedAt");
CREATE INDEX "DistributionTemplateItem_templateId_idx" ON "DistributionTemplateItem"("templateId");
CREATE INDEX "DistributionTemplateItem_medicineId_idx" ON "DistributionTemplateItem"("medicineId");
CREATE UNIQUE INDEX "DistributionTemplateItem_templateId_sortOrder_key" ON "DistributionTemplateItem"("templateId", "sortOrder");
CREATE INDEX "Distribution_templateId_idx" ON "Distribution"("templateId");
CREATE INDEX "Distribution_stationId_idx" ON "Distribution"("stationId");
CREATE INDEX "Distribution_appliedById_idx" ON "Distribution"("appliedById");
CREATE INDEX "Distribution_appliedAt_idx" ON "Distribution"("appliedAt");

-- Foreign keys
ALTER TABLE "DistributionTemplateItem" ADD CONSTRAINT "DistributionTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DistributionTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DistributionTemplateItem" ADD CONSTRAINT "DistributionTemplateItem_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DistributionTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Distribution" ADD CONSTRAINT "Distribution_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New inventory transaction type for admin distributions.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'DISTRIBUTION';