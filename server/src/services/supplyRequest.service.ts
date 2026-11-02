import type { Prisma, SupplyRequestStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import type { Role } from '@prisma/client';
import { createAudit, type AuditEntryInput } from './audit.service.js';
import { managedStationIds } from './scope.service.js';
import * as notificationService from './notification.service.js';

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
  inspectionId: true,
  batchId: true,
  expectedArrivalAt: true,
  dispatchedById: true,
  dispatchedAt: true,
  receivedById: true,
  receivedAt: true,
  receivedQuantity: true,
  confirmedById: true,
  confirmedAt: true,
  notes: true,
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
  dispatchedBy: { select: { id: true, displayName: true } },
  receivedBy: { select: { id: true, displayName: true } },
  confirmedBy: { select: { id: true, displayName: true } },
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

  await notificationService.notifyStationSupervisors(ambulance.stationId, {
    type: 'SUPPLY_REQUEST_CREATED',
    severity: 'ACTION',
    titleKey: 'notif.supply_new.title',
    bodyKey: 'notif.supply_new.body',
    dedupeKey: `supply:${request.id}:created`,
    entityType: 'SupplyRequest',
    entityId: request.id,
    data: {
      item: medicine.name, quantity: input.quantity,
      ambulance: ambulance.vehicleNumber, page: 'supply', requestId: request.id,
    },
  }, actor.id);

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
  DISPATCHED: 'DISPATCH_SUPPLY_REQUEST',
  IN_TRANSIT: 'TRANSIT_SUPPLY_REQUEST',
  RECEIVED: 'RECEIVE_SUPPLY_REQUEST',
  FULFILLED: 'FULFIL_SUPPLY_REQUEST',
  CLOSED: 'CLOSE_SUPPLY_REQUEST',
  PENDING: 'PENDING_SUPPLY_REQUEST',
  CANCELLED: 'CANCEL_SUPPLY_REQUEST',
};

// Allowed forward transitions for the fulfilment lifecycle. Stock is only
// credited to the unit at RECEIVED/FULFILLED (the arrival hold is lifted when
// the receipt is double-confirmed — see Phase 4).
const STATUS_FLOW: Record<string, SupplyRequestStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['DISPATCHED', 'FULFILLED'],
  DISPATCHED: ['IN_TRANSIT', 'RECEIVED', 'FULFILLED'],
  IN_TRANSIT: ['RECEIVED', 'FULFILLED'],
  RECEIVED: ['CLOSED', 'FULFILLED'],
  FULFILLED: ['CLOSED'],
  REJECTED: [],
  CLOSED: [],
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

  if ((status === 'APPROVED' || status === 'REJECTED') && request.createdById !== actor.id) {
    const approved = status === 'APPROVED';
    await notificationService.notifyUser(request.createdById, {
      type: `SUPPLY_REQUEST_${status}`,
      severity: approved ? 'INFO' : 'ACTION',
      titleKey: approved ? 'notif.supply_approved.title' : 'notif.supply_rejected.title',
      bodyKey: approved ? 'notif.supply_approved.body' : 'notif.supply_rejected.body',
      dedupeKey: `supply:${requestId}:${status.toLowerCase()}`,
      stationId: request.ambulance.stationId,
      entityType: 'SupplyRequest',
      entityId: requestId,
      data: {
        item: request.medicine.name, quantity: request.quantity,
        ambulance: request.ambulance.vehicleNumber, page: 'supply', requestId,
      },
    });
  }

  return updated;
}

export async function cancelSupplyRequest(actor: SupplyActor, requestId: string, meta: AuditEntryInput = {}) {
  const request = await prisma.supplyRequest.findUnique({
    where: { id: requestId },
    select: { ...REQUEST_DETAIL, ambulance: { select: { id: true, stationId: true, vehicleNumber: true } } },
  });
  if (!request) throw AppError.notFound('Supply request not found');
  if (request.status !== 'PENDING') throw AppError.conflict('Only pending requests can be cancelled');

  const isReviewer = actor.role === 'ADMIN' || actor.role === 'SUPERVISOR';
  const managed = actor.role === 'SUPERVISOR' ? await managedStationIds(actor.id) : new Set<string>();
  const inScope =
    actor.role === 'ADMIN' ||
    (actor.role === 'SUPERVISOR' && managed.has(request.ambulance.stationId)) ||
    request.createdById === actor.id;

  // Everyone is checked: a reviewer only inside their own units, a crew member
  // only on their own request. (The reviewer-only check let any crew member
  // cancel any unit's pending request.)
  if (!inScope) throw AppError.forbidden('You do not have access to this request');
  if (!isReviewer && request.createdById !== actor.id) {
    throw AppError.forbidden('You can only cancel a supply request you raised');
  }

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

  if (request.createdById !== actor.id) {
    await notificationService.notifyUser(request.createdById, {
      type: 'SUPPLY_REQUEST_CANCELLED',
      severity: 'INFO',
      titleKey: 'notif.supply_cancelled.title',
      bodyKey: 'notif.supply_cancelled.body',
      dedupeKey: `supply:${requestId}:cancelled`,
      stationId: request.ambulance.stationId,
      entityType: 'SupplyRequest',
      entityId: requestId,
      data: {
        item: request.medicine.name, quantity: request.quantity,
        ambulance: request.ambulance.vehicleNumber, page: 'supply', requestId,
      },
    });
  }

  return updated;
}

// ── Fulfilment lifecycle (approve → dispatch → arrive → double-confirm → close) ─

type RequestDetail = Prisma.SupplyRequestGetPayload<{ select: typeof REQUEST_DETAIL }>;

/** Loads a request and enforces reviewer scope (admin, or supervisor of its unit). */
async function loadForReviewer(actor: SupplyActor, requestId: string): Promise<RequestDetail & { ambulance: { id: string; stationId: string; vehicleNumber: string } }> {
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
  return request as RequestDetail & { ambulance: { id: string; stationId: string; vehicleNumber: string } };
}

export interface DispatchInput {
  expectedArrivalAt?: string | null;
  batchId?: string | null;
  notes?: string | null;
}

/** APPROVED → DISPATCHED. The goods are now "held" on the unit until arrival. */
export async function dispatchSupplyRequest(
  actor: SupplyActor,
  requestId: string,
  input: DispatchInput,
  meta: AuditEntryInput = {},
) {
  const request = await loadForReviewer(actor, requestId);
  if (request.status !== 'APPROVED') {
    throw AppError.conflict('Only an approved request can be dispatched');
  }

  const updated = await prisma.supplyRequest.update({
    where: { id: requestId },
    data: {
      status: 'DISPATCHED',
      dispatchedById: actor.id,
      dispatchedAt: new Date(),
      expectedArrivalAt: input.expectedArrivalAt ? new Date(input.expectedArrivalAt) : null,
      batchId: input.batchId || null,
      notes: input.notes?.trim() || request.notes,
    },
  });

  await createAudit(prisma, {
    userId: actor.id,
    action: 'DISPATCH_SUPPLY_REQUEST',
    entityType: 'SupplyRequest',
    entityId: requestId,
    ambulanceId: request.ambulanceId,
    stationId: request.ambulance.stationId,
    metadata: { medicineName: request.medicine.name, quantity: request.quantity, expectedArrivalAt: input.expectedArrivalAt ?? null },
    ...meta,
  });

  if (request.createdById !== actor.id) await notificationService.notifyUser(request.createdById, {
    type: 'SUPPLY_REQUEST_DISPATCHED',
    severity: 'INFO',
    titleKey: 'notif.supply_dispatched.title',
    bodyKey: 'notif.supply_dispatched.body',
    dedupeKey: `supply:${requestId}:dispatched`,
    stationId: request.ambulance.stationId,
    entityType: 'SupplyRequest',
    entityId: requestId,
    data: { item: request.medicine.name, quantity: request.quantity, ambulance: request.ambulance.vehicleNumber, page: 'supply', requestId },
  });

  return updated;
}

export interface ReceiveInput {
  receivedQuantity?: number | null;
  batchId?: string | null;
  notes?: string | null;
}

/** DISPATCHED/IN_TRANSIT → RECEIVED. The crew (first confirmation) counts the goods in. */
export async function receiveSupplyRequest(
  actor: SupplyActor,
  requestId: string,
  input: ReceiveInput,
  meta: AuditEntryInput = {},
) {
  const request = await prisma.supplyRequest.findUnique({
    where: { id: requestId },
    select: { ...REQUEST_DETAIL, ambulance: { select: { id: true, stationId: true, vehicleNumber: true } } },
  });
  if (!request) throw AppError.notFound('Supply request not found');

  const inScope =
    actor.role === 'ADMIN' ||
    actor.stationId === request.ambulance.stationId ||
    request.createdById === actor.id;
  if (!inScope) throw AppError.forbidden('You do not have access to this request');

  if (request.status !== 'DISPATCHED' && request.status !== 'IN_TRANSIT') {
    throw AppError.conflict('Only a dispatched request can be received');
  }

  const receivedQuantity = input.receivedQuantity ?? request.quantity;
  if (!Number.isInteger(receivedQuantity) || receivedQuantity < 0) {
    throw AppError.badRequest('Received quantity must be a non-negative integer');
  }

  const updated = await prisma.supplyRequest.update({
    where: { id: requestId },
    data: {
      status: 'RECEIVED',
      receivedById: actor.id,
      receivedAt: new Date(),
      receivedQuantity,
      batchId: input.batchId || request.batchId,
      notes: input.notes?.trim() || request.notes,
    },
  });

  await createAudit(prisma, {
    userId: actor.id,
    action: 'RECEIVE_SUPPLY_REQUEST',
    entityType: 'SupplyRequest',
    entityId: requestId,
    ambulanceId: request.ambulanceId,
    stationId: request.ambulance.stationId,
    metadata: { medicineName: request.medicine.name, quantity: request.quantity, receivedQuantity },
    ...meta,
  });

  await notificationService.notifyStationSupervisors(request.ambulance.stationId, {
    type: 'SUPPLY_REQUEST_RECEIVED',
    severity: 'ACTION',
    titleKey: 'notif.supply_received.title',
    bodyKey: 'notif.supply_received.body',
    dedupeKey: `supply:${requestId}:received`,
    entityType: 'SupplyRequest',
    entityId: requestId,
    data: { item: request.medicine.name, quantity: receivedQuantity, ambulance: request.ambulance.vehicleNumber, page: 'supply', requestId },
  }, actor.id);

  return updated;
}

/**
 * RECEIVED → FULFILLED (second confirmation). This lifts the arrival hold: the
 * received quantity is credited to the unit's stock, and the confirmer is
 * recorded (may be the same person who received it).
 */
export async function confirmSupplyRequest(
  actor: SupplyActor,
  requestId: string,
  meta: AuditEntryInput = {},
) {
  const request = await loadForReviewer(actor, requestId);
  if (request.status !== 'RECEIVED') {
    throw AppError.conflict('Only a received request can be confirmed');
  }

  const received = request.receivedQuantity ?? request.quantity;

  const updated = await prisma.$transaction(async (tx) => {
    // Atomically claim the RECEIVED → FULFILLED transition. Two concurrent
    // confirmations would otherwise both credit the same stock.
    const claimed = await tx.supplyRequest.updateMany({
      where: { id: requestId, status: 'RECEIVED' },
      data: {
        status: 'FULFILLED',
        confirmedById: actor.id,
        confirmedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw AppError.conflict('This request was already confirmed');
    }

    // Credit stock when the receipt names a batch. Zero/negative receipts add
    // no stock and must not create a zero-change ledger row.
    if (request.batchId && received > 0) {
      const inventory = await tx.inventory.upsert({
        where: { ambulanceId_batchId: { ambulanceId: request.ambulanceId, batchId: request.batchId } },
        create: { ambulanceId: request.ambulanceId, batchId: request.batchId, quantity: received },
        update: { quantity: { increment: received }, deletedAt: null },
        select: { id: true, quantity: true },
      });
      await tx.inventoryTransaction.create({
        data: {
          inventoryId: inventory.id,
          transactionType: 'RESTOCK',
          quantityChange: received,
          quantityBefore: inventory.quantity - received,
          quantityAfter: inventory.quantity,
          reason: `Supply request ${requestId} fulfilled`,
          referenceId: requestId,
          performedById: actor.id,
        },
      });
    }

    return tx.supplyRequest.findUniqueOrThrow({ where: { id: requestId } });
  });

  await createAudit(prisma, {
    userId: actor.id,
    action: 'FULFIL_SUPPLY_REQUEST',
    entityType: 'SupplyRequest',
    entityId: requestId,
    ambulanceId: request.ambulanceId,
    stationId: request.ambulance.stationId,
    metadata: { medicineName: request.medicine.name, quantity: received, batchId: request.batchId ?? null },
    ...meta,
  });

  if (request.createdById !== actor.id) await notificationService.notifyUser(request.createdById, {
    type: 'SUPPLY_REQUEST_FULFILLED',
    severity: 'INFO',
    titleKey: 'notif.supply_fulfilled.title',
    bodyKey: 'notif.supply_fulfilled.body',
    dedupeKey: `supply:${requestId}:fulfilled`,
    stationId: request.ambulance.stationId,
    entityType: 'SupplyRequest',
    entityId: requestId,
    data: { item: request.medicine.name, quantity: received, ambulance: request.ambulance.vehicleNumber, page: 'supply', requestId },
  });
  if (request.batchId) await notificationService.resolveStockUnavailable(request.ambulanceId, request.medicineId);

  return updated;
}

/** FULFILLED → CLOSED (archive). */
export async function closeSupplyRequest(actor: SupplyActor, requestId: string, meta: AuditEntryInput = {}) {
  const request = await loadForReviewer(actor, requestId);
  if (request.status !== 'FULFILLED') {
    throw AppError.conflict('Only a fulfilled request can be closed');
  }

  const updated = await prisma.supplyRequest.update({
    where: { id: requestId },
    data: { status: 'CLOSED' },
  });

  await createAudit(prisma, {
    userId: actor.id,
    action: 'CLOSE_SUPPLY_REQUEST',
    entityType: 'SupplyRequest',
    entityId: requestId,
    ambulanceId: request.ambulanceId,
    stationId: request.ambulance.stationId,
    metadata: { medicineName: request.medicine.name },
    ...meta,
  });

  return updated;
}
