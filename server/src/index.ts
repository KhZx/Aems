import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { prisma } from './config/prisma.js';
import { syncStockReasons } from './config/stockReasons.js';
import { runExpiryNotificationSweep } from './services/notificationJobs.service.js';

const app = createApp();

// Fail fast with one actionable line instead of a wall of Prisma errors when
// the database is unreachable. Railway restarts the service automatically.
try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  const lines =
    err instanceof Error
      ? err.message.split('\n').map((line) => line.trim()).filter(Boolean)
      : [String(err)];
  const detail =
    lines.find(
      (line) =>
        !line.startsWith('Invalid `') &&
        !line.startsWith('Please make sure') &&
        !line.startsWith('→') &&
        !/^\d+\s/.test(line),
    ) ?? lines[0] ?? 'Unknown database error';
  logger.error(`Database connection failed: ${detail}`);
  logger.error('Check DATABASE_URL and make sure PostgreSQL is running (local: npm run db:start).');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}

const expiryNotificationTimer = setInterval(() => {
  void runExpiryNotificationSweep().catch((err) => logger.error({ err }, 'Expiry notification sweep failed'));
}, 24 * 60 * 60 * 1000);
expiryNotificationTimer.unref?.();
void runExpiryNotificationSweep().catch((err) => logger.error({ err }, 'Initial expiry notification sweep failed'));

// Seed/refresh the structured reason catalog before accepting traffic so stock
// actions and inspections always have their reference data available.
syncStockReasons(prisma)
  .then(({ total, created }) => logger.info({ total, created }, 'Stock reason catalog synced'))
  .catch((err) => logger.error({ err }, 'Failed to sync stock reason catalog'));

const server = app.listen(env.PORT, () => {
  logger.info(`AEMS API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

server.on('error', (err) => {
  logger.error({ err }, 'HTTP server failed to start');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down AEMS API');
  clearInterval(expiryNotificationTimer);

  // SSE clients keep connections open indefinitely, so bound the graceful
  // drain and force-close whatever is left instead of waiting forever.
  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out; closing remaining connections');
    server.closeAllConnections?.();
    process.exit(0);
  }, 15_000);
  forceExit.unref?.();

  server.close(async () => {
    clearTimeout(forceExit);
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
