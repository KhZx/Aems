import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError } from '../utils/AppError.js';

type Source = 'body' | 'query' | 'params';

/**
 * Validates a request section against a Zod schema. On failure it rejects
 * with a 400 and a structured list of field errors. Validation is enforced
 * server-side and is the first line of defense; the browser is untrusted.
 */
export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      next(AppError.badRequest('Request validation failed', issues));
      return;
    }

    if (source === 'query') {
      // Express 5 exposes req.query via a prototype getter that re-parses on
      // every access, so Object.assign() here is silently lost. Shadow the
      // getter with a real own-property so coerced values (e.g. numbers) stick.
      Object.defineProperty(req, 'query', {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } else {
      (req as unknown as Record<string, unknown>)[source] = result.data;
    }
    next();
  };
}
