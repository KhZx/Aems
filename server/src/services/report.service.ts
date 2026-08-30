import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/AppError.js';
import { createAudit, type AuditEntryInput } from './audit.service.js';

export interface CreateReportInput {
  stationId?: string | null;
  title?: string | null;
  reportText: string;
  data?: Record<string, unknown> | null;
  createdById: string;
  meta?: AuditEntryInput;
}

export async function createReport(input: CreateReportInput) {
  if (input.stationId) {
    const station = await prisma.station.findUnique({ where: { id: input.stationId } });
    if (!station) throw AppError.notFound('Station not found');
  }

  const report = await prisma.report.create({
    data: {
      stationId: input.stationId ?? null,
      title: input.title ?? null,
      reportText: input.reportText,
      data: (input.data as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      createdById: input.createdById,
    },
  });

  await createAudit(prisma, {
    userId: input.createdById,
    action: 'CREATE_REPORT',
    entityType: 'Report',
    entityId: report.id,
    stationId: input.stationId ?? undefined,
    metadata: { title: report.title ?? null, reportLength: report.reportText.length },
    ...input.meta,
  });

  return report;
}

export interface ListReportsInput {
  stationIds?: string[];
  page?: number;
  pageSize?: number;
}

export async function listReports(input: ListReportsInput = {}) {
  const { stationIds, page = 1, pageSize = 50 } = input;

  const where: Prisma.ReportWhereInput = {
    ...(stationIds ? { stationId: { in: stationIds } } : {}),
  };

  const [total, reports] = await prisma.$transaction([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        station: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, displayName: true } },
      },
    }),
  ]);

  return { total, page, pageSize, reports };
}
