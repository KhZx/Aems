import { Prisma, MedicineCategory } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

type Tx = Prisma.TransactionClient;

export interface DistributionBatchInput {
  batchNumber?: string | null;
  expiryDate: string;
  receivedDate?: string | null;
  supplier?: string | null;
  quantity: number;
}

export interface DistributionItemInput {
  name: string;
  category?: MedicineCategory;
  location?: string | null;
  serialNumber?: string | null;
  size?: string | null;
  barcode?: string | null;
  notes?: string | null;
  technicalNotes?: string | null;
  batches: DistributionBatchInput[];
}

export interface TemplateInput {
  name: string;
  description?: string | null;
  isActive?: boolean;
  items: DistributionItemInput[];
}

export interface AmbulanceApplyResult {
  stationId: string;
  stationCode: string;
  stationName: string;
  ambulanceId: string | null;
  vehicleNumber: string | null;
  status: 'applied' | 'skipped';
  reason?: string;
  itemsAdded: number;
  unitsAdded: number;
}

export interface ApplyDistributionResult {
  templateId: string;
  templateName: string;
  applied: AmbulanceApplyResult[];
  skipped: AmbulanceApplyResult[];
  totals: { stations: number; ambulances: number; items: number; units: number };
}

interface FlatItem {
  medicineId: string;
  name: string;
  batchNumber: string;
  expiryDate: Date;
  receivedDate: Date | null;
  supplier: string | null;
  quantity: number;
}

const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const norm = (s?: string | null) => (s || '').trim().toLowerCase();

/**
 * Resolves a medicine for a template item, mirroring the app's add-item flow:
 * an existing medicine with the same name (and size, if given) is reused; a
 * new Medicine record is created otherwise. The resolved id is stored on the
 * template item; the item also keeps a snapshot of the display fields.
 */
async function resolveMedicine(input: DistributionItemInput): Promise<string> {
  const nameN = norm(input.name);
  const where: Prisma.MedicineWhereInput = { name: { equals: input.name, mode: 'insensitive' }, deletedAt: null };
  const matches = await prisma.medicine.findMany({ where, select: { id: true, name: true, size: true }, take: 200 });
  const sameName = matches.filter((m) => norm(m.name) === nameN);
  if (sameName.length) {
    const sizeN = input.size ? norm(input.size) : null;
    if (sizeN) {
      const exact = sameName.find((m) => norm(m.size) === sizeN);
      if (exact) return exact.id;
    } else if (sameName.length === 1) {
      return sameName[0].id;
    }
  }
  const created = await prisma.medicine.create({
    data: {
      name: input.name.trim(),
      category: input.category ?? MedicineCategory.MEDICATION,
      size: input.size ?? null,
      location: input.location ?? null,
      serialNumber: input.serialNumber ?? null,
      barcode: input.barcode ?? null,
      notes: input.notes ?? null,
      technicalNotes: input.technicalNotes ?? null,
    },
  });
  return created.id;
}

function toBatchRow(batch: DistributionBatchInput, idx: number) {
  return {
    batchNumber: (batch.batchNumber || '').trim() || `TEMP-${Date.now().toString(36).toUpperCase()}-${idx}`,
    expiryDate: toDate(batch.expiryDate),
    receivedDate: batch.receivedDate ? toDate(batch.receivedDate) : null,
    supplier: batch.supplier ?? null,
    quantity: batch.quantity,
    sortOrder: idx,
  };
}

/**
 * Validates that every item can be stored: medicine id is resolved, at least
 * one batch is present (enforced by the validator), and batch numbers are
 * unique within the item.
 */
function validateItems(items: DistributionItemInput[]) {
  for (const item of items) {
    if (!item.name?.trim()) throw AppError.badRequest('Each item needs a name');
    if (!item.batches?.length) throw AppError.badRequest(`Item "${item.name}" needs at least one batch`);
    const lots = item.batches.map((b) => (b.batchNumber || '').trim() || '');
    if (new Set(lots.map((l) => l.toLowerCase())).size !== lots.length) {
      throw AppError.badRequest(`Item "${item.name}" has duplicate batch numbers`);
    }
  }
}

/**
 * Creates a distribution template (a prepared inventory list) plus its items.
 * Items mirror the app "Add Item" form: full medicine fields and multiple
 * batches. Templates are pure plans: no stock is touched until `applyTemplate`.
 */
export async function createTemplate(
  actorId: string,
  input: TemplateInput,
  meta?: AuditEntryInput,
) {
  validateItems(input.items);
  const itemRows = await Promise.all(
    input.items.map(async (item, idx) => {
      const medicineId = await resolveMedicine(item);
      return {
        sortOrder: idx,
        medicineId,
        name: item.name.trim(),
        category: item.category ?? MedicineCategory.MEDICATION,
        location: item.location ?? null,
        serialNumber: item.serialNumber ?? null,
        size: item.size ?? null,
        barcode: item.barcode ?? null,
        notes: item.notes ?? null,
        technicalNotes: item.technicalNotes ?? null,
        batches: { create: item.batches.map((b, bi) => toBatchRow(b, bi)) },
      };
    }),
  );

  const template = await prisma.distributionTemplate.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      isActive: input.isActive ?? true,
      items: { create: itemRows },
    },
    include: { items: { include: { batches: true } } },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'CREATE_DISTRIBUTION_TEMPLATE',
    entityType: 'DistributionTemplate',
    entityId: template.id,
    metadata: { name: template.name, items: template.items.length },
    ...meta,
  });

  return template;
}

/**
 * Updates a template. Since templates are plans (never fixtures), the items
 * are replaced wholesale; stock already applied via this template is untouched.
 */
export async function updateTemplate(
  actorId: string,
  id: string,
  input: TemplateInput,
  meta?: AuditEntryInput,
) {
  const existing = await prisma.distributionTemplate.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Distribution template not found');

  validateItems(input.items);
  const itemRows = await Promise.all(
    input.items.map(async (item, idx) => {
      const medicineId = await resolveMedicine(item);
      return {
        sortOrder: idx,
        medicineId,
        name: item.name.trim(),
        category: item.category ?? MedicineCategory.MEDICATION,
        location: item.location ?? null,
        serialNumber: item.serialNumber ?? null,
        size: item.size ?? null,
        barcode: item.barcode ?? null,
        notes: item.notes ?? null,
        technicalNotes: item.technicalNotes ?? null,
        batches: { create: item.batches.map((b, bi) => toBatchRow(b, bi)) },
      };
    }),
  );

  const template = await prisma.$transaction(async (tx) => {
    await tx.distributionTemplateItem.deleteMany({ where: { templateId: id } });
    return tx.distributionTemplate.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description ?? null,
        isActive: input.isActive ?? true,
        items: { create: itemRows },
      },
      include: { items: { include: { batches: true } } },
    });
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'UPDATE_DISTRIBUTION_TEMPLATE',
    entityType: 'DistributionTemplate',
    entityId: template.id,
    metadata: { name: template.name, items: template.items.length },
    ...meta,
  });

  return template;
}

/**
 * Deletes or archives a template. Templates that have been applied keep their
 * distribution history (FK constraint), so those are archived (isActive=false)
 * instead of hard-deleted.
 */
export async function deleteTemplate(actorId: string, id: string, meta?: AuditEntryInput) {
  const existing = await prisma.distributionTemplate.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { distributions: true } } },
  });
  if (!existing) throw AppError.notFound('Distribution template not found');

  let archived = false;
  if (existing._count.distributions > 0) {
    await prisma.distributionTemplate.update({ where: { id }, data: { isActive: false } });
    archived = true;
  } else {
    await prisma.distributionTemplate.delete({ where: { id } });
  }

  await createAudit(prisma, {
    userId: actorId,
    action: archived ? 'ARCHIVE_DISTRIBUTION_TEMPLATE' : 'DELETE_DISTRIBUTION_TEMPLATE',
    entityType: 'DistributionTemplate',
    entityId: id,
    metadata: { name: existing.name, archived },
    ...meta,
  });

  return { id, archived };
}

export async function listTemplates() {
  return prisma.distributionTemplate.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: {
          batches: { orderBy: { sortOrder: 'asc' } },
          medicine: { select: { id: true, name: true, size: true, category: true } },
        },
      },
      _count: { select: { distributions: true } },
    },
  });
}

/**
 * Applies a template to the selected stations. Each target station's own
 * ambulance receives the template's items as ADDED stock (batch reused/restored
 * by medicine+batchNumber), so other stations are never affected. Stations
 * without any ambulance are skipped and reported as warnings. After a
 * successful apply the template is auto-archived so it is not re-applied by
 * accident; the admin can flip it back to Active to reuse it.
 */
export async function applyTemplate(
  actorId: string,
  templateId: string,
  stationIds: string[],
  meta?: AuditEntryInput,
): Promise<ApplyDistributionResult> {
  const template = await prisma.distributionTemplate.findUnique({
    where: { id: templateId },
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { batches: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  });
  if (!template) throw AppError.notFound('Distribution template not found');
  if (!template.isActive) throw AppError.badRequest('This template is archived and cannot be applied');

  // Flatten items x batches into a list of (medicine, batch, quantity) rows.
  const flat: FlatItem[] = [];
  for (const item of template.items) {
    for (const batch of item.batches) {
      flat.push({
        medicineId: item.medicineId ?? '',
        name: item.name,
        batchNumber:
          (batch.batchNumber || '').trim() ||
          `LOT-${Date.now().toString(36).toUpperCase()}-${flat.length.toString(36)}`,
        expiryDate: batch.expiryDate,
        receivedDate: batch.receivedDate,
        supplier: batch.supplier,
        quantity: batch.quantity,
      });
    }
  }

  const stations = await prisma.station.findMany({
    where: { id: { in: stationIds } },
    include: { ambulances: { orderBy: { createdAt: 'asc' } } },
  });

  const applied: AmbulanceApplyResult[] = [];
  const skipped: AmbulanceApplyResult[] = [];
  const stockedStations = new Set<string>();
  let totalItems = 0;
  let totalUnits = 0;

  await prisma.$transaction(async (tx) => {
    for (const sid of stationIds) {
      const station = stations.find((s) => s.id === sid);
      if (!station) {
        skipped.push({ stationId: sid, stationCode: '—', stationName: 'Unknown station', ambulanceId: null, vehicleNumber: null, status: 'skipped', reason: 'Station not found', itemsAdded: 0, unitsAdded: 0 });
        continue;
      }

      // Every usable car in the unit gets the list — a unit usually has more
      // than one ambulance. Cars out of service are reported, not stocked.
      const usable = station.ambulances.filter((a) => a.status === 'ACTIVE');
      for (const inactive of station.ambulances.filter((a) => a.status !== 'ACTIVE')) {
        skipped.push({
          stationId: station.id,
          stationCode: station.code,
          stationName: station.name,
          ambulanceId: inactive.id,
          vehicleNumber: inactive.vehicleNumber,
          status: 'skipped',
          reason: `Vehicle is ${inactive.status.toLowerCase()}`,
          itemsAdded: 0,
          unitsAdded: 0,
        });
      }

      if (usable.length === 0) {
        skipped.push({ stationId: station.id, stationCode: station.code, stationName: station.name, ambulanceId: null, vehicleNumber: null, status: 'skipped', reason: 'No active ambulance for this station', itemsAdded: 0, unitsAdded: 0 });
        continue;
      }

      for (const ambulance of usable) {
        let unitsAdded = 0;
        let rowsApplied = 0;
        for (const row of flat) {
          if (!row.medicineId) continue;
          const qty = await addStockToAmbulance(tx, ambulance.id, row, template.name);
          unitsAdded += qty;
          rowsApplied += 1;
        }
        totalUnits += unitsAdded;
        totalItems += rowsApplied;
        stockedStations.add(station.id);

        applied.push({
          stationId: station.id,
          stationCode: station.code,
          stationName: station.name,
          ambulanceId: ambulance.id,
          vehicleNumber: ambulance.vehicleNumber,
          status: 'applied',
          itemsAdded: rowsApplied,
          unitsAdded,
        });

        await createAudit(tx, {
          userId: actorId,
          action: 'DISTRIBUTE_STOCK',
          entityType: 'Ambulance',
          entityId: ambulance.id,
          stationId: station.id,
          ambulanceId: ambulance.id,
          metadata: { templateName: template.name, templateId: template.id, batches: rowsApplied, units: unitsAdded },
          ...meta,
        });
      }

      await tx.distribution.create({
        data: { templateId: template.id, stationId: station.id, appliedById: actorId },
      });
    }
  });

  // The template stays usable: a standard fleet load-out is applied again the
  // next time stock needs topping up.
  return {
    templateId: template.id,
    templateName: template.name,
    applied,
    skipped,
    totals: {
      stations: stockedStations.size,
      ambulances: applied.length,
      items: totalItems,
      units: totalUnits,
    },
  };
}

/**
 * Adds `quantity` units of a (medicine, batch) row to an ambulance. The batch
 * is keyed by (medicine, batchNumber): existing active batches are reused,
 * soft-deleted ones are restored, unknown ones are created. Stock is ADDED
 * (incremented), never overwritten.
 */
async function addStockToAmbulance(
  tx: Tx,
  ambulanceId: string,
  row: FlatItem,
  templateName: string,
): Promise<number> {
  const key = { medicineId: row.medicineId, batchNumber: row.batchNumber.trim() };
  const existing = await tx.medicineBatch.findUnique({ where: { medicineId_batchNumber: key } });

  let batchId: string;
  if (!existing) {
    batchId = (
      await tx.medicineBatch.create({ data: { ...key, expiryDate: row.expiryDate, receivedDate: row.receivedDate, supplier: row.supplier } })
    ).id;
  } else if (existing.deletedAt) {
    await tx.medicineBatch.update({
      where: { id: existing.id },
      data: { deletedAt: null, isActive: true, expiryDate: row.expiryDate, receivedDate: row.receivedDate, supplier: row.supplier },
    });
    batchId = existing.id;
  } else {
    batchId = existing.id;
  }

  const inventory = await tx.inventory.upsert({
    where: { ambulanceId_batchId: { ambulanceId, batchId } },
    create: { ambulanceId, batchId, quantity: row.quantity },
    update: { quantity: { increment: row.quantity }, deletedAt: null },
  });

  await tx.inventoryTransaction.create({
    data: {
      inventoryId: inventory.id,
      transactionType: 'DISTRIBUTION',
      quantityChange: row.quantity,
      quantityBefore: row.quantity > inventory.quantity ? inventory.quantity - row.quantity : 0,
      quantityAfter: inventory.quantity,
      reason: `Admin distribution — ${templateName}`,
      referenceId: crypto.randomUUID(),
      performedById: null,
    },
  });

  return row.quantity;
}

export interface ListDistributionsInput {
  templateId?: string;
  stationId?: string;
  page?: number | string;
  pageSize?: number | string;
}

export async function listDistributions(input: ListDistributionsInput = {}) {
  const templateId = typeof input.templateId === 'string' ? input.templateId : undefined;
  const stationId = typeof input.stationId === 'string' ? input.stationId : undefined;
  const page = Math.max(1, parseInt(String(input.page ?? '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(String(input.pageSize ?? '50'), 10) || 50));
  const where: Prisma.DistributionWhereInput = {
    ...(templateId ? { templateId } : {}),
    ...(stationId ? { stationId } : {}),
  };

  const [total, distributions] = await prisma.$transaction([
    prisma.distribution.count({ where }),
    prisma.distribution.findMany({
      where,
      orderBy: { appliedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        template: { select: { id: true, name: true } },
        station: { select: { id: true, code: true, name: true } },
        appliedBy: { select: { id: true, displayName: true, email: true } },
      },
    }),
  ]);

  return { total, page, pageSize, distributions };
}