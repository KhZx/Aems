-- Add composite indexes for the hottest inventory/medicine queries.

-- Speed up inventory list scoped to an ambulance, filtered by deleted + quantity.
CREATE INDEX IF NOT EXISTS "Inventory_ambulanceId_deletedAt_quantity_idx"
  ON "Inventory" ("ambulanceId", "deletedAt", "quantity");

-- Speed up expiry-range scans (dashboard warnings/expired) + FEFO ordering.
CREATE INDEX IF NOT EXISTS "MedicineBatch_expiryDate_isActive_deletedAt_idx"
  ON "MedicineBatch" ("expiryDate", "isActive", "deletedAt");
