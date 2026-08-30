import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import * as handoverService from '../services/handover.service.js';
import * as scopeService from '../services/scope.service.js';

const user = (req: Request) => req.authUser!;

/** POST /api/handovers */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireStationAccess(me, req.body.stationId, managed);

  const data = await handoverService.createHandover({
    stationId: req.body.stationId,
    outgoing: req.body.outgoing,
    createdById: me.id,
    meta: requestMeta(req),
  });

  res.status(201).json({ success: true, data });
});

/** POST /api/handovers/:id/acknowledge */
export const acknowledge = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const handover = await handoverService.getHandover(reqParam(req, 'id'));
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireStationAccess(me, handover.stationId, managed);

  const data = await handoverService.acknowledgeHandover({
    handoverId: handover.id,
    incomingName: req.body.incoming.paramedicName,
    incomingEmpId: req.body.incoming.paramedicId,
    incomingNotes: req.body.incoming.notes,
    acknowledgedById: me.id,
    meta: requestMeta(req),
  });

  res.json({ success: true, data });
});

/** GET /api/handovers */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const stationId = req.query.stationId as string | undefined;
  const page = (req.query.page as never) ?? 1;
  const pageSize = (req.query.pageSize as never) ?? 50;

  let data;
  if (stationId) {
    const managed = await scopeService.managedStationIds(me.id);
    await scopeService.requireStationAccess(me, stationId, managed);
    data = await handoverService.listHandovers({ stationIds: [stationId], page, pageSize });
  } else {
    const accessible = await scopeService.accessibleStationIds(me);
    data = await handoverService.listHandovers({
      stationIds: me.role === 'ADMIN' ? undefined : accessible,
      page,
      pageSize,
    });
  }

  res.json({ success: true, data });
});
