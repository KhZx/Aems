import { z } from 'zod';
import { InspectionItemCondition, InspectionStatus } from '@prisma/client';

const conditionValues = Object.values(InspectionItemCondition) as [string, ...string[]];
const statusValues = Object.values(InspectionStatus) as [string, ...string[]];

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

// Accept undefined, null or '' for optional text so clients can send explicit nulls.
const optionalText = (max: number) =>
  z.string().trim().max(max).nullish().or(z.literal('')).transform((v) => v || undefined);

// A single allocation of a discrepancy to a reason (units accounted for).
const reasonLineSchema = z.object({
  code: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(1_000_000),
  notes: optionalText(300),
});

const checkedDetailSchema = z.object({
  expiryVerified: z.boolean().optional(),
  packagingIntact: z.boolean().optional(),
  quantityVerified: z.boolean().optional(),
  notesRequired: z.boolean().optional(),
}).strip(); // strip extra keys so future client fields don't break

export const inspectionItemSchema = z.object({
  inventoryId: z.string().uuid(),
  actualQuantity: z.number().int().min(0).max(1_000_000),
  condition: z.enum(conditionValues).nullish().transform((v) => v ?? undefined),
  reasonCode: z.string().trim().max(64).nullish().or(z.literal('')).transform((v) => v || undefined),
  notes: z.string().trim().max(300).nullish().or(z.literal('')).transform((v) => v || undefined),
  reasonLines: z.array(reasonLineSchema).max(20).nullish().transform((v) => v ?? undefined),
  checkedDetail: checkedDetailSchema.nullish(),
});

// A draft can start empty and be filled/resumed any time.
export const createInspectionSchema = z.object({
  ambulanceId: z.string().uuid(),
  title: optionalText(120),
  notes: optionalText(1000),
  shiftCode: optionalText(20),
  items: z.array(inspectionItemSchema).max(500).default([]),
});

export const updateInspectionSchema = z.object({
  title: optionalText(120),
  notes: optionalText(1000),
  shiftCode: optionalText(20),
  items: z.array(inspectionItemSchema).max(500),
});

export const acknowledgeInspectionSchema = z.object({
  reviewNotes: optionalText(1000),
});

export const voidInspectionSchema = z.object({
  voidReason: z.string().trim().min(3).max(500),
});

export const listInspectionsQuerySchema = z.object({
  ambulanceId: z.string().uuid().optional(),
  stationId: z.string().uuid().optional(),
  status: z.enum(statusValues).optional(),
  mine: boolish.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

// Supervisor at-a-glance rollup: everything from the last `days` days (0 = all
// time) across the caller's units, optionally narrowed to one unit.
export const inspectionOverviewQuerySchema = z.object({
  stationId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(0).max(3650).default(30),
  status: z.enum(statusValues).optional(),
  includeVoided: boolish.optional(),
});

export type CreateInspectionBody = z.infer<typeof createInspectionSchema>;
