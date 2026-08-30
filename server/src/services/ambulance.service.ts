import type { AmbulanceStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

export interface CreateAmbulanceInput {
  stationCode: string;
  vehicleNumber: string;
  status?: AmbulanceStatus;
}

export interface UpdateAmbulanceInput {
  stationCode?: string;
  status?: AmbulanceStatus;
}

export async function createAmbulance(actorId: string, input: CreateAmbulanceInput, meta: AuditEntryInput = {}) {
  const station = await prisma.station.findUnique({ where: { code: input.stationCode } });
  if (!station) throw AppError.badRequest(`Station "${input.stationCode}" not found`, { field: 'stationCode' });

  const vehicleNumber = input.vehicleNumber.trim();
  if (!vehicleNumber) throw AppError.badRequest('Vehicle number is required');

  const existing = await prisma.ambulance.findUnique({ where: { vehicleNumber } });
  if (existing) throw AppError.conflict(`Vehicle "${vehicleNumber}" already exists`);

  const ambulance = await prisma.ambulance.create({
    data: { stationId: station.id, vehicleNumber, status: input.status ?? 'ACTIVE' },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'CREATE_AMBULANCE',
    entityType: 'Ambulance',
    entityId: ambulance.id,
    stationId: station.id,
    metadata: { vehicleNumber, stationCode: input.stationCode },
    ...meta,
  });

  return ambulance;
}

export async function updateAmbulance(
  actorId: string,
  id: string,
  input: UpdateAmbulanceInput,
  meta: AuditEntryInput = {},
) {
  const before = await prisma.ambulance.findUnique({ where: { id } });
  if (!before) throw AppError.notFound('Ambulance not found');

  let stationId: string | undefined;
  if (input.stationCode) {
    const station = await prisma.station.findUnique({ where: { code: input.stationCode } });
    if (!station) throw AppError.badRequest(`Station "${input.stationCode}" not found`, { field: 'stationCode' });
    stationId = station.id;
  }

  const ambulance = await prisma.ambulance.update({
    where: { id },
    data: {
      stationId: stationId ?? undefined,
      status: input.status,
    },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'UPDATE_AMBULANCE',
    entityType: 'Ambulance',
    entityId: ambulance.id,
    stationId: ambulance.stationId,
    metadata: {
      before: { stationId: before.stationId, status: before.status },
      after: { stationId: ambulance.stationId, status: ambulance.status },
    },
    ...meta,
  });

  return ambulance;
}

export async function deleteAmbulance(actorId: string, id: string, meta: AuditEntryInput = {}): Promise<void> {
  const ambulance = await prisma.ambulance.findUnique({ where: { id } });
  if (!ambulance) throw AppError.notFound('Ambulance not found');

  const stockCount = await prisma.inventory.count({ where: { ambulanceId: id } });
  if (stockCount > 0) {
    throw AppError.conflict('Ambulance still has inventory; clear it before deleting');
  }

  await prisma.ambulance.delete({ where: { id } });

  await createAudit(prisma, {
    userId: actorId,
    action: 'DELETE_AMBULANCE',
    entityType: 'Ambulance',
    entityId: id,
    stationId: ambulance.stationId,
    metadata: { vehicleNumber: ambulance.vehicleNumber },
    ...meta,
  });
}

export async function listAmbulances(input: { stationCode?: string; search?: string } = {}) {
  const where: Prisma.AmbulanceWhereInput = {
    ...(input.stationCode ? { station: { code: input.stationCode } } : {}),
    ...(input.search
      ? { vehicleNumber: { contains: input.search, mode: 'insensitive' } }
      : {}),
  };

  return prisma.ambulance.findMany({
    where,
    orderBy: { vehicleNumber: 'asc' },
    include: {
      station: { select: { id: true, code: true, name: true } },
      _count: { select: { inventory: true } },
    },
  });
}

export async function getAmbulanceById(id: string) {
  const ambulance = await prisma.ambulance.findUnique({
    where: { id },
    include: {
      station: { select: { id: true, code: true, name: true, location: true } },
      inventory: {
        include: {
          batch: { include: { medicine: true } },
          transactions: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      },
    },
  });
  if (!ambulance) throw AppError.notFound('Ambulance not found');
  return ambulance;
}
