import { z } from 'zod';

export const createReportSchema = z.object({
  stationId: z.string().uuid().optional().or(z.literal('')),
  title: z.string().trim().max(150).optional().or(z.literal('')),
  reportText: z.string().trim().min(1).max(20_000),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const listReportsQuerySchema = z.object({
  stationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
