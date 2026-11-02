import type { Role } from '@prisma/client';

/**
 * Explicit permission names. Every authorization decision in the application
 * is expressed as a permission check, never as an inline role comparison.
 */
export type Permission =
  | 'user:read'
  | 'user:create'
  | 'user:update'
  | 'user:approve'
  | 'user:changeRole'
  | 'user:disable'
  | 'station:read'
  | 'station:create'
  | 'station:update'
  | 'station:delete'
  /** ADMIN only: hand out/revoke supervisor station assignments. */
  | 'station:assign'
  /** SUPERVISOR: add/remove stations on their own managed list. */
  | 'station:selfAssign'
  | 'ambulance:read'
  | 'ambulance:create'
  | 'ambulance:update'
  | 'medicine:read'
  | 'medicine:create'
  | 'medicine:update'
  | 'medicine:delete'
  | 'batch:read'
  | 'batch:create'
  /** Edits a batch/lot (number, expiry, supplier, received date) — audited. */
  | 'batch:update'
  | 'inventory:read'
  | 'inventory:use'
  | 'inventory:restock'
  | 'inventory:adjust'
  | 'inventory:update-expiry'
  /** Edits the lot metadata on ONE unit's own stock line (per-unit override). */
  | 'inventory:update-lot'
  | 'inventory:write'
  | 'inventory:transfer'
  | 'inspection:read'
  | 'inspection:create'
  /** Acknowledge or void a completed inspection (supervisor/admin). */
  | 'inspection:review'
  | 'transfer:read'
  | 'shiftnote:read'
  | 'shiftnote:create'
  | 'shiftnote:delete'
  /** Puts a soft-deleted shift note back (supervisor/admin only). */
  | 'shiftnote:restore'
  | 'handover:read'
  | 'handover:create'
  | 'handover:acknowledge'
  | 'report:read'
  | 'report:create'
  | 'audit:read'
  | 'supply:request'
  | 'supply:read'
  | 'supply:review'
  | 'dashboard:read'
  | 'distribution:manage';

const ALL_PERMISSIONS: Permission[] = [
  'user:read',
  'user:create',
  'user:update',
  'user:approve',
  'user:changeRole',
  'user:disable',
  'station:read',
  'station:create',
  'station:update',
  'station:delete',
  'station:assign',
  'station:selfAssign',
  'ambulance:read',
  'ambulance:create',
  'ambulance:update',
  'medicine:read',
  'medicine:create',
  'medicine:update',
  'medicine:delete',
  'batch:read',
  'batch:create',
  'batch:update',
  'inventory:read',
  'inventory:use',
  'inventory:restock',
  'inventory:adjust',
  'inventory:update-expiry',
  'inventory:update-lot',
  'inventory:write',
  'inventory:transfer',
  'inspection:read',
  'inspection:create',
  'inspection:review',
  'transfer:read',
  'shiftnote:read',
  'shiftnote:create',
  'shiftnote:delete',
  'shiftnote:restore',
  'handover:read',
  'handover:create',
  'handover:acknowledge',
  'report:read',
  'report:create',
  'audit:read',
  'supply:request',
  'supply:read',
  'supply:review',
  'dashboard:read',
  'distribution:manage',
];

/**
 * Role → permission mapping. One authoritative table; changing access
 * semantics means editing this table, not hunting for role strings.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: ALL_PERMISSIONS,

  SUPERVISOR: [
    'user:read',
    'station:read',
    'station:selfAssign',
    'ambulance:read',
    'medicine:read',
    'medicine:delete',
    'batch:read',
    'batch:update',
    'inventory:read',
    'inventory:restock',
    'inventory:adjust',
    'inventory:update-expiry',
    'inventory:update-lot',
    'inventory:write',
    'inventory:transfer',
  'inspection:read',
  'inspection:create',
  'inspection:review',
  'transfer:read',
  'shiftnote:read',
  'shiftnote:create',
  'shiftnote:delete',
  'shiftnote:restore',
  'handover:read',
  'handover:create',
  'handover:acknowledge',
  'report:read',
  'report:create',
  'audit:read',
  'supply:request',
  'supply:read',
  'supply:review',
  'dashboard:read',
  ],

  PARAMEDIC: [
    'medicine:read',
    'medicine:create',
    'batch:read',
    'batch:create',
    'batch:update',
    'inventory:read',
    'inventory:use',
    'inventory:restock',
    'inventory:adjust',
    'inventory:update-expiry',
    'inventory:update-lot',
    'inspection:read',
    'inspection:create',
    'transfer:read',
    'shiftnote:read',
    'shiftnote:create',
    'shiftnote:delete',
    'handover:read',
    'handover:create',
    'handover:acknowledge',
    'report:read',
    'report:create',
    'audit:read',
    'supply:request',
    'supply:read',
  ],

  EMT: [
    'medicine:read',
    'medicine:create',
    'batch:read',
    'batch:create',
    'batch:update',
    'inventory:read',
    'inventory:use',
    'inventory:restock',
    'inventory:adjust',
    'inventory:update-expiry',
    'inventory:update-lot',
    'inspection:read',
    'inspection:create',
    'transfer:read',
    'shiftnote:read',
    'shiftnote:create',
    'shiftnote:delete',
    'handover:read',
    'handover:create',
    'handover:acknowledge',
    'report:read',
    'report:create',
    'audit:read',
    'supply:request',
    'supply:read',
  ],

  TECHNICIAN: [
    'medicine:read',
    'medicine:create',
    'batch:read',
    'batch:create',
    'batch:update',
    'inventory:read',
    'inventory:restock',
    'inventory:adjust',
    'inventory:update-expiry',
    'inventory:update-lot',
    'inventory:write',
    'inspection:read',
    'inspection:create',
    'transfer:read',
    'shiftnote:read',
    'shiftnote:create',
    'shiftnote:delete',
    'handover:read',
    'handover:create',
    'handover:acknowledge',
    'report:read',
    'audit:read',
    'supply:request',
    'supply:read',
  ],

  DOCTOR: [
    'medicine:read',
    'batch:read',
    'batch:update',
    'inventory:read',
    'inventory:use',
    'inspection:read',
    'transfer:read',
    'shiftnote:read',
    'handover:read',
    'handover:create',
    'handover:acknowledge',
    'report:read',
    'audit:read',
    'supply:read',
  ],
};

/** Returns the set of permissions granted to a role. */
export function permissionsFor(role: Role): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role] ?? []);
}

export { ALL_PERMISSIONS };
