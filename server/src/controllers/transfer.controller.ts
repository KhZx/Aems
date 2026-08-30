import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import * as transferService from '../services/transfer.service.js';
import * as scopeService from '../services/scope.service.js';

const user = (req: Request) => req.authUser!;

/** POST /api/inventory/transfer */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const managed = await scopeService.managedStationIds(me.id);

  const source = await transferService.getTransferSource(req.body.sourceInventoryId);
  await scopeService.requireAmbulanceAccess(me, source.ambulanceId, managed);
  await scopeService.requireAmbulanceAccess(me, req.body.destinationAmbulanceId, managed);

  const meta = requestMeta(req);
  const data = await transferService.transferStock({
    sourceInventoryId: req.body.sourceInventoryId,
    destinationAmbulanceId: req.body.destinationAmbulanceId,
    quantity: req.body.quantity,
    notes: req.body.notes,
    performedById: me.id,
    meta,
  });

  res.status(201).json({ success: true, data });
});

/** GET /api/transfers */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const accessible = await scopeService.accessibleStationIds(me);

  const data = await transferService.listTransfers({
    ambulanceId: req.query.ambulanceId as string | undefined,
    stationIds: me.role === 'ADMIN' ? undefined : accessible,
    page: (req.query.page as never) ?? 1,
    pageSize: (req.query.pageSize as never) ?? 50,
  });

  res.json({ success: true, data });
});
