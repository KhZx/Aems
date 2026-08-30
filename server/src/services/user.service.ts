import type { Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

export interface RegisterInput {
  firebaseUid: string;
  email: string;
  displayName: string;
  empId?: string;
  badgeNumber?: string;
  requestedRole?: Role | null;
  stationCode?: string | null;
  supervisorZone?: string | null;
  managedStationCodes?: string[];
}

export interface ApproveInput {
  role: Role;
  stationCode?: string | null;
  badgeNumber?: string | null;
  supervisorZone?: string | null;
  managedStationCodes?: string[];
}

const USER_SELECT = {
  id: true,
  firebaseUid: true,
  email: true,
  displayName: true,
  role: true,
  status: true,
  requestedRole: true,
  empId: true,
  badgeNumber: true,
  supervisorZone: true,
  approvedAt: true,
  approvedBy: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
  stationId: true,
  station: { select: { id: true, code: true, name: true, location: true } },
  managedStations: { select: { station: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.UserSelect;

/** Raw shape straight out of Prisma (managedStations nested under station). */
type RawUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

export type PublicUser = Omit<RawUser, 'station' | 'managedStations'> & {
  station: { id: string; code: string; name: string; location: string | null } | null;
  managedStations: { id: string; code: string; name: string }[];
};

function publicUser(user: RawUser): PublicUser {
  return {
    ...user,
    station: user.station ?? null,
    managedStations: user.managedStations.map((m) => m.station),
  };
}

/** Bootstraps the first administrator when BOOTSTRAP_ADMIN_UID is configured. */
export async function applyBootstrapAdmin(firebaseUid: string): Promise<boolean> {
  if (!env.BOOTSTRAP_ADMIN_UID || env.BOOTSTRAP_ADMIN_UID !== firebaseUid) return false;

  const user = await prisma.user.findUnique({ where: { firebaseUid } });
  if (!user) return false;

  if (user.role !== 'ADMIN' || user.status !== 'ACTIVE') {
    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'ADMIN', status: 'ACTIVE', approvedAt: new Date() },
    });
  }
  return true;
}

/**
 * Creates a pending application user for an already-verified Firebase
 * account. Self-registration can never grant a role or activate the account.
 */
export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const existing = await prisma.user.findUnique({ where: { firebaseUid: input.firebaseUid } });
  if (existing) {
    // Bootstrap admin may already exist but needs no re-registration.
    return publicUser(await prisma.user.findUniqueOrThrow({ where: { id: existing.id }, select: USER_SELECT }));
  }

  const email = input.email.toLowerCase().trim();
  const existingByEmail = await prisma.user.findUnique({ where: { email } });
  if (existingByEmail) {
    throw AppError.conflict('An account with this email already exists');
  }

  let stationId: string | null = null;
  if (input.stationCode) {
    const station = await prisma.station.findUnique({ where: { code: input.stationCode } });
    if (!station) {
      throw AppError.badRequest('Station not found. Contact an administrator.', {
        field: 'stationCode',
      });
    }
    stationId = station.id;
  }

  const user = await prisma.user.create({
    data: {
      firebaseUid: input.firebaseUid,
      email,
      displayName: input.displayName.trim(),
      empId: input.empId ?? null,
      badgeNumber: input.badgeNumber ?? null,
      requestedRole: input.requestedRole ?? null,
      stationId,
      supervisorZone: input.supervisorZone ?? null,
      status: 'PENDING',
      role: 'PARAMEDIC',
    },
    select: USER_SELECT,
  });

  // For SUPERVISOR requests, persist the stations the applicant selected so
  // the admin sees them pre-filled at approval time. approveUser/changeRole
  // always rebuild this set, so nothing here survives beyond the request.
  if (input.requestedRole === 'SUPERVISOR' && input.managedStationCodes?.length) {
    const managed: Prisma.ManagedStationCreateManyInput[] = [];
    for (const code of [...new Set(input.managedStationCodes)]) {
      if (!code.trim()) continue;
      const station = await prisma.station.findUnique({ where: { code: code.trim() } });
      if (station) managed.push({ userId: user.id, stationId: station.id });
    }
    if (managed.length) await prisma.managedStation.createMany({ data: managed });
  }

  await createAudit(prisma, {
    userId: user.id,
    action: 'CREATE_USER',
    entityType: 'User',
    entityId: user.id,
    stationId: stationId ?? undefined,
    metadata: {
      email: user.email,
      requestedRole: user.requestedRole,
      stationCode: input.stationCode ?? null,
    },
  });

  return publicUser(user);
}

export async function getUserById(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
  if (!user) throw AppError.notFound('User not found');
  return publicUser(user);
}

export async function getUserByFirebaseUid(firebaseUid: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { firebaseUid }, select: USER_SELECT });
  return user ? publicUser(user) : null;
}

export interface ListUsersInput {
  status?: UserStatus;
  role?: Role;
  search?: string;
  stationId?: string;
  page?: number;
  pageSize?: number;
}

export async function listUsers(input: ListUsersInput) {
  const { status, role, search, stationId, page = 1, pageSize = 50 } = input;

  const where: Prisma.UserWhereInput = {
    ...(status ? { status } : {}),
    ...(role ? { role } : {}),
    ...(stationId ? { stationId } : {}),
    ...(search
      ? {
          OR: [
            { displayName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { empId: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, users] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, users: users.map(publicUser) };
}

async function assertStationExists(code: string): Promise<string> {
  const station = await prisma.station.findUnique({ where: { code } });
  if (!station) throw AppError.badRequest(`Station "${code}" not found`, { field: 'stationCode' });
  return station.id;
}

/** Approves a pending user and assigns role/station. Admin-only. */
export async function approveUser(
  actorId: string,
  targetId: string,
  input: ApproveInput,
  meta: AuditEntryInput = {},
): Promise<PublicUser> {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw AppError.notFound('User not found');

  let stationId: string | null = null;
  if (input.stationCode) {
    stationId = await assertStationExists(input.stationCode);
  }

  const managed: Prisma.ManagedStationCreateManyInput[] = [];
  if (input.role === 'SUPERVISOR' && input.managedStationCodes?.length) {
    const codes = [...new Set(input.managedStationCodes)];
    for (const code of codes) {
      const id = await assertStationExists(code);
      managed.push({ userId: target.id, stationId: id });
    }
  }

  const user = await prisma.$transaction(async (tx) => {
    if (managed.length) {
      await tx.managedStation.deleteMany({ where: { userId: target.id } });
      await tx.managedStation.createMany({ data: managed });
    } else {
      await tx.managedStation.deleteMany({ where: { userId: target.id } });
    }

    return tx.user.update({
      where: { id: target.id },
      data: {
        role: input.role,
        status: 'ACTIVE',
        stationId,
        badgeNumber: input.badgeNumber ?? target.badgeNumber,
        supervisorZone: input.supervisorZone ?? target.supervisorZone,
        approvedAt: new Date(),
        approvedBy: actorId,
      },
      select: USER_SELECT,
    });
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'APPROVE_USER',
    entityType: 'User',
    entityId: target.id,
    stationId: stationId ?? undefined,
    metadata: {
      targetUserId: target.id,
      targetEmail: target.email,
      role: input.role,
      stationCode: input.stationCode ?? null,
      managedStationCodes: input.managedStationCodes ?? [],
    },
    ...meta,
  });

  return publicUser(user);
}

/** Rejects a pending user request. Admin-only. */
export async function rejectUser(actorId: string, targetId: string, meta: AuditEntryInput = {}): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: targetId },
    data: { status: 'REJECTED' },
    select: USER_SELECT,
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'REJECT_USER',
    entityType: 'User',
    entityId: targetId,
    metadata: { targetUserId: targetId, targetEmail: user.email },
    ...meta,
  });

  return publicUser(user);
}

export async function setUserStatus(
  actorId: string,
  targetId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED',
  meta: AuditEntryInput = {},
): Promise<PublicUser> {
  if (status === 'ACTIVE') {
    throw AppError.badRequest('Use the approval flow to activate an account');
  }
  const user = await prisma.user.update({
    where: { id: targetId },
    data: { status },
    select: USER_SELECT,
  });

  await createAudit(prisma, {
    userId: actorId,
    action: status === 'DISABLED' ? 'DISABLE_USER' : 'SUSPEND_USER',
    entityType: 'User',
    entityId: targetId,
    metadata: { targetUserId: targetId, targetEmail: user.email },
    ...meta,
  });

  return publicUser(user);
}

export interface ChangeRoleInput {
  role: Role;
  stationCode?: string | null;
  managedStationCodes?: string[];
}

/** Admin-only role/station reassignment. */
export async function changeRole(
  actorId: string,
  targetId: string,
  input: ChangeRoleInput,
  meta: AuditEntryInput = {},
): Promise<PublicUser> {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw AppError.notFound('User not found');

  let stationId: string | null = null;
  if (input.stationCode) stationId = await assertStationExists(input.stationCode);

  const managed: Prisma.ManagedStationCreateManyInput[] = [];
  if (input.role === 'SUPERVISOR' && input.managedStationCodes?.length) {
    for (const code of [...new Set(input.managedStationCodes)]) {
      managed.push({ userId: target.id, stationId: await assertStationExists(code) });
    }
  }

  const before = { role: target.role, stationId: target.stationId };

  const user = await prisma.$transaction(async (tx) => {
    await tx.managedStation.deleteMany({ where: { userId: target.id } });
    if (managed.length) await tx.managedStation.createMany({ data: managed });
    return tx.user.update({
      where: { id: target.id },
      data: { role: input.role, stationId, status: target.status === 'PENDING' ? 'ACTIVE' : target.status },
      select: USER_SELECT,
    });
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'CHANGE_ROLE',
    entityType: 'User',
    entityId: target.id,
    stationId: stationId ?? undefined,
    metadata: {
      targetUserId: target.id,
      fromRole: before.role,
      toRole: input.role,
      fromStationId: before.stationId,
      toStationId: stationId,
    },
    ...meta,
  });

  return publicUser(user);
}

/** Deletes a user record. Admin-only; keeps audit history intact. */
export async function deleteUser(actorId: string, targetId: string, meta: AuditEntryInput = {}): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw AppError.notFound('User not found');

  await prisma.$transaction([
    prisma.managedStation.deleteMany({ where: { userId: target.id } }),
    prisma.user.delete({ where: { id: target.id } }),
  ]);

  await createAudit(prisma, {
    userId: actorId,
    action: 'DELETE_USER',
    entityType: 'User',
    entityId: targetId,
    metadata: { targetUserId: targetId, targetEmail: target.email },
    ...meta,
  });
}

/**
 * Replaces the supervisor's own managed-station list (self-service from the
 * supervisor dashboard). Only called for SUPERVISORS (enforced in the
 * controller). Throws if any code is unknown or the station is inactive.
 */
export async function setMyManagedStations(actorId: string, codes: string[]): Promise<{ id: string; code: string; name: string }[]> {
  const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (unique.length > 50) throw AppError.badRequest('Too many stations (max 50)');

  const found = await prisma.station.findMany({
    where: { code: { in: unique }, status: 'ACTIVE' },
    select: { id: true, code: true, name: true },
  });
  if (found.length !== unique.length) {
    const known = new Set(found.map((s) => s.code));
    throw AppError.badRequest(`Unknown station code(s): ${unique.filter((c) => !known.has(c)).join(', ')}`);
  }
  if (!found.length) return [];

  await prisma.$transaction([
    prisma.managedStation.deleteMany({ where: { userId: actorId } }),
    prisma.managedStation.createMany({
      data: found.map((s) => ({ userId: actorId, stationId: s.id })),
    }),
  ]);

  return found;
}

/** Records a login event (invoked after successful Firebase sign-in). */
export async function recordLogin(firebaseUid: string, meta: AuditEntryInput = {}): Promise<PublicUser> {
  let user = await prisma.user.findUnique({ where: { firebaseUid }, select: USER_SELECT });
  if (!user) throw AppError.unauthorized('Account not registered');

  // Promote the bootstrapped first admin BEFORE the status gate, otherwise a
  // freshly registered bootstrap UID is stuck at PENDING forever.
  if (env.BOOTSTRAP_ADMIN_UID && env.BOOTSTRAP_ADMIN_UID === firebaseUid) {
    await applyBootstrapAdmin(firebaseUid);
    user = await prisma.user.findUnique({ where: { firebaseUid }, select: USER_SELECT });
  }

  if (user!.status !== 'ACTIVE') {
    const message =
      user!.status === 'PENDING'
        ? 'Account is pending approval'
        : user!.status === 'REJECTED'
          ? 'Account request was rejected'
          : 'Account is disabled';
    throw AppError.forbidden(message);
  }

  const updated = await prisma.user.update({
    where: { id: user!.id },
    data: { lastLoginAt: new Date() },
    select: USER_SELECT,
  });

  await createAudit(prisma, {
    userId: updated.id,
    action: 'LOGIN',
    entityType: 'User',
    entityId: updated.id,
    stationId: updated.stationId ?? undefined,
    ...meta,
  });

  return publicUser(updated);
}
