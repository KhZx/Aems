import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

/**
 * Global rate limiter applied to all API routes. In production, configure a
 * stricter reverse-proxy level limit as well.
 */
export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  // Integration tests intentionally make many requests from one in-memory IP.
  // Keep production protections enabled while avoiding order-dependent tests.
  skip: () => env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, _next, options) => {
    throw AppError.tooManyRequests(options.message);
  },
});

/** Stricter limiter for authentication endpoints (login/signup). */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  skip: () => env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, _next, options) => {
    throw AppError.tooManyRequests(options.message);
  },
});

/**
 * Limiter for destructive endpoints (delete / bulk-clear). Keyed by user id when
 * authenticated and IP otherwise, so one account (or one stolen token) cannot
 * mass-delete records even with a valid session. Legitimate use is a handful of
 * requests per shift; the limit is deliberately far above that.
 */
export const destructiveRateLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 40,
  skip: () => env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.authUser?.id;
    return userId ? `uid:${userId}` : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  handler: (_req, _res, _next, options) => {
    throw AppError.tooManyRequests(
      'Too many delete/clear attempts in a short period. If this is legitimate, contact an administrator.',
    );
  },
});
