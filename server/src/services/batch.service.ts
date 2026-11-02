import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { classifyExpiry } from '../utils/fefo.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

export interface CreateBatchInput {
  medicineId: string;
  batchNumber: string;
  expiryDate: string; // ISO date
  receivedDate?: string | null;
  supplier?: string | null;
}

export async function createBatch(actorId: string, input: CreateBatchInput, meta: AuditEntryInput = {}) {
  const medicine = await prisma.medicine.findUnique({ where: { id: input.medicineId, deletedAt: null } });
  if (!medicine) throw AppError.notFound('Medicine not found');

  const batchNumber = input.batchNumber.trim();
  if (!batchNumber) throw AppError.badRequest('Batch number is required');

  const expiry = new Date(input.expiryDate);
  if (Number.isNaN(expiry.getTime())) throw AppError.badRequest('Invalid expiry date');

  const existing = await prisma.medicineBatch.findUnique({
    where: { medicineId_batchNumber: { medicineId: input.medicineId, batchNumber } },
  });
  if (existing && !existing.deletedAt) {
    throw AppError.conflict('Batch number already exists for this medicine');
  }

  const data: Prisma.MedicineBatchUncheckedCreateInput = {
    medicineId: input.medicineId,
    batchNumber,
    expiryDate: expiry,
    receivedDate: input.receivedDate ? new Date(input.receivedDate) : null,
    supplier: input.supplier ?? null,
    isActive: true,
    deletedAt: null,
  };

  // A soft-deleted batch is revived in place (same id) so historical
  // transactions keep pointing at it and the unique MRP-key stays intact.
  const batch = existing
    ? await prisma.medicineBatch.update({ where: { id: existing.id }, data })
    : await prisma.medicineBatch.create({ data });

  await createAudit(prisma, {
    userId: actorId,
    action: 'CREATE_BATCH',
    entityType: 'MedicineBatch',
    entityId: batch.id,
    metadata: {
      medicineId: input.medicineId,
      medicineName: medicine.name,
      batchNumber,
      expiryDate: batch.expiryDate.toISOString(),
      receivedDate: batch.receivedDate ? batch.receivedDate.toISOString() : null,
      supplier: batch.supplier ?? null,
    },
    ...meta,
  });

  return batch;
}

export interface UpdateBatchInput {
  batchNumber?: string;
  expiryDate?: string; // ISO date (YYYY-MM-DD)
  receivedDate?: string | null;
  supplier?: string | null;
  /** Mandatory: the batch is shared fleet-wide, so edits must be traceable. */
  reason: string;
}

/**
 * Edits a batch/lot. The supplier/expiry/received date and lot number live on
 * the shared batch record, so the change applies to every ambulance stocking
 * that lot. Field-level from→to values are captured in the audit trail along
 * with the required reason.
 */
export async function updateBatch(
  actorId: string,
  batchId: string,
  input: UpdateBatchInput,
  meta: AuditEntryInput = {},
) {
  const reason = input.reason?.trim();
  if (!reason) throw AppError.badRequest('A reason is required to edit a batch');

  const existing = await prisma.medicineBatch.findUnique({ where: { id: batchId } });
  if (!existing || existing.deletedAt) throw AppError.notFound('Batch not found');

  const data: Prisma.MedicineBatchUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (input.batchNumber !== undefined) {
    const batchNumber = input.batchNumber.trim();
    if (!batchNumber) throw AppError.badRequest('Batch number cannot be empty');
    if (batchNumber !== existing.batchNumber) {
      // A different live batch with the same number for this medicine would
      // violate the unique (medicineId, batchNumber) key (P2002).
      const clash = await prisma.medicineBatch.findUnique({
        where: { medicineId_batchNumber: { medicineId: existing.medicineId, batchNumber } },
      });
      if (clash && !clash.deletedAt && clash.id !== existing.id) {
        throw AppError.conflict('Batch number already exists for this medicine');
      }
      data.batchNumber = batchNumber;
      changes.batchNumber = { from: existing.batchNumber, to: batchNumber };
    }
  }

  if (input.expiryDate !== undefined) {
    const expiry = new Date(`${input.expiryDate}T00:00:00.000Z`);
    if (Number.isNaN(expiry.getTime())) throw AppError.badRequest('Invalid expiry date');
    if (expiry.getTime() !== existing.expiryDate.getTime()) {
      data.expiryDate = expiry;
      changes.expiryDate = {
        from: existing.expiryDate.toISOString().slice(0, 10),
        to: input.expiryDate,
      };
    }
  }

  if (input.receivedDate !== undefined) {
    const received = input.receivedDate ? new Date(`${input.receivedDate}T00:00:00.000Z`) : null;
    if (input.receivedDate && Number.isNaN(received!.getTime())) {
      throw AppError.badRequest('Invalid received date');
    }
    const current = existing.receivedDate ? existing.receivedDate.toISOString().slice(0, 10) : null;
    const next = received ? input.receivedDate : null;
    if (current !== next) {
      data.receivedDate = received;
      changes.receivedDate = { from: current, to: next };
    }
  }

  if (input.supplier !== undefined) {
    const supplier = input.supplier?.trim() || null;
    if ((existing.supplier ?? null) !== supplier) {
      data.supplier = supplier;
      changes.supplier = { from: existing.supplier ?? null, to: supplier };
    }
  }

  if (Object.keys(data).length === 0) {
    throw AppError.badRequest('No changes to save');
  }

  const batch = await prisma.medicineBatch.update({
    where: { id: existing.id },
    data,
    include: { medicine: { select: { id: true, name: true } } },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'UPDATE_BATCH',
    entityType: 'MedicineBatch',
    entityId: batch.id,
    metadata: {
      medicineId: batch.medicineId,
      medicineName: batch.medicine.name,
      changes,
      reason,
    },
    ...meta,
  });

  return batch;
}

export async function listBatches(input: { medicineId?: string; activeOnly?: boolean; page?: number; pageSize?: number } = {}) {
  const { medicineId, activeOnly = true, page = 1, pageSize = 50 } = input;

  const where: Prisma.MedicineBatchWhereInput = {
    deletedAt: null,
    ...(medicineId ? { medicineId } : {}),
    ...(activeOnly ? { isActive: true } : {}),
  };

  const [total, batches] = await prisma.$transaction([
    prisma.medicineBatch.count({ where }),
    prisma.medicineBatch.findMany({
      where,
      orderBy: [{ expiryDate: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        medicine: { select: { id: true, name: true, category: true, unit: true, size: true } },
        _count: { select: { inventory: true } },
      },
    }),
  ]);

  const withStatus = batches.map((b) => ({
    ...b,
    expiryStatus: classifyExpiry(b.expiryDate),
  }));

  return { total, page, pageSize, batches: withStatus };
}
