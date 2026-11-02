import { z } from 'zod';
import { MedicineCategory } from '@prisma/client';

const categoryValues = Object.values(MedicineCategory) as [string, ...string[]];

const positiveInt = z.number().int().min(1).max(1_000_000);
const nonNegativeInt = z.number().int().min(0).max(1_000_000);
// Optional structured reason code from the catalog (see GET /stock-reasons).
const reasonCode = z.string().trim().max(64).optional().or(z.literal(''));

export const useMedicineSchema = z.object({
  ambulanceId: z.string().uuid(),
  medicineId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().min(2).max(300),
  reasonCode,
});

export const restockSchema = z.object({
  ambulanceId: z.string().uuid(),
  batchId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().max(300).optional().or(z.literal('')),
  reasonCode,
});

export const adjustSchema = z.object({
  inventoryId: z.string().uuid(),
  newQuantity: nonNegativeInt,
  reason: z.string().trim().min(2).max(300),
  reasonCode,
});

export const removeStockSchema = z.object({
  inventoryId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().min(2).max(300),
  reasonCode,
});

// Body for DELETE /inventory/:id — reason is optional so legacy callers that
// send no body keep working, but the app always supplies one. `.default({})`
// lets a body-less DELETE pass validation.
export const removeStockLineSchema = z
  .object({
    reason: z.string().trim().min(2).max(300).optional().or(z.literal('')),
    reasonCode,
  })
  .default({});

export const updateInventoryNotesSchema = z.object({
  inventoryId: z.string().uuid(),
  notes: z.string().trim().max(500),
  reason: z.string().trim().min(2).max(300),
});

export const updateInventoryExpirySchema = z.object({
  inventoryId: z.string().uuid(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD'),
});

/**
 * Per-unit lot edit. Each field is optional (partial), but a reason is always
 * required — the edit is scoped to one ambulance's stock line and audited.
 */
export const updateInventoryLotSchema = z
  .object({
    batchNumber: z.string().trim().min(1).max(50).optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD').optional(),
    supplier: z.string().trim().max(120).optional().or(z.literal('')),
    receivedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Received date must be YYYY-MM-DD')
      .optional()
      .or(z.literal('')),
    reason: z.string().trim().min(2, 'A reason is required').max(300),
  })
  .refine(
    (v) =>
      v.batchNumber !== undefined ||
      v.expiryDate !== undefined ||
      v.supplier !== undefined ||
      v.receivedDate !== undefined,
    { message: 'Nothing to update' },
  );

export const returnSchema = z.object({
  ambulanceId: z.string().uuid(),
  batchId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().max(300).optional().or(z.literal('')),
  reasonCode,
});

export const initialStockSchema = z.object({
  ambulanceId: z.string().uuid(),
  batchId: z.string().uuid(),
  quantity: nonNegativeInt,
});

export const listInventoryQuerySchema = z.object({
  ambulanceId: z.string().uuid().optional(),
  stationId: z.string().uuid().optional(),
  medicineId: z.string().uuid().optional(),
  category: z.enum(categoryValues).optional(),
  search: z.string().trim().max(100).optional(),
  includeEmpty: z.coerce.boolean().optional(),
  // Supplying either paging field opts into the bounded `{ items, total }` envelope.
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const inventoryIdParamSchema = z.object({
  id: z.string().uuid(),
});
