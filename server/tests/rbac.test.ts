import { describe, expect, it } from 'vitest';
import { permissionsFor, ROLE_PERMISSIONS, ALL_PERMISSIONS } from '../src/utils/rbac.js';

describe('RBAC permission model', () => {
  it('grants ADMIN every permission', () => {
    expect(permissionsFor('ADMIN').size).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) expect(permissionsFor('ADMIN').has(p)).toBe(true);
  });

  it('paramedics may adjust their own unit but never the fleet-wide catalogue', () => {
    const p = permissionsFor('PARAMEDIC');
    expect(p.has('inventory:use')).toBe(true);
    expect(p.has('inventory:read')).toBe(true);
    // Adjusting stock on their OWN unit is allowed (the controller still scopes
    // every call to that unit's ambulance).
    expect(p.has('inventory:adjust')).toBe(true);
    expect(p.has('inventory:transfer')).toBe(false);
    expect(p.has('user:approve')).toBe(false);
    // Deleting/renaming a medicine is company-wide: never for a crew member.
    expect(p.has('medicine:delete')).toBe(false);
    expect(p.has('medicine:update')).toBe(false);
    // Nobody but ADMIN hands out station assignments.
    expect(p.has('station:assign')).toBe(false);
    // A crew member may remove their own fresh note, but cannot restore one.
    expect(p.has('shiftnote:delete')).toBe(true);
    expect(p.has('shiftnote:restore')).toBe(false);
    expect(p.has('medicine:create')).toBe(true);
    expect(p.has('batch:create')).toBe(true);
  });

  it('no field crew role may delete a medicine from the shared catalogue', () => {
    for (const role of ['PARAMEDIC', 'EMT', 'TECHNICIAN', 'DOCTOR'] as const) {
      const p = permissionsFor(role);
      expect(p.has('medicine:delete')).toBe(false);
      expect(p.has('medicine:update')).toBe(false);
      expect(p.has('station:assign')).toBe(false);
      expect(p.has('station:delete')).toBe(false);
      expect(p.has('user:update')).toBe(false);
      expect(p.has('shiftnote:restore')).toBe(false);
    }
  });

  it('supervisors may adjust/inspect/transfer and manage the catalogue, but not roles or assignments', () => {
    const p = permissionsFor('SUPERVISOR');
    expect(p.has('inventory:adjust')).toBe(true);
    expect(p.has('inventory:transfer')).toBe(true);
    expect(p.has('inspection:create')).toBe(true);
    expect(p.has('audit:read')).toBe(true);
    expect(p.has('medicine:delete')).toBe(true);
    expect(p.has('shiftnote:restore')).toBe(true);
    expect(p.has('user:approve')).toBe(false);
    expect(p.has('user:changeRole')).toBe(false);
    // A supervisor must not be able to grant themselves more units.
    expect(p.has('station:assign')).toBe(false);
  });

  it('only ADMIN may assign stations', () => {
    expect(permissionsFor('ADMIN').has('station:assign')).toBe(true);
    for (const role of ['PARAMEDIC', 'EMT', 'TECHNICIAN', 'DOCTOR', 'SUPERVISOR'] as const) {
      expect(permissionsFor(role).has('station:assign')).toBe(false);
    }
  });

  it('technicians can restock/adjust but not consume medicine', () => {
    const p = permissionsFor('TECHNICIAN');
    expect(p.has('inventory:restock')).toBe(true);
    expect(p.has('inventory:adjust')).toBe(true);
    expect(p.has('inventory:use')).toBe(false);
  });

  it('field crews may request stock but not review supply requests', () => {
    for (const role of ['PARAMEDIC', 'EMT', 'TECHNICIAN'] as const) {
      const p = permissionsFor(role);
      expect(p.has('supply:request')).toBe(true);
      expect(p.has('supply:read')).toBe(true);
      expect(p.has('supply:review')).toBe(false);
    }
  });

  it('supervisors and admins may request, read and review supply requests', () => {
    for (const role of ['SUPERVISOR', 'ADMIN'] as const) {
      const p = permissionsFor(role);
      expect(p.has('supply:request')).toBe(true);
      expect(p.has('supply:read')).toBe(true);
      expect(p.has('supply:review')).toBe(true);
    }
  });

  it('doctors may read supply requests but not request or review them', () => {
    const p = permissionsFor('DOCTOR');
    expect(p.has('supply:read')).toBe(true);
    expect(p.has('supply:request')).toBe(false);
    expect(p.has('supply:review')).toBe(false);
  });

  it('every role has an explicit entry', () => {
    for (const role of ['PARAMEDIC', 'EMT', 'TECHNICIAN', 'DOCTOR', 'SUPERVISOR', 'ADMIN'] as const) {
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });
});
