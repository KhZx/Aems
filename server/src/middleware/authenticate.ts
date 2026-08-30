import type { NextFunction, Request, Response } from 'express';
import { adminAuth, firebaseConfigured } from '../config/firebase.js';
import { prisma } from '../config/prisma.js';
import { permissionsFor } from '../utils/rbac.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

async function verifyTokenFromHeader(req: Request): Promise<{
  firebaseUid: string;
  idToken: string;
  email: string | null;
}> {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw AppError.unauthorized('Missing or malformed Authorization header');
  }

  if (!firebaseConfigured()) {
    logger.error('Firebase Admin credentials not configured — cannot verify tokens');
    throw AppError.unauthorized('Server authentication is not configured');
  }

  let firebaseUid: string;
  let email: string | null = null;
  try {
    const decoded = await adminAuth().verifyIdToken(token);
    firebaseUid = decoded.uid;
    email = decoded.email ?? null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ reason }, 'Firebase ID token verification failed');
    throw AppError.unauthorized('Invalid or expired token');
  }

  return { firebaseUid, idToken: token, email };
}

/**
 * Verifies the Firebase ID token only and stores the verified Firebase UID on
 * the request. Used by endpoints that must run before a matching user record
 * exists (e.g. self-registration).
 */
export async function verifyFirebaseToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { firebaseUid, idToken, email } = await verifyTokenFromHeader(req);
    req.firebaseUid = firebaseUid;
    req.idToken = idToken;
    req.verifiedEmail = email;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Verifies the `Authorization: Bearer <firebase-id-token>` header using the
 * Firebase Admin SDK, loads the matching application user from PostgreSQL,
 * checks that the account is active, and attaches the user + permissions to
 * `req`. Every protected route sits behind this middleware.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { firebaseUid, idToken } = await verifyTokenFromHeader(req);

    const user = await prisma.user.findUnique({ where: { firebaseUid } });
    if (!user) {
      throw AppError.unauthorized('Account has not been registered in the application');
    }

    if (user.status !== 'ACTIVE') {
      const msg =
        user.status === 'PENDING'
          ? 'Account is pending approval'
          : user.status === 'REJECTED'
            ? 'Account request was rejected'
            : 'Account is disabled';
      throw AppError.forbidden(msg);
    }

    req.firebaseUid = firebaseUid;
    req.idToken = idToken;
    req.authUser = {
      id: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      stationId: user.stationId,
    };
    req.permissions = permissionsFor(user.role);

    next();
  } catch (err) {
    next(err);
  }
}
