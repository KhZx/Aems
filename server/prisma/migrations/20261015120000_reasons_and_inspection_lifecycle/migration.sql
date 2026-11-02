-- Structured reason catalog + free-form inspection lifecycle + supply-request
-- fulfilment/arrival trail. Written to be data-safe on populated databases.

-- CreateEnum
CREATE TYPE "InspectionItemCondition" AS ENUM ('OK', 'MISSING', 'DAMAGED', 'EXPIRED', 'UNUSABLE', 'EXTRA', 'NOT_CHECKED');

-- CreateEnum
CREATE TYPE "StockReasonFamily" AS ENUM ('CONSUMPTION', 'EXPIRY', 'DAMAGE', 'LOSS', 'PROCESS', 'ACCOUNTABILITY', 'OTHER');

-- CreateEnum
CREATE TYPE "StockReasonEffect" AS ENUM ('LOSS', 'RELOCATION', 'STATUS_HOLD', 'CORRECTION');

-- CreateEnum
CREATE TYPE "StockReasonItemType" AS ENUM ('MEDICATION', 'EQUIPMENT');

-- CreateEnum
CREATE TYPE "StockAction" AS ENUM ('USE', 'DELETE', 'DAMAGE', 'EXPIRE', 'TRANSFER', 'ADJUST', 'RETURN', 'INSPECTION');

-- AlterEnum: InspectionStatus -> DRAFT/COMPLETED/ACKNOWLEDGED/VOID.
-- Rebuilt in a single transactional pass: adding enum values and using them in
-- the same transaction is unsafe, and explicit BEGIN/COMMIT would break
-- Prisma's atomic migration boundary.
ALTER TABLE "Inspection" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "InspectionStatus_new" AS ENUM ('DRAFT', 'COMPLETED', 'ACKNOWLEDGED', 'VOID');
ALTER TABLE "Inspection" ALTER COLUMN "status" TYPE "InspectionStatus_new"
  USING (
    CASE "status"::text
      WHEN 'PENDING' THEN 'DRAFT'
      WHEN 'CANCELLED' THEN 'VOID'
      ELSE "status"::text
    END
  )::"InspectionStatus_new";
ALTER TYPE "InspectionStatus" RENAME TO "InspectionStatus_old";
ALTER TYPE "InspectionStatus_new" RENAME TO "InspectionStatus";
DROP TYPE "InspectionStatus_old";
ALTER TABLE "Inspection" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- AlterEnum
ALTER TYPE "SupplyRequestStatus" ADD VALUE IF NOT EXISTS 'DISPATCHED';
ALTER TYPE "SupplyRequestStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
ALTER TYPE "SupplyRequestStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE "SupplyRequestStatus" ADD VALUE IF NOT EXISTS 'CLOSED';

-- AlterTable (Inspection). updatedAt is added with a temporary default so it is
-- safe on populated tables, then the default is dropped to match the schema.
ALTER TABLE "Inspection" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "correctionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "countedItems" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewNotes" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "shiftCode" TEXT,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "totalItems" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "voidReason" TEXT;
ALTER TABLE "Inspection" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable (InspectionItem)
ALTER TABLE "InspectionItem" ADD COLUMN     "condition" "InspectionItemCondition" NOT NULL DEFAULT 'OK',
ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "requestId" TEXT;

-- AlterTable (InventoryTransaction): structured reason code for stock actions.
ALTER TABLE "InventoryTransaction" ADD COLUMN "reasonCode" TEXT;

-- AlterTable (SupplyRequest)
ALTER TABLE "SupplyRequest" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "dispatchedById" TEXT,
ADD COLUMN     "expectedArrivalAt" TIMESTAMP(3),
ADD COLUMN     "inspectionId" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "receivedById" TEXT,
ADD COLUMN     "receivedQuantity" INTEGER;

-- CreateTable
CREATE TABLE "StockReason" (
    "code" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelAr" TEXT NOT NULL,
    "family" "StockReasonFamily" NOT NULL,
    "effect" "StockReasonEffect" NOT NULL DEFAULT 'LOSS',
    "itemTypes" "StockReasonItemType"[],
    "actions" "StockAction"[],
    "requiresNote" BOOLEAN NOT NULL DEFAULT false,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockReason_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "StockReason_family_idx" ON "StockReason"("family");
CREATE INDEX "StockReason_isActive_idx" ON "StockReason"("isActive");
CREATE INDEX "Inspection_status_idx" ON "Inspection"("status");
CREATE INDEX "Inspection_reviewedById_idx" ON "Inspection"("reviewedById");
CREATE INDEX "InspectionItem_reasonCode_idx" ON "InspectionItem"("reasonCode");
CREATE INDEX "InventoryTransaction_reasonCode_idx" ON "InventoryTransaction"("reasonCode");
CREATE INDEX "SupplyRequest_inspectionId_idx" ON "SupplyRequest"("inspectionId");

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InspectionItem" ADD CONSTRAINT "InspectionItem_reasonCode_fkey" FOREIGN KEY ("reasonCode") REFERENCES "StockReason"("code") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InspectionItem" ADD CONSTRAINT "InspectionItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupplyRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "MedicineBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
