import type { Permission } from '../utils/rbac.js';
import type { AuthedUser } from './index.js';

declare global {
  namespace Express {
    interface Request {
      /** The authenticated application user (loaded from PostgreSQL). */
      authUser?: AuthedUser;
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
