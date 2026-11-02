import type { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { classifyExpiry } from '../utils/fefo.js';
import {
  effectiveBatchNumber,
  effectiveExpiryDate,
  effectiveReceivedDate,
  effectiveSupplier,
  hasLotOverride,
} from '../utils/lotOverrides.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';
import * as notificationService from './notification.service.js';

type Tx = Prisma.TransactionClient;
const MAX_LEGACY_INVENTORY_ROWS = 5_000;

export interface InventoryOperationMeta extends AuditEntryInput {}

const INVENTORY_DETAIL = {
  id: true,
  ambulanceId: true,
  quantity: true,
  notes: true,
  overrideBatchNumber: true,
  overrideExpiryDate: true,
  overrideSupplier: true,
  overrideReceivedDate: true,
  deletedAt: true,
  updatedAt: true,
  batch: {
    select: {
      id: true,
      batchNumber: true,
      expiryDate: true,
      receivedDate: true,
      supplier: true,
      medicine: {
        select: {
          id: true,
          name: true,
          category: true,
          strength: true,
          dosageForm: true,
          size: true,
          unit: true,
          location: true,
          serialNumber: true,
          notes: true,
          technicalNotes: true,
          barcode: true,
        },
      },
    },
  },
  ambulance: { select: { id: true, vehicleNumber: true, station: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.InventorySelect;

type InventoryDetail = Prisma.InventoryGetPayload<{ select: typeof INVENTORY_DETAIL }>;

/**
 * Collapses per-unit lot overrides into the `batch` sub-object so every reader
 * (including the web app) transparently sees the effective lot number / expiry /
 * supplier / received date. `batch.id` and `batch.medicine` stay the shared ones
 * (stock operations still target the real batch), and `hasLotOverride` lets the
 * UI flag a line the unit has customised.
 */
function toEffectiveLot(row: InventoryDetail) {
  return {
    ...row,
    batch: {
      ...row.batch,
      batchNumber: effectiveBatchNumber(row, row.batch),
      expiryDate: effectiveExpiryDate(row, row.batch),
      supplier: effectiveSupplier(row, row.batch),
      receivedDate: effectiveReceivedDate(row, row.batch),
    },
    hasLotOverride: hasLotOverride(row),
    expiryStatus: classifyExpiry(effectiveExpiryDate(row, row.batch)),
  };
}

/**
 * Locks inventory rows in a deterministic order (sorted by id) to prevent
 * deadlocks when multiple transactions touch overlapping rows.
 */
async function lockInventoryRows(tx: Tx, ids: string[]): Promise<void> {
  const sorted = [...new Set(ids)].sort();
  for (const id of sorted) {
    await tx.$queryRaw`SELECT "id" FROM "Inventory" WHERE "id" = ${id} FOR UPDATE`;
  }
}

async function lockInventory(tx: Tx, id: string): Promise<InventoryDetail> {
  await lockInventoryRows(tx, [id]);
  const row = await tx.inventory.findFirst({
    where: { id, deletedAt: null },
    select: INVENTORY_DETAIL,
  });
  if (!row) throw AppError.notFound('Inventory record not found');
  return row;
}

async function recordChange(
  tx: Tx,
  inventoryId: string,
  type: TransactionType,
  delta: number,
  reason: string | null,
  referenceId: string,
  performedById: string,
  reasonCode: string | null = null,
): Promise<InventoryDetail> {
  const updated = await tx.inventory.update({
    where: { id: inventoryId },
    data: { quantity: { increment: delta } },
    select: INVENTORY_DETAIL,
  });

  await tx.inventoryTransaction.create({
    data: {
      inventoryId,
      transactionType: type,
      quantityChange: delta,
      quantityBefore: updated.quantity - delta,
      quantityAfter: updated.quantity,
      reason,
      reasonCode,
      referenceId,
      performedById,
    },
  });

  return toEffectiveLot(updated);
}

function assertPositiveQuantity(qty: number): void {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw AppError.badRequest('Quantity must be a positive integer');
  }
}

// ── Reads ──────────────────────────────────────────────────────

export async function getInventoryDetail(id: string) {
  const row = await prisma.inventory.findUnique({ where: { id }, select: INVENTORY_DETAIL });
  if (!row) throw AppError.notFound('Inventory record not found');
  return toEffectiveLot(row);
}

export interface ListInventoryInput {
  ambulanceId?: string;
  stationIds?: string[];
  medicineId?: string;
  category?: string;
  search?: string;
  includeEmpty?: boolean;
}

export interface ListInventoryPageInput extends ListInventoryInput {
  page: number;
  pageSize: number;
}

function inventoryWhere(input: ListInventoryInput): Prisma.InventoryWhereInput {
  const batchFilters: Prisma.MedicineBatchWhereInput[] = [
    { deletedAt: null },
    { medicine: { deletedAt: null } },
  ];
  if (input.medicineId) batchFilters.push({ medicineId: input.medicineId });
  if (input.category) batchFilters.push({ medicine: { category: input.category as never } });
  if (input.search) {
    batchFilters.push({
      medicine: {
        OR: [
          { name: { contains: input.search, mode: 'insensitive' } },
          { genericName: { contains: input.search, mode: 'insensitive' } },
        ],
      },
    });
  }

  return {
    ...(input.ambulanceId ? { ambulanceId: input.ambulanceId } : {}),
    ...(input.stationIds ? { ambulance: { stationId: { in: input.stationIds } } } : {}),
    deletedAt: null,
    batch: { AND: batchFilters },
    ...(input.includeEmpty ? {} : { quantity: { gt: 0 } }),
  };
}

function sortEffectiveInventory<T extends { batch: { expiryDate: Date }; ambulanceId: string }>(rows: T[]): T[] {
  return rows.sort(
    (a, b) =>
      a.batch.expiryDate.getTime() - b.batch.expiryDate.getTime() ||
      a.ambulanceId.localeCompare(b.ambulanceId),
  );
}

export async function listInventory(input: ListInventoryInput = {}) {
  const rows = await prisma.inventory.findMany({
    where: inventoryWhere(input),
    select: INVENTORY_DETAIL,
    take: MAX_LEGACY_INVENTORY_ROWS + 1,
  });
  if (rows.length > MAX_LEGACY_INVENTORY_ROWS) {
    throw AppError.conflict(
      `This inventory is too large for an unpaged response. Request page/pageSize (maximum ${MAX_LEGACY_INVENTORY_ROWS} legacy rows).`,
    );
  }

  // Sort on the EFFECTIVE expiry (override first, else shared batch) so a unit's
  // corrected date drives display order, not just the shared batch date.
  return sortEffectiveInventory(rows.map(toEffectiveLot));
}

/** Bounded inventory page for clients loading a large station/fleet. */
export async function listInventoryPage(input: ListInventoryPageInput) {
  const where = inventoryWhere(input);
  const pageQuery = prisma.inventory.findMany({
    where,
    orderBy: [{ ambulanceId: 'asc' }, { id: 'asc' }],
    skip: (input.page - 1) * input.pageSize,
    take: input.pageSize,
    select: INVENTORY_DETAIL,
  });
  // Count once on page one; repeating COUNT(*) on every page makes bulk loads
  // needlessly expensive as the inventory table grows.
  const [total, rows] = input.page === 1
    ? await prisma.$transaction([prisma.inventory.count({ where }), pageQuery])
    : [null, await pageQuery] as const;

  return {
    items: sortEffectiveInventory(rows.map(toEffectiveLot)),
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}

// ── USE (FEFO) ─────────────────────────────────────────────────

export interface UseMedicineInput {
  ambulanceId: string;
  medicineId: string;
  quantity: number;
  reason: string;
  reasonCode?: string | null;
  performedById: string;
  meta?: InventoryOperationMeta;
}

export interface Consumption {
  inventoryId: string;
  batchId: string;
  batchNumber: string;
  expiryDate: Date;
  quantity: number;
}

export async function useMedicine(input: UseMedicineInput) {
  assertPositiveQuantity(input.quantity);
  if (!input.reason?.trim()) throw AppError.badRequest('A reason is required when using medicine');

  const referenceId = crypto.randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const ambulance = await tx.ambulance.findUnique({
      where: { id: input.ambulanceId },
      include: { station: { select: { id: true, code: true, name: true } } },
    });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const candidates = await tx.inventory.findMany({
      where: {
        ambulanceId: input.ambulanceId,
        deletedAt: null,
        batch: { medicineId: input.medicineId, isActive: true, deletedAt: null },
        quantity: { gt: 0 },
      },
      select: { id: true },
    });

    if (candidates.length === 0) {
      throw AppError.conflict('Insufficient stock for this medicine');
    }

    const ids = candidates.map((c) => c.id);
    await lockInventoryRows(tx, ids);

    const rows = await tx.inventory.findMany({
      where: { id: { in: ids } },
      select: INVENTORY_DETAIL,
    });

    // FEFO on the EFFECTIVE expiry per unit (override first, else shared batch).
    const ordered = rows
      .map(toEffectiveLot)
      .sort((a, b) => a.batch.expiryDate.getTime() - b.batch.expiryDate.getTime() || a.id.localeCompare(b.id));

    const available = ordered.reduce((sum, r) => sum + r.quantity, 0);
    if (available < input.quantity) {
      throw AppError.conflict(
        `Insufficient stock: ${available} available, ${input.quantity} requested (FEFO order)`,
      );
    }

    let remaining = input.quantity;
    const consumed: Consumption[] = [];

    for (const row of ordered) {
      if (remaining <= 0) break;
      if (row.quantity <= 0) continue;

      const take = Math.min(remaining, row.quantity);
      await recordChange(tx, row.id, 'USE', -take, input.reason, referenceId, input.performedById, input.reasonCode ?? null);
      consumed.push({
        inventoryId: row.id,
        batchId: row.batch.id,
        batchNumber: row.batch.batchNumber,
        expiryDate: row.batch.expiryDate,
        quantity: take,
      });
      remaining -= take;
    }

    await createAudit(tx, {
      userId: input.performedById,
      action: 'USE_MEDICINE',
      entityType: 'Medicine',
      entityId: input.medicineId,
      ambulanceId: input.ambulanceId,
      stationId: ambulance.stationId,
      metadata: {
        referenceId,
        quantity: input.quantity,
        reason: input.reason,
        consumed,
      },
      ...input.meta,
    });

    const remainingAfter = available - input.quantity;
    return {
      payload: { referenceId, consumed, quantity: input.quantity, remaining: remainingAfter },
      stockUnavailable: remainingAfter === 0 ? {
        stationId: ambulance.stationId,
        stationName: ambulance.station.name,
        stationCode: ambulance.station.code,
        ambulanceId: ambulance.id,
        ambulanceNumber: ambulance.vehicleNumber,
        medicineId: input.medicineId,
        medicineName: ordered[0]?.batch.medicine.name ?? input.medicineId,
        category: ordered[0]?.batch.medicine.category ?? 'MEDICATION',
        actorId: input.performedById,
        referenceId,
      } : null,
    };
  });
  if (result.stockUnavailable) await notificationService.notifyStockUnavailable(result.stockUnavailable);
  return result.payload;
}

// ── RESTOCK ────────────────────────────────────────────────────

export interface RestockInput {
  ambulanceId: string;
  batchId: string;
  quantity: number;
  reason?: string | null;
  reasonCode?: string | null;
  performedById: string;
  meta?: InventoryOperationMeta;
}

export async function restock(input: RestockInput) {
  assertPositiveQuantity(input.quantity);
  const referenceId = crypto.randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.medicineBatch.findUnique({ where: { id: input.batchId }, include: { medicine: true } });
    if (!batch || batch.deletedAt || batch.medicine.deletedAt) throw AppError.notFound('Batch not found');
    if (!batch.isActive) throw AppError.conflict('Batch is deactivated');

    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const stockBefore = await tx.inventory.aggregate({
      where: {
        ambulanceId: input.ambulanceId,
        deletedAt: null,
        batch: { medicineId: batch.medicineId, isActive: true, deletedAt: null },
      },
      _sum: { quantity: true },
    });

    const inventory = await tx.inventory.upsert({
      where: { ambulanceId_batchId: { ambulanceId: input.ambulanceId, batchId: input.batchId } },
      create: { ambulanceId: input.ambulanceId, batchId: input.batchId, quantity: input.quantity },
      update: { quantity: { increment: input.quantity }, deletedAt: null },
      select: INVENTORY_DETAIL,
    });

    await tx.inventoryTransaction.create({
      data: {
        inventoryId: inventory.id,
        transactionType: 'RESTOCK',
        quantityChange: input.quantity,
        quantityBefore: inventory.quantity - input.quantity,
        quantityAfter: inventory.quantity,
        reason: input.reason ?? null,
        reasonCode: input.reasonCode ?? null,
        referenceId,
        performedById: input.performedById,
      },
    });

    await createAudit(tx, {
      userId: input.performedById,
      action: 'RESTOCK',
      entityType: 'MedicineBatch',
      entityId: batch.id,
      ambulanceId: input.ambulanceId,
      stationId: ambulance.stationId,
      metadata: {
        referenceId,
        medicineName: batch.medicine.name,
        batchNumber: batch.batchNumber,
        quantity: input.quantity,
        reason: input.reason ?? null,
      },
      ...input.meta,
    });

    return { payload: toEffectiveLot(inventory), restoreUnavailable: (stockBefore._sum.quantity ?? 0) === 0 };
  });
  if (result.restoreUnavailable) await notificationService.resolveStockUnavailable(input.ambulanceId, result.payload.batch.medicine.id);
  return result.payload;
}

// ── ADJUST ─────────────────────────────────────────────────────

export interface AdjustInput {
  inventoryId: string;
  newQuantity: number;
  reason: string;
  reasonCode?: string | null;
  performedById: string;
  meta?: InventoryOperationMeta;
}

export async function adjustQuantity(input: AdjustInput) {
  if (!Number.isInteger(input.newQuantity) || input.newQuantity < 0) {
    throw AppError.badRequest('New quantity must be a non-negative integer');
  }
  if (!input.reason?.trim()) throw AppError.badRequest('A reason is required for an adjustment');

  const referenceId = crypto.randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const inventory = await lockInventory(tx, input.inventoryId);
    const delta = input.newQuantity - inventory.quantity;
    if (delta === 0) {
      throw AppError.badRequest('New quantity equals current quantity; nothing to adjust');
    }

    const updated = await recordChange(
      tx,
      inventory.id,
      'ADJUSTMENT',
      delta,
      input.reason,
      referenceId,
      input.performedById,
      input.reasonCode ?? null,
    );

    const available = await tx.inventory.aggregate({
      where: {
        ambulanceId: inventory.ambulanceId,
        deletedAt: null,
        batch: { medicineId: inventory.batch.medicine.id, isActive: true, deletedAt: null },
      },
      _sum: { quantity: true },
    });
    const totalAvailable = available._sum.quantity ?? 0;

    await createAudit(tx, {
      userId: input.performedById,
      action: 'ADJUST_INVENTORY',
      entityType: 'Inventory',
      entityId: inventory.id,
      ambulanceId: inventory.ambulanceId,
      stationId: inventory.ambulance.station.id,
      metadata: {
        referenceId,
        medicineName: inventory.batch.medicine.name,
        batchNumber: inventory.batch.batchNumber,
        from: inventory.quantity,
        to: input.newQuantity,
        reason: input.reason,
      },
      ...input.meta,
    });

    return {
      payload: updated,
      stockUnavailable: input.newQuantity === 0 && totalAvailable === 0 ? {
        stationId: inventory.ambulance.station.id,
        stationName: inventory.ambulance.station.name,
        stationCode: inventory.ambulance.station.code,
        ambulanceId: inventory.ambulance.id,
        ambulanceNumber: inventory.ambulance.vehicleNumber,
        medicineId: inventory.batch.medicine.id,
        medicineName: inventory.batch.medicine.name,
        category: inventory.batch.medicine.category,
        actorId: input.performedById,
        referenceId,
      } : null,
      restoreUnavailable: inventory.quantity === 0 && totalAvailable > 0
        ? { ambulanceId: inventory.ambulance.id, medicineId: inventory.batch.medicine.id }
        : null,
    };
  });
  if (result.stockUnavailable) await notificationService.notifyStockUnavailable(result.stockUnavailable);
  if (result.restoreUnavailable) await notificationService.resolveStockUnavailable(result.restoreUnavailable.ambulanceId, result.restoreUnavailable.medicineId);
  return result.payload;
}

// ── NOTES / EXPIRY METADATA ────────────────────────────────────

export interface UpdateNotesInput {
  inventoryId: string;
  notes: string;
  reason: string;
  performedById: string;
  meta?: InventoryOperationMeta;
}

/** Updates the free-text note on a stock line (metadata only — never qty/expiry/name). */
export async function updateItemNotes(input: UpdateNotesInput) {
  return prisma.$transaction(async (tx) => {
    const inventory = await lockInventory(tx, input.inventoryId);
    const from = inventory.notes ?? null;
    const notes = input.notes || null;
    if (from === notes) {
      throw AppError.badRequest('Note is unchanged; nothing to save');
    }
    const updated = await tx.inventory.update({
      where: { id: inventory.id },
      data: { notes },
      select: INVENTORY_DETAIL,
    });
    await createAudit(tx, {
      userId: input.performedById,
      action: 'ADJUST_INVENTORY',
      entityType: 'Inventory',
      entityId: inventory.id,
      ambulanceId: inventory.ambulanceId,
      stationId: inventory.ambulance.station.id,
      metadata: {
        field: 'notes',
        from,
        to: notes,
        medicineName: inventory.batch.medicine.name,
        batchNumber: effectiveBatchNumber(inventory, inventory.batch),
        reason: input.reason,
      },
      ...input.meta,
    });
    return toEffectiveLot(updated);
  });
}

export interface UpdateExpiryInput {
  inventoryId: string;
  expiryDate: string;
  performedById: string;
  meta?: InventoryOperationMeta;
}

/**
 * Corrects the expiry date of a single stock line. This is now a PER-UNIT
 * override on the inventory row: the shared batch every other ambulance points
 * at is left untouched. Setting the date back to the shared batch value clears
 * the override so the unit inherits again.
 */
export async function updateItemExpiry(input: UpdateExpiryInput) {
  const newExpiry = new Date(`${input.expiryDate}T00:00:00.000Z`);
  if (Number.isNaN(newExpiry.getTime())) {
    throw AppError.badRequest('Invalid expiry date');
  }
  return prisma.$transaction(async (tx) => {
    const inventory = await lockInventory(tx, input.inventoryId);
    const from = effectiveExpiryDate(inventory, inventory.batch);
    if (from.getTime() === newExpiry.getTime()) {
      throw AppError.badRequest('Expiry date is unchanged; nothing to save');
    }
    const override = newExpiry.getTime() === inventory.batch.expiryDate.getTime() ? null : newExpiry;
    const updated = await tx.inventory.update({
      where: { id: inventory.id },
      data: { overrideExpiryDate: override },
      select: INVENTORY_DETAIL,
    });
    await createAudit(tx, {
      userId: input.performedById,
      action: 'ADJUST_INVENTORY',
      entityType: 'Inventory',
      entityId: inventory.id,
      ambulanceId: inventory.ambulanceId,
      stationId: inventory.ambulance.station.id,
      metadata: {
        field: 'expiryDate',
        from: from.toISOString().slice(0, 10),
        to: input.expiryDate,
        medicineName: inventory.batch.medicine.name,
        batchNumber: effectiveBatchNumber(inventory, inventory.batch),
        reason: 'Expiry date corrected (this unit only)',
      },
      ...input.meta,
    });
    return toEffectiveLot(updated);
  });
}

// ── PER-UNIT LOT OVERRIDES ─────────────────────────────────────

export interface UpdateStockLotInput {
  inventoryId: string;
  batchNumber?: string;
  expiryDate?: string;
  supplier?: string | null;
  receivedDate?: string | null;
  reason: string;
  performedById: string;
  meta?: InventoryOperationMeta;
}

/**
 * Edits the lot metadata (number / expiry / supplier / received date) for ONE
 * stock line. Overrides are written to the inventory row, so the change is
 * scoped to that ambulance: the shared batch everyone else stocked is untouched.
 * Passing a value that matches the shared batch clears that override. A reason
 * is mandatory and the from→to diff is written to the audit log.
 */
export async function updateStockLot(input: UpdateStockLotInput) {
  const reason = input.reason?.trim();
  if (!reason) throw AppError.badRequest('A reason is required to edit a lot');

  return prisma.$transaction(async (tx) => {
    const inventory = await lockInventory(tx, input.inventoryId);
    const data: Prisma.InventoryUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (input.batchNumber !== undefined) {
      const value = input.batchNumber.trim();
      if (!value) throw AppError.badRequest('Batch number cannot be empty');
      const current = effectiveBatchNumber(inventory, inventory.batch);
      // Setting the shared number back clears the override.
      const override = value === inventory.batch.batchNumber ? null : value;
      if (value !== current) {
        data.overrideBatchNumber = override;
        changes.batchNumber = { from: current, to: value };
      }
    }

    if (input.expiryDate !== undefined) {
      const value = new Date(`${input.expiryDate}T00:00:00.000Z`);
      if (Number.isNaN(value.getTime())) throw AppError.badRequest('Invalid expiry date');
      const current = effectiveExpiryDate(inventory, inventory.batch);
      const override = value.getTime() === inventory.batch.expiryDate.getTime() ? null : value;
      if (value.getTime() !== current.getTime()) {
        data.overrideExpiryDate = override;
        changes.expiryDate = { from: current.toISOString().slice(0, 10), to: input.expiryDate };
      }
    }

    if (input.supplier !== undefined) {
      const value = input.supplier?.trim() || null;
      const current = effectiveSupplier(inventory, inventory.batch);
      const override = value === (inventory.batch.supplier ?? null) ? null : value;
      if (value !== current) {
        data.overrideSupplier = override;
        changes.supplier = { from: current, to: value };
      }
    }

    if (input.receivedDate !== undefined) {
      const value = input.receivedDate ? new Date(`${input.receivedDate}T00:00:00.000Z`) : null;
      if (input.receivedDate && Number.isNaN(value!.getTime())) {
        throw AppError.badRequest('Invalid received date');
      }
      const current = effectiveReceivedDate(inventory, inventory.batch);
      const currentKey = current ? current.toISOString().slice(0, 10) : null;
      const nextKey = value ? input.receivedDate! : null;
      const sharedKey = inventory.batch.receivedDate
        ? inventory.batch.receivedDate.toISOString().slice(0, 10)
        : null;
      const override = nextKey === sharedKey ? null : value;
      if (nextKey !== currentKey) {
        data.overrideReceivedDate = override;
        changes.receivedDate = { from: currentKey, to: nextKey };
      }
    }

    if (Object.keys(data).length === 0) {
      throw AppError.badRequest('No changes to save');
    }

    const updated = await tx.inventory.update({
      where: { id: inventory.id },
      data,
      select: INVENTORY_DETAIL,
    });

    await createAudit(tx, {
      userId: input.performedById,
      action: 'UPDATE_STOCK_LOT',
      entityType: 'Inventory',
      entityId: inventory.id,
      ambulanceId: inventory.ambulanceId,
      stationId: inventory.ambulance.station.id,
      metadata: {
        medicineName: inventory.batch.medicine.name,
        batchId: inventory.batch.id,
        sharedBatchNumber: inventory.batch.batchNumber,
        changes,
        reason,
      },
      ...input.meta,
    });

    return toEffectiveLot(updated);
  });
}

// ── DAMAGED / EXPIRED / RETURN ─────────────────────────────────

interface RemoveStockInput {
  inventoryId: string;
  quantity: number;
  reason: string;
  reasonCode?: string | null;
  performedById: string;
  type: 'DAMAGED' | 'EXPIRED';
  meta?: InventoryOperationMeta;
}

async function removeStock(input: RemoveStockInput) {
  assertPositiveQuantity(input.quantity);
  if (!input.reason?.trim()) throw AppError.badRequest('A reason is required');

  const referenceId = crypto.randomUUID();
  const action = input.type === 'DAMAGED' ? 'DAMAGED' : 'PROCESS_EXPIRED';

  const result = await prisma.$transaction(async (tx) => {
    const inventory = await lockInventory(tx, input.inventoryId);
    if (input.quantity > inventory.quantity) {
      throw AppError.conflict(
        `Cannot remove ${input.quantity}: only ${inventory.quantity} in stock`,
      );
    }

    const updated = await recordChange(
      tx,
      inventory.id,
      input.type,
      -input.quantity,
      input.reason,
      referenceId,
      input.performedById,
      input.reasonCode ?? null,
    );

    const available = await tx.inventory.aggregate({
      where: {
        ambulanceId: inventory.ambulanceId,
        deletedAt: null,
        batch: { medicineId: inventory.batch.medicine.id, isActive: true, deletedAt: null },
      },
      _sum: { quantity: true },
    });

    await createAudit(tx, {
      userId: input.performedById,
      action,
      entityType: 'Inventory',
      entityId: inventory.id,
      ambulanceId: inventory.ambulanceId,
      stationId: inventory.ambulance.station.id,
      metadata: {
        referenceId,
        medicineName: inventory.batch.medicine.name,
        batchNumber: inventory.batch.batchNumber,
        quantity: input.quantity,
        reason: input.reason,
      },
      ...input.meta,
    });

    return {
      payload: updated,
      stockUnavailable: inventory.quantity > 0 && (available._sum.quantity ?? 0) === 0 ? {
        stationId: inventory.ambulance.station.id,
        stationName: inventory.ambulance.station.name,
        stationCode: inventory.ambulance.station.code,
        ambulanceId: inventory.ambulance.id,
        ambulanceNumber: inventory.ambulance.vehicleNumber,
        medicineId: inventory.batch.medicine.id,
        medicineName: inventory.batch.medicine.name,
        category: inventory.batch.medicine.category,
        actorId: input.performedById,
        referenceId,
      } : null,
    };
  });
  if (result.stockUnavailable) await notificationService.notifyStockUnavailable(result.stockUnavailable);
  return result.payload;
}

export function markDamaged(input: Omit<RemoveStockInput, 'type'>) {
  return removeStock({ ...input, type: 'DAMAGED' });
}

export function processExpired(input: Omit<RemoveStockInput, 'type'>) {
  return removeStock({ ...input, type: 'EXPIRED' });
}

// ── REMOVE STOCK LINE (single lot on a single car) ─────────────

export interface RemoveStockLineInput {
  inventoryId: string;
  reason?: string | null;
  reasonCode?: string | null;
  performedById: string;
  meta?: InventoryOperationMeta;
}

/**
 * Soft-deletes ONE stock line — a single lot/batch stocked on one ambulance.
 * Unlike deleting a medicine this never cascades: the medicine and all of its
 * other batches/lots stay untouched. Historical transactions keep resolving
 * because nothing is physically dropped.
 */
export async function removeStockLine(input: RemoveStockLineInput) {
  const referenceId = crypto.randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const inventory = await lockInventory(tx, input.inventoryId);
    if (inventory.deletedAt) throw AppError.notFound('Inventory record not found');
    const now = new Date();

    const updated = await tx.inventory.update({
      where: { id: inventory.id },
      data: { deletedAt: now },
      select: INVENTORY_DETAIL,
    });

    const available = await tx.inventory.aggregate({
      where: {
        ambulanceId: inventory.ambulanceId,
        deletedAt: null,
        batch: { medicineId: inventory.batch.medicine.id, isActive: true, deletedAt: null },
      },
      _sum: { quantity: true },
    });

    await createAudit(tx, {
      userId: input.performedById,
      action: 'DELETE_STOCK',
      entityType: 'Inventory',
      entityId: inventory.id,
      ambulanceId: inventory.ambulanceId,
      stationId: inventory.ambulance.station.id,
      metadata: {
        referenceId,
        medicineName: inventory.batch.medicine.name,
        batchId: inventory.batch.id,
        batchNumber: effectiveBatchNumber(inventory, inventory.batch),
        quantity: inventory.quantity,
        notes: inventory.notes ?? null,
        reason: input.reason ?? null,
        reasonCode: input.reasonCode ?? null,
      },
      ...input.meta,
    });

    return {
      payload: toEffectiveLot(updated),
      stockUnavailable: inventory.quantity > 0 && (available._sum.quantity ?? 0) === 0 ? {
        stationId: inventory.ambulance.station.id,
        stationName: inventory.ambulance.station.name,
        stationCode: inventory.ambulance.station.code,
        ambulanceId: inventory.ambulance.id,
        ambulanceNumber: inventory.ambulance.vehicleNumber,
        medicineId: inventory.batch.medicine.id,
        medicineName: inventory.batch.medicine.name,
        category: inventory.batch.medicine.category,
        actorId: input.performedById,
        referenceId,
      } : null,
    };
  });
  if (result.stockUnavailable) await notificationService.notifyStockUnavailable(result.stockUnavailable);
  return result.payload;
}

export interface ReturnInput {
  ambulanceId: string;
  batchId: string;
  quantity: number;
  reason?: string | null;
  reasonCode?: string | null;
  performedById: string;
  meta?: InventoryOperationMeta;
}

export async function returnStock(input: ReturnInput) {
  assertPositiveQuantity(input.quantity);
  const referenceId = crypto.randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.medicineBatch.findUnique({ where: { id: input.batchId }, include: { medicine: true } });
    if (!batch || batch.deletedAt || batch.medicine.deletedAt) throw AppError.notFound('Batch not found');

    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const stockBefore = await tx.inventory.aggregate({
      where: { ambulanceId: input.ambulanceId, deletedAt: null, batch: { medicineId: batch.medicineId, isActive: true, deletedAt: null } },
      _sum: { quantity: true },
    });

    const inventory = await tx.inventory.upsert({
      where: { ambulanceId_batchId: { ambulanceId: input.ambulanceId, batchId: input.batchId } },
      create: { ambulanceId: input.ambulanceId, batchId: input.batchId, quantity: input.quantity },
      update: { quantity: { increment: input.quantity }, deletedAt: null },
      select: INVENTORY_DETAIL,
    });

    await tx.inventoryTransaction.create({
      data: {
        inventoryId: inventory.id,
        transactionType: 'RETURN',
        quantityChange: input.quantity,
        quantityBefore: inventory.quantity - input.quantity,
        quantityAfter: inventory.quantity,
        reason: input.reason ?? null,
        reasonCode: input.reasonCode ?? null,
        referenceId,
        performedById: input.performedById,
      },
    });

    await createAudit(tx, {
      userId: input.performedById,
      action: 'RETURN',
      entityType: 'MedicineBatch',
      entityId: batch.id,
      ambulanceId: input.ambulanceId,
      stationId: ambulance.stationId,
      metadata: {
        referenceId,
        medicineName: batch.medicine.name,
        batchNumber: batch.batchNumber,
        quantity: input.quantity,
        reason: input.reason ?? null,
      },
      ...input.meta,
    });

    return { payload: toEffectiveLot(inventory), restoreUnavailable: (stockBefore._sum.quantity ?? 0) === 0 };
  });
  if (result.restoreUnavailable) await notificationService.resolveStockUnavailable(input.ambulanceId, result.payload.batch.medicine.id);
  return result.payload;
}

// ── INITIAL STOCK (seed/import) ────────────────────────────────

export interface InitialStockInput {
  ambulanceId: string;
  batchId: string;
  quantity: number;
  performedById: string;
  meta?: InventoryOperationMeta;
}

/** Seeding helper for batch-initialising stock (admin/import). */
export async function setInitialStock(input: InitialStockInput) {
  if (!Number.isInteger(input.quantity) || input.quantity < 0) {
    throw AppError.badRequest('Initial quantity must be a non-negative integer');
  }
  const referenceId = crypto.randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.medicineBatch.findUnique({ where: { id: input.batchId }, include: { medicine: true } });
    if (!batch || batch.deletedAt || batch.medicine.deletedAt) throw AppError.notFound('Batch not found');
    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const stockBefore = await tx.inventory.aggregate({
      where: { ambulanceId: input.ambulanceId, deletedAt: null, batch: { medicineId: batch.medicineId, isActive: true, deletedAt: null } },
      _sum: { quantity: true },
    });

    const inventory = await tx.inventory.upsert({
      where: { ambulanceId_batchId: { ambulanceId: input.ambulanceId, batchId: input.batchId } },
      create: { ambulanceId: input.ambulanceId, batchId: input.batchId, quantity: input.quantity },
      update: { quantity: input.quantity, deletedAt: null },
      select: INVENTORY_DETAIL,
    });

    await tx.inventoryTransaction.create({
      data: {
        inventoryId: inventory.id,
        transactionType: 'INITIAL_STOCK',
        quantityChange: input.quantity,
        quantityBefore: 0,
        quantityAfter: input.quantity,
        reason: 'Initial stock load',
        referenceId,
        performedById: input.performedById,
      },
    });

    await createAudit(tx, {
      userId: input.performedById,
      action: 'INITIAL_STOCK',
      entityType: 'Inventory',
      entityId: inventory.id,
      ambulanceId: input.ambulanceId,
      stationId: ambulance.stationId,
      metadata: { referenceId, quantity: input.quantity },
      ...input.meta,
    });

    return { payload: toEffectiveLot(inventory), restoreUnavailable: (stockBefore._sum.quantity ?? 0) === 0 && inventory.quantity > 0 };
  });
  if (result.restoreUnavailable) await notificationService.resolveStockUnavailable(input.ambulanceId, result.payload.batch.medicine.id);
  return result.payload;
}
