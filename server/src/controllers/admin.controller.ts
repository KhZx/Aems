import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { AppError } from '../utils/AppError.js';
import * as adminResetService from '../services/adminReset.service.js';

/** POST /api/admin/reset-stations-medicines — admin only, typed confirmation, audited. */
export const resetStationsMedicines = asyncHandler(async (req: Request, res: Response) => {
  const me = req.authUser!;
  if (me.role !== 'ADMIN') throw AppError.forbidden('Only administrators can reset station and medicine data');
  const data = await adminResetService.resetStationsAndMedicines(me.id, requestMeta(req));
  res.json({ success: true, data });
});
