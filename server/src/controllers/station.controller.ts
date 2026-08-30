import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import * as stationService from '../services/station.service.js';

const actor = (req: Request) => req.authUser!.id;

/** GET /api/public/stations — minimal directory for the signup form. */
export const publicList = asyncHandler(async (_req: Request, res: Response) => {
  const stations = await stationService.listStations({ status: 'ACTIVE' });
  res.json({
    success: true,
    data: stations.map((s) => ({ id: s.id, code: s.code, name: s.name, location: s.location })),
  });
});

/** GET /api/stations */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const stations = await stationService.listStations({
    search: req.query.search as string | undefined,
    status: req.query.status as never,
  });
  res.json({ success: true, data: stations });
});

/** GET /api/stations/code/:code */
export const getByCode = asyncHandler(async (req: Request, res: Response) => {
  const station = await stationService.getStationByCode(reqParam(req, 'code'));
  res.json({ success: true, data: station });
});

/** POST /api/stations */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const station = await stationService.createStation(actor(req), req.body, meta);
  res.status(201).json({ success: true, data: station });
});

/** PATCH /api/stations/:id */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const station = await stationService.updateStation(actor(req), reqParam(req, 'id'), req.body, meta);
  res.json({ success: true, data: station });
});

/** DELETE /api/stations/:id */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  await stationService.deleteStation(actor(req), reqParam(req, 'id'), meta);
  res.status(204).send();
});
