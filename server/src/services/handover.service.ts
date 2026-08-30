import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

const HANDOVER_INCLUDE = {
  createdBy: { select: { id: true, displayName: true } },
} satisfies Prisma.HandoverInclude;

type HandoverRow = Prisma.HandoverGetPayload<{ include: typeof HANDOVER_INCLUDE }>;

/** Flattens the DB row back into the nested shape used by the app. */
function toApiHandover(h: HandoverRow) {
  return {
    id: h.id,
    status: h.status === 'ACKNOWLEDGED' ? 'acknowledged' : 'submitted',
    createdAt: h.createdAt,
    acknowledgedAt: h.acknowledgedAt,
    outgoing: {
      paramedicName: h.outgoingName,
      paramedicId: h.outgoingEmpId,
      shiftType: h.outgoingShift,
      patientsCount: h.patientsCount,
      equipStatus: h.equipStatus,
      pendingIssues: h.pendingIssues,
      medicationsUsed: h.medicationsUsed,
      notes: h.notes,
    },
    incoming: h.incomingName
      ? {
          paramedicName: h.incomingName,
          paramedicId: h.incomingEmpId,
          notes: h.incomingNotes,
        }
      : null,
  };
}

export interface HandoverOutgoingInput {
  paramedicName: string;
  paramedicId?: string | null;
  shiftType?: string | null;
  patientsCount?: number;
  equipStatus?: string | null;
  pendingIssues?: string | null;
  medicationsUsed?: string | null;
  notes?: string | null;
}

export interface CreateHandoverInput {
  stationId: string;
  outgoing: HandoverOutgoingInput;
  createdById: string;
  meta?: AuditEntryInput;
}

export async function createHandover(input: CreateHandoverInput) {
  const station = await prisma.station.findUnique({ where: { id: input.stationId } });
  if (!station) throw AppError.notFound('Station not found');

  const pending = await prisma.handover.findFirst({
    where: { stationId: input.stationId, status: 'SUBMITTED' },
  });
  if (pending) throw AppError.conflict('A handover is already awaiting acknowledgment');

  const handover = await prisma.handover.create({
    data: {
      stationId: input.stationId,
      status: 'SUBMITTED',
      outgoingName: input.outgoing.paramedicName,
      outgoingEmpId: input.outgoing.paramedicId ?? null,
      outgoingShift: input.outgoing.shiftType ?? null,
      patientsCount: input.outgoing.patientsCount ?? 0,
      equipStatus: input.outgoing.equipStatus ?? null,
      pendingIssues: input.outgoing.pendingIssues ?? null,
      medicationsUsed: input.outgoing.medicationsUsed ?? null,
      notes: input.outgoing.notes ?? null,
      createdById: input.createdById,
    },
    include: HANDOVER_INCLUDE,
  });

  await createAudit(prisma, {
    userId: input.createdById,
    action: 'SUBMIT_HANDOVER',
    entityType: 'Handover',
    entityId: handover.id,
    stationId: input.stationId,
    metadata: { outgoingName: input.outgoing.paramedicName, equipStatus: input.outgoing.equipStatus ?? null },
    ...input.meta,
  });

  return toApiHandover(handover);
}

export async function getHandover(id: string) {
  const handover = await prisma.handover.findUnique({ where: { id } });
  if (!handover) throw AppError.notFound('Handover not found');
  return handover;
}

export interface AcknowledgeHandoverInput {
  handoverId: string;
  incomingName: string;
  incomingEmpId?: string | null;
  incomingNotes?: string | null;
  acknowledgedById: string;
  meta?: AuditEntryInput;
}

export async function acknowledgeHandover(input: AcknowledgeHandoverInput) {
  const handover = await prisma.handover.findUnique({ where: { id: input.handoverId } });
  if (!handover) throw AppError.notFound('Handover not found');
  if (handover.status !== 'SUBMITTED') {
    throw AppError.conflict('This handover was already acknowledged');
  }

  const updated = await prisma.handover.update({
    where: { id: handover.id },
    data: {
      status: 'ACKNOWLEDGED',
      incomingName: input.incomingName,
      incomingEmpId: input.incomingEmpId ?? null,
      incomingNotes: input.incomingNotes ?? null,
      acknowledgedAt: new Date(),
    },
    include: HANDOVER_INCLUDE,
  });

  await createAudit(prisma, {
    userId: input.acknowledgedById,
    action: 'ACKNOWLEDGE_HANDOVER',
    entityType: 'Handover',
    entityId: handover.id,
    stationId: handover.stationId,
    metadata: { incomingName: input.incomingName },
    ...input.meta,
  });

  return toApiHandover(updated);
}

export interface ListHandoversInput {
  stationIds?: string[];
  page?: number;
  pageSize?: number;
}

export async function listHandovers(input: ListHandoversInput = {}) {
  const { stationIds, page = 1, pageSize = 50 } = input;

  const where: Prisma.HandoverWhereInput = {
    ...(stationIds ? { stationId: { in: stationIds } } : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.handover.count({ where }),
    prisma.handover.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: HANDOVER_INCLUDE,
    }),
  ]);

  return { total, page, pageSize, handovers: rows.map(toApiHandover) };
}
