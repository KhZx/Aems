import { z } from 'zod';

// Accept either a full ISO datetime (with offset) or a calendar date. The
// controller widens a date-only `to` to the end of that day so the selected
// period is inclusive on both ends.
const dateLike = z
  .string()
  .trim()
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(Date.parse(v)),
    'Expected an ISO date or datetime',
  );

export const analyticsQuerySchema = z.object({
  from: dateLike.optional(),
  to: dateLike.optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  stationId: z.string().uuid().optional(),
  ambulanceId: z.string().uuid().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
