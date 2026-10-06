import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import * as dutyService from '../services/duty.service.js';

const user = (req: Request) => req.authUser!;

/** GET /api/me/duty — active unit + roster allow-list for the caller. */
export const state = asyncHandler(async (req: Request, res: Response) => {
  const data = await dutyService.getDutyState(user(req).id);
  res.json({ success: true, data });
});

/** POST /api/me/duty/switch — unlimited switches, reason required, audited. */
export const switchUnit = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const data = await dutyService.switchDutyUnit({
    userId: me.id,
    role: me.role,
    stationId: req.body.stationId,
    reason: req.body.reason,
    meta: requestMeta(req),
  });
  res.json({ success: true, data });
});
