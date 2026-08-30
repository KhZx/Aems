import { z } from 'zod';

export const createHandoverSchema = z.object({
  stationId: z.string().uuid(),
  outgoing: z.object({
    paramedicName: z.string().trim().min(1).max(150),
    paramedicId: z.string().trim().max(100).optional().or(z.literal('')),
    shiftType: z.string().trim().max(50).optional().or(z.literal('')),
    patientsCount: z.number().int().min(0).max(100_000).default(0),
    equipStatus: z.string().trim().max(80).optional().or(z.literal('')),
    pendingIssues: z.string().trim().max(2000).optional().or(z.literal('')),
    medicationsUsed: z.string().trim().max(2000).optional().or(z.literal('')),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
  }),
});

export const acknowledgeHandoverSchema = z.object({
  incoming: z.object({
    paramedicName: z.string().trim().min(1).max(150),
    paramedicId: z.string().trim().max(100).optional().or(z.literal('')),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
  }),
});

export const listHandoversQuerySchema = z.object({
  stationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
