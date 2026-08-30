import { z } from 'zod';
import { AmbulanceStatus } from '@prisma/client';

export const createAmbulanceSchema = z.object({
  stationCode: z.string().trim().min(1).max(20),
  vehicleNumber: z.string().trim().min(1).max(30),
  status: z.enum([AmbulanceStatus.ACTIVE, AmbulanceStatus.MAINTENANCE, AmbulanceStatus.OUT_OF_SERVICE, AmbulanceStatus.DECOMMISSIONED]).optional(),
});

export const updateAmbulanceSchema = z.object({
  stationCode: z.string().trim().min(1).max(20).optional(),
  status: z.enum([AmbulanceStatus.ACTIVE, AmbulanceStatus.MAINTENANCE, AmbulanceStatus.OUT_OF_SERVICE, AmbulanceStatus.DECOMMISSIONED]).optional(),
});

export const listAmbulancesQuerySchema = z.object({
  stationCode: z.string().trim().max(20).optional(),
  search: z.string().trim().max(100).optional(),
});
