/*
  Warnings:

  - You are about to sync the database schema with the Prisma schema.
  - This migration closes the drift between the initial migration and the
    current schema (soft-delete columns, medicine metadata, shift notes,
    handovers, supply requests and reports).

*/
-- CreateEnum
CREATE TYPE "NotePriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "HandoverStatus" AS ENUM ('SUBMITTED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "SupplyRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Inventory" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "Medicine" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "location" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "serialNumber" TEXT,
ADD COLUMN     "technicalNotes" TEXT;

-- AlterTable
ALTER TABLE "MedicineBatch" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SupplyRequest" (
    "id" TEXT NOT NULL,
    "ambulanceId" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "SupplyRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftNote" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" "NotePriority" NOT NULL DEFAULT 'MEDIUM',
    "author" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handover" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "status" "HandoverStatus" NOT NULL DEFAULT 'SUBMITTED',
    "outgoingName" TEXT NOT NULL,
    "outgoingEmpId" TEXT,
    "outgoingShift" TEXT,
    "patientsCount" INTEGER NOT NULL DEFAULT 0,
    "equipStatus" TEXT,
    "pendingIssues" TEXT,
    "medicationsUsed" TEXT,
    "notes" TEXT,
    "incomingName" TEXT,
    "incomingEmpId" TEXT,
    "incomingNotes" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Handover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "stationId" TEXT,
    "title" TEXT,
    "reportText" TEXT NOT NULL,
    "data" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplyRequest_status_idx" ON "SupplyRequest"("status");

-- CreateIndex
CREATE INDEX "SupplyRequest_ambulanceId_idx" ON "SupplyRequest"("ambulanceId");

-- CreateIndex
CREATE INDEX "SupplyRequest_medicineId_idx" ON "SupplyRequest"("medicineId");

-- CreateIndex
CREATE INDEX "SupplyRequest_createdById_idx" ON "SupplyRequest"("createdById");

-- CreateIndex
CREATE INDEX "SupplyRequest_createdAt_idx" ON "SupplyRequest"("createdAt");

-- CreateIndex
CREATE INDEX "ShiftNote_stationId_idx" ON "ShiftNote"("stationId");

-- CreateIndex
CREATE INDEX "ShiftNote_priority_idx" ON "ShiftNote"("priority");

-- CreateIndex
CREATE INDEX "ShiftNote_createdAt_idx" ON "ShiftNote"("createdAt");

-- CreateIndex
CREATE INDEX "Handover_stationId_idx" ON "Handover"("stationId");

-- CreateIndex
CREATE INDEX "Handover_status_idx" ON "Handover"("status");

-- CreateIndex
CREATE INDEX "Handover_createdAt_idx" ON "Handover"("createdAt");

-- CreateIndex
CREATE INDEX "Report_stationId_idx" ON "Report"("stationId");

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");

-- CreateIndex
CREATE INDEX "Inventory_deletedAt_idx" ON "Inventory"("deletedAt");

-- CreateIndex
CREATE INDEX "Medicine_deletedAt_idx" ON "Medicine"("deletedAt");

-- CreateIndex
CREATE INDEX "MedicineBatch_deletedAt_idx" ON "MedicineBatch"("deletedAt");

-- AddForeignKey
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_ambulanceId_fkey" FOREIGN KEY ("ambulanceId") REFERENCES "Ambulance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyRequest" ADD CONSTRAINT "SupplyRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftNote" ADD CONSTRAINT "ShiftNote_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftNote" ADD CONSTRAINT "ShiftNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
