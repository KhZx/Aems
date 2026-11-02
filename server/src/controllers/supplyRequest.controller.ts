import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import {
  cancelSupplyRequest,
  closeSupplyRequest,
  confirmSupplyRequest,
  createSupplyRequest,
  dispatchSupplyRequest,
  listSupplyRequests,
  receiveSupplyRequest,
  reviewSupplyRequest,
} from '../services/supplyRequest.service.js';

const actor = (req: Request) => req.authUser!;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const result = await listSupplyRequests(actor(req), {
    status: req.query.status as never,
    mine: req.query.mine as unknown as boolean | undefined,
    ambulanceId: req.query.ambulanceId as string | undefined,
    page: req.query.page as unknown as number | undefined,
    pageSize: req.query.pageSize as unknown as number | undefined,
  });
  res.json({ success: true, data: result });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const request = await createSupplyRequest(actor(req), req.body, requestMeta(req));
  res.status(201).json({ success: true, data: request });
});

export const review = asyncHandler(async (req: Request, res: Response) => {
  const request = await reviewSupplyRequest(actor(req), reqParam(req, 'id'), req.body.status, requestMeta(req));
  res.json({ success: true, data: request });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const request = await cancelSupplyRequest(actor(req), reqParam(req, 'id'), requestMeta(req));
  res.json({ success: true, data: request });
});

export const dispatch = asyncHandler(async (req: Request, res: Response) => {
  const request = await dispatchSupplyRequest(actor(req), reqParam(req, 'id'), req.body, requestMeta(req));
  res.json({ success: true, data: request });
});

export const receive = asyncHandler(async (req: Request, res: Response) => {
  const request = await receiveSupplyRequest(actor(req), reqParam(req, 'id'), req.body, requestMeta(req));
  res.json({ success: true, data: request });
});

export const confirm = asyncHandler(async (req: Request, res: Response) => {
  const request = await confirmSupplyRequest(actor(req), reqParam(req, 'id'), requestMeta(req));
  res.json({ success: true, data: request });
});

export const close = asyncHandler(async (req: Request, res: Response) => {
  const request = await closeSupplyRequest(actor(req), reqParam(req, 'id'), requestMeta(req));
  res.json({ success: true, data: request });
});