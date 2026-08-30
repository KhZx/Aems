import { z } from 'zod';

export const createBatchSchema = z.object({
  medicineId: z.string().uuid(),
  batchNumber: z.string().trim().min(1).max(50),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD'),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Received date must be YYYY-MM-DD').optional().or(z.literal('')),
  supplier: z.string().trim().max(120).optional().or(z.literal('')),
});

export const listBatchesQuerySchema = z.object({
  medicineId: z.string().uuid().optional(),
  activeOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
