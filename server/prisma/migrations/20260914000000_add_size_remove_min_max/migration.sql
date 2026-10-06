-- AddSizeRemoveMinMax
-- Adds an optional free-text "size" label (e.g. suction tubes "8FG"/"14FG",
-- gloves "M"/"L") and removes the discontinued minimum/maximum stock columns
-- and their check constraints.

-- AlterTable
ALTER TABLE "Medicine" ADD COLUMN "size" TEXT;

-- DropConstraints (the two "maximumStock" checks and the min/max ordering check)
ALTER TABLE "Medicine" DROP CONSTRAINT "Medicine_minimumStock_check";
ALTER TABLE "Medicine" DROP CONSTRAINT "Medicine_maximumStock_check";
ALTER TABLE "Medicine" DROP CONSTRAINT "Medicine_min_max_check";

-- DropColumns
ALTER TABLE "Medicine" ALTER COLUMN "minimumStock" DROP DEFAULT;
ALTER TABLE "Medicine" DROP COLUMN "minimumStock";
ALTER TABLE "Medicine" DROP COLUMN "maximumStock";