import { z } from 'zod';
import { MedicineCategory } from '@prisma/client';

const categoryValues = Object.values(MedicineCategory) as [string, ...string[]];

const checkMinMax = (
  data: { minimumStock?: number; maximumStock?: number | null },
  ctx: z.RefinementCtx,
): void => {
  if (data.minimumStock != null && data.maximumStock != null && data.maximumStock < data.minimumStock) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maximumStock'],
      message: 'Maximum stock must be greater than or equal to the minimum stock',
    });
  }
};

const medicineBase = z.object({
  name: z.string().trim().min(2).max(150),
  genericName: z.string().trim().max(150).optional().or(z.literal('')),
  category: z.enum(categoryValues),
  strength: z.string().trim().max(50).optional().or(z.literal('')),
  dosageForm: z.string().trim().max(50).optional().or(z.literal('')),
  unit: z.string().trim().max(30).optional().or(z.literal('')),
  barcode: z.string().trim().max(50).optional().or(z.literal('')),
  location: z.string().trim().max(200).optional().or(z.literal('')),
  serialNumber: z.string().trim().max(50).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  technicalNotes: z.string().trim().max(2000).optional().or(z.literal('')),
  minimumStock: z.number().int().min(0).max(1_000_000).optional(),
  maximumStock: z.number().int().min(1).max(1_000_000).nullable().optional(),
});

export const createMedicineSchema = medicineBase.superRefine(checkMinMax);

export const updateMedicineSchema = medicineBase
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .superRefine(checkMinMax);

export const listMedicinesQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  category: z.enum(categoryValues).optional(),
  includeInactive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
