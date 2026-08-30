import type { Request } from 'express';
import { AppError } from './AppError.js';

/**
 * Reads a single-valued route parameter. Express 5 types params as
 * `string | string[]`; all routes in this app use single-valued params,
 * so anything else is a 400.
 */
export function reqParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') {
    throw AppError.badRequest(`Invalid route parameter "${name}"`);
  }
  return value;
}
