import { z } from 'zod';
import { MedicineCategory } from '@prisma/client';

const categoryValues = Object.values(MedicineCategory) as [string, ...string[]];

const nonNegativeInt = z.number().int().min(0).max(10_000_000);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

export const allocationSchema = z.object({
  vehicle: z.string().trim().min(1).max(30),
  quantity: nonNegativeInt,
});

const batchInputSchema = z.object({
  batchNumber: z.string().trim().min(1).max(80),
  expiryDate: dateStr,
  receivedDate: dateStr.nullable().optional().default(null),
  supplier: z.string().trim().max(150).nullable().optional().default(null),
  quantity: nonNegativeInt.default(0),
  distribution: z.array(allocationSchema).max(300).optional(),
});

const itemInputSchema = z.object({
  name: z.string().trim().min(2).max(150),
  category: z.enum(categoryValues),
  size: z.string().trim().max(50).nullable().optional().default(null),
  strength: z.string().trim().max(50).nullable().optional().default(null),
  dosageForm: z.string().trim().max(50).nullable().optional().default(null),
  genericName: z.string().trim().max(150).nullable().optional().default(null),
  unit: z.string().trim().max(30).nullable().optional().default(null),
  barcode: z.string().trim().max(50).nullable().optional().default(null),
  serialNumber: z.string().trim().max(50).nullable().optional().default(null),
  location: z.string().trim().max(200).nullable().optional().default(null),
  notes: z.string().trim().max(2000).nullable().optional().default(null),
  technicalNotes: z.string().trim().max(2000).nullable().optional().default(null),
  batches: z.array(batchInputSchema).max(1000).optional().default([]),
});

export const importInventorySchema = z.object({
  ambulanceId: z.string().uuid().nullable().optional().default(null),
  items: z.array(itemInputSchema).min(1).max(2000),
});