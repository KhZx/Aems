import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../config/prisma.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntryInput {
  userId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  ambulanceId?: string | null;
  stationId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** A complete audit entry: the action is always set by the calling service. */
export type AuditEntry = AuditEntryInput & { action: string };

/**
 * Appends an entry to the audit log. Audit logs are append-only: there is no
 * update/delete service anywhere in the application, and no normal user can
 * modify them.
 *
 * Pass the interactive transaction client when the entry must be written
 * atomically with the operation it records.
 */
export async function createAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ambulanceId: entry.ambulanceId ?? null,
      stationId: entry.stationId ?? null,
      metadata: (entry.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    },
  });
}

export interface ListAuditLogsInput {
  action?: string;
  userId?: string;
  stationId?: string;
  stationIds?: string[];
  ambulanceId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Read-only audit log listing. There is deliberately no update/delete
 * counterpart anywhere in the API.
 */
export async function listAuditLogs(input: ListAuditLogsInput = {}) {
  const {
    action,
    userId,
    stationId,
    stationIds,
    ambulanceId,
    from,
    to,
    page = 1,
    pageSize = 50,
  } = input;

  const where: Prisma.AuditLogWhereInput = {
    ...(action ? { action } : {}),
    ...(userId ? { userId } : {}),
    ...(stationId ? { stationId } : {}),
    ...(stationIds ? { stationId: { in: stationIds } } : {}),
    ...(ambulanceId ? { ambulanceId } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
  };

  const [total, logs] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        station: { select: { id: true, code: true, name: true } },
        ambulance: { select: { id: true, vehicleNumber: true } },
      },
    }),
  ]);

  return { total, page, pageSize, logs };
}
