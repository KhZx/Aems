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
 * Actions that describe platform administration rather than day-to-day unit
 * operations: account/role management, station & ambulance configuration,
 * login events and fleet-wide distribution templates. Units and supervisors
 * never see these — only admins do. Every action NOT listed here is treated as
 * operational and is visible (scoped) to the owning unit.
 */
export const SYSTEM_AUDIT_ACTIONS: readonly string[] = [
  'LOGIN',
  'SECURITY_SCOPE_DENIED',
  'CREATE_USER',
  'APPROVE_USER',
  'REJECT_USER',
  'DISABLE_USER',
  'SUSPEND_USER',
  'CHANGE_ROLE',
  'CHANGE_PASSWORD',
  'RESET_USER_PASSWORD',
  'DELETE_USER',
  'SET_MANAGED_STATIONS',
  'UPDATE_USER_UNITS',
  'CREATE_STATION',
  'UPDATE_STATION',
  'DELETE_STATION',
  'CREATE_AMBULANCE',
  'UPDATE_AMBULANCE',
  'DELETE_AMBULANCE',
  'CREATE_DISTRIBUTION_TEMPLATE',
  'UPDATE_DISTRIBUTION_TEMPLATE',
];

export function isSystemAuditAction(action: string): boolean {
  return SYSTEM_AUDIT_ACTIONS.includes(action);
}

/**
 * Appends an entry to the audit log. Audit logs are append-only: there is no
 * update/delete service anywhere in the application, and no normal user can
 * modify them.
 *
 * Pass the interactive transaction client when the entry must be written
 * atomically with the operation it records.
 */
export async function createAudit(db: Db, entry: AuditEntry): Promise<void> {
  // Attribute the event to a station so it shows up in that station's log:
  //   - an explicit stationId (inventory / ambulance / inspection / …) wins;
  //   - otherwise fall back to the acting user's current station, so catalogue
  //     and account events performed by crew are filed under their unit too.
  // Admins have no station, so their fleet-wide actions stay untagged.
  let stationId = entry.stationId ?? null;
  if (!stationId && entry.userId) {
    const actor = await db.user.findUnique({
      where: { id: entry.userId },
      select: { stationId: true },
    });
    stationId = actor?.stationId ?? null;
  }

  await db.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ambulanceId: entry.ambulanceId ?? null,
      stationId,
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
  /** 'all' (admins) includes system/admin events; 'operational' hides them. */
  audience?: 'all' | 'operational';
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
    audience = 'all',
    page = 1,
    pageSize = 50,
  } = input;

  const and: Prisma.AuditLogWhereInput[] = [];
  if (action) and.push({ action });
  if (audience === 'operational') and.push({ action: { notIn: [...SYSTEM_AUDIT_ACTIONS] } });

  // Station scope. A row belongs to a station when it is filed under it, OR when
  // it is a duty switch that moved someone INTO or OUT of it. Recording both ends
  // means the unit a crew member LEFT sees the move in its log too, not just the
  // unit they joined — otherwise the origin supervisor watches someone vanish.
  const scopeIds = stationId ? [stationId] : stationIds;
  if (scopeIds) {
    and.push(
      scopeIds.length === 0
        ? { id: '__no_station__' }
        : {
            OR: [
              { stationId: { in: scopeIds } },
              ...scopeIds.map((sid) => ({ metadata: { path: ['fromStationId'], equals: sid } })),
              ...scopeIds.map((sid) => ({ metadata: { path: ['toStationId'], equals: sid } })),
            ],
          },
    );
  }

  const where: Prisma.AuditLogWhereInput = {
    ...(and.length ? { AND: and } : {}),
    ...(userId ? { userId } : {}),
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
