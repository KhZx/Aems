import type { NotePriority, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

export interface CreateShiftNoteInput {
  stationId: string;
  title: string;
  content: string;
  priority?: NotePriority;
  author?: string | null;
  createdById: string;
  meta?: AuditEntryInput;
}

export async function createShiftNote(input: CreateShiftNoteInput) {
  const station = await prisma.station.findUnique({ where: { id: input.stationId } });
  if (!station) throw AppError.notFound('Station not found');

  const note = await prisma.shiftNote.create({
    data: {
      stationId: input.stationId,
      title: input.title,
      content: input.content,
      priority: input.priority ?? 'MEDIUM',
      author: input.author ?? null,
      createdById: input.createdById,
    },
  });

  await createAudit(prisma, {
    userId: input.createdById,
    action: 'CREATE_SHIFT_NOTE',
    entityType: 'ShiftNote',
    entityId: note.id,
    stationId: input.stationId,
    metadata: { title: note.title, priority: note.priority },
    ...input.meta,
  });

  return note;
}

export async function getShiftNote(id: string) {
  const note = await prisma.shiftNote.findUnique({ where: { id } });
  if (!note) throw AppError.notFound('Shift note not found');
  return note;
}

export interface ListShiftNotesInput {
  stationIds?: string[];
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listShiftNotes(input: ListShiftNotesInput = {}) {
  const { stationIds, includeDeleted = false, page = 1, pageSize = 50 } = input;

  const where: Prisma.ShiftNoteWhereInput = {
    ...(stationIds ? { stationId: { in: stationIds } } : {}),
    ...(includeDeleted ? {} : { deletedAt: null }),
  };

  const [total, notes] = await prisma.$transaction([
    prisma.shiftNote.count({ where }),
    prisma.shiftNote.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { createdBy: { select: { id: true, displayName: true } } },
    }),
  ]);

  return { total, page, pageSize, notes };
}

/** How long after posting an author may still remove their own note. */
export const AUTHOR_DELETE_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface DeleteShiftNoteInput {
  noteId: string;
  actorId: string;
  actorRole: 'ADMIN' | 'SUPERVISOR' | string;
  reason?: string | null;
  meta?: AuditEntryInput;
}

/**
 * Removes a shift note by soft-deleting it. Nothing is physically dropped, so a
 * supervisor can always put it back (see `restoreShiftNote`).
 *
 * Rules:
 *   - the caller must already have station access (enforced by the controller);
 *   - the AUTHOR may remove their own note within AUTHOR_DELETE_WINDOW_MS —
 *     a typo fixed minutes after writing it is not tampering;
 *   - anyone else's note, or an older one, needs SUPERVISOR/ADMIN.
 */
export async function deleteShiftNote(input: DeleteShiftNoteInput) {
  const note = await prisma.shiftNote.findUnique({ where: { id: input.noteId } });
  if (!note) throw AppError.notFound('Shift note not found');
  if (note.deletedAt) throw AppError.conflict('Shift note is already removed');

  const isReviewer = input.actorRole === 'ADMIN' || input.actorRole === 'SUPERVISOR';
  const isAuthor = note.createdById === input.actorId;
  const withinWindow = Date.now() - note.createdAt.getTime() < AUTHOR_DELETE_WINDOW_MS;

  if (!isReviewer && !(isAuthor && withinWindow)) {
    throw AppError.forbidden(
      isAuthor
        ? 'Notes can only be removed by their author within 12 hours of posting — ask a supervisor'
        : 'Only a supervisor can remove another crew member’s shift note',
    );
  }

  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 300) : null;

  const deleted = await prisma.$transaction(async (tx) => {
    const updated = await tx.shiftNote.update({
      where: { id: note.id },
      data: { deletedAt: new Date(), deletedById: input.actorId, deleteReason: reason },
    });

    await createAudit(tx, {
      userId: input.actorId,
      action: 'DELETE_SHIFT_NOTE',
      entityType: 'ShiftNote',
      entityId: note.id,
      stationId: note.stationId,
      metadata: { title: note.title, priority: note.priority, reason, softDelete: true },
      ...input.meta,
    });

    return updated;
  });

  return deleted;
}

export interface RestoreShiftNoteInput {
  noteId: string;
  actorId: string;
  meta?: AuditEntryInput;
}

/** Brings a soft-deleted shift note back (SUPERVISOR/ADMIN only). */
export async function restoreShiftNote(input: RestoreShiftNoteInput) {
  const note = await prisma.shiftNote.findUnique({ where: { id: input.noteId } });
  if (!note) throw AppError.notFound('Shift note not found');
  if (!note.deletedAt) throw AppError.conflict('Shift note is not removed');

  return prisma.$transaction(async (tx) => {
    const restored = await tx.shiftNote.update({
      where: { id: note.id },
      data: { deletedAt: null, deletedById: null, deleteReason: null },
    });

    await createAudit(tx, {
      userId: input.actorId,
      action: 'RESTORE_SHIFT_NOTE',
      entityType: 'ShiftNote',
      entityId: note.id,
      stationId: note.stationId,
      metadata: { title: note.title, removedAt: note.deletedAt?.toISOString() ?? null },
      ...input.meta,
    });

    return restored;
  });
}
