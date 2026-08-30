import type { NextFunction, Request, Response } from 'express';
import type { Ambulance, Role, Station } from '@prisma/client';
import type { Permission } from '../utils/rbac.js';
import { AppError } from '../utils/AppError.js';

/**
 * Express middleware that rejects the request unless the authenticated user
 * holds the given permission.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      next(AppError.unauthorized());
      return;
    }
    if (!req.permissions?.has(permission)) {
      next(AppError.forbidden(`Missing permission: ${permission}`));
      return;
    }
    next();
  };
}

// ── Station / ambulance scoping ─────────────────────────────────

/**
 * True when the user is ADMIN (global scope) or SUPERVISOR managing the
 * given station.
 */
export function canManageStation(req: Request, station: Pick<Station, 'id'>): boolean {
  const user = req.authUser;
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (user.role === 'SUPERVISOR') {
    // Managed-station membership is checked by the service layer with a
    // single query; this helper is a fast path only for ADMIN.
    return false;
  }
  return false;
}

export function hasGlobalScope(user: { role: Role } | undefined): boolean {
  return user?.role === 'ADMIN';
}

/** True when the ambulance belongs to a station the user may access. */
export function canAccessAmbulance(
  user: { role: Role; stationId: string | null },
  ambulance: Pick<Ambulance, 'stationId'>,
  managedStationIds: ReadonlySet<string>,
): boolean {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'SUPERVISOR') return managedStationIds.has(ambulance.stationId);
  return user.stationId != null && user.stationId === ambulance.stationId;
}
