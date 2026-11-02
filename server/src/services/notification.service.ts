import type { NotificationSeverity, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '../config/prisma.js';
import { logger } from '../utils/logger.js';

export interface NotificationEventInput {
  type: string;
  severity: NotificationSeverity;
  titleKey: string;
  bodyKey: string;
  data: Prisma.InputJsonObject;
  dedupeKey: string;
  stationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribeToNotificationUpdates(userId: string, listener: Listener) {
  const set = listeners.get(userId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(userId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(userId);
  };
}

function publish(userIds: string[]) {
  for (const userId of userIds) {
    for (const listener of listeners.get(userId) ?? []) {
      try { listener(); } catch { /* one client must not interrupt other subscribers */ }
    }
  }
}

/** Durable, per-recipient insert. Unique dedupe keys keep retries from alerting twice. */
export async function notifyUsers(userIds: string[], event: NotificationEventInput) {
  const recipients = [...new Set(userIds.filter(Boolean))];
  if (!recipients.length) return;
  try {
    const result = await prisma.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        stationId: event.stationId ?? null,
        type: event.type,
        severity: event.severity,
        titleKey: event.titleKey,
        bodyKey: event.bodyKey,
        data: event.data,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        dedupeKey: event.dedupeKey,
      })),
      skipDuplicates: true,
    });
    if (result.count > 0) publish(recipients);
  } catch (err) {
    // The operational action has already committed. A notification failure must
    // never turn it into a client-visible failure or tempt a duplicate retry.
    logger.error({ err, type: event.type, dedupeKey: event.dedupeKey }, 'Failed to persist notifications');
  }
}

export async function notifyUser(userId: string, event: NotificationEventInput) {
  await notifyUsers([userId], event);
}

export async function notifyStationSupervisors(stationId: string, event: NotificationEventInput, excludeUserId?: string) {
  try {
    let users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: 'SUPERVISOR',
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
        managedStations: { some: { stationId } },
      },
      select: { id: true },
    });
    // Avoid silently losing an actionable alert for a unit with no assigned supervisor.
    if (!users.length) {
      users = await prisma.user.findMany({
        where: { status: 'ACTIVE', role: 'ADMIN', ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
        select: { id: true },
      });
    }
    await notifyUsers(users.map((user) => user.id), { ...event, stationId });
  } catch (err) {
    logger.error({ err, stationId, type: event.type }, 'Failed to resolve notification recipients');
  }
}

export async function notifyStationTeam(
  stationId: string,
  event: NotificationEventInput,
  excludeUserIds: string[] = [],
) {
  try {
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        ...(excludeUserIds.length ? { id: { notIn: excludeUserIds } } : {}),
        OR: [
          { stationId },
          { managedStations: { some: { stationId } } },
        ],
      },
      select: { id: true },
    });
    await notifyUsers(users.map((user) => user.id), { ...event, stationId });
  } catch (err) {
    logger.error({ err, stationId, type: event.type }, 'Failed to resolve station notification recipients');
  }
}

export async function notifyStockUnavailable(input: {
  stationId: string;
  stationName: string;
  ambulanceId: string;
  ambulanceNumber: string;
  medicineId: string;
  medicineName: string;
  category: string;
  actorId?: string;
  referenceId: string;
}) {
  await notifyStationTeam(input.stationId, {
    type: 'STOCK_UNAVAILABLE',
    severity: 'CRITICAL',
    titleKey: 'notif.stock_unavailable.title',
    bodyKey: 'notif.stock_unavailable.body',
    dedupeKey: `stock-unavailable:${input.ambulanceId}:${input.medicineId}:${input.referenceId}`,
    entityType: 'Medicine',
    entityId: input.medicineId,
    data: {
      item: input.medicineName,
      category: input.category,
      unit: input.stationName,
      ambulance: input.ambulanceNumber,
      page: 'equipment',
      ambulanceId: input.ambulanceId,
    },
  }, input.actorId ? [input.actorId] : []);
}

export async function notifyExpiryDigest(input: {
  stationId: string;
  stationName: string;
  band: 'WEEK' | 'DAY' | 'EXPIRED';
  items: Array<{ id: string; ambulanceNumber: string; name: string; batchNumber: string; expiryDate: string; quantity: number }>;
}) {
  const items = [...input.items].sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = createHash('sha256')
    .update(items.map((item) => `${item.id}:${item.expiryDate}:${item.quantity}`).join('|'))
    .digest('hex').slice(0, 24);
  const key = `expiry:${input.stationId}:${input.band}:${fingerprint}`;
  const suffix = input.band === 'EXPIRED' ? 'expired' : input.band === 'DAY' ? 'day' : 'week';
  await notifyStationSupervisors(input.stationId, {
    type: 'EXPIRY_RISK',
    severity: input.band === 'WEEK' ? 'ACTION' : 'CRITICAL',
    titleKey: `notif.expiry.${suffix}.title`,
    bodyKey: `notif.expiry.${suffix}.body`,
    dedupeKey: key,
    entityType: 'Ambulance',
    entityId: input.stationId,
    data: {
      unit: input.stationName,
      itemsCount: items.length,
      ambulancesCount: new Set(items.map((item) => item.ambulanceNumber)).size,
      items: items.slice(0, 5).map((item) => `${item.ambulanceNumber}: ${item.name} (${item.batchNumber})`).join(', '),
      page: 'stations',
    },
  });
  return key;
}

/** Old expiry digests are resolved when their stock set or risk band changes. */
export async function resolveStaleExpiryDigests(activeKeys: string[]) {
  try {
    const current = new Set(activeKeys);
    const open = await prisma.notification.findMany({
      where: { type: 'EXPIRY_RISK', resolvedAt: null },
      select: { id: true, userId: true, dedupeKey: true },
    });
    const stale = open.filter((notification) => !current.has(notification.dedupeKey));
    if (!stale.length) return;
    await prisma.notification.updateMany({
      where: { id: { in: stale.map((item) => item.id) } },
      data: { resolvedAt: new Date(), readAt: new Date() },
    });
    publish([...new Set(stale.map((item) => item.userId))]);
  } catch (err) {
    logger.error({ err }, 'Failed to resolve stale expiry notifications');
  }
}

/** Resolve open out-of-stock alerts once any usable stock returns to the unit. */
export async function resolveStockUnavailable(ambulanceId: string, medicineId: string) {
  const prefix = `stock-unavailable:${ambulanceId}:${medicineId}:`;
  try {
    const open = await prisma.notification.findMany({
      where: { type: 'STOCK_UNAVAILABLE', resolvedAt: null, dedupeKey: { startsWith: prefix } },
      select: { userId: true },
      distinct: ['userId'],
    });
    if (!open.length) return;
    await prisma.notification.updateMany({
      where: { type: 'STOCK_UNAVAILABLE', resolvedAt: null, dedupeKey: { startsWith: prefix } },
      data: { resolvedAt: new Date(), readAt: new Date() },
    });
    publish(open.map((item) => item.userId));
  } catch (err) {
    logger.error({ err, ambulanceId, medicineId }, 'Failed to resolve stock notifications');
  }
}

export async function notificationList(userId: string, input: { page?: number; pageSize?: number; unreadOnly?: boolean } = {}) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 30;
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(input.unreadOnly ? { readAt: null, resolvedAt: null } : {}),
  };
  const [total, unread, notifications] = await prisma.$transaction([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null, resolvedAt: null } }),
    prisma.notification.findMany({
      where,
      orderBy: [{ resolvedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return { total, unread, page, pageSize, notifications };
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
    select: { id: true, readAt: true },
  });
  if (!existing) return false;
  if (existing.readAt) return true;
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (result.count) publish([userId]);
  return result.count > 0;
}

export async function markAllNotificationsRead(userId: string) {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (result.count) publish([userId]);
  return result.count;
}
