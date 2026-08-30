import { z } from 'zod';

export const transferSchema = z.object({
  sourceInventoryId: z.string().uuid(),
  destinationAmbulanceId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1_000_000),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
});

export const listTransfersQuerySchema = z.object({
  ambulanceId: z.string().uuid().optional(),
  stationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
