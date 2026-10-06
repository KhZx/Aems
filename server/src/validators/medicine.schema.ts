import { z } from 'zod';
import { MedicineCategory } from '@prisma/client';

const categoryValues = Object.values(MedicineCategory) as [string, ...string[]];

const medicineBase = z.object({
  name: z.string().trim().min(2).max(150),
  genericName: z.string().trim().max(150).optional().or(z.literal('')),
  category: z.enum(categoryValues),
  strength: z.string().trim().max(50).optional().or(z.literal('')),
  dosageForm: z.string().trim().max(50).optional().or(z.literal('')),
  size: z.string().trim().max(50).optional().or(z.literal('')),
  unit: z.string().trim().max(30).optional().or(z.literal('')),
  barcode: z.string().trim().max(50).optional().or(z.literal('')),
  location: z.string().trim().max(200).optional().or(z.literal('')),
  serialNumber: z.string().trim().max(50).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  technicalNotes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export const createMedicineSchema = medicineBase;

export const updateMedicineSchema = medicineBase
  .partial()
  .extend({ isActive: z.boolean().optional() });

export const listMedicinesQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  category: z.enum(categoryValues).optional(),
  includeInactive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
