// Sets baseline environment variables BEFORE any module imports run.
const src = process.env;

src.NODE_ENV = src.NODE_ENV ?? 'test';
src.DATABASE_URL = src.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/aems_test?schema=public';
src.FIREBASE_PROJECT_ID = src.FIREBASE_PROJECT_ID ?? 'aems-test';
src.FIREBASE_CLIENT_EMAIL = src.FIREBASE_CLIENT_EMAIL ?? 'test@example.com';
src.FIREBASE_PRIVATE_KEY = src.FIREBASE_PRIVATE_KEY ?? 'test-private-key';
src.FRONTEND_ORIGIN = src.FRONTEND_ORIGIN ?? 'http://localhost:3000';
src.BOOTSTRAP_ADMIN_UID = src.BOOTSTRAP_ADMIN_UID ?? '';

export {};
