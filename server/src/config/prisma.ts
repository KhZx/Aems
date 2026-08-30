import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __aemsPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return client;
}

/**
 * Singleton Prisma client shared across the application.
 * Reused across test runs via the global to avoid exhausting connections.
 */
export const prisma = global.__aemsPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__aemsPrisma = prisma;
}
