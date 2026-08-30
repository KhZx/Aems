import type { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { classifyExpiry } from '../utils/fefo.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

type Tx = Prisma.TransactionClient;

export interface InventoryOperationMeta extends AuditEntryInput {}

const INVENTORY_DETAIL = {
  id: true,
  ambulanceId: true,
  quantity: true,
  notes: true,
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
          unit: true,
          minimumStock: true,
          maximumStock: true,
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
  const row = await tx.inventory.findUnique({ where: { id }, select: INVENTORY_DETAIL });
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
      referenceId,
      performedById,
    },
  });

  return updated;
}

function assertPositiveQuantity(qty: number): void {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw AppError.badRequest('Quantity must be a positive integer');
  }
}

// ── Reads ──────────────────────────────────────────────────────

export async function getInventoryDetail(id: string): Promise<InventoryDetail> {
  const row = await prisma.inventory.findUnique({ where: { id }, select: INVENTORY_DETAIL });
  if (!row) throw AppError.notFound('Inventory record not found');
  return row;
}

export interface ListInventoryInput {
  ambulanceId?: string;
  stationIds?: string[];
  medicineId?: string;
  category?: string;
  search?: string;
  includeEmpty?: boolean;
}

export async function listInventory(input: ListInventoryInput = {}) {
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

  const where: Prisma.InventoryWhereInput = {
    ...(input.ambulanceId ? { ambulanceId: input.ambulanceId } : {}),
    ...(input.stationIds ? { ambulance: { stationId: { in: input.stationIds } } } : {}),
    batch: { AND: batchFilters },
    ...(input.includeEmpty ? {} : { quantity: { gt: 0 } }),
  };

  const rows = await prisma.inventory.findMany({
    where,
    select: INVENTORY_DETAIL,
    orderBy: [{ batch: { expiryDate: 'asc' } }, { ambulanceId: 'asc' }],
  });

  return rows.map((row) => ({
    ...row,
    expiryStatus: classifyExpiry(row.batch.expiryDate),
    lowStock: row.batch.medicine.minimumStock > 0 && row.quantity < row.batch.medicine.minimumStock,
    overStock: row.batch.medicine.maximumStock != null && row.quantity > row.batch.medicine.maximumStock,
  }));
}

// ── USE (FEFO) ─────────────────────────────────────────────────

export interface UseMedicineInput {
  ambulanceId: string;
  medicineId: string;
  quantity: number;
  reason: string;
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

  return prisma.$transaction(async (tx) => {
    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const candidates = await tx.inventory.findMany({
      where: {
        ambulanceId: input.ambulanceId,
        batch: { medicineId: input.medicineId, isActive: true, deletedAt: null },
        quantity: { gt: 0 },
      },
      select: { id: true },
      orderBy: [{ batch: { expiryDate: 'asc' } }, { id: 'asc' }],
    });

    if (candidates.length === 0) {
      throw AppError.conflict('Insufficient stock for this medicine');
    }

    const ids = candidates.map((c) => c.id);
    await lockInventoryRows(tx, ids);

    const rows = await tx.inventory.findMany({
      where: { id: { in: ids } },
      select: INVENTORY_DETAIL,
      orderBy: [{ batch: { expiryDate: 'asc' } }, { id: 'asc' }],
    });

    const available = rows.reduce((sum, r) => sum + r.quantity, 0);
    if (available < input.quantity) {
      throw AppError.conflict(
        `Insufficient stock: ${available} available, ${input.quantity} requested (FEFO order)`,
      );
    }

    let remaining = input.quantity;
    const consumed: Consumption[] = [];

    for (const row of rows) {
      if (remaining <= 0) break;
      if (row.quantity <= 0) continue;

      const take = Math.min(remaining, row.quantity);
      await recordChange(tx, row.id, 'USE', -take, input.reason, referenceId, input.performedById);
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

    return { referenceId, consumed, quantity: input.quantity, remaining: available - input.quantity };
  });
}

// ── RESTOCK ────────────────────────────────────────────────────

export interface RestockInput {
  ambulanceId: string;
  batchId: string;
  quantity: number;
  reason?: string | null;
  performedById: string;
  meta?: InventoryOperationMeta;
}

export async function restock(input: RestockInput) {
  assertPositiveQuantity(input.quantity);
  const referenceId = crypto.randomUUID();

  return prisma.$transaction(async (tx) => {
    const batch = await tx.medicineBatch.findUnique({ where: { id: input.batchId }, include: { medicine: true } });
    if (!batch || batch.deletedAt || batch.medicine.deletedAt) throw AppError.notFound('Batch not found');
    if (!batch.isActive) throw AppError.conflict('Batch is deactivated');

    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const inventory = await tx.inventory.upsert({
      where: { ambulanceId_batchId: { ambulanceId: input.ambulanceId, batchId: input.batchId } },
      create: { ambulanceId: input.ambulanceId, batchId: input.batchId, quantity: input.quantity },
      update: { quantity: { increment: input.quantity } },
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

    return inventory;
  });
}

// ── ADJUST ─────────────────────────────────────────────────────

export interface AdjustInput {
  inventoryId: string;
  newQuantity: number;
  reason: string;
  performedById: string;
  meta?: InventoryOperationMeta;
}

export async function adjustQuantity(input: AdjustInput) {
  if (!Number.isInteger(input.newQuantity) || input.newQuantity < 0) {
    throw AppError.badRequest('New quantity must be a non-negative integer');
  }
  if (!input.reason?.trim()) throw AppError.badRequest('A reason is required for an adjustment');

  const referenceId = crypto.randomUUID();

  return prisma.$transaction(async (tx) => {
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
    );

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

    return updated;
  });
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
        batchNumber: inventory.batch.batchNumber,
        reason: input.reason,
      },
      ...input.meta,
    });
    return updated;
  });
}

export interface UpdateExpiryInput {
  inventoryId: string;
  expiryDate: string;
  performedById: string;
  meta?: InventoryOperationMeta;
}

/**
 * Corrects the expiry date of the batch backing a stock line. The expiry lives
 * on the shared batch, so this changes it for every unit stocking that batch —
 * which is the desired behaviour for field crews fixing a mis-entered date.
 */
export async function updateItemExpiry(input: UpdateExpiryInput) {
  const newExpiry = new Date(`${input.expiryDate}T00:00:00.000Z`);
  if (Number.isNaN(newExpiry.getTime())) {
    throw AppError.badRequest('Invalid expiry date');
  }
  return prisma.$transaction(async (tx) => {
    const inventory = await lockInventory(tx, input.inventoryId);
    const from = inventory.batch.expiryDate;
    if (from.getTime() === newExpiry.getTime()) {
      throw AppError.badRequest('Expiry date is unchanged; nothing to save');
    }
    const updated = await tx.medicineBatch.update({
      where: { id: inventory.batch.id },
      data: { expiryDate: newExpiry },
      select: { id: true, batchNumber: true, expiryDate: true },
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
        batchNumber: inventory.batch.batchNumber,
        reason: 'Expiry date corrected',
      },
      ...input.meta,
    });
    return { ...updated, expiryDate: input.expiryDate };
  });
}

// ── DAMAGED / EXPIRED / RETURN ─────────────────────────────────

interface RemoveStockInput {
  inventoryId: string;
  quantity: number;
  reason: string;
  performedById: string;
  type: 'DAMAGED' | 'EXPIRED';
  meta?: InventoryOperationMeta;
}

async function removeStock(input: RemoveStockInput) {
  assertPositiveQuantity(input.quantity);
  if (!input.reason?.trim()) throw AppError.badRequest('A reason is required');

  const referenceId = crypto.randomUUID();
  const action = input.type === 'DAMAGED' ? 'DAMAGED' : 'PROCESS_EXPIRED';

  return prisma.$transaction(async (tx) => {
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
    );

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

    return updated;
  });
}

export function markDamaged(input: Omit<RemoveStockInput, 'type'>) {
  return removeStock({ ...input, type: 'DAMAGED' });
}

export function processExpired(input: Omit<RemoveStockInput, 'type'>) {
  return removeStock({ ...input, type: 'EXPIRED' });
}

export interface ReturnInput {
  ambulanceId: string;
  batchId: string;
  quantity: number;
  reason?: string | null;
  performedById: string;
  meta?: InventoryOperationMeta;
}

export async function returnStock(input: ReturnInput) {
  assertPositiveQuantity(input.quantity);
  const referenceId = crypto.randomUUID();

  return prisma.$transaction(async (tx) => {
    const batch = await tx.medicineBatch.findUnique({ where: { id: input.batchId }, include: { medicine: true } });
    if (!batch || batch.deletedAt || batch.medicine.deletedAt) throw AppError.notFound('Batch not found');

    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const inventory = await tx.inventory.upsert({
      where: { ambulanceId_batchId: { ambulanceId: input.ambulanceId, batchId: input.batchId } },
      create: { ambulanceId: input.ambulanceId, batchId: input.batchId, quantity: input.quantity },
      update: { quantity: { increment: input.quantity } },
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

    return inventory;
  });
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

  return prisma.$transaction(async (tx) => {
    const batch = await tx.medicineBatch.findUnique({ where: { id: input.batchId }, include: { medicine: true } });
    if (!batch || batch.deletedAt || batch.medicine.deletedAt) throw AppError.notFound('Batch not found');
    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const inventory = await tx.inventory.upsert({
      where: { ambulanceId_batchId: { ambulanceId: input.ambulanceId, batchId: input.batchId } },
      create: { ambulanceId: input.ambulanceId, batchId: input.batchId, quantity: input.quantity },
      update: { quantity: input.quantity },
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

    return inventory;
  });
}
