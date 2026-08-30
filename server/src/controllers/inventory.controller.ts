import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import * as inventoryService from '../services/inventory.service.js';
import * as scopeService from '../services/scope.service.js';

const user = (req: Request) => req.authUser!;

/** GET /api/inventory — scoped to the caller's accessible stations. */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const stationId = req.query.stationId as string | undefined;

  let rows;
  if (stationId) {
    const managed = await scopeService.managedStationIds(me.id);
    await scopeService.requireStationAccess(me, stationId, managed);
    rows = await inventoryService.listInventory({
      stationIds: [stationId],
      ambulanceId: req.query.ambulanceId as string | undefined,
      medicineId: req.query.medicineId as string | undefined,
      category: req.query.category as string | undefined,
      search: req.query.search as string | undefined,
      includeEmpty: req.query.includeEmpty === 'true',
    });
  } else {
    const accessible = await scopeService.accessibleStationIds(me);
    rows = await inventoryService.listInventory({
      ambulanceId: req.query.ambulanceId as string | undefined,
      medicineId: req.query.medicineId as string | undefined,
      category: req.query.category as string | undefined,
      search: req.query.search as string | undefined,
      includeEmpty: req.query.includeEmpty === 'true',
      stationIds: me.role === 'ADMIN' ? undefined : accessible,
    });
  }

  res.json({ success: true, data: rows });
});

/** GET /api/inventory/:id */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const row = await inventoryService.getInventoryDetail(reqParam(req, 'id'));
  const managed = await scopeService.managedStationIds(user(req).id);
  await scopeService.requireAmbulanceAccess(user(req), row.ambulanceId, managed);
  res.json({ success: true, data: row });
});

/** Shared guard: resolves + authorizes the ambulance for an operation. */
async function requireAmbulanceFor(req: Request, ambulanceId: string) {
  const me = user(req);
  const managed = await scopeService.managedStationIds(me.id);
  const ambulance = await scopeService.requireAmbulanceAccess(me, ambulanceId, managed);
  return { ambulance, managed };
}

/** POST /api/inventory/use */
export const use = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  await requireAmbulanceFor(req, req.body.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.useMedicine({
    ambulanceId: req.body.ambulanceId,
    medicineId: req.body.medicineId,
    quantity: req.body.quantity,
    reason: req.body.reason,
    performedById: me.id,
    meta,
  });
  res.json({ success: true, data });
});

/** POST /api/inventory/restock */
export const restock = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  await requireAmbulanceFor(req, req.body.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.restock({
    ambulanceId: req.body.ambulanceId,
    batchId: req.body.batchId,
    quantity: req.body.quantity,
    reason: req.body.reason,
    performedById: me.id,
    meta,
  });
  res.status(201).json({ success: true, data });
});

/** POST /api/inventory/adjust */
export const adjust = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const row = await inventoryService.getInventoryDetail(req.body.inventoryId);
  await requireAmbulanceFor(req, row.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.adjustQuantity({
    inventoryId: req.body.inventoryId,
    newQuantity: req.body.newQuantity,
    reason: req.body.reason,
    performedById: me.id,
    meta,
  });
  res.json({ success: true, data });
});

/** POST /api/inventory/damaged */
export const damaged = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const row = await inventoryService.getInventoryDetail(req.body.inventoryId);
  await requireAmbulanceFor(req, row.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.markDamaged({
    inventoryId: req.body.inventoryId,
    quantity: req.body.quantity,
    reason: req.body.reason,
    performedById: me.id,
    meta,
  });
  res.json({ success: true, data });
});

/** POST /api/inventory/expired */
export const expired = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const row = await inventoryService.getInventoryDetail(req.body.inventoryId);
  await requireAmbulanceFor(req, row.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.processExpired({
    inventoryId: req.body.inventoryId,
    quantity: req.body.quantity,
    reason: req.body.reason,
    performedById: me.id,
    meta,
  });
  res.json({ success: true, data });
});

/** POST /api/inventory/notes */
export const updateNotes = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const row = await inventoryService.getInventoryDetail(req.body.inventoryId);
  await requireAmbulanceFor(req, row.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.updateItemNotes({
    inventoryId: req.body.inventoryId,
    notes: req.body.notes,
    reason: req.body.reason,
    performedById: me.id,
    meta,
  });
  res.json({ success: true, data });
});

/** POST /api/inventory/expiry */
export const updateExpiry = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const row = await inventoryService.getInventoryDetail(req.body.inventoryId);
  await requireAmbulanceFor(req, row.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.updateItemExpiry({
    inventoryId: req.body.inventoryId,
    expiryDate: req.body.expiryDate,
    performedById: me.id,
    meta,
  });
  res.json({ success: true, data });
});

/** POST /api/inventory/return */
export const returnStock = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  await requireAmbulanceFor(req, req.body.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.returnStock({
    ambulanceId: req.body.ambulanceId,
    batchId: req.body.batchId,
    quantity: req.body.quantity,
    reason: req.body.reason,
    performedById: me.id,
    meta,
  });
  res.status(201).json({ success: true, data });
});

/** POST /api/inventory/initial-stock — admin seeding. */
export const initialStock = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  await requireAmbulanceFor(req, req.body.ambulanceId);
  const meta = requestMeta(req);
  const data = await inventoryService.setInitialStock({
    ambulanceId: req.body.ambulanceId,
    batchId: req.body.batchId,
    quantity: req.body.quantity,
    performedById: me.id,
    meta,
  });
  res.status(201).json({ success: true, data });
});
