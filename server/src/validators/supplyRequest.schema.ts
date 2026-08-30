import { z } from 'zod';
import { SupplyRequestStatus } from '@prisma/client';

const statusValues = Object.values(SupplyRequestStatus) as [string, ...string[]];

export const createSupplyRequestSchema = z.object({
  ambulanceId: z.string().uuid(),
  medicineId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});

export const reviewSupplyRequestSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'FULFILLED']),
});

export const listSupplyRequestsQuerySchema = z.object({
  status: z.enum(statusValues).optional(),
  mine: z.coerce.boolean().optional(),
  ambulanceId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});