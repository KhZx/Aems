import { z } from 'zod';

export const createBatchSchema = z.object({
  medicineId: z.string().uuid(),
  batchNumber: z.string().trim().min(1).max(50),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD'),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Received date must be YYYY-MM-DD').optional().or(z.literal('')),
  supplier: z.string().trim().max(120).optional().or(z.literal('')),
});

/**
 * Edits a batch/lot. Every field is optional (partial update), but a reason is
 * always required — the batch is shared by every ambulance stocking the lot, so
 * the change must be traceable in the audit trail.
 */
export const updateBatchSchema = z
  .object({
    batchNumber: z.string().trim().min(1).max(50).optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD').optional(),
    receivedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Received date must be YYYY-MM-DD')
      .optional()
      .or(z.literal('')),
    supplier: z.string().trim().max(120).optional().or(z.literal('')),
    reason: z.string().trim().min(2, 'A reason is required').max(500),
  })
  .refine(
    (v) =>
      v.batchNumber !== undefined ||
      v.expiryDate !== undefined ||
      v.receivedDate !== undefined ||
      v.supplier !== undefined,
    { message: 'Nothing to update' },
  );

export const listBatchesQuerySchema = z.object({
  medicineId: z.string().uuid().optional(),
  activeOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
