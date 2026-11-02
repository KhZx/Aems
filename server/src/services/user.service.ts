import type { Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { adminAuth } from '../config/firebase.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
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
  dutyRoster: { select: { stationId: true } },
} satisfies Prisma.UserSelect;

/** Raw shape straight out of Prisma (managedStations nested under station). */
type RawUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

export type PublicUser = Omit<RawUser, 'station' | 'managedStations' | 'dutyRoster'> & {
  station: { id: string; code: string; name: string; location: string | null } | null;
  managedStations: { id: string; code: string; name: string }[];
  /** Roster allow-list: ids of the units this user may hold as duty unit. */
  dutyUnitIds: string[];
};

function publicUser(user: RawUser): PublicUser {
  return {
    ...user,
    station: user.station ?? null,
    managedStations: user.managedStations.map((m) => m.station),
    dutyUnitIds: user.dutyRoster.map((r) => r.stationId),
  };
}

/** A supervisor can edit only their own display zone. */
export async function updateMySupervisorZone(
  userId: string,
  supervisorZone: string,
  meta: AuditEntryInput = {},
): Promise<PublicUser> {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
  if (!current) throw AppError.notFound('User not found');
  if (current.role !== 'SUPERVISOR') throw AppError.forbidden('Only supervisors can update a supervisor zone');

  const normalizedZone = supervisorZone.trim() || null;
  if (current.supervisorZone === normalizedZone) return publicUser(current);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { supervisorZone: normalizedZone },
    select: USER_SELECT,
  });
  await createAudit(prisma, {
    userId,
    action: 'UPDATE_SUPERVISOR_ZONE',
    entityType: 'User',
    entityId: userId,
    stationId: current.stationId ?? undefined,
    metadata: { self: true, previousZone: current.supervisorZone, supervisorZone: normalizedZone },
    ...meta,
  });
  return publicUser(updated);
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

/**
 * Ids of every ACTIVE station. Crew rosters default to this full set so a
 * paramedic can switch to any unit out of the box; admins may narrow the
 * roster afterwards from Users → Units.
 */
async function defaultRosterStationIds(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.station.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  return rows.map((s) => s.id);
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
    await tx.managedStation.deleteMany({ where: { userId: target.id } });
    if (managed.length) {
      await tx.managedStation.createMany({ data: managed, skipDuplicates: true });
    }

    // Crew default to every active unit on their roster (their assigned unit
    // is always included); admins can narrow it later. Supervisors/admins have
    // global scope and hold no duty unit.
    const isCrewRole = input.role !== 'ADMIN' && input.role !== 'SUPERVISOR';
    await tx.dutyRoster.deleteMany({ where: { userId: target.id } });
    if (isCrewRole) {
      const unitIds = new Set(await defaultRosterStationIds(tx));
      if (stationId) unitIds.add(stationId);
      if (unitIds.size) {
        await tx.dutyRoster.createMany({
          data: [...unitIds].map((id) => ({ userId: target.id, stationId: id, createdBy: actorId })),
          skipDuplicates: true,
        });
      }
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
    stationId: user.stationId ?? undefined,
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
    stationId: user.stationId ?? undefined,
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
  // No stationCode in the payload → the unit stays where it is (role edits
  // must not silently clear someone's station).
  const effectiveStationId = input.stationCode ? stationId : target.stationId;
  const isCrewRole = input.role !== 'ADMIN' && input.role !== 'SUPERVISOR';

  const user = await prisma.$transaction(async (tx) => {
    await tx.managedStation.deleteMany({ where: { userId: target.id } });
    if (managed.length) await tx.managedStation.createMany({ data: managed, skipDuplicates: true });

    if (!isCrewRole) {
      // Staff hold no duty roster.
      await tx.dutyRoster.deleteMany({ where: { userId: target.id } });
    } else {
      const existing = await tx.dutyRoster.findMany({
        where: { userId: target.id },
        select: { stationId: true },
      });
      if (!existing.length) {
        // No roster yet → default to every active unit (plus their own unit).
        const unitIds = new Set(await defaultRosterStationIds(tx));
        if (effectiveStationId) unitIds.add(effectiveStationId);
        if (unitIds.size) {
          await tx.dutyRoster.createMany({
            data: [...unitIds].map((id) => ({ userId: target.id, stationId: id, createdBy: actorId })),
            skipDuplicates: true,
          });
        }
      } else if (effectiveStationId && !existing.some((r) => r.stationId === effectiveStationId)) {
        // Keep an admin-narrowed roster, but always let them reach their unit.
        await tx.dutyRoster.createMany({
          data: [{ userId: target.id, stationId: effectiveStationId, createdBy: actorId }],
          skipDuplicates: true,
        });
      }
    }

    return tx.user.update({
      where: { id: target.id },
      data: {
        role: input.role,
        stationId: effectiveStationId,
        status: target.status === 'PENDING' ? 'ACTIVE' : target.status,
      },
      select: USER_SELECT,
    });
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'CHANGE_ROLE',
    entityType: 'User',
    entityId: target.id,
    stationId: effectiveStationId ?? undefined,
    metadata: {
      targetUserId: target.id,
      fromRole: before.role,
      toRole: input.role,
      fromStationId: before.stationId,
      toStationId: effectiveStationId,
    },
    ...meta,
  });

  return publicUser(user);
}

/** Deletes a user record. Admin-only; keeps audit history intact. */
export async function deleteUser(actorId: string, targetId: string, meta: AuditEntryInput = {}): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw AppError.notFound('User not found');

  try {
    await prisma.$transaction([
      prisma.managedStation.deleteMany({ where: { userId: target.id } }),
      prisma.user.delete({ where: { id: target.id } }),
    ]);
  } catch {
    throw AppError.conflict('User is referenced by historical records (inspections, reports, etc.); disable the account instead');
  }

  await createAudit(prisma, {
    userId: actorId,
    action: 'DELETE_USER',
    entityType: 'User',
    entityId: targetId,
    stationId: target.stationId ?? undefined,
    metadata: { targetUserId: targetId, targetEmail: target.email },
    ...meta,
  });
}

/**
 * Replaces a user's managed-station list. Administrators reach this through
 * `station:assign`; a supervisor may only edit their OWN list via
 * `station:selfAssign`. Throws if any code is unknown or the station is
 * inactive. Every change is audited (`self` marks a supervisor self-assignment).
 */
export async function setManagedStationsForUser(
  actorId: string,
  userId: string,
  codes: string[],
  meta: AuditEntryInput = {},
): Promise<{ id: string; code: string; name: string }[]> {
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

  await prisma.managedStation.deleteMany({ where: { userId } });
  if (found.length) {
    await prisma.managedStation.createMany({
      data: found.map((s) => ({ userId, stationId: s.id })),
      skipDuplicates: true,
    });
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { stationId: true },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'SET_MANAGED_STATIONS',
    entityType: 'User',
    entityId: userId,
    stationId: target?.stationId ?? undefined,
    metadata: {
      targetUserId: userId,
      self: actorId === userId,
      stationCodes: found.map((s) => s.code).sort(),
      stationCount: found.length,
    },
    ...meta,
  });

  return found;
}

/**
 * Admin-only: replaces a user's roster allow-list (the units they may hold
 * as duty unit). If their active unit drops off the list, they are moved to
 * the first remaining unit (or cleared). Fully audited.
 */
export async function setUserUnits(
  actorId: string,
  targetId: string,
  stationIds: string[],
  meta: AuditEntryInput = {},
): Promise<{ id: string; code: string; name: string; status: string }[]> {
  const unique = [...new Set(stationIds.map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) throw AppError.badRequest('At least one unit is required');
  if (unique.length > 50) throw AppError.badRequest('Too many units (max 50)');

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, email: true, role: true, stationId: true, station: { select: { code: true } } },
  });
  if (!target) throw AppError.notFound('User not found');
  if (target.role === 'ADMIN' || target.role === 'SUPERVISOR') {
    throw AppError.badRequest('Staff accounts do not hold duty units');
  }

  const stations = await prisma.station.findMany({
    where: { id: { in: unique } },
    select: { id: true, code: true, name: true, status: true },
  });
  if (stations.length !== unique.length) {
    const known = new Set(stations.map((s) => s.id));
    throw AppError.badRequest(`Unknown unit(s): ${unique.filter((id) => !known.has(id)).join(', ')}`);
  }

  // If their current unit drops off the roster, move them to the first unit on it.
  const currentStillOn = target.stationId != null && stations.some((s) => s.id === target.stationId);
  const nextActive = currentStillOn
    ? target.stationId
    : (stations.find((s) => s.status === 'ACTIVE')?.id ?? stations[0].id);

  const previous = await prisma.dutyRoster.count({ where: { userId: targetId } });

  await prisma.$transaction([
    prisma.dutyRoster.deleteMany({ where: { userId: targetId } }),
    prisma.dutyRoster.createMany({
      data: stations.map((s) => ({ userId: targetId, stationId: s.id, createdBy: actorId })),
      skipDuplicates: true,
    }),
    prisma.user.update({ where: { id: targetId }, data: { stationId: nextActive } }),
  ]);

  await createAudit(prisma, {
    userId: actorId,
    action: 'UPDATE_USER_UNITS',
    entityType: 'User',
    entityId: targetId,
    stationId: nextActive,
    metadata: {
      targetUserId: targetId,
      targetEmail: target.email,
      units: stations.map((s) => s.code).sort(),
      unitCount: stations.length,
      previousCount: previous,
      moved: !currentStillOn,
      fromStation: currentStillOn ? null : (target.station?.code ?? null),
      toStation:
        stations.find((s) => s.id === nextActive)?.code ?? null,
    },
    ...meta,
  });

  return stations.sort((a, b) => a.code.localeCompare(b.code));
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

/**
 * Admin-only: sets a new password for another user's Firebase account.
 *
 * The change happens through the Firebase Admin SDK, so the target's current
 * password is never required (this is a reset, not a change). Their refresh
 * tokens are revoked afterwards so every device has to sign in again with the
 * new password. Guards against resetting your own account — administrators use
 * the self-service "change password" flow, which proves the current password.
 */
export async function setUserPassword(
  actorId: string,
  targetId: string,
  password: string,
  meta: AuditEntryInput = {},
): Promise<{ id: string; email: string }> {
  if (actorId === targetId) {
    throw AppError.badRequest('Use your own account settings to change your password');
  }

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, firebaseUid: true, email: true, displayName: true, stationId: true },
  });
  if (!target) throw AppError.notFound('User not found');

  try {
    await adminAuth().updateUser(target.firebaseUid, { password });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'auth/user-not-found') {
      throw AppError.notFound('Firebase account not found for this user');
    }
    if (code === 'auth/invalid-password' || code === 'auth/password-does-not-meet-requirements') {
      throw AppError.badRequest('Password does not meet Firebase requirements');
    }
    throw err;
  }

  // Force every device to authenticate again with the new password. The
  // password is already changed, so a revoke failure must not fail the call.
  await adminAuth().revokeRefreshTokens(target.firebaseUid).catch((err: unknown) => {
    logger.warn(`Failed to revoke refresh tokens for user ${target.id}: ${(err as Error).message}`);
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'RESET_USER_PASSWORD',
    entityType: 'User',
    entityId: target.id,
    stationId: target.stationId ?? undefined,
    metadata: { targetUserId: target.id, targetEmail: target.email },
    ...meta,
  });

  return { id: target.id, email: target.email };
}

/**
 * Records a self-service password change for the given user. The password
 * itself is changed client-side via Firebase Auth (after re-authentication),
 * so this endpoint only writes the audit trail.
 */
export async function recordPasswordChange(userId: string, meta: AuditEntryInput = {}): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, stationId: true },
  });
  if (!user) throw AppError.notFound('User not found');

  await createAudit(prisma, {
    userId: user.id,
    action: 'CHANGE_PASSWORD',
    entityType: 'User',
    entityId: user.id,
    stationId: user.stationId ?? undefined,
    metadata: { self: true },
    ...meta,
  });
}
