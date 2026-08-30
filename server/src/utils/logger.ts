import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Structured JSON logger. In production, logs are emitted as JSON so
 * they can be shipped to a log aggregator; in development a pretty
 * transport is used for readability.
 */
export const logger = pino({
  level: isProduction ? 'info' : 'debug',
  base: { service: 'aems-api', env: env.NODE_ENV },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
});

export type Logger = typeof logger;
