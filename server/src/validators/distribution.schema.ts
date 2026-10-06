import { z } from 'zod';
import { MedicineCategory } from '@prisma/client';

export const distributionBatchSchema = z.object({
  batchNumber: z.string().trim().max(80).optional().nullable().default(null),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').nullable().optional().default(null),
  supplier: z.string().trim().max(150).nullable().optional().default(null),
  quantity: z.number().int().min(1).max(10_000_000).default(1),
});

export const distributionItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.nativeEnum(MedicineCategory).optional(),
  location: z.string().trim().max(200).nullable().optional().default(null),
  serialNumber: z.string().trim().max(200).nullable().optional().default(null),
  size: z.string().trim().max(100).nullable().optional().default(null),
  barcode: z.string().trim().max(100).nullable().optional().default(null),
  notes: z.string().trim().max(1000).nullable().optional().default(null),
  technicalNotes: z.string().trim().max(2000).nullable().optional().default(null),
  batches: z.array(distributionBatchSchema).min(1).max(100),
});

export const createDistributionTemplateSchema = z.object({
  name: z.string().trim().min(2).max(150),
  description: z.string().trim().max(2000).nullable().optional().default(null),
  isActive: z.boolean().optional().default(true),
  items: z.array(distributionItemSchema).min(1).max(1000),
});

export const updateDistributionTemplateSchema = createDistributionTemplateSchema;

export const distributionIdParamSchema = z.object({
  id: z.string().min(1).max(80),
});

export const applyDistributionSchema = z.object({
  templateId: z.string().min(1).max(80),
  stationIds: z.array(z.string().min(1).max(80)).min(1).max(100),
});