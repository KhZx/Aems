import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

type Tx = Prisma.TransactionClient;

export interface TransferInput {
  sourceInventoryId: string;
  destinationAmbulanceId: string;
  quantity: number;
  notes?: string | null;
  performedById: string;
  meta?: AuditEntryInput;
}

/** Lightweight lookup of the ambulance owning a source inventory row. */
export async function getTransferSource(sourceInventoryId: string): Promise<{ ambulanceId: string }> {
  const row = await prisma.inventory.findUnique({
    where: { id: sourceInventoryId },
    select: { ambulanceId: true },
  });
  if (!row) throw AppError.notFound('Source inventory not found');
  return row;
}

/**
 * Atomically moves a quantity of a specific batch from one ambulance to
 * another. The source is decremented, the destination incremented and a
 * shared reference id links TRANSFER_OUT / TRANSFER_IN transactions.
 * If anything fails, the whole operation rolls back: A loses nothing,
 * B gains nothing.
 */
export async function transferStock(input: TransferInput) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw AppError.badRequest('Quantity must be a positive integer');
  }

  const transferId = crypto.randomUUID();

  return prisma.$transaction(async (tx) => {
    const source = await tx.inventory.findUnique({
      where: { id: input.sourceInventoryId },
      include: {
        ambulance: true,
        batch: { include: { medicine: true } },
      },
    });
    if (!source) throw AppError.notFound('Source inventory not found');

    if (source.ambulanceId === input.destinationAmbulanceId) {
      throw AppError.badRequest('Source and destination ambulance cannot be the same');
    }

    const destination = await tx.ambulance.findUnique({ where: { id: input.destinationAmbulanceId } });
    if (!destination) throw AppError.notFound('Destination ambulance not found');

    // Lock the source row (and later the destination row) in sorted order.
    const destInventory = await tx.inventory.findUnique({
      where: {
        ambulanceId_batchId: {
          ambulanceId: input.destinationAmbulanceId,
          batchId: source.batchId,
        },
      },
    });

    const lockIds = [source.id, ...(destInventory ? [destInventory.id] : [])].sort();
    for (const id of lockIds) {
      await tx.$queryRaw`SELECT "id" FROM "Inventory" WHERE "id" = ${id} FOR UPDATE`;
    }

    if (input.quantity > source.quantity) {
      throw AppError.conflict(
        `Cannot transfer ${input.quantity}: only ${source.quantity} in stock on source`,
      );
    }

    const sourceUpdated = await tx.inventory.update({
      where: { id: source.id },
      data: { quantity: { decrement: input.quantity } },
    });

    await tx.inventoryTransaction.create({
      data: {
        inventoryId: source.id,
        transactionType: 'TRANSFER_OUT',
        quantityChange: -input.quantity,
        quantityBefore: sourceUpdated.quantity + input.quantity,
        quantityAfter: sourceUpdated.quantity,
        reason: `Transfer to ${destination.vehicleNumber}`,
        referenceId: transferId,
        performedById: input.performedById,
      },
    });

    const destinationInventory = await tx.inventory.upsert({
      where: {
        ambulanceId_batchId: {
          ambulanceId: input.destinationAmbulanceId,
          batchId: source.batchId,
        },
      },
      create: {
        ambulanceId: input.destinationAmbulanceId,
        batchId: source.batchId,
        quantity: input.quantity,
      },
      update: { quantity: { increment: input.quantity } },
    });

    await tx.inventoryTransaction.create({
      data: {
        inventoryId: destinationInventory.id,
        transactionType: 'TRANSFER_IN',
        quantityChange: input.quantity,
        quantityBefore: destinationInventory.quantity - input.quantity,
        quantityAfter: destinationInventory.quantity,
        reason: `Transfer from ${source.ambulance.vehicleNumber}`,
        referenceId: transferId,
        performedById: input.performedById,
      },
    });

    const transfer = await tx.transfer.create({
      data: {
        sourceAmbulanceId: source.ambulanceId,
        destinationAmbulanceId: input.destinationAmbulanceId,
        inventoryId: source.id,
        quantity: input.quantity,
        status: 'COMPLETED',
        performedById: input.performedById,
        notes: input.notes ?? null,
      },
    });

    await createAudit(tx, {
      userId: input.performedById,
      action: 'TRANSFER',
      entityType: 'Transfer',
      entityId: transfer.id,
      ambulanceId: source.ambulanceId,
      stationId: source.ambulance.stationId,
      metadata: {
        referenceId: transferId,
        medicineName: source.batch.medicine.name,
        batchNumber: source.batch.batchNumber,
        quantity: input.quantity,
        fromAmbulance: source.ambulance.vehicleNumber,
        fromStationId: source.ambulance.stationId,
        toAmbulance: destination.vehicleNumber,
        toStationId: destination.stationId,
        notes: input.notes ?? null,
      },
      ...input.meta,
    });

    return {
      transfer,
      referenceId: transferId,
      sourceRemaining: sourceUpdated.quantity,
      destinationQuantity: destinationInventory.quantity,
    };
  });
}

export interface ListTransfersInput {
  ambulanceId?: string;
  stationIds?: string[];
  performedById?: string;
  page?: number;
  pageSize?: number;
}

export async function listTransfers(input: ListTransfersInput = {}) {
  const { ambulanceId, stationIds, performedById, page = 1, pageSize = 50 } = input;

  const or: Prisma.TransferWhereInput[] = [];
  if (ambulanceId) or.push({ sourceAmbulanceId: ambulanceId }, { destinationAmbulanceId: ambulanceId });
  if (stationIds) {
    or.push(
      { sourceAmbulance: { stationId: { in: stationIds } } },
      { destinationAmbulance: { stationId: { in: stationIds } } },
    );
  }
  const where: Prisma.TransferWhereInput = {
    ...(or.length ? { OR: or } : {}),
    ...(performedById ? { performedById } : {}),
  };

  const [total, transfers] = await prisma.$transaction([
    prisma.transfer.count({ where }),
    prisma.transfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        sourceAmbulance: { select: { id: true, vehicleNumber: true, station: { select: { code: true, name: true } } } },
        destinationAmbulance: { select: { id: true, vehicleNumber: true, station: { select: { code: true, name: true } } } },
        performedBy: { select: { id: true, displayName: true } },
        inventory: { select: { batch: { select: { batchNumber: true, medicine: { select: { name: true, unit: true } } } } } },
      },
    }),
  ]);

  return { total, page, pageSize, transfers };
}
