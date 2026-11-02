import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

const UNIT_SELECT = { id: true, code: true, name: true, status: true } as const;

export type DutyUnit = {
  id: string;
  code: string;
  name: string;
  status: string;
};

export interface DutyState {
  active: DutyUnit | null;
  units: DutyUnit[];
}

/** Current duty unit + the roster allow-list the user may switch to. */
export async function getDutyState(userId: string): Promise<DutyState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stationId: true, role: true },
  });
  if (!user) throw AppError.notFound('User not found');

  if (user.role === 'ADMIN' || user.role === 'SUPERVISOR') {
    return { active: null, units: [] };
  }

  const roster = await prisma.dutyRoster.findMany({
    where: { userId },
    orderBy: { station: { code: 'asc' } },
    include: { station: { select: UNIT_SELECT } },
  });
  const units = roster.map((r) => r.station);
  // Active unit is read straight from User.stationId so an admin removing it
  // from the roster doesn't hide where the person currently is.
  const active = user.stationId
    ? await prisma.station.findUnique({ where: { id: user.stationId }, select: UNIT_SELECT })
    : null;
  return { active, units };
}

export interface SwitchDutyInput {
  userId: string;
  role: string;
  stationId: string;
  reason: string;
  meta?: AuditEntryInput;
}

/**
 * Moves the caller's duty unit (station). Switching is unlimited but always
 * audited: the reason lands on the audit row for supervisor review.
 */
export async function switchDutyUnit(input: SwitchDutyInput): Promise<DutyState> {
  const { userId, role, stationId, reason, meta = {} } = input;

  if (role === 'ADMIN' || role === 'SUPERVISOR') {
    throw AppError.forbidden('Staff accounts do not hold a duty unit');
  }

  const onRoster = await prisma.dutyRoster.findUnique({
    where: { userId_stationId: { userId, stationId } },
  });
  if (!onRoster) {
    throw AppError.forbidden('That unit is not on your roster');
  }

  const target = await prisma.station.findUnique({
    where: { id: stationId },
    select: UNIT_SELECT,
  });
  if (!target) throw AppError.notFound('Unit not found');
  if (target.status !== 'ACTIVE') {
    throw AppError.badRequest('That unit is out of service');
  }

  const before = await prisma.user.findUnique({
    where: { id: userId },
    select: { stationId: true },
  });

  // Same unit → nothing changed, no audit noise.
  if (before?.stationId === stationId) {
    return getDutyState(userId);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { stationId },
  });

  let from: DutyUnit | null = null;
  if (before?.stationId) {
    from = await prisma.station.findUnique({
      where: { id: before.stationId },
      select: UNIT_SELECT,
    });
  }

  await createAudit(prisma, {
    userId,
    action: 'DUTY_SWITCH',
    entityType: 'DutyAssignment',
    entityId: stationId,
    stationId,
    metadata: {
      reason,
      from: from?.code ?? null,
      fromName: from?.name ?? null,
      fromStationId: before?.stationId ?? null,
      to: target.code,
      toName: target.name,
      toStationId: stationId,
    },
    ...meta,
  });

  return getDutyState(userId);
}
