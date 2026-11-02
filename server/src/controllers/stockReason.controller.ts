import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/prisma.js';
import { listStockReasons } from '../config/stockReasons.js';

/**
 * GET /stock-reasons — the structured reason catalog used by stock actions and
 * inspection discrepancies. Filterable by item type and action so the
 * frontend only ever shows valid choices for the context.
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const { itemType, action, includeInactive } = req.query as {
    itemType?: 'MEDICATION' | 'EQUIPMENT';
    action?: 'USE' | 'DELETE' | 'DAMAGE' | 'EXPIRE' | 'TRANSFER' | 'ADJUST' | 'RETURN' | 'INSPECTION';
    includeInactive?: boolean;
  };

  const reasons = await listStockReasons(prisma, { itemType, action, includeInactive });

  res.json({
    success: true,
    data: {
      reasons: reasons.map((r) => ({
        code: r.code,
        labelEn: r.labelEn,
        labelAr: r.labelAr,
        family: r.family,
        effect: r.effect,
        itemTypes: r.itemTypes,
        actions: r.actions,
        requiresNote: r.requiresNote,
        requiresReview: r.requiresReview,
        sortOrder: r.sortOrder,
        isActive: r.isActive,
      })),
    },
  });
});
