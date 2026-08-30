import { z } from 'zod';
import { StationStatus } from '@prisma/client';

/**
 * A station is a single unit: its code IS the car number, so codes are
 * digits only (e.g. "54").
 */
export const STATION_CODE_RE = /^\d{1,6}$/;

export const stationCodeSchema = z
  .string()
  .trim()
  .regex(STATION_CODE_RE, 'Station code must be the unit/car number: digits only (max 6)');

export const createStationSchema = z.object({
  code: stationCodeSchema,
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().max(200).optional().or(z.literal('')),
});

export const updateStationSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  location: z.string().trim().max(200).nullable().optional(),
  status: z.enum([StationStatus.ACTIVE, StationStatus.INACTIVE]).optional(),
});

export const listStationsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum([StationStatus.ACTIVE, StationStatus.INACTIVE]).optional(),
});

export const stationCodeParamSchema = z.object({
  code: z.string().trim().max(20),
});
