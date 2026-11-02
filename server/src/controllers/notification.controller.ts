import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { reqParam } from '../utils/param.js';
import * as notificationService from '../services/notification.service.js';

const userId = (req: Request) => req.authUser!.id;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const data = await notificationService.notificationList(userId(req), {
    page: Number(req.query.page ?? 1),
    pageSize: Number(req.query.pageSize ?? 30),
    unreadOnly: String(req.query.unreadOnly ?? '') === 'true',
  });
  res.json({ success: true, data });
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const updated = await notificationService.markNotificationRead(userId(req), reqParam(req, 'id'));
  if (!updated) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Notification not found' } });
    return;
  }
  res.json({ success: true, data: { read: true } });
});

export const markAllRead = asyncHandler(async (req: Request, res: Response) => {
  const updated = await notificationService.markAllNotificationsRead(userId(req));
  res.json({ success: true, data: { updated } });
});

/** Authenticated, user-scoped SSE stream. Payloads only signal a refresh; data
 * itself is loaded through the normal permission-scoped JSON endpoint. */
export const stream = asyncHandler(async (req: Request, res: Response) => {
  const me = userId(req);
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 4000\n\nevent: ready\ndata: {}\n\n');

  const publishRefresh = () => {
    if (!res.writableEnded) res.write('event: refresh\ndata: {}\n\n');
  };
  const unsubscribe = notificationService.subscribeToNotificationUpdates(me, publishRefresh);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25_000);

  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
