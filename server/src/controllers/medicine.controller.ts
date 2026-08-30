import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import * as medicineService from '../services/medicine.service.js';

const actorId = (req: Request) => req.authUser!.id;

/** GET /api/medicines */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const data = await medicineService.listMedicines({
    search: req.query.search as string | undefined,
    category: req.query.category as never,
    includeInactive: req.query.includeInactive === 'true',
    page: (req.query.page as never) ?? 1,
    pageSize: (req.query.pageSize as never) ?? 50,
  });
  res.json({ success: true, data });
});

/** GET /api/medicines/:id */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const medicine = await medicineService.getMedicineById(reqParam(req, 'id'));
  res.json({ success: true, data: medicine });
});

/** POST /api/medicines */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const medicine = await medicineService.createMedicine(actorId(req), req.body, meta);
  res.status(201).json({ success: true, data: medicine });
});

/** PATCH /api/medicines/:id */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const medicine = await medicineService.updateMedicine(actorId(req), reqParam(req, 'id'), req.body, meta);
  res.json({ success: true, data: medicine });
});

/** DELETE /api/medicines/:id */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const result = await medicineService.deleteMedicine(actorId(req), reqParam(req, 'id'), meta);
  res.json({ success: true, data: result });
});
