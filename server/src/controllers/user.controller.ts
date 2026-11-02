import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import { AppError } from '../utils/AppError.js';
import * as userService from '../services/user.service.js';

const actor = (req: Request) => req.authUser!.id;

/** GET /api/users — list users (admin/supervisor). */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const data = await userService.listUsers({
    status: req.query.status as never,
    role: req.query.role as never,
    search: req.query.search as string | undefined,
    stationId: req.query.stationId as string | undefined,
    page: (req.query.page as never) ?? 1,
    pageSize: (req.query.pageSize as never) ?? 50,
  });
  res.json({ success: true, data });
});

/** GET /api/users/:id */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.getUserById(reqParam(req, 'id'));
  res.json({ success: true, data: user });
});

/** POST /api/users/:id/approve */
export const approve = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const user = await userService.approveUser(actor(req), reqParam(req, 'id'), req.body, meta);
  res.json({ success: true, data: user });
});

/** POST /api/users/:id/reject */
export const reject = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const user = await userService.rejectUser(actor(req), reqParam(req, 'id'), meta);
  res.json({ success: true, data: user });
});

/** POST /api/users/:id/status */
export const setStatus = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const user = await userService.setUserStatus(actor(req), reqParam(req, 'id'), req.body.status, meta);
  res.json({ success: true, data: user });
});

/** POST /api/users/:id/role */
export const changeRole = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const user = await userService.changeRole(actor(req), reqParam(req, 'id'), req.body, meta);
  res.json({ success: true, data: user });
});

/** PUT /api/users/:id/password — admin sets a new password for another user. */
export const setPassword = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const result = await userService.setUserPassword(actor(req), reqParam(req, 'id'), req.body.password, meta);
  res.json({ success: true, data: result });
});

/** DELETE /api/users/:id */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const id = reqParam(req, 'id');
  if (id === actor(req)) {
    throw AppError.badRequest('You cannot delete your own account');
  }
  const meta = requestMeta(req);
  await userService.deleteUser(actor(req), id, meta);
  res.status(204).send();
});

/**
 * PUT /api/users/:id/managed-stations — administrator assigns the units a
 * supervisor is responsible for (station:assign, admin-only). To change their
 * own list a supervisor uses PUT /api/me/managed-stations instead.
 */
export const setManagedStations = asyncHandler(async (req: Request, res: Response) => {
  const targetId = reqParam(req, 'id');
  const managedStations = await userService.setManagedStationsForUser(actor(req), targetId, req.body.stationCodes, requestMeta(req));
  res.json({ success: true, data: { managedStations } });
});

/**
 * PUT /api/me/managed-stations — a supervisor edits the units on their OWN
 * managed list (station:selfAssign). The target is always the caller, so this
 * cannot be used to grant anyone else access.
 */
export const setMyManagedStations = asyncHandler(async (req: Request, res: Response) => {
  const me = actor(req);
  const managedStations = await userService.setManagedStationsForUser(me, me, req.body.stationCodes, requestMeta(req));
  res.json({ success: true, data: { managedStations } });
});

/** PUT /api/me/supervisor-zone — supervisors may update only their own zone. */
export const updateMySupervisorZone = asyncHandler(async (req: Request, res: Response) => {
  if (req.authUser?.role !== 'SUPERVISOR') {
    throw AppError.forbidden('Only supervisors can update a supervisor zone');
  }
  const user = await userService.updateMySupervisorZone(actor(req), req.body.supervisorZone, requestMeta(req));
  res.json({ success: true, data: user });
});

/** PUT /api/users/:id/units — replaces the user's roster allow-list. */
export const setUnits = asyncHandler(async (req: Request, res: Response) => {
  const targetId = reqParam(req, 'id');
  const units = await userService.setUserUnits(actor(req), targetId, req.body.stationIds, requestMeta(req));
  res.json({ success: true, data: { units } });
});
