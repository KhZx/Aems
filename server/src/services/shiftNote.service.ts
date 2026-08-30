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
  page?: number;
  pageSize?: number;
}

export async function listShiftNotes(input: ListShiftNotesInput = {}) {
  const { stationIds, page = 1, pageSize = 50 } = input;

  const where: Prisma.ShiftNoteWhereInput = {
    ...(stationIds ? { stationId: { in: stationIds } } : {}),
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

export async function deleteShiftNote(id: string, actorId: string, meta: AuditEntryInput = {}): Promise<void> {
  const note = await prisma.shiftNote.findUnique({ where: { id } });
  if (!note) throw AppError.notFound('Shift note not found');

  await prisma.shiftNote.delete({ where: { id } });

  await createAudit(prisma, {
    userId: actorId,
    action: 'DELETE_SHIFT_NOTE',
    entityType: 'ShiftNote',
    entityId: id,
    stationId: note.stationId,
    metadata: { title: note.title },
    ...meta,
  });
}
