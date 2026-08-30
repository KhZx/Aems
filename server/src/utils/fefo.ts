/**
 * FEFO (First Expiry, First Out) and expiry-status helpers.
 *
 * Expiry status is computed here on the backend and never trusted from the
 * browser. All frontends display whatever this module returns.
 */

export type ExpiryStatus = 'EXPIRED' | 'CRITICAL' | 'WARNING' | 'VALID' | 'NONE';

export const WARN_DAYS = 30;
export const CRITICAL_DAYS = 7;

/** Days from today until the given date (negative when in the past). */
export function daysUntil(date: Date, now: Date = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Classifies a single expiry date.
 *  - EXPIRED  → in the past
 *  - CRITICAL → within CRITICAL_DAYS
 *  - WARNING  → within WARN_DAYS
 *  - VALID    → beyond WARN_DAYS
 */
export function classifyExpiry(expiryDate: Date | null, now: Date = new Date()): ExpiryStatus {
  if (!expiryDate) return 'NONE';
  const days = daysUntil(expiryDate, now);
  if (days < 0) return 'EXPIRED';
  if (days <= CRITICAL_DAYS) return 'CRITICAL';
  if (days <= WARN_DAYS) return 'WARNING';
  return 'VALID';
}

export interface BatchStock {
  inventoryId: string;
  batchId: string;
  batchNumber: string;
  expiryDate: Date;
  quantity: number;
}

/**
 * Given all stock rows for one medicine, returns the batch that must be
 * consumed first according to FEFO. Only batches with stock are considered;
 * among them the earliest expiry wins. Expired stock is surfaced first so it
 * can be removed.
 */
export function pickFefoBatch(batches: BatchStock[], now: Date = new Date()): BatchStock | null {
  const inStock = batches
    .filter((b) => b.quantity > 0)
    .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());

  if (inStock.length === 0) return null;

  const first = inStock[0];
  return classifyExpiry(first.expiryDate, now) === 'EXPIRED' ? first : first;
}

/** Sum of all stock across batches for a medicine. */
export function totalStock(batches: BatchStock[]): number {
  return batches.reduce((sum, b) => sum + b.quantity, 0);
}

/** All batches of a medicine grouped by expiry status. */
export function groupByExpiry(
  batches: BatchStock[],
  now: Date = new Date(),
): Record<Exclude<ExpiryStatus, 'NONE'>, BatchStock[]> {
  const grouped = {
    EXPIRED: [] as BatchStock[],
    CRITICAL: [] as BatchStock[],
    WARNING: [] as BatchStock[],
    VALID: [] as BatchStock[],
  };
  for (const b of batches) {
    const status = classifyExpiry(b.expiryDate, now);
    if (status === 'EXPIRED') grouped.EXPIRED.push(b);
    else if (status === 'CRITICAL') grouped.CRITICAL.push(b);
    else if (status === 'WARNING') grouped.WARNING.push(b);
    else if (status === 'VALID') grouped.VALID.push(b);
  }
  return grouped;
}
