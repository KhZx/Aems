import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import * as reportService from '../services/report.service.js';
import * as scopeService from '../services/scope.service.js';

const user = (req: Request) => req.authUser!;

/** POST /api/reports */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  if (req.body.stationId) {
    const managed = await scopeService.managedStationIds(me.id);
    await scopeService.requireStationAccess(me, req.body.stationId, managed);
  }

  const data = await reportService.createReport({
    stationId: req.body.stationId || null,
    title: req.body.title || null,
    reportText: req.body.reportText,
    data: req.body.data ?? null,
    createdById: me.id,
    meta: requestMeta(req),
  });

  res.status(201).json({ success: true, data });
});

/** GET /api/reports */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const stationId = req.query.stationId as string | undefined;
  const page = (req.query.page as never) ?? 1;
  const pageSize = (req.query.pageSize as never) ?? 50;

  let data;
  if (stationId) {
    const managed = await scopeService.managedStationIds(me.id);
    await scopeService.requireStationAccess(me, stationId, managed);
    data = await reportService.listReports({ stationIds: [stationId], page, pageSize });
  } else {
    const accessible = await scopeService.accessibleStationIds(me);
    data = await reportService.listReports({
      stationIds: me.role === 'ADMIN' ? undefined : accessible,
      page,
      pageSize,
    });
  }

  res.json({ success: true, data });
});
