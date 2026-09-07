import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __aemsPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    datasources: {
      db: {
        // Connection pool to keep request latency low against remote (Railway)
        // Postgres. Prisma opens a fresh socket per query without a pool, which
        // adds 50–150ms of TLS handshake overhead to every request.
        url: process.env.DATABASE_URL
          ? poolUrl(process.env.DATABASE_URL)
          : undefined,
      },
    },
  });
  return client;
}

/**
 * Rewrites a PostgreSQL connection string to route through PgBouncer-style
 * transaction pooling via a `pgbouncer=true` / `pool_timeout` hint. If the URL
 * already contains explicit pool params or uses a pgbouncer host, it is
 * returned unchanged.
 */
function poolUrl(original: string): string {
  if (/\b(pgbouncer|pooler)\b/.test(original)) return original;
  const separator = original.includes('?') ? '&' : '?';
  return `${original}${separator}connection_limit=5&pool_timeout=10&connect_timeout=15`;
}

/**
 * Singleton Prisma client shared across the application.
 * Reused across test runs via the global to avoid exhausting connections.
 */
export const prisma = global.__aemsPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__aemsPrisma = prisma;
}
