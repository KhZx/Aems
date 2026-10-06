import { Prisma, type MedicineCategory } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

type Tx = Prisma.TransactionClient;

export interface ImportBatchInput {
  batchNumber: string;
  expiryDate: string;
  receivedDate?: string | null;
  supplier?: string | null;
  quantity?: number;
  distribution?: { vehicle: string; quantity: number }[];
}

export interface ImportItemInput {
  name: string;
  category: MedicineCategory;
  size?: string | null;
  strength?: string | null;
  dosageForm?: string | null;
  genericName?: string | null;
  unit?: string | null;
  barcode?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  notes?: string | null;
  technicalNotes?: string | null;
  batches?: ImportBatchInput[];
}

export interface ImportItemResult {
  name: string;
  status: 'created' | 'restored' | 'merged';
  batches: number;
  units: number;
}

export interface ImportInventoryResult {
  items: { total: number; created: number; restored: number; merged: number };
  batches: { created: number; restored: number; merged: number };
  units: number;
  warnings: string[];
  statuses: ImportItemResult[];
}

export interface ImportInventoryInput {
  actorId: string;
  stationId: string;
  primaryAmbulanceId?: string | null;
  items: ImportItemInput[];
  meta?: AuditEntryInput;
}

type ItemStatus = 'created' | 'restored' | 'merged';
type BatchStatus = 'created' | 'restored' | 'merged';

/** Status per batchNumber for the returned per-item summary. */
interface BatchOutcome {
  status: BatchStatus;
  units: number;
}

/**
 * Imports an exported AEMS inventory file into the caller's station.
 *
 * Matching is identity-based (medicine = name + size + category; batch =
 * batchNumber within that medicine), so a file survives the "export → delete →
 * import" round trip: soft-deleted medicines/batches are restored in place,
 * newly-seen ones are created, and records that still exist are merged (stock
 * synchronised to the file without overwriting live batch metadata).
 *
 * Everything runs in a single transaction and is recorded as one audit entry.
 */
export async function importInventory(input: ImportInventoryInput): Promise<ImportInventoryResult> {
  const warnings: string[] = [];
  const statuses: ImportItemResult[] = [];
  const totals = { items: { total: 0, created: 0, restored: 0, merged: 0 }, batches: { created: 0, restored: 0, merged: 0 }, units: 0 };

  await prisma.$transaction(async (tx) => {
    const ambulances = await tx.ambulance.findMany({
      where: { stationId: input.stationId, status: 'ACTIVE' },
      select: { id: true, vehicleNumber: true },
      orderBy: { vehicleNumber: 'asc' },
    });
    if (ambulances.length === 0) {
      throw AppError.badRequest('This station has no active ambulance to receive stock');
    }

    const byVehicle = new Map(ambulances.map((a) => [a.vehicleNumber, a.id]));
    const primaryAmbulanceId =
      input.primaryAmbulanceId && ambulances.some((a) => a.id === input.primaryAmbulanceId)
        ? input.primaryAmbulanceId
        : ambulances[0].id;

    for (const item of input.items) {
      const { medicine, status } = await resolveMedicine(tx, item, warnings);
      const batchOutcomes: BatchOutcome[] = [];

      // Defensive de-dup: a hand-edited file may list the same LOT twice.
      const byBatch = new Map<string, ImportBatchInput>();
      for (const b of item.batches ?? []) {
        const existing = byBatch.get(b.batchNumber) ?? { ...b, quantity: b.quantity ?? 0, distribution: [] };
        existing.quantity = (existing.quantity ?? 0) + (b.quantity ?? 0);
        existing.distribution = [...(existing.distribution ?? []), ...(b.distribution ?? [])];
        byBatch.set(b.batchNumber, existing);
      }

      for (const batch of byBatch.values()) {
        const outcome = await syncBatch(tx, medicine.id, batch, byVehicle, primaryAmbulanceId, warnings);
        batchOutcomes.push({ status: outcome.status, units: outcome.units });
        totals.batches[outcome.status]++;
        totals.units += outcome.units;
      }

      const itemStatus: ItemStatus = status;
      totals.items[itemStatus]++;
      totals.items.total++;
      statuses.push({
        name: medicine.name,
        status: itemStatus,
        batches: batchOutcomes.length,
        units: batchOutcomes.reduce((s, b) => s + b.units, 0),
      });
    }

    await createAudit(tx, {
      userId: input.actorId,
      action: 'IMPORT_INVENTORY',
      entityType: 'Station',
      entityId: input.stationId,
      stationId: input.stationId,
      metadata: {
        items: totals.items,
        batches: totals.batches,
        units: totals.units,
        warnings,
        itemsImported: statuses.map((s) => `${s.name} (${s.status})`),
      },
      ...input.meta,
    });
  });

  return { ...totals, warnings, statuses };
}

/** Finds (or creates/restores) the medicine backing an imported item. */
async function resolveMedicine(
  tx: Tx,
  item: ImportItemInput,
  warnings: string[],
): Promise<{ medicine: { id: string; name: string; barcode: string | null }; status: ItemStatus }> {
  const identity = { name: item.name.trim(), size: item.size ?? null, category: item.category as MedicineCategory };

  const active = await tx.medicine.findFirst({ where: { ...identity, deletedAt: null } });
  if (active) {
    await applyBarcode(tx, active.id, item.barcode ?? null, warnings);
    return { medicine: { id: active.id, name: active.name, barcode: active.barcode }, status: 'merged' };
  }

  const deleted = await tx.medicine.findFirst({ where: { ...identity } });
  if (deleted) {
    await tx.medicine.update({
      where: { id: deleted.id },
      data: { deletedAt: null, isActive: true },
    });
    await applyBarcode(tx, deleted.id, item.barcode ?? null, warnings);
    return { medicine: { id: deleted.id, name: deleted.name, barcode: deleted.barcode }, status: 'restored' };
  }

  const created = await tx.medicine.create({
    data: {
      name: item.name.trim(),
      genericName: item.genericName ?? null,
      category: item.category,
      strength: item.strength ?? null,
      dosageForm: item.dosageForm ?? null,
      size: item.size ?? null,
      unit: item.unit ?? null,
      barcode: null,
      location: item.location ?? null,
      serialNumber: item.serialNumber ?? null,
      notes: item.notes ?? null,
      technicalNotes: item.technicalNotes ?? null,
      isActive: true,
    },
  });
  await applyBarcode(tx, created.id, item.barcode ?? null, warnings);
  return { medicine: { id: created.id, name: created.name, barcode: created.barcode }, status: 'created' };
}

/** Assigns the file's barcode so long as no other active medicine claims it. */
async function applyBarcode(tx: Tx, medicineId: string, desired: string | null, warnings: string[]) {
  if (!desired) return;
  const holder = await tx.medicine.findFirst({ where: { barcode: desired, deletedAt: null, id: { not: medicineId } } });
  if (holder) {
    warnings.push(`Barcode "${desired}" is already used by "${holder.name}"; import kept the existing code`);
    return;
  }
  await tx.medicine.update({ where: { id: medicineId }, data: { barcode: desired } });
}

/** Creates, restores or reconnects a batch, then sets exact stock from the file. */
async function syncBatch(
  tx: Tx,
  medicineId: string,
  batch: ImportBatchInput,
  byVehicle: Map<string, string>,
  primaryAmbulanceId: string,
  warnings: string[],
): Promise<{ status: BatchStatus; units: number }> {
  const key = { medicineId, batchNumber: batch.batchNumber.trim() };
  const expiry = new Date(`${batch.expiryDate}T00:00:00.000Z`);
  const received = batch.receivedDate ? new Date(`${batch.receivedDate}T00:00:00.000Z`) : null;

  const existing = await tx.medicineBatch.findUnique({ where: { medicineId_batchNumber: key } });

  let batchId: string;
  let status: BatchStatus;

  if (!existing) {
    const created = await tx.medicineBatch.create({
      data: {
        ...key,
        expiryDate: expiry,
        receivedDate: received,
        supplier: batch.supplier ?? null,
      },
    });
    batchId = created.id;
    status = 'created';
  } else if (existing.deletedAt) {
    await tx.medicineBatch.update({
      where: { id: existing.id },
      data: { deletedAt: null, isActive: true, expiryDate: expiry, receivedDate: received, supplier: batch.supplier ?? null },
    });
    batchId = existing.id;
    status = 'restored';
  } else {
    batchId = existing.id;
    status = 'merged';
  }

  const units = await syncStock(tx, batchId, batch, byVehicle, primaryAmbulanceId, warnings);
  return { status, units };
}

/**
 * Sets exact quantities from the file. `distribution` (per-vehicle) wins over
 * the plain `quantity` total; vehicles that don't exist in this station are
 * sent to the primary ambulance so no shelf fixture is silently lost.
 */
async function syncStock(
  tx: Tx,
  batchId: string,
  batch: ImportBatchInput,
  byVehicle: Map<string, string>,
  primaryAmbulanceId: string,
  warnings: string[],
): Promise<number> {
  const alloc = batch.distribution ?? [];
  let units = 0;

  if (alloc.length > 0) {
    let unmatched = 0;
    for (const a of alloc) {
      const ambulanceId = byVehicle.get(a.vehicle);
      if (a.quantity <= 0) continue;
      if (!ambulanceId) {
        unmatched += a.quantity;
        warnings.push(`Vehicle "${a.vehicle}" not found in this station; its ${a.quantity} units went to the primary unit`);
        continue;
      }
      await setStockRow(tx, ambulanceId, batchId, a.quantity);
      units += a.quantity;
    }
    if (unmatched > 0) {
      await setStockRow(tx, primaryAmbulanceId, batchId, unmatched);
      units += unmatched;
    }
  } else if ((batch.quantity ?? 0) > 0) {
    await setStockRow(tx, primaryAmbulanceId, batchId, batch.quantity!);
    units = batch.quantity!;
  }

  return units;
}

const IMPORT_TXN_REASON = 'Imported from AEMS backup file';

async function setStockRow(tx: Tx, ambulanceId: string, batchId: string, quantity: number) {
  const inventory = await tx.inventory.upsert({
    where: { ambulanceId_batchId: { ambulanceId, batchId } },
    create: { ambulanceId, batchId, quantity },
    update: { quantity, deletedAt: null },
  });

  // One INITIAL_STOCK ledger row per (file, stock line); re-importing the same
  // file mutates quantity again but only logs once so the ledger stays clean.
  const prior = await tx.inventoryTransaction.findFirst({
    where: {
      inventoryId: inventory.id,
      transactionType: 'INITIAL_STOCK',
      reason: IMPORT_TXN_REASON,
    },
  });
  if (!prior) {
    await tx.inventoryTransaction.create({
      data: {
        inventoryId: inventory.id,
        transactionType: 'INITIAL_STOCK',
        quantityChange: quantity,
        quantityBefore: 0,
        quantityAfter: quantity,
        reason: IMPORT_TXN_REASON,
        referenceId: crypto.randomUUID(),
        performedById: null,
      },
    });
  }
}