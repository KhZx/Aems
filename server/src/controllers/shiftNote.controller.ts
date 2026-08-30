import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requestMeta } from '../utils/request.js';
import { reqParam } from '../utils/param.js';
import * as shiftNoteService from '../services/shiftNote.service.js';
import * as scopeService from '../services/scope.service.js';

const user = (req: Request) => req.authUser!;

/** POST /api/shift-notes */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireStationAccess(me, req.body.stationId, managed);

  const data = await shiftNoteService.createShiftNote({
    stationId: req.body.stationId,
    title: req.body.title,
    content: req.body.content,
    priority: req.body.priority,
    author: req.body.author,
    createdById: me.id,
    meta: requestMeta(req),
  });

  res.status(201).json({ success: true, data });
});

/** GET /api/shift-notes */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const stationId = req.query.stationId as string | undefined;
  const page = (req.query.page as never) ?? 1;
  const pageSize = (req.query.pageSize as never) ?? 50;

  let data;
  if (stationId) {
    const managed = await scopeService.managedStationIds(me.id);
    await scopeService.requireStationAccess(me, stationId, managed);
    data = await shiftNoteService.listShiftNotes({ stationIds: [stationId], page, pageSize });
  } else {
    const accessible = await scopeService.accessibleStationIds(me);
    data = await shiftNoteService.listShiftNotes({
      stationIds: me.role === 'ADMIN' ? undefined : accessible,
      page,
      pageSize,
    });
  }

  res.json({ success: true, data });
});

/** DELETE /api/shift-notes/:id */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const me = user(req);
  const note = await shiftNoteService.getShiftNote(reqParam(req, 'id'));
  const managed = await scopeService.managedStationIds(me.id);
  await scopeService.requireStationAccess(me, note.stationId, managed);

  await shiftNoteService.deleteShiftNote(note.id, me.id, requestMeta(req));
  res.json({ success: true, data: { id: note.id } });
});
