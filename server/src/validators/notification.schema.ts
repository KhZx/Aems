import { z } from 'zod';

const boolish = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']),
]).transform((value) => value === true || value === 'true' || value === '1');

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  unreadOnly: boolish.optional().default(false),
});
