import { describe, expect, it } from 'vitest';
import { permissionsFor, ROLE_PERMISSIONS, ALL_PERMISSIONS } from '../src/utils/rbac.js';

describe('RBAC permission model', () => {
  it('grants ADMIN every permission', () => {
    expect(permissionsFor('ADMIN').size).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) expect(permissionsFor('ADMIN').has(p)).toBe(true);
  });

  it('paramedics may use inventory but not adjust or approve users', () => {
    const p = permissionsFor('PARAMEDIC');
    expect(p.has('inventory:use')).toBe(true);
    expect(p.has('inventory:read')).toBe(true);
    expect(p.has('inventory:adjust')).toBe(false);
    expect(p.has('inventory:transfer')).toBe(false);
    expect(p.has('user:approve')).toBe(false);
    expect(p.has('medicine:create')).toBe(true);
    expect(p.has('batch:create')).toBe(true);
  });

  it('supervisors may adjust/inspect/transfer but not manage roles', () => {
    const p = permissionsFor('SUPERVISOR');
    expect(p.has('inventory:adjust')).toBe(true);
    expect(p.has('inventory:transfer')).toBe(true);
    expect(p.has('inspection:create')).toBe(true);
    expect(p.has('audit:read')).toBe(true);
    expect(p.has('user:approve')).toBe(false);
    expect(p.has('user:changeRole')).toBe(false);
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
