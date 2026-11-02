import { prisma } from '../config/prisma.js';
import { logger } from '../utils/logger.js';
import { notifyExpiryDigest, resolveStaleExpiryDigests } from './notification.service.js';

const EXPIRY_NOTICE_DAYS = 7;
const EXPIRY_SCAN_MAX = 10_000;

/** Daily-ish digest scan. It emits one grouped alert per station and risk band,
 * then deduplicates that exact stock set across subsequent scans. */
export async function runExpiryNotificationSweep(now = new Date()) {
  const sevenDays = new Date(now.getTime() + EXPIRY_NOTICE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.inventory.findMany({
    where: {
      deletedAt: null,
      quantity: { gt: 0 },
      batch: {
        isActive: true,
        deletedAt: null,
        medicine: { isActive: true, deletedAt: null },
      },
      OR: [
        { overrideExpiryDate: { lte: sevenDays } },
        { overrideExpiryDate: null, batch: { expiryDate: { lte: sevenDays } } },
      ],
    },
    orderBy: [{ ambulanceId: 'asc' }, { id: 'asc' }],
    take: EXPIRY_SCAN_MAX,
    select: {
      id: true,
      quantity: true,
      overrideExpiryDate: true,
      ambulance: {
        select: {
          id: true,
          vehicleNumber: true,
          station: { select: { id: true, code: true, name: true } },
        },
      },
      batch: {
        select: {
          batchNumber: true,
          expiryDate: true,
          medicine: { select: { name: true } },
        },
      },
    },
  });

  type Band = 'WEEK' | 'DAY' | 'EXPIRED';
  const groups = new Map<string, {
    stationId: string;
    stationName: string;
    band: Band;
    items: Array<{ id: string; ambulanceNumber: string; name: string; batchNumber: string; expiryDate: string; quantity: number }>;
  }>();

  for (const row of rows) {
    const expiry = row.overrideExpiryDate ?? row.batch.expiryDate;
    const remaining = expiry.getTime() - now.getTime();
    const band: Band = remaining <= 0 ? 'EXPIRED' : remaining <= 24 * 60 * 60 * 1000 ? 'DAY' : 'WEEK';
    const station = row.ambulance.station;
    const key = `${station.id}:${band}`;
    const group = groups.get(key) ?? {
      stationId: station.id,
      stationName: station.name || station.code,
      band,
      items: [],
    };
    group.items.push({
      id: row.id,
      ambulanceNumber: row.ambulance.vehicleNumber,
      name: row.batch.medicine.name,
      batchNumber: row.batch.batchNumber,
      expiryDate: expiry.toISOString().slice(0, 10),
      quantity: row.quantity,
    });
    groups.set(key, group);
  }

  const activeKeys: string[] = [];
  for (const group of groups.values()) {
    activeKeys.push(await notifyExpiryDigest(group));
  }
  if (rows.length < EXPIRY_SCAN_MAX) await resolveStaleExpiryDigests(activeKeys);
  else logger.warn({ limit: EXPIRY_SCAN_MAX }, 'Expiry notification scan hit its safety limit; stale alerts were retained');

  const resolvedBefore = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const readBefore = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const pruned = await prisma.notification.deleteMany({
    where: {
      OR: [
        { resolvedAt: { lt: resolvedBefore } },
        { readAt: { lt: readBefore }, resolvedAt: null, type: { not: 'STOCK_UNAVAILABLE' } },
      ],
    },
  });
  return { scanned: rows.length, digests: groups.size, pruned: pruned.count };
}
