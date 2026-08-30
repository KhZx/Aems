import type { Prisma, StationStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';
import { STATION_CODE_RE } from '../validators/station.schema.js';

export interface CreateStationInput {
  code: string;
  name: string;
  location?: string | null;
}

export interface UpdateStationInput {
  name?: string;
  location?: string | null;
  status?: StationStatus;
}

/**
 * Creates a station/unit. Because a station IS a single car, the unit's car
 * is created automatically with the vehicle number matching the unit code.
 */
export async function createStation(actorId: string, input: CreateStationInput, meta: AuditEntryInput = {}) {
  const code = input.code.trim();
  if (!STATION_CODE_RE.test(code)) {
    throw AppError.badRequest('Station code must be the unit/car number: digits only (max 6)');
  }

  const existing = await prisma.station.findUnique({ where: { code } });
  if (existing) throw AppError.conflict(`Station code "${code}" already exists`);

  const station = await prisma.$transaction(async (tx) => {
    const st = await tx.station.create({
      data: { code, name: input.name.trim(), location: input.location ?? null },
    });
    // One car per unit — the car number is the unit code.
    await tx.ambulance.create({ data: { vehicleNumber: code, stationId: st.id } });
    return st;
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'CREATE_STATION',
    entityType: 'Station',
    entityId: station.id,
    stationId: station.id,
    metadata: { code: station.code, name: station.name, carCreated: true },
    ...meta,
  });

  return station;
}

export async function updateStation(
  actorId: string,
  id: string,
  input: UpdateStationInput,
  meta: AuditEntryInput = {},
) {
  const before = await prisma.station.findUnique({ where: { id } });
  if (!before) throw AppError.notFound('Station not found');

  const station = await prisma.station.update({
    where: { id },
    data: {
      name: input.name !== undefined ? input.name.trim() : undefined,
      location: input.location !== undefined ? input.location : undefined,
      status: input.status,
    },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'UPDATE_STATION',
    entityType: 'Station',
    entityId: station.id,
    stationId: station.id,
    metadata: { before: { name: before.name }, after: { name: station.name } },
    ...meta,
  });

  return station;
}

export async function deleteStation(actorId: string, id: string, meta: AuditEntryInput = {}): Promise<void> {
  const station = await prisma.station.findUnique({
    where: { id },
    include: { ambulances: { take: 1 }, users: { take: 1 } },
  });
  if (!station) throw AppError.notFound('Station not found');
  if (station.users.length > 0) {
    throw AppError.conflict('Station has users assigned; reassign them first');
  }

  // The unit's car may be removed too, but never if it still holds stock.
  const stock = await prisma.inventory.count({ where: { ambulance: { stationId: id } } });
  if (stock > 0) {
    throw AppError.conflict('Station still has stock; move or consume it before deleting');
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.ambulance.deleteMany({ where: { stationId: id } });
      await tx.station.delete({ where: { id } });
    });
  } catch (err) {
    // Historical records (audits, inspections, transfers) may reference the car.
    throw AppError.conflict('Station is referenced by historical records; mark it INACTIVE instead');
  }

  await createAudit(prisma, {
    userId: actorId,
    action: 'DELETE_STATION',
    entityType: 'Station',
    entityId: id,
    stationId: id,
    metadata: { code: station.code, name: station.name },
    ...meta,
  });
}

export interface ListStationsInput {
  search?: string;
  status?: StationStatus;
}

export async function listStations(input: ListStationsInput = {}) {
  const where: Prisma.StationWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.search
      ? {
          OR: [
            { code: { contains: input.search, mode: 'insensitive' } },
            { name: { contains: input.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const stations = await prisma.station.findMany({
    where,
    orderBy: { code: 'asc' },
    include: {
      _count: { select: { ambulances: true, users: true } },
    },
  });

  return stations;
}

export async function getStationByCode(code: string) {
  const station = await prisma.station.findUnique({
    where: { code },
    include: { _count: { select: { ambulances: true, users: true } } },
  });
  if (!station) throw AppError.notFound('Station not found');
  return station;
}
