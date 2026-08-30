import type { Role, UserStatus } from '@prisma/client';
import type { Permission } from '../utils/rbac.js';

declare global {
  namespace Express {
    interface Request {
      /** The authenticated application user (loaded from PostgreSQL). */
      authUser?: {
        id: string;
        firebaseUid: string;
        email: string;
        displayName: string;
        role: Role;
        status: UserStatus;
        stationId: string | null;
      };
      /** Permissions granted to the authenticated user for this request. */
      permissions?: ReadonlySet<Permission>;
      /** Raw Firebase UID from the verified ID token. */
      firebaseUid?: string;
      /** Email claim from the verified ID token. */
      verifiedEmail?: string | null;
      /** Verified Firebase ID token (may be used for display/audit). */
      idToken?: string;
    }
  }
}

export {};
