import type { Request, Response } from 'express';
import type { InspectionStatus } from '@prisma/client';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import { AppError } from '../utils/AppError.js';
import * as inspectionService from '../services/inspection.service.js';
import * as scopeService from '../services/scope.service.js';
import { prisma } from '../config/prisma.js';

const user = (req: Request) => req.authUser!;

/** Ownership guard: the performer, or a supervisor/admin with ambulance scope. */
async function assertCanMutate(inspectionId: string, req: Request) {
  const me = user(req);
  const inspection = await prisma.inspection.findUnique({
    where: { id: inspectionId },
    select: { id: true, ambulanceId: true, performedById: true },
  });
  if (!inspection) throw AppError.notFound('Inspection not found');

  if (me.role === 'ADMIN') return inspection;
  if (inspection.performedById === me.id) return inspection;

  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireAmbulanceAccess(me, inspection.ambulanceId, managed);
  return inspection;
}

/** POST /api/inspections — start a free-form draft. */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireAmbulanceAccess(me, req.body.ambulanceId, managed);

  const inspection = await inspectionService.createDraft(
    me.id,
    {
      ambulanceId: req.body.ambulanceId,
      title: req.body.title,
      notes: req.body.notes,
      shiftCode: req.body.shiftCode,
      items: req.body.items,
    },
    requestMeta(req),
  );

  res.status(201).json({ success: true, data: inspection });
});

/** PUT /api/inspections/:id — save/resume a draft (replaces its lines). */
export const save = asyncHandler(async (req: Request, res: Response) => {
  const id = reqParam(req, 'id');
  await assertCanMutate(id, req);

  const inspection = await inspectionService.updateDraft(
    id,
    {
      title: req.body.title,
      notes: req.body.notes,
      shiftCode: req.body.shiftCode,
      items: req.body.items,
    },
    requestMeta(req),
  );

  res.json({ success: true, data: inspection });
});

/** POST /api/inspections/:id/complete — freeze, reconcile stock, generate report. */
export const complete = asyncHandler(async (req: Request, res: Response) => {
  const id = reqParam(req, 'id');
  await assertCanMutate(id, req);
  const data = await inspectionService.completeInspection(id, requestMeta(req));
  res.json({ success: true, data });
});

/** POST /api/inspections/:id/acknowledge — supervisor closes the loop. */
export const acknowledge = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const id = reqParam(req, 'id');
  const inspection = await prisma.inspection.findUnique({ where: { id }, select: { ambulanceId: true } });
  if (!inspection) throw AppError.notFound('Inspection not found');
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireAmbulanceAccess(me, inspection.ambulanceId, managed);

  const data = await inspectionService.acknowledgeInspection(id, me.id, req.body.reviewNotes, requestMeta(req));
  res.json({ success: true, data });
});

/** POST /api/inspections/:id/void — supervisor reverses the reconciliation. */
export const voidInspection = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const id = reqParam(req, 'id');
  const inspection = await prisma.inspection.findUnique({ where: { id }, select: { ambulanceId: true } });
  if (!inspection) throw AppError.notFound('Inspection not found');
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireAmbulanceAccess(me, inspection.ambulanceId, managed);

  const data = await inspectionService.voidInspection(id, me.id, req.body.voidReason, requestMeta(req));
  res.json({ success: true, data });
});

/** DELETE /api/inspections/:id — discard a draft. */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const id = reqParam(req, 'id');
  await assertCanMutate(id, req);
  const data = await inspectionService.deleteDraft(id, requestMeta(req));
  res.json({ success: true, data });
});

/** GET /api/inspections */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const accessible = await scopeService.accessibleStationIds(me);

  const data = await inspectionService.listInspections({
    ambulanceId: req.query.ambulanceId as string | undefined,
    stationIds: me.role === 'ADMIN' ? undefined : accessible,
    performedById: req.query.mine ? me.id : undefined,
    status: req.query.status as 'DRAFT' | 'COMPLETED' | 'ACKNOWLEDGED' | 'VOID' | undefined,
    page: (req.query.page as never) ?? 1,
    pageSize: (req.query.pageSize as never) ?? 50,
  });

  res.json({ success: true, data });
});

/** GET /api/inspections/overview — supervisor at-a-glance rollup. */
export const overview = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const accessible = await scopeService.accessibleStationIds(me);

  // `days` is coerced by the schema (0 = all time); `status` narrows the set to
  // a single lifecycle bucket when the caller asks for one explicitly.
  const days = Number(req.query.days ?? 30);
  const since = Number.isFinite(days) && days > 0
    ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    : null;
  // `boolish` may leave the raw query value as a string; normalise both forms.
  const includeVoided = String(req.query.includeVoided ?? '') === 'true';
  const explicitStatus = typeof req.query.status === 'string' && req.query.status
    ? [req.query.status as InspectionStatus]
    : undefined;
  const statuses = explicitStatus
    ?? (includeVoided ? (['COMPLETED', 'ACKNOWLEDGED', 'VOID'] as InspectionStatus[]) : undefined);

  const data = await inspectionService.inspectionOverview({
    stationIds: me.role === 'ADMIN' ? undefined : accessible,
    stationId: req.query.stationId as string | undefined,
    since,
    statuses,
  });

  res.json({ success: true, data });
});

/** GET /api/inspections/:id */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const inspection = await inspectionService.getInspection(reqParam(req, 'id'));
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireAmbulanceAccess(me, inspection.ambulance.id, managed);
  res.json({ success: true, data: inspection });
});
