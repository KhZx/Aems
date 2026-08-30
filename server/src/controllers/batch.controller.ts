import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import * as batchService from '../services/batch.service.js';

const actorId = (req: Request) => req.authUser!.id;

/** GET /api/batches */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const data = await batchService.listBatches({
    medicineId: req.query.medicineId as string | undefined,
    activeOnly: req.query.activeOnly !== 'false',
    page: (req.query.page as never) ?? 1,
    pageSize: (req.query.pageSize as never) ?? 50,
  });
  res.json({ success: true, data });
});

/** POST /api/batches */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const meta = requestMeta(req);
  const batch = await batchService.createBatch(actorId(req), req.body, meta);
  res.status(201).json({ success: true, data: batch });
});
