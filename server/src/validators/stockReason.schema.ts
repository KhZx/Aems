import { z } from 'zod';
import { StockAction, StockReasonItemType } from '@prisma/client';

const itemTypeValues = Object.values(StockReasonItemType) as [string, ...string[]];
const actionValues = Object.values(StockAction) as [string, ...string[]];

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const listStockReasonsQuerySchema = z.object({
  itemType: z.enum(itemTypeValues).optional(),
  action: z.enum(actionValues).optional(),
  includeInactive: boolish.optional(),
});
