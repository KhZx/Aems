import { Prisma, type InspectionItemCondition, type InspectionStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';
import * as notificationService from './notification.service.js';

type Tx = Prisma.TransactionClient;

export interface InspectionItemReasonInput {
  code: string;
  quantity: number;
  notes?: string | null;
}

export interface InspectionItemInput {
  inventoryId: string;
  actualQuantity: number;
  condition?: InspectionItemCondition;
  reasonCode?: string | null;
  notes?: string | null;
  reasonLines?: InspectionItemReasonInput[];
  checkedDetail?: {
    expiryVerified?: boolean;
    packagingIntact?: boolean;
    quantityVerified?: boolean;
    notesRequired?: boolean;
  } | null;
}

export interface SaveInspectionInput {
  ambulanceId: string;
  title?: string | null;
  notes?: string | null;
  shiftCode?: string | null;
  items: InspectionItemInput[];
}

export type UpdateInspectionInput = Omit<SaveInspectionInput, 'ambulanceId'>;

const ITEM_TYPE_FOR_CATEGORY: Record<string, 'MEDICATION' | 'EQUIPMENT'> = {
  MEDICATION: 'MEDICATION',
};

function itemTypeFor(category: string): 'MEDICATION' | 'EQUIPMENT' {
  return ITEM_TYPE_FOR_CATEGORY[category] ?? 'EQUIPMENT';
}

/**
 * Validates and normalises inspection lines against live inventory and the
 * reason catalog. Runs inside the caller's transaction so the checks and the
 * writes are atomic. Returns the reason map for downstream review flags.
 */
async function resolveItems(tx: Tx, ambulanceId: string, items: InspectionItemInput[]): Promise<void> {
  const uniqueIds = [...new Set(items.map((i) => i.inventoryId))];

  const inventories = await tx.inventory.findMany({
    where: { id: { in: uniqueIds }, ambulanceId, deletedAt: null },
    select: { id: true, quantity: true, batch: { select: { medicine: { select: { category: true } } } } },
  });
  if (inventories.length !== uniqueIds.length) {
    throw AppError.badRequest('One or more lines do not belong to this ambulance (or were removed)');
  }
  const invById = new Map(inventories.map((inv) => [inv.id, inv]));

  const allCodes = new Set<string>();
  for (const item of items) {
    if (item.reasonCode) allCodes.add(item.reasonCode);
    for (const line of item.reasonLines ?? []) allCodes.add(line.code);
  }
  const reasonCodes = [...allCodes];
  const reasons = reasonCodes.length
    ? await tx.stockReason.findMany({ where: { code: { in: reasonCodes } } })
    : [];
  const reasonByCode = new Map(reasons.map((r) => [r.code, r]));

  const validateReason = (code: string, itemType: 'MEDICATION' | 'EQUIPMENT', note: string | null | undefined) => {
    const reason = reasonByCode.get(code);
    if (!reason || !reason.isActive) throw AppError.badRequest(`Unknown reason: ${code}`);
    if (!reason.actions.includes('INSPECTION')) {
      throw AppError.badRequest(`Reason ${code} cannot be used during an inspection`);
    }
    if (!reason.itemTypes.includes(itemType)) {
      throw AppError.badRequest(`Reason ${code} does not apply to ${itemType.toLowerCase()} items`);
    }
    if (reason.requiresNote && !note?.trim()) {
      throw AppError.badRequest(`A note is required for reason ${code}`);
    }
  };

  for (const item of items) {
    const inv = invById.get(item.inventoryId);
    if (!inv) throw AppError.badRequest('Unknown inventory line');

    const condition = item.condition ?? 'OK';
    const itemType = itemTypeFor(inv.batch.medicine.category);
    const lines = item.reasonLines ?? [];

    if (condition !== 'OK' && condition !== 'NOT_CHECKED' && lines.length === 0 && !item.reasonCode) {
      throw AppError.badRequest(`A reason is required for a line marked ${condition}`);
    }
    // A non-OK verdict normally has to affect at least one unit. The exception
    // is a line that is flagged with a reason but left on the books: equipment
    // found expired/damaged and still present is a real finding with no stock
    // movement, and the supervisor needs to see it. Requirement at line 98 still
    // forces a reason for every non-OK line, so nothing slips through unexplained.
    if (
      (condition === 'MISSING' ||
        condition === 'DAMAGED' ||
        condition === 'EXPIRED' ||
        condition === 'UNUSABLE' ||
        condition === 'EXTRA') &&
      Math.abs(item.actualQuantity - inv.quantity) === 0 &&
      lines.length === 0 &&
      !item.reasonCode
    ) {
      throw AppError.badRequest(
        `A line marked ${condition} must affect at least one unit, or carry a reason to record it as found`,
      );
    }

    if (lines.length) {
      // The split allocations must account for the whole discrepancy.
      const diff = item.actualQuantity - inv.quantity;
      const sum = lines.reduce((s, l) => s + l.quantity, 0);
      if (sum !== Math.abs(diff)) {
        throw AppError.badRequest('The split reasons must add up to the counted difference');
      }
      for (const line of lines) validateReason(line.code, itemType, line.notes ?? item.notes);
    }

    if (item.reasonCode) {
      validateReason(item.reasonCode, itemType, item.notes);
      // Reasons flagged for review leave the inspection in the review queue.
    }
  }
}

/** Persists the item rows for an inspection, replacing any existing ones. */
async function writeItems(tx: Tx, inspectionId: string, items: InspectionItemInput[]) {
  await tx.inspectionItem.deleteMany({ where: { inspectionId } });
  if (items.length === 0) return;

  const uniqueIds = [...new Set(items.map((i) => i.inventoryId))];
  const inventories = await tx.inventory.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, quantity: true },
  });
  const qtyById = new Map(inventories.map((inv) => [inv.id, inv.quantity]));

  for (const item of items) {
    const expected = qtyById.get(item.inventoryId) ?? 0;
    const condition = item.condition ?? 'OK';
    const actual = item.actualQuantity;
    const created = await tx.inspectionItem.create({
      data: {
        inspectionId,
        inventoryId: item.inventoryId,
        expectedQuantity: expected,
        actualQuantity: actual,
        difference: actual - expected,
        condition,
        reasonCode: item.reasonCode ?? null,
        notes: item.notes?.trim() || null,
      },
    });

    const lines = item.reasonLines ?? [];
    if (lines.length) {
      await tx.inspectionItemReason.createMany({
        data: lines.map((line, index) => ({
          inspectionItemId: created.id,
          reasonCode: line.code,
          quantity: line.quantity,
          notes: line.notes?.trim() || null,
          sortOrder: index,
        })),
      });
    }
  }
}

/** Recomputes item expectations + differences against current stock (no writes). */
async function refreshItemExpected(tx: Tx, inspectionId: string) {
  const items = await tx.inspectionItem.findMany({ where: { inspectionId } });
  for (const item of items) {
    const inv = await tx.inventory.findUnique({ where: { id: item.inventoryId } });
    if (!inv) continue;
    const difference = item.actualQuantity - inv.quantity;
    if (difference !== item.difference || inv.quantity !== item.expectedQuantity) {
      await tx.inspectionItem.update({
        where: { id: item.id },
        data: { expectedQuantity: inv.quantity, difference },
      });
    }
  }
}

// ── Draft lifecycle ─────────────────────────────────────────────

export async function createDraft(
  actorId: string,
  input: SaveInspectionInput,
  meta: AuditEntryInput = {},
) {
  return prisma.$transaction(async (tx) => {
    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    await resolveItems(tx, input.ambulanceId, input.items);

    const inspection = await tx.inspection.create({
      data: {
        ambulanceId: input.ambulanceId,
        performedById: actorId,
        status: 'DRAFT',
        title: input.title?.trim() || null,
        notes: input.notes?.trim() || null,
        shiftCode: input.shiftCode?.trim() || null,
      },
    });

    await writeItems(tx, inspection.id, input.items);
    await updateCounters(tx, inspection.id);

    await createAudit(tx, {
      userId: actorId,
      action: 'INSPECTION_DRAFT',
      entityType: 'Inspection',
      entityId: inspection.id,
      ambulanceId: input.ambulanceId,
      stationId: ambulance.stationId,
      metadata: { itemCount: input.items.length, title: input.title ?? null, reason: input.notes ?? null },
      ...meta,
    });

    return inspection;
  });
}

export async function updateDraft(
  id: string,
  input: UpdateInspectionInput,
  meta: AuditEntryInput = {},
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.inspection.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound('Inspection not found');
    if (existing.status !== 'DRAFT') throw AppError.conflict('Only drafts can be edited');

    await resolveItems(tx, existing.ambulanceId, input.items);

    const inspection = await tx.inspection.update({
      where: { id },
      data: {
        title: input.title !== undefined ? input.title?.trim() || null : undefined,
        notes: input.notes !== undefined ? input.notes?.trim() || null : undefined,
        shiftCode: input.shiftCode !== undefined ? input.shiftCode?.trim() || null : undefined,
      },
    });

    await writeItems(tx, id, input.items);
    await updateCounters(tx, id);

    await createAudit(tx, {
      userId: existing.performedById,
      action: 'INSPECTION_DRAFT_UPDATE',
      entityType: 'Inspection',
      entityId: id,
      ambulanceId: existing.ambulanceId,
      metadata: { itemCount: input.items.length, title: input.title ?? existing.title, reason: input.notes ?? existing.notes },
      ...meta,
    });

    return inspection;
  });
}

export async function deleteDraft(id: string, meta: AuditEntryInput = {}) {
  const existing = await prisma.inspection.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Inspection not found');
  if (existing.status !== 'DRAFT') throw AppError.conflict('Only drafts can be deleted');

  await prisma.inspection.delete({ where: { id } });
  await createAudit(prisma, {
    userId: existing.performedById,
    action: 'INSPECTION_DRAFT_DELETE',
    entityType: 'Inspection',
    entityId: id,
    ambulanceId: existing.ambulanceId,
    ...meta,
  });
  return { id };
}

/** Recomputes counted/total/correction counters for a draft. */
async function updateCounters(tx: Tx, inspectionId: string) {
  const inspection = await tx.inspection.findUnique({ where: { id: inspectionId } });
  if (!inspection) return;
  const [items, totalItems] = await Promise.all([
    tx.inspectionItem.findMany({ where: { inspectionId }, select: { condition: true, difference: true } }),
    tx.inventory.count({ where: { ambulanceId: inspection.ambulanceId, deletedAt: null } }),
  ]);
  const countedItems = items.filter((i) => i.condition !== 'NOT_CHECKED').length;
  const correctionCount = items.filter((i) => i.difference !== 0).length;
  await tx.inspection.update({
    where: { id: inspectionId },
    data: { countedItems, totalItems, correctionCount },
  });
}

// ── Completion (reconcile) ──────────────────────────────────────

export async function completeInspection(id: string, meta: AuditEntryInput = {}) {
  const completed = await prisma.$transaction(async (tx) => {
    const inspection = await tx.inspection.findUnique({ where: { id } });
    if (!inspection) throw AppError.notFound('Inspection not found');
    if (inspection.status !== 'DRAFT') throw AppError.conflict('Only drafts can be completed');

    const items = await tx.inspectionItem.findMany({ where: { inspectionId: id } });
    if (items.length === 0) throw AppError.badRequest('A draft must have at least one line to complete');

    // Lock the affected stock rows so a concurrent use/transfer cannot race.
    for (const item of items) {
      await tx.$queryRaw`SELECT "id" FROM "Inventory" WHERE "id" = ${item.inventoryId} FOR UPDATE`;
    }
    await refreshItemExpected(tx, id);

    const fresh = await tx.inspectionItem.findMany({ where: { inspectionId: id } });

    const previous = await tx.inspection.findFirst({
      where: {
        ambulanceId: inspection.ambulanceId,
        status: { in: ['COMPLETED', 'ACKNOWLEDGED'] },
        completedAt: { not: null },
      },
      orderBy: [{ completedAt: 'desc' }, { performedAt: 'desc' }],
      select: {
        id: true,
        items: { select: { inventoryId: true, actualQuantity: true, condition: true } },
      },
    });
    let comparison = { changedItems: 0, qtyDecreased: 0, qtyIncreased: 0 };
    if (previous) {
      const beforeByInventory = new Map(previous.items.map((item) => [item.inventoryId, item]));
      const seen = new Set<string>();
      for (const item of fresh) {
        const before = beforeByInventory.get(item.inventoryId);
        seen.add(item.inventoryId);
        if (!before) { comparison.changedItems += 1; continue; }
        const delta = item.actualQuantity - before.actualQuantity;
        if (delta !== 0 || item.condition !== before.condition) comparison.changedItems += 1;
        if (delta < 0) comparison.qtyDecreased += -delta;
        if (delta > 0) comparison.qtyIncreased += delta;
      }
      for (const item of previous.items) {
        if (!seen.has(item.inventoryId)) comparison.changedItems += 1;
      }
    }

    // Resolve human-readable names for the audit trail (audit metadata is the
    // only thing a supervisor sees, so it must stand on its own).
    const invMeta = await tx.inventory.findMany({
      where: { id: { in: fresh.map((i) => i.inventoryId) } },
      select: { id: true, batch: { select: { medicine: { select: { name: true } } } } },
    });
    const nameById = new Map(invMeta.map((i) => [i.id, i.batch.medicine.name]));

    // Split-reason allocations, grouped per item, for a self-contained audit row.
    const lineRows = await tx.inspectionItemReason.findMany({
      where: { inspectionItemId: { in: fresh.map((i) => i.id) } },
      orderBy: { sortOrder: 'asc' },
    });
    const linesByItem = new Map<string, Array<{ code: string | null; quantity: number; notes: string | null }>>();
    for (const line of lineRows) {
      const arr = linesByItem.get(line.inspectionItemId) ?? [];
      arr.push({ code: line.reasonCode, quantity: line.quantity, notes: line.notes });
      linesByItem.set(line.inspectionItemId, arr);
    }

    const corrections: Array<{ inventoryId: string; name: string; from: number; to: number; difference: number; reason: string | null; lines: Array<{ code: string | null; quantity: number; notes: string | null }> }> = [];
    const notChecked: string[] = [];

    for (const item of fresh) {
      if (item.condition === 'NOT_CHECKED') {
        notChecked.push(nameById.get(item.inventoryId) ?? item.inventoryId);
        continue;
      }
      if (item.difference === 0) continue;
      const before = item.expectedQuantity;
      const lines = linesByItem.get(item.id) ?? [];
      const primaryReason = item.reasonCode ?? lines[0]?.code ?? null;

      await tx.inventory.update({
        where: { id: item.inventoryId },
        data: { quantity: item.actualQuantity },
      });

      await tx.inventoryTransaction.create({
        data: {
          inventoryId: item.inventoryId,
          transactionType: 'INSPECTION_CORRECTION',
          quantityChange: item.difference,
          quantityBefore: before,
          quantityAfter: item.actualQuantity,
          reason: `Inspection ${id}`,
          reasonCode: primaryReason,
          referenceId: id,
          performedById: inspection.performedById,
        },
      });

      corrections.push({
        inventoryId: item.inventoryId,
        name: nameById.get(item.inventoryId) ?? item.inventoryId,
        from: before,
        to: item.actualQuantity,
        difference: item.difference,
        reason: primaryReason,
        lines,
      });
    }

    const checkedCount = fresh.filter((i) => i.condition !== 'NOT_CHECKED').length;
    const lost = corrections.filter((c) => c.difference < 0);
    const found = corrections.filter((c) => c.difference > 0);

    // The "inspection report" half of the audit entry: what the crew FOUND,
    // independent of the stock maths. These lists are what a supervisor reads
    // when deciding whether to acknowledge or void the adjustment below.
    const byCondition = (c: string) =>
      fresh.filter((i) => i.condition === c).map((i) => nameById.get(i.inventoryId) ?? i.inventoryId);
    const conditions = {
      missing: byCondition('MISSING'),
      damaged: byCondition('DAMAGED'),
      expired: byCondition('EXPIRED'),
      unusable: byCondition('UNUSABLE'),
      extra: byCondition('EXTRA'),
    };

    await tx.inspection.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await updateCounters(tx, id);

    const ambulance = await tx.ambulance.findUnique({
      where: { id: inspection.ambulanceId },
      include: { station: { select: { id: true, code: true, name: true } } },
    });

    await createAudit(tx, {
      userId: inspection.performedById,
      action: 'INSPECTION_COMPLETE',
      entityType: 'Inspection',
      entityId: id,
      ambulanceId: inspection.ambulanceId,
      stationId: ambulance?.stationId ?? null,
      metadata: {
        itemCount: fresh.length,
        checkedCount,
        notCheckedCount: notChecked.length,
        corrections,
        lost,
        found,
        notChecked,
        conditions,
        title: inspection.title,
        notes: inspection.notes,
        shiftCode: inspection.shiftCode,
      },
      ...meta,
    });

    const closed = await tx.inspection.findUnique({ where: { id } });
    return {
      result: { inspection: closed, corrections },
      notification: previous && comparison.changedItems > 0 && ambulance?.station
        ? {
            stationId: ambulance.station.id,
            stationName: ambulance.station.name,
            stationCode: ambulance.station.code,
            ambulanceNumber: ambulance.vehicleNumber,
            performedById: inspection.performedById,
            comparison,
            previousInspectionId: previous.id,
          }
        : null,
    };
  });

  if (completed.notification) {
    const n = completed.notification;
    await notificationService.notifyStationSupervisors(n.stationId, {
      type: 'INSPECTION_CHANGES',
      severity: n.comparison.qtyDecreased > 0 ? 'ACTION' : 'INFO',
      titleKey: 'notif.inspection_changes.title',
      bodyKey: 'notif.inspection_changes.body',
      dedupeKey: `inspection:${id}:changes`,
      entityType: 'Inspection',
      entityId: id,
      data: {
        unit: n.stationName || n.stationCode,
        ambulance: n.ambulanceNumber,
        changedItems: n.comparison.changedItems,
        qtyDecreased: n.comparison.qtyDecreased,
        qtyIncreased: n.comparison.qtyIncreased,
        inspectionId: id,
        previousInspectionId: n.previousInspectionId,
        page: 'inspections',
      },
    }, n.performedById);
  }
  return completed.result;
}

// ── Review (acknowledge / void) ─────────────────────────────────

export async function acknowledgeInspection(
  id: string,
  reviewerId: string,
  reviewNotes: string | null | undefined,
  meta: AuditEntryInput = {},
) {
  const inspection = await prisma.inspection.findUnique({ where: { id } });
  if (!inspection) throw AppError.notFound('Inspection not found');
  if (inspection.status !== 'COMPLETED') throw AppError.conflict('Only a completed inspection can be acknowledged');

  const updated = await prisma.inspection.update({
    where: { id },
    data: {
      status: 'ACKNOWLEDGED',
      reviewedById: reviewerId,
      reviewedAt: new Date(),
      reviewNotes: reviewNotes?.trim() || null,
    },
  });

  await createAudit(prisma, {
    userId: reviewerId,
    action: 'INSPECTION_ACKNOWLEDGE',
    entityType: 'Inspection',
    entityId: id,
    ambulanceId: updated.ambulanceId,
    metadata: { reviewNotes: reviewNotes ?? null, reason: reviewNotes ?? null, title: inspection.title },
    ...meta,
  });

  return updated;
}

export async function voidInspection(id: string, actorId: string, voidReason: string, meta: AuditEntryInput = {}) {
  return prisma.$transaction(async (tx) => {
    const inspection = await tx.inspection.findUnique({ where: { id } });
    if (!inspection) throw AppError.notFound('Inspection not found');
    if (inspection.status !== 'COMPLETED' && inspection.status !== 'ACKNOWLEDGED') {
      throw AppError.conflict('Only a completed or acknowledged inspection can be voided');
    }

    const items = await tx.inspectionItem.findMany({ where: { inspectionId: id, difference: { not: 0 } } });

    const reversals: Array<{ inventoryId: string; change: number }> = [];
    for (const item of items) {
      const inv = await tx.inventory.findUnique({ where: { id: item.inventoryId } });
      if (!inv) continue;
      const change = -item.difference; // undo the inspection's correction
      const newQty = Math.max(0, inv.quantity + change);
      const applied = newQty - inv.quantity;

      await tx.inventory.update({ where: { id: item.inventoryId }, data: { quantity: newQty } });
      await tx.inventoryTransaction.create({
        data: {
          inventoryId: item.inventoryId,
          transactionType: 'INSPECTION_CORRECTION',
          quantityChange: applied,
          quantityBefore: inv.quantity,
          quantityAfter: newQty,
          reason: `Inspection ${id} voided`,
          reasonCode: item.reasonCode ?? null,
          referenceId: id,
          performedById: actorId,
        },
      });
      reversals.push({ inventoryId: item.inventoryId, change: applied });
    }

    const updated = await tx.inspection.update({
      where: { id },
      data: {
        status: 'VOID',
        voidReason: voidReason.trim(),
        reviewedById: actorId,
        reviewedAt: new Date(),
      },
    });

    await createAudit(tx, {
      userId: actorId,
      action: 'INSPECTION_VOID',
      entityType: 'Inspection',
      entityId: id,
      ambulanceId: updated.ambulanceId,
      metadata: { voidReason, reason: voidReason, reversals, title: inspection.title },
      ...meta,
    });

    return updated;
  });
}

// ── Reads ───────────────────────────────────────────────────────

export interface ListInspectionsInput {
  ambulanceId?: string;
  stationIds?: string[];
  performedById?: string;
  status?: 'DRAFT' | 'COMPLETED' | 'ACKNOWLEDGED' | 'VOID';
  page?: number;
  pageSize?: number;
}

export async function listInspections(input: ListInspectionsInput = {}) {
  const { ambulanceId, stationIds, performedById, status, page = 1, pageSize = 50 } = input;

  const where: Prisma.InspectionWhereInput = {
    ...(ambulanceId ? { ambulanceId } : {}),
    ...(stationIds ? { ambulance: { stationId: { in: stationIds } } } : {}),
    ...(performedById ? { performedById } : {}),
    ...(status ? { status } : {}),
  };

  const [total, inspections] = await prisma.$transaction([
    prisma.inspection.count({ where }),
    prisma.inspection.findMany({
      where,
      orderBy: { performedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        ambulance: { select: { id: true, vehicleNumber: true, station: { select: { code: true, name: true } } } },
        performedBy: { select: { id: true, displayName: true } },
        reviewedBy: { select: { id: true, displayName: true } },
        _count: { select: { items: true } },
      },
    }),
  ]);

  return { total, page, pageSize, inspections };
}

export async function getInspection(id: string) {
  const inspection = await prisma.inspection.findUnique({
    where: { id },
    include: {
      ambulance: { select: { id: true, vehicleNumber: true, station: { select: { code: true, name: true } } } },
      performedBy: { select: { id: true, displayName: true, empId: true } },
      reviewedBy: { select: { id: true, displayName: true } },
      requests: { select: { id: true, status: true, quantity: true, medicine: { select: { name: true } } } },
      items: {
        include: {
          reason: { select: { code: true, labelEn: true, labelAr: true, family: true, requiresReview: true } },
          reasonLines: {
            include: { reason: { select: { code: true, labelEn: true, labelAr: true, family: true, requiresReview: true } } },
            orderBy: { sortOrder: 'asc' },
          },
          inventory: {
            select: {
              quantity: true,
              batch: {
                select: {
                  batchNumber: true,
                  expiryDate: true,
                  medicine: { select: { id: true, name: true, unit: true, category: true, size: true } },
                },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!inspection) throw AppError.notFound('Inspection not found');

  const previousInspection = inspection.completedAt
    ? await prisma.inspection.findFirst({
        where: {
          ambulanceId: inspection.ambulanceId,
          status: { in: ['COMPLETED', 'ACKNOWLEDGED'] },
          completedAt: { lt: inspection.completedAt },
        },
        orderBy: [{ completedAt: 'desc' }, { performedAt: 'desc' }],
        select: {
          id: true,
          status: true,
          performedAt: true,
          completedAt: true,
          performedBy: { select: { displayName: true } },
          items: {
            include: {
              reason: { select: { code: true, labelEn: true, labelAr: true, family: true } },
              reasonLines: {
                include: { reason: { select: { code: true, labelEn: true, labelAr: true, family: true } } },
                orderBy: { sortOrder: 'asc' },
              },
              inventory: {
                select: {
                  batch: {
                    select: {
                      batchNumber: true,
                      medicine: { select: { name: true, category: true, size: true } },
                    },
                  },
                },
              },
            },
            orderBy: { id: 'asc' },
          },
        },
      })
    : null;

  return { ...inspection, previousInspection };
}

// Backwards-compatible one-shot create used nowhere now but exported for tests.
export async function createInspection(input: {
  ambulanceId: string;
  notes?: string | null;
  items: InspectionItemInput[];
  performedById: string;
  meta?: AuditEntryInput;
}) {
  const draft = await createDraft(
    input.performedById,
    { ambulanceId: input.ambulanceId, notes: input.notes, items: input.items },
    input.meta,
  );
  return completeInspection(draft.id, input.meta);
}

// ── Supervisor overview (at-a-glance rollup) ────────────────────
//
// The supervisor sees one latest snapshot comparison per ambulance. The saved
// inspection itself remains immutable and item-level detail is fetched only
// when the supervisor opens it.

const OVERVIEW_STATUSES: InspectionStatus[] = ['COMPLETED', 'ACKNOWLEDGED'];
const OVERVIEW_MAX_INSPECTIONS = 500;

export interface InspectionOverviewInput {
  /** Station scope. `undefined` = every station (admin); `[]` = none. */
  stationIds?: string[];
  /** Narrow to a single unit (ignored when outside `stationIds`). */
  stationId?: string;
  /** Only count inspections performed at/after this instant. `null` = all time. */
  since?: Date | null;
  /** Overrides the default COMPLETED + ACKNOWLEDGED set. */
  statuses?: InspectionStatus[];
}

export interface InspectionOverviewInspection {
  id: string;
  status: string;
  performedAt: string;
  completedAt: string | null;
  stationId: string;
  stationCode: string;
  unitName: string;
  ambulanceNumber: string;
  performedById: string | null;
  performedByName: string | null;
  countedItems: number;
  totalItems: number;
  correctionCount: number;
}

export interface InspectionOverview {
  generatedAt: string;
  since: string | null;
  statuses: string[];
  inspections: InspectionOverviewInspection[];
  comparisons: InspectionOverviewComparison[];
}

export interface InspectionOverviewComparison {
  inspectionId: string;
  ambulanceId: string;
  ambulanceNumber: string;
  stationId: string;
  stationCode: string;
  unitName: string;
  performedAt: string;
  performedByName: string | null;
  previousInspectionId: string | null;
  previousPerformedAt: string | null;
  changedItems: number;
  qtyDecreased: number;
  qtyIncreased: number;
  addedItems: number;
  removedItems: number;
  currentItems: number;
  previousItems: number;
}

/** Latest completed snapshot versus the immediately preceding completed snapshot
 * for each ambulance. Ranking happens in PostgreSQL so this stays one bounded
 * query instead of an N+1 lookup per vehicle. Drafts and voided records never
 * become baselines. */
async function latestInspectionComparisons(
  stationScope: string[] | undefined,
  since: Date | null,
): Promise<InspectionOverviewComparison[]> {
  const stationClause = stationScope
    ? Prisma.sql`AND a."stationId" IN (${Prisma.join(stationScope)})`
    : Prisma.empty;
  const sinceClause = since
    ? Prisma.sql`AND current_row."completedAt" >= ${since}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<Array<{
    inspectionId: string;
    ambulanceId: string;
    ambulanceNumber: string;
    stationId: string;
    stationCode: string;
    unitName: string;
    performedAt: Date;
    performedByName: string | null;
    previousInspectionId: string | null;
    previousPerformedAt: Date | null;
    changedItems: number;
    qtyDecreased: number;
    qtyIncreased: number;
    addedItems: number;
    removedItems: number;
    currentItems: number;
    previousItems: number;
  }>>(Prisma.sql`
    WITH ranked AS (
      SELECT i."id", i."ambulanceId", i."performedAt", i."completedAt", i."performedById",
        ROW_NUMBER() OVER (
          PARTITION BY i."ambulanceId"
          ORDER BY i."completedAt" DESC, i."performedAt" DESC, i."id" DESC
        ) AS rank
      FROM "Inspection" i
      JOIN "Ambulance" a ON a."id" = i."ambulanceId"
      WHERE i."status"::text IN (${Prisma.join(OVERVIEW_STATUSES)})
        AND i."completedAt" IS NOT NULL
        ${stationClause}
    ),
    pairs AS (
      SELECT current_row."id" AS current_id,
        previous_row."id" AS previous_id,
        current_row."ambulanceId" AS ambulance_id,
        current_row."completedAt" AS current_at,
        previous_row."completedAt" AS previous_at,
        current_row."performedById" AS performed_by_id
      FROM ranked current_row
      LEFT JOIN ranked previous_row
        ON previous_row."ambulanceId" = current_row."ambulanceId"
        AND previous_row.rank = 2
      WHERE current_row.rank = 1
        ${sinceClause}
      ORDER BY current_row."completedAt" DESC, current_row."id" DESC
      LIMIT ${OVERVIEW_MAX_INSPECTIONS}
    ),
    item_deltas AS (
      SELECT p.current_id, c."inventoryId" AS inventory_id,
        c."actualQuantity" AS current_quantity,
        previous_item."actualQuantity" AS previous_quantity,
        c."condition"::text AS current_condition,
        previous_item."condition"::text AS previous_condition
      FROM pairs p
      JOIN "InspectionItem" c ON c."inspectionId" = p.current_id
      LEFT JOIN "InspectionItem" previous_item
        ON previous_item."inspectionId" = p.previous_id
        AND previous_item."inventoryId" = c."inventoryId"

      UNION ALL

      SELECT p.current_id, previous_item."inventoryId" AS inventory_id,
        NULL::integer AS current_quantity,
        previous_item."actualQuantity" AS previous_quantity,
        NULL::text AS current_condition,
        previous_item."condition"::text AS previous_condition
      FROM pairs p
      JOIN "InspectionItem" previous_item ON previous_item."inspectionId" = p.previous_id
      WHERE NOT EXISTS (
        SELECT 1 FROM "InspectionItem" c
        WHERE c."inspectionId" = p.current_id
          AND c."inventoryId" = previous_item."inventoryId"
      )
    )
    SELECT p.current_id AS "inspectionId",
      p.ambulance_id AS "ambulanceId",
      a."vehicleNumber" AS "ambulanceNumber",
      s."id" AS "stationId",
      s."code" AS "stationCode",
      s."name" AS "unitName",
      p.current_at AS "performedAt",
      performer."displayName" AS "performedByName",
      p.previous_id AS "previousInspectionId",
      p.previous_at AS "previousPerformedAt",
      (COUNT(d.inventory_id) FILTER (
        WHERE p.previous_id IS NOT NULL
          AND (d.current_quantity IS DISTINCT FROM d.previous_quantity
            OR d.current_condition IS DISTINCT FROM d.previous_condition)
      ))::integer AS "changedItems",
      COALESCE(SUM(GREATEST(d.previous_quantity - d.current_quantity, 0)) FILTER (
        WHERE d.current_quantity IS NOT NULL AND d.previous_quantity IS NOT NULL
      ), 0)::integer AS "qtyDecreased",
      COALESCE(SUM(GREATEST(d.current_quantity - d.previous_quantity, 0)) FILTER (
        WHERE d.current_quantity IS NOT NULL AND d.previous_quantity IS NOT NULL
      ), 0)::integer AS "qtyIncreased",
      (COUNT(d.inventory_id) FILTER (
        WHERE p.previous_id IS NOT NULL AND d.current_quantity IS NOT NULL AND d.previous_quantity IS NULL
      ))::integer AS "addedItems",
      (COUNT(d.inventory_id) FILTER (
        WHERE p.previous_id IS NOT NULL AND d.current_quantity IS NULL AND d.previous_quantity IS NOT NULL
      ))::integer AS "removedItems",
      (COUNT(d.inventory_id) FILTER (WHERE d.current_quantity IS NOT NULL))::integer AS "currentItems",
      (COUNT(d.inventory_id) FILTER (WHERE d.previous_quantity IS NOT NULL))::integer AS "previousItems"
    FROM pairs p
    JOIN "Ambulance" a ON a."id" = p.ambulance_id
    JOIN "Station" s ON s."id" = a."stationId"
    LEFT JOIN "User" performer ON performer."id" = p.performed_by_id
    LEFT JOIN item_deltas d ON d.current_id = p.current_id
    GROUP BY p.current_id, p.ambulance_id, a."vehicleNumber", s."id", s."code", s."name",
      p.current_at, performer."displayName", p.previous_id, p.previous_at
    ORDER BY p.current_at DESC
    LIMIT ${OVERVIEW_MAX_INSPECTIONS}
  `);

  return rows.map((row) => ({
    ...row,
    performedAt: row.performedAt.toISOString(),
    previousPerformedAt: row.previousPerformedAt?.toISOString() ?? null,
  }));
}

export async function inspectionOverview(
  input: InspectionOverviewInput = {},
): Promise<InspectionOverview> {
  const requestedStatuses = input.statuses?.length ? input.statuses : OVERVIEW_STATUSES;
  // Drafts are never historical comparison snapshots.
  const statuses = requestedStatuses.filter((status) => status !== 'DRAFT');
  const since = input.since ?? null;
  const sinceLabel = since ? since.toISOString() : null;

  let stationScope: string[] | undefined;
  if (input.stationId) {
    if (input.stationIds && !input.stationIds.includes(input.stationId)) stationScope = [];
    else stationScope = [input.stationId];
  } else {
    stationScope = input.stationIds;
  }

  const base: InspectionOverview = {
    generatedAt: new Date().toISOString(),
    since: sinceLabel,
    statuses,
    inspections: [],
    comparisons: [],
  };
  if ((stationScope && stationScope.length === 0) || statuses.length === 0) return base;

  const stationFilter: Prisma.AmbulanceWhereInput = stationScope
    ? { stationId: { in: stationScope } }
    : {};
  const inspectionWhere: Prisma.InspectionWhereInput = {
    status: { in: statuses },
    ...(since ? { completedAt: { gte: since } } : {}),
    ambulance: stationFilter,
  };

  const [inspections, comparisons] = await Promise.all([
    prisma.inspection.findMany({
      where: inspectionWhere,
      orderBy: [{ completedAt: 'desc' }, { performedAt: 'desc' }],
      take: OVERVIEW_MAX_INSPECTIONS,
      select: {
        id: true, status: true, performedAt: true, completedAt: true,
        countedItems: true, totalItems: true, correctionCount: true,
        ambulance: {
          select: {
            id: true, vehicleNumber: true,
            station: { select: { id: true, code: true, name: true } },
          },
        },
        performedBy: { select: { id: true, displayName: true } },
      },
    }),
    latestInspectionComparisons(stationScope, since),
  ]);

  base.inspections = inspections.map((inspection) => {
    const station = inspection.ambulance.station;
    return {
      id: inspection.id,
      status: inspection.status,
      performedAt: inspection.completedAt?.toISOString() ?? inspection.performedAt.toISOString(),
      completedAt: inspection.completedAt?.toISOString() ?? null,
      stationId: station?.id ?? '',
      stationCode: station?.code ?? '',
      unitName: station?.name ?? station?.code ?? '',
      ambulanceNumber: inspection.ambulance.vehicleNumber,
      performedById: inspection.performedBy?.id ?? null,
      performedByName: inspection.performedBy?.displayName ?? null,
      countedItems: inspection.countedItems,
      totalItems: inspection.totalItems,
      correctionCount: inspection.correctionCount,
    };
  });
  base.comparisons = comparisons;
  return base;
}
