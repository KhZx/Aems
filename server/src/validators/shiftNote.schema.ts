import { z } from 'zod';

export const notePrioritySchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

export const createShiftNoteSchema = z.object({
  stationId: z.string().uuid(),
  title: z.string().trim().min(1).max(150),
  content: z.string().trim().max(2000),
  priority: notePrioritySchema.default('MEDIUM'),
  author: z.string().trim().max(120).optional().or(z.literal('')),
});

export const listShiftNotesQuerySchema = z.object({
  stationId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
