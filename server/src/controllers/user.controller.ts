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

/** PUT /api/auth/me/managed-stations — supervisor self-service unit list. */
export const updateMyManagedStations = asyncHandler(async (req: Request, res: Response) => {
  const me = req.authUser!;
  if (me.role !== 'SUPERVISOR') {
    throw AppError.forbidden('Only supervisors can manage their station list');
  }
  const managedStations = await userService.setMyManagedStations(me.id, req.body.stationCodes);
  res.json({ success: true, data: { managedStations } });
});
