import { z } from 'zod';

/** Switching units is free but the reason is mandatory — it lands in the audit trail. */
export const switchDutySchema = z.object({
  stationId: z.string().uuid(),
  reason: z.string().trim().min(2, 'A reason is required').max(300),
});

/** Admin: replaces a user's roster allow-list. */
export const setUserUnitsSchema = z.object({
  stationIds: z.array(z.string().uuid()).min(1, 'At least one unit is required').max(50),
});
