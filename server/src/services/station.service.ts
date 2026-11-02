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
  code?: string;
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
  const before = await prisma.station.findUnique({
    where: { id },
    include: { ambulances: { take: 1 } },
  });
  if (!before) throw AppError.notFound('Station not found');

  const data: Prisma.StationUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.code !== undefined) {
    const code = input.code.trim();
    if (!STATION_CODE_RE.test(code)) {
      throw AppError.badRequest('Station code must be the unit/car number: digits only (max 6)');
    }
    if (code !== before.code) {
      const clash = await prisma.station.findUnique({ where: { code } });
      if (clash && clash.id !== id) throw AppError.conflict(`Station code "${code}" already exists`);
      // vehicleNumber is @unique across the fleet; guard it before re-numbering
      // this unit's own car so we never collide with another unit's car. A
      // station normally has exactly one car, but compare by car id to be safe.
      const ownCar = before.ambulances[0];
      const carClash = await prisma.ambulance.findUnique({ where: { vehicleNumber: code } });
      if (carClash && carClash.id !== ownCar?.id) {
        throw AppError.conflict(`Ambulance number "${code}" is already used by another unit`);
      }
      data.code = code;
      changes.code = { from: before.code, to: code };
    }
  }

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name !== before.name) {
      data.name = name;
      changes.name = { from: before.name, to: name };
    }
  }

  if (input.location !== undefined) {
    const location = input.location?.trim() || null;
    if ((before.location ?? null) !== location) {
      data.location = location;
      changes.location = { from: before.location ?? null, to: location };
    }
  }

  if (input.status !== undefined && input.status !== before.status) {
    data.status = input.status;
    changes.status = { from: before.status, to: input.status };
  }

  if (Object.keys(data).length === 0) throw AppError.badRequest('No changes to save');

  const station = await prisma.$transaction(async (tx) => {
    const st = await tx.station.update({ where: { id }, data });
    if (changes.code) {
      const car = before.ambulances[0];
      if (car) {
        await tx.ambulance.update({
          where: { id: car.id },
          data: { vehicleNumber: changes.code.to as string },
        });
      }
    }
    return st;
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'UPDATE_STATION',
    entityType: 'Station',
    entityId: station.id,
    stationId: station.id,
    // `code` keeps the existing admin-log rendering working; `changes` carries
    // the full field-level diff (same shape as UPDATE_MEDICINE).
    metadata: { code: station.code, changes },
    ...meta,
  });

  return station;
}

export async function deleteStation(actorId: string, id: string, meta: AuditEntryInput = {}): Promise<void> {
  const station = await prisma.station.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          users: true,
          shiftNotes: true,
          handovers: true,
          reports: true,
          distributions: true,
          // The station's OWN lifecycle entries (create/edit) always exist and
          // are not "history" — exclude them so a never-used unit stays
          // deletable. Any other station-tagged audit blocks the delete.
          auditLogs: { where: { action: { notIn: ['CREATE_STATION', 'UPDATE_STATION'] } } },
          managedBy: true,
          dutyAssignments: true,
        },
      },
      ambulances: {
        include: {
          _count: {
            select: {
              inventory: true,
              inspections: true,
              transfers: true,
              transfersFromDestination: true,
              supplyRequests: true,
              auditLogs: true,
            },
          },
        },
      },
    },
  });
  if (!station) throw AppError.notFound('Station not found');

  // A station is only hard-deleted when NOTHING references it. Anything else
  // is real operational history that must survive for audit — and some of it
  // (shift notes, handovers) even cascades on delete — so those stations are
  // deactivated instead. Each blocker is reported explicitly.
  const blockers: string[] = [];
  const c = station._count;
  if (c.users > 0) blockers.push(`${c.users} assigned user(s)`);
  if (c.shiftNotes > 0) blockers.push(`${c.shiftNotes} shift note(s)`);
  if (c.handovers > 0) blockers.push(`${c.handovers} handover(s)`);
  if (c.reports > 0) blockers.push(`${c.reports} report(s)`);
  if (c.distributions > 0) blockers.push(`${c.distributions} distribution(s)`);
  if (c.auditLogs > 0) blockers.push(`${c.auditLogs} audit entr${c.auditLogs === 1 ? 'y' : 'ies'}`);
  if (c.managedBy > 0) blockers.push(`${c.managedBy} supervisor assignment(s)`);
  if (c.dutyAssignments > 0) blockers.push(`${c.dutyAssignments} duty assignment(s)`);

  const amb = station.ambulances.reduce(
    (acc, a) => ({
      inventory: acc.inventory + a._count.inventory,
      inspections: acc.inspections + a._count.inspections,
      transfers: acc.transfers + a._count.transfers + a._count.transfersFromDestination,
      supplyRequests: acc.supplyRequests + a._count.supplyRequests,
      auditLogs: acc.auditLogs + a._count.auditLogs,
    }),
    { inventory: 0, inspections: 0, transfers: 0, supplyRequests: 0, auditLogs: 0 },
  );
  if (amb.inventory > 0) blockers.push(`${amb.inventory} stock line(s)`);
  if (amb.inspections > 0) blockers.push(`${amb.inspections} inspection(s)`);
  if (amb.transfers > 0) blockers.push(`${amb.transfers} transfer(s)`);
  if (amb.supplyRequests > 0) blockers.push(`${amb.supplyRequests} supply request(s)`);
  if (amb.auditLogs > 0) blockers.push(`${amb.auditLogs} equipment audit entr${amb.auditLogs === 1 ? 'y' : 'ies'}`);

  if (blockers.length > 0) {
    throw AppError.conflict(
      `Station ${station.code} cannot be deleted — it still has ${blockers.join(', ')}. ` +
        `Mark it INACTIVE instead to remove it from active lists while keeping its history for audit.`,
    );
  }

  // Genuinely empty (a freshly registered unit): safe to hard-delete. The
  // DELETE_STATION audit entry is written WITHOUT a stationId because the row
  // is now gone — a dangling FK would be rejected — so the deletion is
  // attributed to the acting admin instead.
  await prisma.$transaction(async (tx) => {
    await tx.ambulance.deleteMany({ where: { stationId: id } });
    await tx.station.delete({ where: { id } });
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'DELETE_STATION',
    entityType: 'Station',
    entityId: id,
    metadata: { code: station.code, name: station.name, hardDeleted: true },
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
