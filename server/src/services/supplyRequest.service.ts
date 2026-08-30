import type { Prisma, SupplyRequestStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import type { Role } from '@prisma/client';
import { createAudit, type AuditEntryInput } from './audit.service.js';
import { managedStationIds } from './scope.service.js';

export interface CreateSupplyRequestInput {
  ambulanceId: string;
  medicineId: string;
  quantity: number;
  reason?: string | null;
}

export interface SupplyActor {
  id: string;
  role: Role;
  stationId: string | null;
}

const REQUEST_DETAIL = {
  id: true,
  ambulanceId: true,
  medicineId: true,
  quantity: true,
  reason: true,
  status: true,
  createdById: true,
  reviewedById: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
  ambulance: {
    select: {
      id: true,
      vehicleNumber: true,
      station: { select: { id: true, code: true, name: true } },
    },
  },
  medicine: { select: { id: true, name: true, category: true, unit: true } },
  createdBy: { select: { id: true, displayName: true, email: true } },
  reviewedBy: { select: { id: true, displayName: true, email: true } },
} satisfies Prisma.SupplyRequestSelect;

/** Verifies a creator may request stock for the given ambulance. */
async function requireRequestableAmbulance(actor: SupplyActor, ambulanceId: string) {
  const ambulance = await prisma.ambulance.findUnique({ where: { id: ambulanceId } });
  if (!ambulance) throw AppError.notFound('Ambulance not found');
  if (actor.role === 'ADMIN') return ambulance;
  // A field user must belong to the ambulance's station. Supervisors may
  // request for any managed station.
  if (actor.role === 'SUPERVISOR') {
    const managed = await managedStationIds(actor.id);
    if (managed.has(ambulance.stationId)) return ambulance;
  }
  if (actor.stationId != null && actor.stationId === ambulance.stationId) return ambulance;
  throw AppError.forbidden('You do not have access to this ambulance');
}

export async function createSupplyRequest(
  actor: SupplyActor,
  input: CreateSupplyRequestInput,
  meta: AuditEntryInput = {},
) {
  const ambulance = await requireRequestableAmbulance(actor, input.ambulanceId);

  const medicine = await prisma.medicine.findUnique({ where: { id: input.medicineId, deletedAt: null } });
  if (!medicine) throw AppError.notFound('Medicine not found');

  const existing = await prisma.supplyRequest.findFirst({
    where: { ambulanceId: input.ambulanceId, medicineId: input.medicineId, status: 'PENDING' },
  });
  if (existing) {
    throw AppError.conflict(
      'There is already a pending supply request for this item on this ambulance',
    );
  }

  const request = await prisma.supplyRequest.create({
    data: {
      ambulanceId: input.ambulanceId,
      medicineId: input.medicineId,
      quantity: input.quantity,
      reason: input.reason?.trim() || null,
      createdById: actor.id,
    },
  });

  await createAudit(prisma, {
    userId: actor.id,
    action: 'CREATE_SUPPLY_REQUEST',
    entityType: 'SupplyRequest',
    entityId: request.id,
    ambulanceId: input.ambulanceId,
    stationId: ambulance.stationId,
    metadata: {
      medicineName: medicine.name,
      quantity: input.quantity,
      reason: input.reason ?? null,
    },
    ...meta,
  });

  return request;
}

export interface ListSupplyRequestsInput {
  status?: SupplyRequestStatus;
  mine?: boolean;
  ambulanceId?: string;
  page?: number;
  pageSize?: number;
}

export async function listSupplyRequests(actor: SupplyActor, input: ListSupplyRequestsInput = {}) {
  const { status, mine, ambulanceId, page = 1, pageSize = 50 } = input;

  const scoped: Prisma.SupplyRequestWhereInput = {};
  if (actor.role === 'SUPERVISOR') {
    const managed = await managedStationIds(actor.id);
    scoped.ambulance = { station: { id: { in: [...managed] } } };
  } else if (actor.role !== 'ADMIN') {
    // Field crews only ever see their own requests.
    scoped.createdById = actor.id;
  }
  if (mine) scoped.createdById = actor.id;
  if (ambulanceId) scoped.ambulanceId = ambulanceId;
  if (status) scoped.status = status;

  const [total, requests] = await prisma.$transaction([
    prisma.supplyRequest.count({ where: scoped }),
    prisma.supplyRequest.findMany({
      where: scoped,
      select: REQUEST_DETAIL,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, requests };
}

const STATUS_ACTIONS: Record<SupplyRequestStatus, string> = {
  APPROVED: 'APPROVE_SUPPLY_REQUEST',
  REJECTED: 'REJECT_SUPPLY_REQUEST',
  FULFILLED: 'FULFIL_SUPPLY_REQUEST',
  PENDING: 'PENDING_SUPPLY_REQUEST',
  CANCELLED: 'CANCEL_SUPPLY_REQUEST',
};

const STATUS_FLOW: Record<string, SupplyRequestStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['FULFILLED'],
  REJECTED: [],
  FULFILLED: [],
  CANCELLED: [],
};

export async function reviewSupplyRequest(
  actor: SupplyActor,
  requestId: string,
  status: SupplyRequestStatus,
  meta: AuditEntryInput = {},
) {
  if (!STATUS_FLOW[status]) {
    throw AppError.badRequest('Invalid target status');
  }
  const request = await prisma.supplyRequest.findUnique({
    where: { id: requestId },
    select: { ...REQUEST_DETAIL, ambulance: { select: { id: true, stationId: true, vehicleNumber: true } } },
  });
  if (!request) throw AppError.notFound('Supply request not found');

  if (actor.role !== 'ADMIN') {
    const managed = await managedStationIds(actor.id);
    if (actor.role !== 'SUPERVISOR' || !managed.has(request.ambulance.stationId)) {
      throw AppError.forbidden('You do not have access to this request');
    }
  }

  if (!STATUS_FLOW[request.status]?.includes(status)) {
    throw AppError.conflict(`Cannot move a ${request.status} request to ${status}`);
  }

  const updated = await prisma.supplyRequest.update({
    where: { id: requestId },
    data: {
      status,
      reviewedById: actor.id,
      reviewedAt: new Date(),
    },
  });

  await createAudit(prisma, {
    userId: actor.id,
    action: STATUS_ACTIONS[status],
    entityType: 'SupplyRequest',
    entityId: requestId,
    ambulanceId: request.ambulanceId,
    stationId: request.ambulance.stationId,
    metadata: {
      medicineName: request.medicine.name,
      quantity: request.quantity,
      reason: request.reason ?? null,
    },
    ...meta,
  });

  return updated;
}

export async function cancelSupplyRequest(actor: SupplyActor, requestId: string, meta: AuditEntryInput = {}) {
  const request = await prisma.supplyRequest.findUnique({
    where: { id: requestId },
    select: { ...REQUEST_DETAIL, ambulance: { select: { id: true, stationId: true } } },
  });
  if (!request) throw AppError.notFound('Supply request not found');
  if (request.status !== 'PENDING') throw AppError.conflict('Only pending requests can be cancelled');

  const isReviewer = actor.role === 'ADMIN' || actor.role === 'SUPERVISOR';
  const managed = actor.role === 'SUPERVISOR' ? await managedStationIds(actor.id) : new Set<string>();
  const inScope =
    actor.role === 'ADMIN' ||
    (actor.role === 'SUPERVISOR' && managed.has(request.ambulance.stationId)) ||
    request.createdById === actor.id;

  if (isReviewer && !inScope) throw AppError.forbidden('You do not have access to this request');

  const updated = await prisma.supplyRequest.update({
    where: { id: requestId },
    data: { status: 'CANCELLED', reviewedById: actor.id, reviewedAt: new Date() },
  });

  await createAudit(prisma, {
    userId: actor.id,
    action: 'CANCEL_SUPPLY_REQUEST',
    entityType: 'SupplyRequest',
    entityId: requestId,
    ambulanceId: request.ambulanceId,
    stationId: request.ambulance.stationId,
    metadata: { medicineName: request.medicine.name, quantity: request.quantity },
    ...meta,
  });

  return updated;
}