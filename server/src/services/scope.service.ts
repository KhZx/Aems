import type { Ambulance, Role } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { canAccessAmbulance } from '../middleware/authorize.js';

export interface ScopeUser {
  id: string;
  role: Role;
  stationId: string | null;
}

/** Station ids a supervisor manages; empty set for everyone else. */
export async function managedStationIds(userId: string): Promise<ReadonlySet<string>> {
  const rows = await prisma.managedStation.findMany({
    where: { userId },
    select: { stationId: true },
  });
  return new Set(rows.map((r) => r.stationId));
}

/** Fetches an ambulance and verifies the user may access it. */
export async function requireAmbulanceAccess(
  user: ScopeUser,
  ambulanceId: string,
  managedIds: ReadonlySet<string>,
): Promise<Ambulance> {
  const ambulance = await prisma.ambulance.findUnique({ where: { id: ambulanceId } });
  if (!ambulance) throw AppError.notFound('Ambulance not found');
  if (!canAccessAmbulance(user, ambulance, managedIds)) {
    throw AppError.forbidden('You do not have access to this ambulance');
  }
  return ambulance;
}

/** Verifies the user may read/write inventory within a station. */
export async function requireStationAccess(
  user: ScopeUser,
  stationId: string,
  managedIds: ReadonlySet<string>,
): Promise<void> {
  if (user.role === 'ADMIN') return;
  if (user.role === 'SUPERVISOR' && managedIds.has(stationId)) return;
  if (user.stationId === stationId) return;
  throw AppError.forbidden('You do not have access to this station');
}

/**
 * Builds a Prisma-compatible `stationId` filter for data listings:
 *   - ADMIN → all stations
 *   - SUPERVISOR → managed stations
 *   - others → their own station
 * Returns the list of station ids (empty array means "no access").
 */
export async function accessibleStationIds(user: ScopeUser): Promise<string[]> {
  if (user.role === 'ADMIN') return [];
  if (user.role === 'SUPERVISOR') {
    return [...(await managedStationIds(user.id))];
  }
  return user.stationId ? [user.stationId] : [];
}
