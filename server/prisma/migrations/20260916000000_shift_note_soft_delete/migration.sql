-- Shift notes are no longer hard-deleted.
-- A removal now stamps `deletedAt`/`deletedById`/`deleteReason` so the content
-- survives, the audit trail keeps the who/why, and a supervisor can restore it.

-- AlterTable
ALTER TABLE "ShiftNote" ADD COLUMN     "deletedAt" TIMESTAMP(3),
                            ADD COLUMN     "deletedById" TEXT,
                            ADD COLUMN     "deleteReason" TEXT;

-- Foreign key for the "who removed it" trail
ALTER TABLE "ShiftNote" ADD CONSTRAINT "ShiftNote_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for filtering the (small) set of removed notes
CREATE INDEX "ShiftNote_deletedAt_idx" ON "ShiftNote"("deletedAt");