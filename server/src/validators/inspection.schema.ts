import { z } from 'zod';

export const inspectionItemSchema = z.object({
  inventoryId: z.string().uuid(),
  actualQuantity: z.number().int().min(0).max(1_000_000),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
});

export const createInspectionSchema = z.object({
  ambulanceId: z.string().uuid(),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
  items: z.array(inspectionItemSchema).min(1).max(500),
});

export const listInspectionsQuerySchema = z.object({
  ambulanceId: z.string().uuid().optional(),
  stationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
