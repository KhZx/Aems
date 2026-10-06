-- Duty-unit switching: the roster allow-list of units (stations) a crew
-- member may hold as their active unit. `User.stationId` is the ACTIVE unit.
-- CreateTable
CREATE TABLE "DutyRoster" (
    "userId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DutyRoster_pkey" PRIMARY KEY ("userId","stationId")
);

-- CreateIndex
CREATE INDEX "DutyRoster_stationId_idx" ON "DutyRoster"("stationId");

-- AddForeignKey
ALTER TABLE "DutyRoster" ADD CONSTRAINT "DutyRoster_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DutyRoster" ADD CONSTRAINT "DutyRoster_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every active crew member starts on their home unit, with that
-- unit on their roster.
INSERT INTO "DutyRoster" ("userId", "stationId")
SELECT u.id, u."stationId"
FROM "User" u
WHERE u."stationId" IS NOT NULL
  AND u."role" IN ('PARAMEDIC','EMT','TECHNICIAN','DOCTOR')
  AND u."status" = 'ACTIVE'
ON CONFLICT DO NOTHING;
