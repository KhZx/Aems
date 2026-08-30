import { z } from 'zod';
import { Role } from '@prisma/client';

const roleValues = Object.values(Role) as [string, ...string[]];

const optionalStationCode = z
  .string()
  .trim()
  .regex(/^\d{1,6}$/, 'Station code must be the unit/car number: digits only (max 6)')
  .optional()
  .or(z.literal(''));

export const registerSchema = z.object({
  displayName: z.string().trim().min(2).max(100),
  empId: z.string().trim().max(20).optional().or(z.literal('')),
  badgeNumber: z.string().trim().max(30).optional().or(z.literal('')),
  requestedRole: z.enum(roleValues).optional(),
  stationCode: optionalStationCode,
  supervisorZone: z.string().trim().max(100).optional().or(z.literal('')),
  managedStationCodes: z.array(z.string().trim().max(20)).max(50).optional(),
});

export const listUsersQuerySchema = z.object({
  status: z.string().optional(),
  role: z.enum(roleValues).optional(),
  search: z.string().trim().max(100).optional(),
  stationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const approveUserSchema = z.object({
  role: z.enum(roleValues),
  stationCode: z.string().trim().max(20).optional().or(z.literal('')),
  badgeNumber: z.string().trim().max(30).optional().or(z.literal('')),
  supervisorZone: z.string().trim().max(100).optional().or(z.literal('')),
  managedStationCodes: z.array(z.string().trim().max(20)).max(50).optional(),
});

export const changeRoleSchema = z.object({
  role: z.enum(roleValues),
  stationCode: z.string().trim().max(20).optional().or(z.literal('')),
  managedStationCodes: z.array(z.string().trim().max(20)).max(50).optional(),
});

export const setUserStatusSchema = z.object({
  status: z.enum(['SUSPENDED', 'DISABLED']),
});

export const updateMyManagedStationsSchema = z.object({
  stationCodes: z.array(z.string().trim().max(20)).max(50),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});
