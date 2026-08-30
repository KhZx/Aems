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

  let accessibleStationIds: string[] = [];
  if (user.role === 'ADMIN') {
    const stations = await prisma.station.findMany({ select: { id: true } });
    accessibleStationIds = stations.map((s) => s.id);
  } else if (user.role === 'SUPERVISOR') {
    accessibleStationIds = user.managedStations.map((s) => s.id);
  } else if (user.station) {
    accessibleStationIds = [user.station.id];
  }

  const ambulances = await prisma.ambulance.findMany({
    where:
      user.role === 'ADMIN' || user.role === 'SUPERVISOR'
        ? { stationId: { in: accessibleStationIds } }
        : { stationId: user.stationId ?? '__none__' },
    select: {
      id: true,
      vehicleNumber: true,
      status: true,
      station: { select: { id: true, code: true, name: true } },
    },
    orderBy: { vehicleNumber: 'asc' },
  });

  return {
    user,
    permissions: [...permissionsFor(user.role)],
    managedStations,
    accessibleStationIds,
    ambulances,
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
  const user = await userService.recordLogin(req.firebaseUid as string, { ipAddress, userAgent });
  const payload = await sessionPayload(user.id);
  res.json({ success: true, data: payload });
});

/** GET /api/auth/me — current profile + permissions (no audit write). */
export const me = asyncHandler(async (req: Request, res: Response) => {
  const payload = await sessionPayload(req.authUser!.id);
  res.json({ success: true, data: payload });
});
