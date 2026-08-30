import { z } from 'zod';
import { MedicineCategory } from '@prisma/client';

const categoryValues = Object.values(MedicineCategory) as [string, ...string[]];

const positiveInt = z.number().int().min(1).max(1_000_000);
const nonNegativeInt = z.number().int().min(0).max(1_000_000);

export const useMedicineSchema = z.object({
  ambulanceId: z.string().uuid(),
  medicineId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().min(2).max(300),
});

export const restockSchema = z.object({
  ambulanceId: z.string().uuid(),
  batchId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().max(300).optional().or(z.literal('')),
});

export const adjustSchema = z.object({
  inventoryId: z.string().uuid(),
  newQuantity: nonNegativeInt,
  reason: z.string().trim().min(2).max(300),
});

export const removeStockSchema = z.object({
  inventoryId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().min(2).max(300),
});

export const updateInventoryNotesSchema = z.object({
  inventoryId: z.string().uuid(),
  notes: z.string().trim().max(500),
  reason: z.string().trim().min(2).max(300),
});

export const updateInventoryExpirySchema = z.object({
  inventoryId: z.string().uuid(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD'),
});

export const returnSchema = z.object({
  ambulanceId: z.string().uuid(),
  batchId: z.string().uuid(),
  quantity: positiveInt,
  reason: z.string().trim().max(300).optional().or(z.literal('')),
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
});

export const inventoryIdParamSchema = z.object({
  id: z.string().uuid(),
});
