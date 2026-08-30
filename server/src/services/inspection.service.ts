import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

type Tx = Prisma.TransactionClient;

export interface InspectionItemInput {
  inventoryId: string;
  actualQuantity: number;
  notes?: string | null;
}

export interface CreateInspectionInput {
  ambulanceId: string;
  notes?: string | null;
  items: InspectionItemInput[];
  performedById: string;
  meta?: AuditEntryInput;
}

/**
 * Creates an inspection. For every item the backend re-reads the authoritative
 * quantity as "expected", computes the difference against the counted value
 * and — when they differ — reconciles inventory and records an
 * INSPECTION_CORRECTION transaction. Inspections are atomic.
 */
export async function createInspection(input: CreateInspectionInput) {
  if (input.items.length === 0) {
    throw AppError.badRequest('Inspection must include at least one item');
  }
  for (const item of input.items) {
    if (!Number.isInteger(item.actualQuantity) || item.actualQuantity < 0) {
      throw AppError.badRequest('Actual quantity must be a non-negative integer');
    }
  }

  return prisma.$transaction(async (tx) => {
    const ambulance = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!ambulance) throw AppError.notFound('Ambulance not found');

    const uniqueIds = [...new Set(input.items.map((i) => i.inventoryId))];
    for (const id of uniqueIds) {
      await tx.$queryRaw`SELECT "id" FROM "Inventory" WHERE "id" = ${id} FOR UPDATE`;
    }

    const inventories = await tx.inventory.findMany({
      where: { id: { in: uniqueIds } },
      select: {
        id: true,
        quantity: true,
        batch: { select: { batchNumber: true, medicine: { select: { name: true } } } },
      },
    });
    if (inventories.length !== uniqueIds.length) {
      throw AppError.notFound('One or more inventory records not found');
    }

    const byId = new Map(inventories.map((inv) => [inv.id, inv]));

    const inspection = await tx.inspection.create({
      data: {
        ambulanceId: input.ambulanceId,
        performedById: input.performedById,
        status: 'COMPLETED',
        notes: input.notes ?? null,
      },
    });

    const corrections: Array<{
      inventoryId: string;
      from: number;
      to: number;
      difference: number;
    }> = [];

    for (const item of input.items) {
      const inv = byId.get(item.inventoryId);
      if (!inv) throw AppError.notFound('Inventory record not found');
      const expected = inv.quantity;
      const difference = item.actualQuantity - expected;

      await tx.inspectionItem.create({
        data: {
          inspectionId: inspection.id,
          inventoryId: item.inventoryId,
          expectedQuantity: expected,
          actualQuantity: item.actualQuantity,
          difference,
          notes: item.notes ?? null,
        },
      });

      if (difference !== 0) {
        const updated = await tx.inventory.update({
          where: { id: item.inventoryId },
          data: { quantity: item.actualQuantity },
        });

        await tx.inventoryTransaction.create({
          data: {
            inventoryId: item.inventoryId,
            transactionType: 'INSPECTION_CORRECTION',
            quantityChange: difference,
            quantityBefore: expected,
            quantityAfter: updated.quantity,
            reason: `Inspection ${inspection.id}`,
            referenceId: inspection.id,
            performedById: input.performedById,
          },
        });

        corrections.push({
          inventoryId: item.inventoryId,
          from: expected,
          to: item.actualQuantity,
          difference,
        });
      }
    }

    await createAudit(tx, {
      userId: input.performedById,
      action: 'INSPECTION',
      entityType: 'Inspection',
      entityId: inspection.id,
      ambulanceId: input.ambulanceId,
      stationId: ambulance.stationId,
      metadata: {
        itemCount: input.items.length,
        corrections,
        notes: input.notes ?? null,
      },
      ...input.meta,
    });

    return {
      inspection,
      corrections,
    };
  });
}

export interface ListInspectionsInput {
  ambulanceId?: string;
  stationIds?: string[];
  performedById?: string;
  page?: number;
  pageSize?: number;
}

export async function listInspections(input: ListInspectionsInput = {}) {
  const { ambulanceId, stationIds, performedById, page = 1, pageSize = 50 } = input;

  const where: Prisma.InspectionWhereInput = {
    ...(ambulanceId ? { ambulanceId } : {}),
    ...(stationIds ? { ambulance: { stationId: { in: stationIds } } } : {}),
    ...(performedById ? { performedById } : {}),
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
      items: {
        include: {
          inventory: {
            select: {
              batch: {
                select: { batchNumber: true, expiryDate: true, medicine: { select: { name: true, unit: true, category: true } } },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!inspection) throw AppError.notFound('Inspection not found');
  return inspection;
}
