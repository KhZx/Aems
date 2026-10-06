import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import type { ApiErrorResponse } from '../types/index.js';

/** 404 handler for unmatched routes. */
export function notFound(_req: Request, res: Response): void {
  const body: ApiErrorResponse = {
    success: false,
    error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
  };
  res.status(404).json(body);
}

interface KnownErrorMapping {
  statusCode: number;
  code: string;
  message: string;
}

/** Maps well-known Prisma errors to safe public messages. */
function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): KnownErrorMapping | null {
  switch (err.code) {
    case 'P2002':
      return {
        statusCode: 409,
        code: 'DUPLICATE_RESOURCE',
        message: 'A record with the same unique value already exists',
      };
    case 'P2003':
      return {
        statusCode: 400,
        code: 'REFERENCE_NOT_FOUND',
        message: 'The request references a record that does not exist',
      };
    case 'P2025':
      return {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Resource not found',
      };
    case 'P2014':
      return {
        statusCode: 400,
        code: 'INVALID_RELATION',
        message: 'The request would violate a relationship constraint',
      };
    default:
      return null;
  }
}

/**
 * Central error handler. Converts every thrown value into a consistent JSON
 * error envelope. Internal details are never leaked to clients in production.
 *
 * A rejected request is also a security signal: someone either walked into a
 * route they have no business calling, or tried to reach another unit's record.
 * Every 401/403 for an authenticated user is written to the audit trail as
 * SECURITY_SCOPE_DENIED so the attempt is visible to a supervisor instead of
 * vanishing silently. Best-effort: a logging failure never changes the response.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = mapPrismaError(err);
    if (mapped) {
      statusCode = mapped.statusCode;
      code = mapped.code;
      message = mapped.message;
    } else {
      logger.error({ err, path: req.path }, 'Prisma error');
    }
  } else {
    logger.error({ err, path: req.path }, 'Unhandled error');
  }

  if (statusCode >= 500) {
    logger.error({ err: err instanceof Error ? err.stack : String(err), path: req.path, method: req.method }, 'Server error');
  }

  if ((statusCode === 401 || statusCode === 403) && req.authUser) {
    logScopeDenial(req, code, message);
  }

  const body: ApiErrorResponse = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  res.status(statusCode).json(body);
}

/**
 * Appends a SECURITY_SCOPE_DENIED entry. Fire-and-forget on purpose: the client
 * is already getting its 403 and must not wait on (or be affected by) the audit
 * write.
 */
function logScopeDenial(req: Request, code: string, message: string): void {
  const user = req.authUser;
  if (!user) return;

  logger.warn(
    { userId: user.id, role: user.role, method: req.method, path: req.path, ip: req.ip },
    'Access denied',
  );

  void (async () => {
    try {
      const { createAudit } = await import('../services/audit.service.js');
      const { prisma } = await import('../config/prisma.js');
      await createAudit(prisma, {
        userId: user.id,
        action: 'SECURITY_SCOPE_DENIED',
        entityType: 'HttpRequest',
        metadata: {
          method: req.method,
          path: req.path,
          code,
          reason: message,
          role: user.role,
          stationId: user.stationId,
        },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    } catch (logErr) {
      logger.error({ err: logErr }, 'Failed to record access-denied audit entry');
    }
  })();
}
