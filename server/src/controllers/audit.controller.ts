import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listAuditLogs } from '../services/audit.service.js';
import * as scopeService from '../services/scope.service.js';

const user = (req: Request) => req.authUser!;

/** GET /api/audit-logs */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);

  let stationId = req.query.stationId as string | undefined;
  let stationIds: string[] | undefined;
  if (stationId) {
    const managed = await scopeService.managedStationIds(me.id);
    await scopeService.requireStationAccess(me, stationId, managed);
  } else if (me.role !== 'ADMIN') {
    const accessible = await scopeService.accessibleStationIds(me);
    if (accessible.length === 1) {
      stationId = accessible[0];
    } else if (accessible.length > 1) {
      stationIds = accessible;
    } else {
      stationId = '__none__'; // no managed stations → nothing to show
    }
  }

  const data = await listAuditLogs({
    action: req.query.action as string | undefined,
    userId: req.query.userId as string | undefined,
    stationId,
    stationIds,
    ambulanceId: req.query.ambulanceId as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 50,
  });

  res.json({ success: true, data });
});
