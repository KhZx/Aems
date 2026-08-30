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

  const body: ApiErrorResponse = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  res.status(statusCode).json(body);
}
