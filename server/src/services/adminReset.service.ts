import { prisma } from '../config/prisma.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

export interface StationsMedicinesResetResult {
  deleted: Record<'stations' | 'ambulances' | 'medicines' | 'batches' | 'inventory' | 'transfers' | 'inspections' | 'supplyRequests' | 'distributions' | 'shiftNotes' | 'handovers' | 'reports', number>;
  usersKept: number;
}

/**
 * Clears stations (units), ambulances, medicines and everything that depends on
 * them: stock, batches, transfers, inspections, supply requests, distributions,
 * shift notes, handovers and reports. User accounts are kept. Audit rows are
 * kept too; their station/vehicle links are detached so the trail survives.
 * All of it runs in one transaction, so a failure leaves the data untouched.
 */
export async function resetStationsAndMedicines(
  actorId: string,
  meta: AuditEntryInput = {},
): Promise<StationsMedicinesResetResult> {
  return prisma.$transaction(
    async (tx) => {
      const deleted = {
        stations: await tx.station.count(),
        ambulances: await tx.ambulance.count(),
        medicines: await tx.medicine.count(),
        batches: await tx.medicineBatch.count(),
        inventory: await tx.inventory.count(),
        transfers: await tx.transfer.count(),
        inspections: await tx.inspection.count(),
        supplyRequests: await tx.supplyRequest.count(),
        distributions: await tx.distribution.count(),
        shiftNotes: await tx.shiftNote.count(),
        handovers: await tx.handover.count(),
        reports: await tx.report.count(),
      };
      const usersKept = await tx.user.count();

      // Children first. Inspection items reference inventory and supply requests,
      // so they go before both; their reason rows cascade.
      await tx.inspectionItem.deleteMany({});
      await tx.inspection.deleteMany({});
      await tx.supplyRequest.deleteMany({});
      await tx.distribution.deleteMany({});
      await tx.distributionTemplate.deleteMany({}); // cascades template items and batches
      await tx.inventoryTransaction.deleteMany({});
      await tx.transfer.deleteMany({});
      await tx.inventory.deleteMany({});
      await tx.medicineBatch.deleteMany({});
      await tx.medicine.deleteMany({});
      await tx.report.deleteMany({});

      // Keep audit history; detach the links that would block the deletes.
      await tx.auditLog.updateMany({ where: { ambulanceId: { not: null } }, data: { ambulanceId: null } });
      await tx.auditLog.updateMany({ where: { stationId: { not: null } }, data: { stationId: null } });

      // Users stay; only their unit assignment is cleared.
      await tx.user.updateMany({ where: { stationId: { not: null } }, data: { stationId: null } });

      await tx.ambulance.deleteMany({});
      await tx.station.deleteMany({}); // cascades managed stations, duty rosters, shift notes, handovers

      await createAudit(tx, {
        userId: actorId,
        action: 'RESET_STATIONS_MEDICINES',
        entityType: 'System',
        metadata: { deleted, usersKept },
        ...meta,
      });

      return { deleted, usersKept };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
