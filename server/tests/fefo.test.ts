import { describe, expect, it } from 'vitest';
import {
  classifyExpiry,
  daysUntil,
  groupByExpiry,
  pickFefoBatch,
  totalStock,
  WARN_DAYS,
  CRITICAL_DAYS,
} from '../src/utils/fefo.js';

describe('fefo helpers', () => {
  const now = new Date('2026-01-15T12:00:00Z');

  describe('classifyExpiry', () => {
    it('classifies past dates as EXPIRED', () => {
      expect(classifyExpiry(new Date('2026-01-10'), now)).toBe('EXPIRED');
    });

    it('classifies within 7 days as CRITICAL', () => {
      expect(classifyExpiry(new Date('2026-01-20'), now)).toBe('CRITICAL');
    });

    it('classifies within 30 days as WARNING', () => {
      expect(classifyExpiry(new Date('2026-02-01'), now)).toBe('WARNING');
    });

    it('classifies beyond 30 days as VALID', () => {
      expect(classifyExpiry(new Date('2026-04-01'), now)).toBe('VALID');
    });

    it('returns NONE for null', () => {
      expect(classifyExpiry(null, now)).toBe('NONE');
    });
  });

  describe('daysUntil', () => {
    it('computes whole-day difference', () => {
      expect(daysUntil(new Date('2026-02-01'), now)).toBe(17);
      expect(daysUntil(new Date('2026-01-10'), now)).toBe(-5);
    });
  });

  describe('pickFefoBatch', () => {
    const mk = (id: string, expiry: string, qty: number) => ({
      inventoryId: id,
      batchId: id,
      batchNumber: id,
      expiryDate: new Date(expiry),
      quantity: qty,
    });

    it('picks the earliest expiry among batches with stock', () => {
      const batches = [mk('a', '2026-06-01', 10), mk('b', '2026-04-01', 5), mk('c', '2027-01-01', 8)];
      expect(pickFefoBatch(batches, now)?.batchId).toBe('b');
    });

    it('ignores zero-stock batches', () => {
      const batches = [mk('a', '2026-02-01', 0), mk('b', '2026-08-01', 4)];
      expect(pickFefoBatch(batches, now)?.batchId).toBe('b');
    });

    it('returns null when nothing is in stock', () => {
      expect(pickFefoBatch([mk('a', '2026-06-01', 0)], now)).toBeNull();
    });
  });

  describe('totalStock / groupByExpiry', () => {
    it('sums quantities', () => {
      const batches = [
        { inventoryId: 'a', batchId: 'a', batchNumber: 'a', expiryDate: new Date('2026-01-01'), quantity: 3 },
        { inventoryId: 'b', batchId: 'b', batchNumber: 'b', expiryDate: new Date('2026-06-01'), quantity: 7 },
      ];
      expect(totalStock(batches)).toBe(10);
    });

    it('groups by expiry status', () => {
      const batches = [
        { inventoryId: 'a', batchId: 'a', batchNumber: 'a', expiryDate: new Date('2026-01-01'), quantity: 1 },
        { inventoryId: 'b', batchId: 'b', batchNumber: 'b', expiryDate: new Date('2026-01-20'), quantity: 1 },
        { inventoryId: 'c', batchId: 'c', batchNumber: 'c', expiryDate: new Date('2026-02-05'), quantity: 1 },
        { inventoryId: 'd', batchId: 'd', batchNumber: 'd', expiryDate: new Date('2026-08-01'), quantity: 1 },
      ];
      const grouped = groupByExpiry(batches, now);
      expect(grouped.EXPIRED).toHaveLength(1);
      expect(grouped.CRITICAL).toHaveLength(1);
      expect(grouped.WARNING).toHaveLength(1);
      expect(grouped.VALID).toHaveLength(1);
    });
  });
});

describe('threshold constants', () => {
  it('uses 7-day critical and 30-day warning windows', () => {
    expect(CRITICAL_DAYS).toBe(7);
    expect(WARN_DAYS).toBe(30);
  });
});
