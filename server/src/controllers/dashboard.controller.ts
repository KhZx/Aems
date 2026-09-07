import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/prisma.js';

// Days before expiry a batch is considered "critical" (amber) / "warning" (yellow).
const WARNING_DAYS = 90;

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
    recentLogs,
    // ── Inventory aggregates computed in the database (avoids shipping every
    // row to Node just to sum it). ─────────────────────────────────────
    totalUnits,
    expiredUnits,
    warningUnits,
    lowStockUnits,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'PENDING' } }),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { status: 'SUSPENDED' } }),
    prisma.station.count(),
    prisma.ambulance.count(),
    prisma.medicine.count({ where: { isActive: true, deletedAt: null } }),
    prisma.medicineBatch.count({ where: { isActive: true, deletedAt: null } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.inventory.aggregate({
      where: { quantity: { gt: 0 }, batch: { deletedAt: null, medicine: { deletedAt: null } } },
      _sum: { quantity: true },
    }).then((r) => r._sum.quantity ?? 0),
    prisma.inventory.aggregate({
      where: {
        quantity: { gt: 0 },
        batch: { deletedAt: null, medicine: { deletedAt: null }, expiryDate: { lt: new Date() } },
      },
      _sum: { quantity: true },
    }).then((r) => r._sum.quantity ?? 0),
    prisma.inventory.aggregate({
      where: {
        quantity: { gt: 0 },
        batch: {
          deletedAt: null,
          medicine: { deletedAt: null },
          expiryDate: {
            gte: new Date(),
            lt: new Date(Date.now() + WARNING_DAYS * 24 * 60 * 60 * 1000),
          },
        },
      },
      _sum: { quantity: true },
    }).then((r) => r._sum.quantity ?? 0),
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(i."quantity"), 0) AS total
      FROM "Inventory" i
      JOIN "MedicineBatch" b ON b."id" = i."batchId"
      JOIN "Medicine" m ON m."id" = b."medicineId"
      WHERE i."quantity" > 0
        AND i."deletedAt" IS NULL
        AND b."deletedAt" IS NULL
        AND b."isActive" = true
        AND m."deletedAt" IS NULL
        AND m."isActive" = true
        AND m."minimumStock" > 0
        AND i."quantity" < m."minimumStock"
    `.then(([r]) => Number(r?.total ?? 0)),
  ]);

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
