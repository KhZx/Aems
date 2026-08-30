import type { MedicineCategory, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { classifyExpiry } from '../utils/fefo.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

export interface CreateMedicineInput {
  name: string;
  genericName?: string | null;
  category: MedicineCategory;
  strength?: string | null;
  dosageForm?: string | null;
  unit?: string | null;
  barcode?: string | null;
  location?: string | null;
  serialNumber?: string | null;
  notes?: string | null;
  technicalNotes?: string | null;
  minimumStock?: number;
  maximumStock?: number | null;
}

export interface UpdateMedicineInput {
  name?: string;
  genericName?: string | null;
  category?: MedicineCategory;
  strength?: string | null;
  dosageForm?: string | null;
  unit?: string | null;
  barcode?: string | null;
  location?: string | null;
  serialNumber?: string | null;
  notes?: string | null;
  technicalNotes?: string | null;
  minimumStock?: number;
  maximumStock?: number | null;
  isActive?: boolean;
}

export async function createMedicine(actorId: string, input: CreateMedicineInput, meta: AuditEntryInput = {}) {
  const name = input.name.trim();
  if (!name) throw AppError.badRequest('Medicine name is required');

  const barcode = input.barcode?.trim() || null;

  if (barcode) {
    const existing = await prisma.medicine.findFirst({ where: { barcode, deletedAt: null } });
    if (existing) throw AppError.conflict('Barcode already in use');
  }

  const medicine = await prisma.medicine.create({
    data: {
      name,
      genericName: input.genericName ?? null,
      category: input.category,
      strength: input.strength ?? null,
      dosageForm: input.dosageForm ?? null,
      unit: input.unit ?? null,
      barcode,
      location: input.location ?? null,
      serialNumber: input.serialNumber ?? null,
      notes: input.notes ?? null,
      technicalNotes: input.technicalNotes ?? null,
      minimumStock: input.minimumStock ?? 0,
      maximumStock: input.maximumStock ?? null,
    },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'CREATE_MEDICINE',
    entityType: 'Medicine',
    entityId: medicine.id,
    metadata: { name: medicine.name, category: medicine.category },
    ...meta,
  });

  return medicine;
}

export async function updateMedicine(
  actorId: string,
  id: string,
  input: UpdateMedicineInput,
  meta: AuditEntryInput = {},
) {
  const before = await prisma.medicine.findUnique({ where: { id, deletedAt: null } });
  if (!before) throw AppError.notFound('Medicine not found');

  const barcode = input.barcode === undefined ? undefined : (input.barcode?.trim() || null);

  if (barcode && barcode !== before.barcode) {
    const existing = await prisma.medicine.findFirst({ where: { barcode, deletedAt: null } });
    if (existing) throw AppError.conflict('Barcode already in use');
  }

  const medicine = await prisma.medicine.update({
    where: { id },
    data: {
      name: input.name !== undefined ? input.name.trim() : undefined,
      genericName: input.genericName !== undefined ? input.genericName : undefined,
      category: input.category,
      strength: input.strength !== undefined ? input.strength : undefined,
      dosageForm: input.dosageForm !== undefined ? input.dosageForm : undefined,
      unit: input.unit !== undefined ? input.unit : undefined,
      barcode,
      location: input.location !== undefined ? input.location : undefined,
      serialNumber: input.serialNumber !== undefined ? input.serialNumber : undefined,
      notes: input.notes !== undefined ? input.notes : undefined,
      technicalNotes: input.technicalNotes !== undefined ? input.technicalNotes : undefined,
      minimumStock: input.minimumStock,
      maximumStock: input.maximumStock !== undefined ? input.maximumStock : undefined,
      isActive: input.isActive,
    },
  });

  await createAudit(prisma, {
    userId: actorId,
    action: 'UPDATE_MEDICINE',
    entityType: 'Medicine',
    entityId: medicine.id,
    metadata: { name: medicine.name },
    ...meta,
  });

  return medicine;
}

export interface DeleteMedicineResult {
  id: string;
  name: string;
  batches: number;
  stockRows: number;
  totalUnits: number;
  expiredUnits: number;
  activeUnits: number;
  affectedAmbulances: number;
}

/**
 * Removes a medicine and everything behind it (batches + stock) in a single
 * transaction by stamping `deletedAt` on the medicine, its batches and every
 * inventory row. Nothing is physically dropped, so historical transactions,
 * transfers, inspections, supply requests and audit entries keep resolving —
 * but nothing deleted can ever surface in active lists again.
 * The barcode is released so entering the same medicine afresh is possible.
 */
export async function deleteMedicine(
  actorId: string,
  id: string,
  meta: AuditEntryInput = {},
): Promise<DeleteMedicineResult> {
  const medicine = await prisma.medicine.findUnique({ where: { id }, include: { batches: true } });
  if (!medicine || medicine.deletedAt) throw AppError.notFound('Medicine not found');

  const batchIds = medicine.batches.map((b) => b.id);
  const expiryOf = new Map(medicine.batches.map((b) => [b.id, b.expiryDate]));

  const stockRows = batchIds.length
    ? await prisma.inventory.findMany({
        where: { batchId: { in: batchIds } },
        select: { id: true, ambulanceId: true, batchId: true, quantity: true },
      })
    : [];

  const now = new Date();
  const totalUnits = stockRows.reduce((s, r) => s + r.quantity, 0);
  const expiredUnits = stockRows
    .filter((r) => classifyExpiry(expiryOf.get(r.batchId) ?? null, now) === 'EXPIRED')
    .reduce((s, r) => s + r.quantity, 0);
  const affectedAmbulances = new Set(stockRows.map((r) => r.ambulanceId)).size;

  await prisma.$transaction([
    prisma.inventory.updateMany({ where: { batchId: { in: batchIds } }, data: { deletedAt: now } }),
    prisma.medicineBatch.updateMany({ where: { medicineId: id }, data: { deletedAt: now } }),
    prisma.medicine.update({ where: { id }, data: { deletedAt: now, barcode: null } }),
  ]);

  await createAudit(prisma, {
    userId: actorId,
    action: 'DELETE_MEDICINE',
    entityType: 'Medicine',
    entityId: id,
    metadata: {
      name: medicine.name,
      barcode: medicine.barcode ?? null,
      batches: medicine.batches.length,
      stockRows: stockRows.length,
      totalUnits,
      expiredUnits,
      activeUnits: totalUnits - expiredUnits,
      affectedAmbulances,
    },
    ...meta,
  });

  return {
    id,
    name: medicine.name,
    batches: medicine.batches.length,
    stockRows: stockRows.length,
    totalUnits,
    expiredUnits,
    activeUnits: totalUnits - expiredUnits,
    affectedAmbulances,
  };
}

export interface ListMedicinesInput {
  search?: string;
  category?: MedicineCategory;
  includeInactive?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listMedicines(input: ListMedicinesInput = {}) {
  const { search, category, includeInactive = false, page = 1, pageSize = 50 } = input;

  const where: Prisma.MedicineWhereInput = {
    deletedAt: null,
    ...(includeInactive ? {} : { isActive: true }),
    ...(category ? { category } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { genericName: { contains: search, mode: 'insensitive' } },
            { barcode: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, medicines] = await prisma.$transaction([
    prisma.medicine.count({ where }),
    prisma.medicine.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { batches: true } } },
    }),
  ]);

  return { total, page, pageSize, medicines };
}

export async function getMedicineById(id: string) {
  const medicine = await prisma.medicine.findUnique({
    where: { id, deletedAt: null },
    include: {
      batches: {
        where: { isActive: true, deletedAt: null },
        orderBy: { expiryDate: 'asc' },
        include: {
          inventory: {
            where: { deletedAt: null },
            include: { ambulance: { select: { id: true, vehicleNumber: true, station: { select: { code: true, name: true } } } } },
          },
        },
      },
    },
  });
  if (!medicine) throw AppError.notFound('Medicine not found');
  return medicine;
}
