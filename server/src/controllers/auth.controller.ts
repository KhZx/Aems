import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { permissionsFor } from '../utils/rbac.js';
import * as userService from '../services/user.service.js';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
async function sessionPayload(userId: string) {
  const user = await userService.getUserById(userId);
  const managedStations = user.managedStations.map((s) => s.code);
  const isStaff = user.role === 'ADMIN' || user.role === 'SUPERVISOR';

  const ambulanceSelect = {
    id: true,
    vehicleNumber: true,
    status: true,
    station: { select: { id: true, code: true, name: true } },
  } as const;

  // Independent lookups run concurrently: each one is a round-trip to the
  // database, which is the dominant cost of login/me when the DB is remote.
  const [accessibleStationIds, ambulances, dutyRoster] = await Promise.all([
    user.role === 'ADMIN'
      ? prisma.station.findMany({ select: { id: true } }).then((stations) => stations.map((s) => s.id))
      : Promise.resolve(
          user.role === 'SUPERVISOR'
            ? user.managedStations.map((s) => s.id)
            : // Crew: stationId IS their active duty unit.
              (user.stationId ? [user.stationId] : []),
        ),
    user.role === 'ADMIN'
      ? prisma.ambulance.findMany({ select: ambulanceSelect, orderBy: { vehicleNumber: 'asc' } })
      : prisma.ambulance.findMany({
          where: isStaff
            ? { stationId: { in: user.managedStations.map((s) => s.id) } }
            : // Crew: the cars of the unit they currently hold.
              { stationId: user.stationId ?? '__none__' },
          select: ambulanceSelect,
          orderBy: { vehicleNumber: 'asc' },
        }),
    // Crew roster: the units (stations) they may switch to. Staff get null.
    isStaff
      ? Promise.resolve(null)
      : prisma.dutyRoster
          .findMany({
            where: { userId: user.id },
            orderBy: { station: { code: 'asc' } },
            include: { station: { select: { id: true, code: true, name: true, status: true } } },
          })
          .then((rows) => rows.map((r) => r.station)),
  ]);

  return {
    user,
    permissions: [...permissionsFor(user.role)],
    managedStations,
    accessibleStationIds,
    ambulances,
    dutyRoster,
  };
}

/** POST /api/auth/register — self-registration (creates a PENDING account). */
export const register = asyncHandler(async (req: Request, res: Response) => {
  const firebaseUid = req.firebaseUid as string;
  const email = req.verifiedEmail ?? (req.body.email as string | undefined);
  if (!email) throw AppError.badRequest('Email is required');

  const user = await userService.registerUser({
    firebaseUid,
    email,
    displayName: req.body.displayName,
    empId: req.body.empId || undefined,
    badgeNumber: req.body.badgeNumber || undefined,
    requestedRole: req.body.requestedRole || undefined,
    stationCode: req.body.stationCode || undefined,
    supervisorZone: req.body.supervisorZone || undefined,
    managedStationCodes: req.body.managedStationCodes || undefined,
  });

  res.status(201).json({ success: true, data: user });
});

/** POST /api/auth/login — called right after a successful Firebase sign-in. */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { ipAddress, userAgent } = requestMeta(req);
  // The audit write and the session lookup are independent; run them together.
  const [, payload] = await Promise.all([
    userService.recordLogin(req.firebaseUid as string, { ipAddress, userAgent }),
    sessionPayload(req.authUser!.id),
  ]);
  res.json({ success: true, data: payload });
});

/** GET /api/auth/me — current profile + permissions (no audit write). */
export const me = asyncHandler(async (req: Request, res: Response) => {
  const payload = await sessionPayload(req.authUser!.id);
  res.json({ success: true, data: payload });
});

/**
 * POST /api/auth/password-changed — records a self-service password change.
 * The password itself is updated client-side through the Firebase SDK (after
 * the user re-authenticates with their current password); this only writes the
 * audit trail so the change is traceable.
 */
export const passwordChanged = asyncHandler(async (req: Request, res: Response) => {
  const { ipAddress, userAgent } = requestMeta(req);
  await userService.recordPasswordChange(req.authUser!.id, { ipAddress, userAgent });
  res.json({ success: true });
});
