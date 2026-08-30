import type { Role, UserStatus } from '@prisma/client';
import type { Permission } from '../utils/rbac.js';

export interface AuthedUser {
  id: string;
  firebaseUid: string;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  stationId: string | null;
}

export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Envelope used for every successful API response. */
export interface ApiResponse<T = unknown> {
  success: true;
  data: T;
}

/** Envelope used for every error response. */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
