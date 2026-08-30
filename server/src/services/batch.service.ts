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
  if (existing) throw AppError.conflict('Batch number already exists for this medicine');

  const batch = await prisma.medicineBatch.create({
    data: {
      medicineId: input.medicineId,
      batchNumber,
      expiryDate: expiry,
      receivedDate: input.receivedDate ? new Date(input.receivedDate) : null,
      supplier: input.supplier ?? null,
    },
  });

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
        medicine: { select: { id: true, name: true, category: true, unit: true, minimumStock: true } },
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
