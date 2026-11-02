/**
 * Per-unit lot overrides.
 *
 * The `MedicineBatch` record is the admin-published template shared by every
 * ambulance. A unit may override the lot number / expiry / supplier / received
 * date on its own `Inventory` row; where an override is set it wins, otherwise
 * the shared batch value is used. These helpers give the "effective" value so
 * reads never have to branch on which source is populated.
 */

export interface LotOverrides {
  overrideBatchNumber: string | null;
  overrideExpiryDate: Date | null;
  overrideSupplier: string | null;
  overrideReceivedDate: Date | null;
}

export interface SharedBatchLot {
  batchNumber: string;
  expiryDate: Date;
  supplier: string | null;
  receivedDate: Date | null;
}

export function effectiveBatchNumber(overrides: LotOverrides, batch: SharedBatchLot): string {
  return overrides.overrideBatchNumber ?? batch.batchNumber;
}

export function effectiveExpiryDate(overrides: LotOverrides, batch: SharedBatchLot): Date {
  return overrides.overrideExpiryDate ?? batch.expiryDate;
}

export function effectiveSupplier(overrides: LotOverrides, batch: SharedBatchLot): string | null {
  return overrides.overrideSupplier ?? batch.supplier;
}

export function effectiveReceivedDate(overrides: LotOverrides, batch: SharedBatchLot): Date | null {
  return overrides.overrideReceivedDate ?? batch.receivedDate;
}

/** True when this stock line carries any per-unit lot override. */
export function hasLotOverride(overrides: LotOverrides): boolean {
  return Boolean(
    overrides.overrideBatchNumber ||
      overrides.overrideExpiryDate ||
      overrides.overrideSupplier ||
      overrides.overrideReceivedDate,
  );
}
