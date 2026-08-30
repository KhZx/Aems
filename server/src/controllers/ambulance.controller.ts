import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import * as ambulanceService from '../services/ambulance.service.js';
import * as scopeService from '../services/scope.service.js';

const actor = (req: Request) => req.authUser!;

/** GET /api/ambulances */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const user = actor(req);
  const all = await ambulanceService.listAmbulances({
    stationCode: req.query.stationCode as string | undefined,
    search: req.query.search as string | undefined,
  });

  // Scope ambulances to what the user may access.
  const managed = await scopeService.managedStationIds(user.id);
  const accessible = await scopeService.accessibleStationIds(user);

  const filtered = user.role === 'ADMIN'
    ? all
    : accessible.length === 0
      ? []
      : all.filter((a) => accessible.includes(a.stationId));

  res.json({ success: true, data: filtered, meta: { managedStations: [...managed] } });
});

/** GET /api/ambulances/:id — includes inventory. */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const user = actor(req);
  const managed = await scopeService.managedStationIds(user.id);
  await scopeService.requireAmbulanceAccess(user, reqParam(req, 'id'), managed);
  const ambulance = await ambulanceService.getAmbulanceById(reqParam(req, 'id'));
  res.json({ success: true, data: ambulance });
});

/** POST /api/ambulances */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const ambulance = await ambulanceService.createAmbulance(actor(req).id, req.body, meta);
  res.status(201).json({ success: true, data: ambulance });
});

/** PATCH /api/ambulances/:id */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const ambulance = await ambulanceService.updateAmbulance(actor(req).id, reqParam(req, 'id'), req.body, meta);
  res.json({ success: true, data: ambulance });
});

/** DELETE /api/ambulances/:id */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  await ambulanceService.deleteAmbulance(actor(req).id, reqParam(req, 'id'), meta);
  res.status(204).send();
});
