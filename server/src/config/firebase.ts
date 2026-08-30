import {
  initializeApp,
  cert,
  getApps,
  type App,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let _app: App | null = null;
let _auth: Auth | null = null;

/**
 * Whether the environment provides the credentials required for the
 * Firebase Admin SDK. Returns false when running without a service-account
 * key (e.g. some test environments), in which case the auth middleware
 * rejects with a clear server-side error.
 */
export function firebaseConfigured(): boolean {
  return Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

/** Lazily initialize the Firebase Admin SDK. Safe to call repeatedly. */
export function firebaseAdmin(): { app: App; auth: Auth } {
  if (_app && _auth) return { app: _app, auth: _auth };

  if (!firebaseConfigured()) {
    throw new Error(
      'Firebase Admin SDK is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
    );
  }

  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

  _app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({
          credential: cert({
            projectId: env.FIREBASE_PROJECT_ID,
            clientEmail: env.FIREBASE_CLIENT_EMAIL,
            privateKey,
          }),
        });

  _auth = getAuth(_app);
  logger.info('Firebase Admin SDK initialized');
  return { app: _app, auth: _auth };
}

/** Returns the Admin Auth handle or throws if not configured. */
export function adminAuth(): Auth {
  return firebaseAdmin().auth;
}
