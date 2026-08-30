import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/prisma.js';
import { classifyExpiry } from '../utils/fefo.js';

/** GET /api/dashboard/overview — aggregate stats (admin/supervisor). */
export const overview = asyncHandler(async (_req: Request, res: Response) => {
  const [
    totalUsers,
    pendingUsers,
    activeUsers,
    suspendedUsers,
    totalStations,
    totalAmbulances,
    totalMedicines,
    totalBatches,
    inventoryRows,
    recentLogs,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'PENDING' } }),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { status: 'SUSPENDED' } }),
    prisma.station.count(),
    prisma.ambulance.count(),
    prisma.medicine.count({ where: { isActive: true, deletedAt: null } }),
    prisma.medicineBatch.count({ where: { isActive: true, deletedAt: null } }),
    prisma.inventory.findMany({
      where: { quantity: { gt: 0 }, batch: { deletedAt: null, medicine: { deletedAt: null } } },
      select: {
        quantity: true,
        batch: { select: { medicineId: true, expiryDate: true, medicine: { select: { minimumStock: true, maximumStock: true } } } },
      },
    }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  const totalUnits = inventoryRows.reduce((s, r) => s + r.quantity, 0);
  const expiredUnits = inventoryRows
    .filter((r) => classifyExpiry(r.batch.expiryDate) === 'EXPIRED')
    .reduce((s, r) => s + r.quantity, 0);
  const warningUnits = inventoryRows
    .filter((r) => {
      const s = classifyExpiry(r.batch.expiryDate);
      return s === 'CRITICAL' || s === 'WARNING';
    })
    .reduce((s, r) => s + r.quantity, 0);

  // Low-stock rows: quantity below the medicine's minimum.
  const lowStockRows = inventoryRows.filter(
    (r) => r.batch.medicine.minimumStock > 0 && r.quantity < r.batch.medicine.minimumStock,
  );
  const lowStockUnits = lowStockRows.reduce((s, r) => s + r.quantity, 0);

  res.json({
    success: true,
    data: {
      users: { total: totalUsers, pending: pendingUsers, active: activeUsers, suspended: suspendedUsers },
      stations: totalStations,
      ambulances: totalAmbulances,
      medicines: totalMedicines,
      batches: totalBatches,
      inventory: {
        totalUnits,
        expiredUnits,
        warningUnits,
        lowStockUnits,
      },
      recentLogs,
    },
  });
});
