-- Supplier goods-receipt: record which supplier a manual intake came from.
-- Additive only — safe to apply directly to prod. The supplier-intake page
-- (action:'receive' in the stock-update edge function) writes this, and reuses
-- past values as an autocomplete list.
ALTER TABLE inventory_adjustments ADD COLUMN IF NOT EXISTS supplier TEXT;

CREATE INDEX IF NOT EXISTS inventory_adjustments_supplier_idx
  ON inventory_adjustments (supplier);
