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
  updateBatchSchema,
  updateInventoryLotSchema,
  listStockReasonsQuerySchema,
  voidInspectionSchema,
  acknowledgeInspectionSchema,
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

  it('medicine creation rejects an oversized size label', () => {
    const r = createMedicineSchema.safeParse({ name: 'Paracetamol', category: 'MEDICATION', size: 'x'.repeat(60) });
    expect(r.success).toBe(false);
    expect(createMedicineSchema.safeParse({ name: 'Paracetamol', category: 'MEDICATION', size: '10FG' }).success).toBe(true);
    expect(createMedicineSchema.safeParse({ name: 'Paracetamol', category: 'MEDICATION' }).success).toBe(true);
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

  it('inspection draft accepts an empty sheet but validates line shape', () => {
    // Free-form: a draft may start empty and be filled in later.
    expect(createInspectionSchema.safeParse({ ambulanceId: UUID, items: [] }).success).toBe(true);
    expect(createInspectionSchema.safeParse({ ambulanceId: UUID }).success).toBe(true);
    // Lines must carry a valid condition and non-negative integer quantity.
    expect(
      createInspectionSchema.safeParse({
        ambulanceId: UUID,
        items: [{ inventoryId: UUID, actualQuantity: 3, condition: 'MISSING', reasonCode: 'LOST_OPERATIONS' }],
      }).success,
    ).toBe(true);
    expect(
      createInspectionSchema.safeParse({ ambulanceId: UUID, items: [{ inventoryId: UUID, actualQuantity: -1 }] }).success,
    ).toBe(false);
    expect(
      createInspectionSchema.safeParse({
        ambulanceId: UUID,
        items: [{ inventoryId: UUID, actualQuantity: 1, condition: 'NOPE' }],
      }).success,
    ).toBe(false);
  });

  it('inspection lines tolerate explicit nulls and normalise them away', () => {
    // The count sheet sends null for reasonCode/notes on rows that were not changed.
    const parsed = createInspectionSchema.safeParse({
      ambulanceId: UUID,
      notes: null,
      title: null,
      shiftCode: null,
      items: [{ inventoryId: UUID, actualQuantity: 5, condition: null, reasonCode: null, notes: null }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.items[0].reasonCode).toBeUndefined();
    expect(parsed.data.items[0].notes).toBeUndefined();
    expect(parsed.data.notes).toBeUndefined();
  });

  it('void requires a substantive reason and acknowledge accepts optional notes', () => {
    expect(voidInspectionSchema.safeParse({ voidReason: 'no' }).success).toBe(false);
    expect(voidInspectionSchema.safeParse({ voidReason: 'Duplicate entry' }).success).toBe(true);
    expect(acknowledgeInspectionSchema.safeParse({}).success).toBe(true);
    expect(acknowledgeInspectionSchema.safeParse({ reviewNotes: 'ok' }).success).toBe(true);
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

  it('batch update always requires a reason and at least one changed field', () => {
    expect(updateBatchSchema.safeParse({ supplier: 'Acme' }).success).toBe(false);
    expect(updateBatchSchema.safeParse({ reason: 'r' }).success).toBe(false);
    expect(updateBatchSchema.safeParse({ supplier: 'Acme', reason: 'Corrected' }).success).toBe(true);
    expect(updateBatchSchema.safeParse({ batchNumber: 'LOT-2', reason: 'Fix lot' }).success).toBe(true);
    expect(updateBatchSchema.safeParse({ reason: 'Fix lot' }).success).toBe(false);
  });

  it('batch update rejects a malformed expiry date', () => {
    expect(updateBatchSchema.safeParse({ expiryDate: '2027/01/01', reason: 'Fix' }).success).toBe(false);
    expect(updateBatchSchema.safeParse({ expiryDate: '2027-01-01', reason: 'Fix' }).success).toBe(true);
  });

  it('per-unit lot update requires a reason and at least one changed field', () => {
    expect(updateInventoryLotSchema.safeParse({ reason: 'Fix lot' }).success).toBe(false);
    expect(updateInventoryLotSchema.safeParse({ batchNumber: 'LOT-9' }).success).toBe(false);
    expect(updateInventoryLotSchema.safeParse({ reason: 'r', batchNumber: 'LOT-9' }).success).toBe(false);
    expect(updateInventoryLotSchema.safeParse({ reason: 'Corrected number', batchNumber: 'LOT-9' }).success).toBe(true);
    expect(updateInventoryLotSchema.safeParse({ reason: 'Fix expiry', expiryDate: '2027-01-01' }).success).toBe(true);
    expect(updateInventoryLotSchema.safeParse({ reason: 'Fix expiry', expiryDate: '2027/01/01' }).success).toBe(false);
    // Empty received date is allowed (clear the override); empty supplier too.
    expect(updateInventoryLotSchema.safeParse({ reason: 'Clear', receivedDate: '' }).success).toBe(true);
    expect(updateInventoryLotSchema.safeParse({ reason: 'Clear', supplier: '' }).success).toBe(true);
  });

  it('stock-reason filters accept known item types/actions and coerce flags', () => {
    expect(listStockReasonsQuerySchema.safeParse({}).success).toBe(true);
    expect(listStockReasonsQuerySchema.safeParse({ itemType: 'MEDICATION' }).success).toBe(true);
    expect(listStockReasonsQuerySchema.safeParse({ itemType: 'EQUIPMENT' }).success).toBe(true);
    expect(listStockReasonsQuerySchema.safeParse({ itemType: 'NOPE' }).success).toBe(false);
    expect(listStockReasonsQuerySchema.safeParse({ action: 'INSPECTION' }).success).toBe(true);
    expect(listStockReasonsQuerySchema.safeParse({ action: 'NOPE' }).success).toBe(false);
    const parsed = listStockReasonsQuerySchema.safeParse({ includeInactive: 'true' });
    expect(parsed.success && parsed.data.includeInactive).toBe(true);
    const parsedFalse = listStockReasonsQuerySchema.safeParse({ includeInactive: 'false' });
    expect(parsedFalse.success && parsedFalse.data.includeInactive).toBe(false);
  });

  it('review only accepts approve/reject (other transitions have their own endpoints)', () => {
    expect(reviewSupplyRequestSchema.safeParse({ status: 'APPROVED' }).success).toBe(true);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'REJECTED' }).success).toBe(true);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'FULFILLED' }).success).toBe(false);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'DISPATCHED' }).success).toBe(false);
    expect(reviewSupplyRequestSchema.safeParse({ status: 'PENDING' }).success).toBe(false);
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
