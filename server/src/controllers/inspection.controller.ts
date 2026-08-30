import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import * as inspectionService from '../services/inspection.service.js';
import * as scopeService from '../services/scope.service.js';

const user = (req: Request) => req.authUser!;

/** POST /api/inspections */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireAmbulanceAccess(me, req.body.ambulanceId, managed);

  const meta = requestMeta(req);
  const data = await inspectionService.createInspection({
    ambulanceId: req.body.ambulanceId,
    notes: req.body.notes,
    items: req.body.items,
    performedById: me.id,
    meta,
  });

  res.status(201).json({ success: true, data });
});

/** GET /api/inspections */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const accessible = await scopeService.accessibleStationIds(me);

  const data = await inspectionService.listInspections({
    ambulanceId: req.query.ambulanceId as string | undefined,
    stationIds: me.role === 'ADMIN' ? undefined : accessible,
    page: (req.query.page as never) ?? 1,
    pageSize: (req.query.pageSize as never) ?? 50,
  });

  res.json({ success: true, data });
});

/** GET /api/inspections/:id */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const inspection = await inspectionService.getInspection(reqParam(req, 'id'));
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireAmbulanceAccess(me, inspection.ambulance.id, managed);
  res.json({ success: true, data: inspection });
});
