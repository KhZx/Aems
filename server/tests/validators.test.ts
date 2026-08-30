import { describe, expect, it } from 'vitest';
import {
  registerSchema,
  approveUserSchema,
  createMedicineSchema,
  useMedicineSchema,
  transferSchema,
  createInspectionSchema,
  createSupplyRequestSchema,
  reviewSupplyRequestSchema,
  listSupplyRequestsQuerySchema,
} from '../src/validators/index.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('request validators', () => {
  it('accepts a valid registration', () => {
    const r = registerSchema.safeParse({
      displayName: 'John Doe',
      empId: 'EMP-001',
      requestedRole: 'PARAMEDIC',
      stationCode: '54',
    });
    expect(r.success).toBe(true);
  });

  it('rejects registration with a short name', () => {
    const r = registerSchema.safeParse({ displayName: 'A' });
    expect(r.success).toBe(false);
  });

  it('approval requires a role', () => {
    const r = approveUserSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('medicine creation rejects negative stock thresholds', () => {
    const r = createMedicineSchema.safeParse({ name: 'X', category: 'MEDICATION', minimumStock: -1 });
    expect(r.success).toBe(false);
  });

  it('use medicine requires positive quantity and a reason', () => {
    expect(useMedicineSchema.safeParse({ ambulanceId: UUID, medicineId: UUID, quantity: 0, reason: 'r' }).success).toBe(false);
    expect(useMedicineSchema.safeParse({ ambulanceId: UUID, medicineId: UUID, quantity: 1 }).success).toBe(false);
    expect(
      useMedicineSchema.safeParse({ ambulanceId: UUID, medicineId: UUID, quantity: 2, reason: 'Patient use' }).success,
    ).toBe(true);
  });

  it('transfer rejects zero quantity', () => {
    const base = { sourceInventoryId: UUID, destinationAmbulanceId: UUID };
    expect(transferSchema.safeParse({ ...base, quantity: 0 }).success).toBe(false);
    expect(transferSchema.safeParse({ ...base, quantity: 2 }).success).toBe(true);
  });

  it('inspection requires at least one item', () => {
    const r = createInspectionSchema.safeParse({ ambulanceId: 'a', items: [] });
    expect(r.success).toBe(false);
  });

  it('supply request creation requires uuid ids and a positive quantity', () => {
    expect(createSupplyRequestSchema.safeParse({ ambulanceId: 'x', medicineId: UUID, quantity: 1 }).success).toBe(false);
    expect(
      createSupplyRequestSchema.safeParse({ ambulanceId: UUID, medicineId: UUID, quantity: 0 }).success,
    ).toBe(false);
    expect(
      createSupplyRequestSchema.safeParse({ ambulanceId: UUID, medicineId: UUID, quantity: 3, reason: 'Low stock' })
        .success,
    ).toBe(true);
    expect(
      createSupplyRequestSchema.safeParse({ ambulanceId: UUID, medicineId: UUID, quantity: 3, reason: '' }).success,
    ).toBe(true);
  });

  it('review only accepts valid target statuses', () => {
    expect(reviewSupplyRequestSchema.safeParse({ status: 'APPROVED' }).success).toBe(true);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'REJECTED' }).success).toBe(true);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'FULFILLED' }).success).toBe(true);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'PENDING' }).success).toBe(false);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'CANCELLED' }).success).toBe(false);
    expect(reviewSupplyRequestSchema.safeParse({}).success).toBe(false);
  });

  it('list query coerces page/pageSize and rejects bad status', () => {
    expect(listSupplyRequestsQuerySchema.safeParse({}).success).toBe(true);
    const ok = listSupplyRequestsQuerySchema.safeParse({ page: '2', pageSize: '10' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.page).toBe(2);
      expect(ok.data.pageSize).toBe(10);
    }
    expect(listSupplyRequestsQuerySchema.safeParse({ status: 'NOPE' }).success).toBe(false);
  });
});
