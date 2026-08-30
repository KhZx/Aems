import type { Request, Response } from 'express';
import { prisma } from '../config/prisma.js';

/**
 * GET /api/health — public liveness for the UI's server/database status dots.
 * Reports server uptime and performs a trivial DB probe so the frontend can
 * show a live red/green indicator for both.
 */
export const health = async (_req: Request, res: Response): Promise<void> => {
  let database = 'ok';
  let dbLatencyMs: number | null = null;
  try {
    const t0 = process.hrtime.bigint();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  } catch {
    database = 'error';
  }

  const dbUp = database === 'ok';
  res.status(dbUp ? 200 : 503).json({
    success: true,
    data: {
      server: 'ok',
      database,
      uptimeSeconds: Math.round(process.uptime()),
      dbLatencyMs: dbLatencyMs != null ? Math.round(dbLatencyMs) : null,
      timestamp: new Date().toISOString(),
    },
  });
};