import type {
  PrismaClient,
  StockAction,
  StockReasonEffect,
  StockReasonFamily,
  StockReasonItemType,
} from '@prisma/client';

/**
 * The structured reason catalog. This array is the single source of truth for
 * reason codes: it is versioned in code, seeded into the `StockReason` table on
 * server start, and referenced by stock actions and inspection discrepancies.
 *
 * Codes are stable and never re-purposed; labels can be edited by admins later
 * without breaking historical records.
 */
export interface StockReasonDef {
  code: string;
  labelEn: string;
  labelAr: string;
  family: StockReasonFamily;
  effect: StockReasonEffect;
  itemTypes: StockReasonItemType[];
  actions: StockAction[];
  requiresNote?: boolean;
  requiresReview?: boolean;
  sortOrder?: number;
}

const BOTH: StockReasonItemType[] = ['MEDICATION', 'EQUIPMENT'];

export const STOCK_REASONS: StockReasonDef[] = [
  // ── Consumption ──────────────────────────────────────────────
  {
    code: 'USED_PATIENT_CARE',
    labelEn: 'Used During Patient Care',
    labelAr: 'استُخدم أثناء رعاية مريض',
    family: 'CONSUMPTION',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['USE', 'INSPECTION'],
    sortOrder: 10,
  },
  {
    code: 'WASTED_SPILLED',
    labelEn: 'Wasted / Spilled',
    labelAr: 'تلف أو انسكاب',
    family: 'CONSUMPTION',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['USE', 'DAMAGE', 'INSPECTION'],
    sortOrder: 20,
  },

  // ── Expiry ───────────────────────────────────────────────────
  {
    code: 'EXPIRED',
    labelEn: 'Expired',
    labelAr: 'منتهي الصلاحية',
    family: 'EXPIRY',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['EXPIRE', 'DELETE', 'INSPECTION'],
    sortOrder: 30,
  },
  {
    code: 'RECALLED',
    labelEn: 'Recalled by Manufacturer',
    labelAr: 'مسحوب من المصنّع',
    family: 'EXPIRY',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['EXPIRE', 'DELETE', 'INSPECTION'],
    sortOrder: 40,
  },

  // ── Damage ───────────────────────────────────────────────────
  {
    code: 'DAMAGED_PACKAGING',
    labelEn: 'Damaged Packaging',
    labelAr: 'تلف العبوة',
    family: 'DAMAGE',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DAMAGE', 'DELETE', 'INSPECTION'],
    sortOrder: 40,
  },
  {
    code: 'PHYSICAL_DAMAGE',
    labelEn: 'Physical Damage / Broken',
    labelAr: 'تلف مادي / مكسور',
    family: 'DAMAGE',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DAMAGE', 'DELETE', 'INSPECTION'],
    sortOrder: 50,
  },
  {
    code: 'CONTAMINATION',
    labelEn: 'Contaminated (blood / body fluid)',
    labelAr: 'ملوّث (دم / سوائل الجسم)',
    family: 'DAMAGE',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DAMAGE', 'DELETE', 'INSPECTION'],
    sortOrder: 60,
  },
  {
    code: 'TEMPERATURE_EXCURSION',
    labelEn: 'Cold-chain / Temperature Breach',
    labelAr: 'خلل في سلسلة التبريد',
    family: 'DAMAGE',
    effect: 'LOSS',
    itemTypes: ['MEDICATION'],
    actions: ['DAMAGE', 'DELETE', 'INSPECTION'],
    sortOrder: 70,
  },
  {
    // A distinct verdict from "damaged": the item is intact but no longer fit
    // for use (expired consumable, worn-out kit, out-of-calibration device).
    // Kept separate so it can be written off during an inspection without
    // borrowing the "wasted/spilled" reason, which means something different.
    code: 'NO_LONGER_SERVICEABLE',
    labelEn: 'No Longer Serviceable',
    labelAr: 'لم يعد صالحاً للاستخدام',
    family: 'DAMAGE',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DAMAGE', 'DELETE', 'INSPECTION'],
    sortOrder: 75,
  },

  // ── Loss ─────────────────────────────────────────────────────
  {
    code: 'LOST_OPERATIONS',
    labelEn: 'Lost During Operations',
    labelAr: 'فُقد أثناء العمل الميداني',
    family: 'LOSS',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DELETE', 'INSPECTION'],
    sortOrder: 80,
  },
  {
    code: 'MISSING_UNKNOWN',
    labelEn: 'Missing — Unknown Reason',
    labelAr: 'مفقود — سبب غير معروف',
    family: 'LOSS',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DELETE', 'INSPECTION'],
    sortOrder: 90,
  },
  {
    code: 'MISFILED',
    labelEn: 'Misfiled / Misplaced',
    labelAr: 'وُضع في غير مكانه',
    family: 'LOSS',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DELETE', 'INSPECTION'],
    sortOrder: 100,
  },
  {
    code: 'SUSPECTED_THEFT',
    labelEn: 'Suspected Theft',
    labelAr: 'اشتباه سرقة',
    family: 'LOSS',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['DELETE', 'INSPECTION'],
    requiresReview: true,
    sortOrder: 110,
  },

  // ── Process ──────────────────────────────────────────────────
  {
    code: 'TRANSFERRED_UNIT',
    labelEn: 'Transferred to Another Unit',
    labelAr: 'نُقل إلى وحدة أخرى',
    family: 'PROCESS',
    effect: 'RELOCATION',
    itemTypes: BOTH,
    actions: ['TRANSFER', 'DELETE', 'INSPECTION'],
    sortOrder: 120,
  },
  {
    code: 'SENT_MAINTENANCE',
    labelEn: 'Sent for Maintenance / Repair',
    labelAr: 'أُرسل للصيانة / الإصلاح',
    family: 'PROCESS',
    effect: 'STATUS_HOLD',
    itemTypes: BOTH,
    actions: ['TRANSFER', 'DELETE', 'INSPECTION'],
    sortOrder: 130,
  },
  {
    code: 'DATA_CORRECTION',
    labelEn: 'Data Entry Correction',
    labelAr: 'تصحيح خطأ إدخال بيانات',
    family: 'PROCESS',
    effect: 'CORRECTION',
    itemTypes: BOTH,
    actions: ['ADJUST', 'DELETE'],
    sortOrder: 140,
  },

  // ── Accountability ───────────────────────────────────────────
  {
    code: 'NOT_CHECKED',
    labelEn: 'Not Checked During Inspection',
    labelAr: 'لم يُتحقق منه أثناء الجرد',
    family: 'ACCOUNTABILITY',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['INSPECTION', 'DELETE'],
    requiresReview: true,
    sortOrder: 150,
  },

  // ── Other ────────────────────────────────────────────────────
  {
    code: 'OTHER',
    labelEn: 'Other (specify)',
    labelAr: 'أخرى (حدّد)',
    family: 'OTHER',
    effect: 'LOSS',
    itemTypes: BOTH,
    actions: ['USE', 'DAMAGE', 'EXPIRE', 'TRANSFER', 'ADJUST', 'RETURN', 'DELETE', 'INSPECTION'],
    requiresNote: true,
    sortOrder: 900,
  },
];

export type StockReasonFilter = {
  itemType?: StockReasonItemType;
  action?: StockAction;
  includeInactive?: boolean;
};

/** Loads the catalog from the DB, optionally filtered by item type and action. */
export async function listStockReasons(prisma: PrismaClient, filter: StockReasonFilter = {}) {
  const where: Record<string, unknown> = {};
  if (!filter.includeInactive) where.isActive = true;
  if (filter.itemType) where.itemTypes = { has: filter.itemType };
  if (filter.action) where.actions = { has: filter.action };

  return prisma.stockReason.findMany({
    where,
    orderBy: [{ family: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
  });
}

/**
 * Idempotently seeds the catalog. Existing rows keep their `isActive` flag and
 * any admin-edited fields that are not part of the definition (labels ARE
 * refreshed from code so shipped wording stays authoritative).
 */
export async function syncStockReasons(prisma: PrismaClient) {
  let created = 0;
  for (const def of STOCK_REASONS) {
    const data = {
      labelEn: def.labelEn,
      labelAr: def.labelAr,
      family: def.family,
      effect: def.effect,
      itemTypes: def.itemTypes,
      actions: def.actions,
      requiresNote: def.requiresNote ?? false,
      requiresReview: def.requiresReview ?? false,
      sortOrder: def.sortOrder ?? 0,
    };
    const existing = await prisma.stockReason.findUnique({ where: { code: def.code } });
    if (existing) {
      await prisma.stockReason.update({ where: { code: def.code }, data });
    } else {
      await prisma.stockReason.create({ data: { code: def.code, ...data } });
      created++;
    }
  }
  return { total: STOCK_REASONS.length, created };
}
