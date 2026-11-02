import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  FIREBASE_PROJECT_ID: z.string().optional().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().optional().default(''),
  FIREBASE_PRIVATE_KEY: z.string().optional().default(''),

  FRONTEND_ORIGIN: z.string().optional().default(''),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  BOOTSTRAP_ADMIN_UID: z.string().optional().default(''),
}).superRefine((value, ctx) => {
  // Production must fail closed: a missing Firebase key or a bad frontend
  // origin otherwise leaves Railway "healthy" while every login/CORS call fails.
  if (value.NODE_ENV !== 'production') return;

  for (const key of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'] as const) {
    if (!value[key]) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
    }
  }

  const origins = value.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['FRONTEND_ORIGIN'], message: 'FRONTEND_ORIGIN is required in production' });
  }
  for (const origin of origins) {
    if (!origin.startsWith('https://') || /localhost|127\.0\.0\.1/.test(origin)) {
      ctx.addIssue({
        code: 'custom',
        path: ['FRONTEND_ORIGIN'],
        message: `Production origins must be public https:// URLs (got "${origin}")`,
      });
    }
  }
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';
