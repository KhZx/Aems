import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import {
  applyTemplate,
  createTemplate,
  deleteTemplate,
  listDistributions,
  listTemplates,
  updateTemplate,
} from '../services/distribution.service.js';

const actor = (req: Request) => req.authUser!;

/** GET /api/distributions/templates */
export const templates = asyncHandler(async (_req: Request, res: Response) => {
  const data = await listTemplates();
  res.json({ success: true, data });
});

/** POST /api/distributions/templates */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const template = await createTemplate(actor(req).id, req.body, requestMeta(req));
  res.status(201).json({ success: true, data: template });
});

/** PATCH /api/distributions/templates/:id */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const template = await updateTemplate(actor(req).id, reqParam(req, 'id'), req.body, requestMeta(req));
  res.json({ success: true, data: template });
});

/** DELETE /api/distributions/templates/:id */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const result = await deleteTemplate(actor(req).id, reqParam(req, 'id'), requestMeta(req));
  res.json({ success: true, data: result });
});

/** POST /api/distributions/apply */
export const apply = asyncHandler(async (req: Request, res: Response) => {
  const result = await applyTemplate(actor(req).id, req.body.templateId, req.body.stationIds, requestMeta(req));
  res.json({ success: true, data: result });
});

/** GET /api/distributions */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await listDistributions({
    templateId: req.query.templateId as string | undefined,
    stationId: req.query.stationId as string | undefined,
    page: req.query.page as unknown as number | undefined,
    pageSize: req.query.pageSize as unknown as number | undefined,
  });
  res.json({ success: true, data: result });
});