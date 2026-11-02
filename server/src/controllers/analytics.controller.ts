import type { Request, Response } from 'express';
import { prisma } from '../config/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import { buildAnalytics } from '../services/analytics.service.js';
import * as scopeService from '../services/scope.service.js';

const DAY_MS = 86_400_000;
const isDateOnly = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * GET /api/reports/analytics — the Reports Dashboard rollup.
 *
 * ADMIN sees the whole fleet; SUPERVISOR is scoped to managed stations. An
 * explicit `stationId` / `ambulanceId` is checked against that scope before
 * any aggregation runs.
 */
export const analytics = asyncHandler(async (req: Request, res: Response) => {
  const me = req.authUser!;
  const stationId = req.query.stationId as string | undefined;
  const ambulanceId = req.query.ambulanceId as string | undefined;
  const managed = await scopeService.managedStationIds(me.id);

  let stationIds: string[] | undefined;
  if (stationId) {
    await scopeService.requireStationAccess(me, stationId, managed);
    stationIds = [stationId];
  } else if (me.role === 'ADMIN') {
    stationIds = undefined;
  } else {
    stationIds = await scopeService.accessibleStationIds(me);
  }

  if (ambulanceId) {
    const ambulance = await prisma.ambulance.findUnique({
      where: { id: ambulanceId },
      select: { stationId: true },
    });
    if (!ambulance) throw AppError.notFound('Ambulance not found');
    await scopeService.requireStationAccess(me, ambulance.stationId, managed);
  }

  const now = Date.now();
  const toRaw = req.query.to as string | undefined;
  const to = toRaw
    ? isDateOnly(toRaw)
      ? new Date(new Date(`${toRaw}T00:00:00.000Z`).getTime() + DAY_MS) // inclusive end-of-day
      : new Date(toRaw)
    : new Date(now);

  const days = Number(req.query.days ?? 30);
  const fromRaw = req.query.from as string | undefined;
  const from = fromRaw
    ? isDateOnly(fromRaw)
      ? new Date(`${fromRaw}T00:00:00.000Z`)
      : new Date(fromRaw)
    : new Date(to.getTime() - days * DAY_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw AppError.badRequest('Invalid period');
  }
  if (from >= to) {
    throw AppError.badRequest('`from` must be before `to`');
  }

  const data = await buildAnalytics({ stationIds, ambulanceId, from, to, days });
  res.json({ success: true, data });
});
