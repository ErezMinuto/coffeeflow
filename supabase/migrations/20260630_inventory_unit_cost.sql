-- Supplier goods-receipt: capture the buying (cost) price per intake line.
-- Additive only — safe to apply directly to prod. The supplier-intake page
-- (action:'receive' in the stock-update edge function) now lets the operator set
-- a per-unit buying price and a sale price alongside the received quantity.
--
-- The live "current" cost shown for the red/green comparison is read from the
-- iCount inventory item (master). These columns are CoffeeFlow's own audit trail
-- of what each receipt's cost was, plus the value it replaced.
ALTER TABLE inventory_adjustments ADD COLUMN IF NOT EXISTS unit_cost        NUMERIC(12,2); -- buying price written this receipt (per unit, ex-VAT)
ALTER TABLE inventory_adjustments ADD COLUMN IF NOT EXISTS unit_cost_before NUMERIC(12,2); -- iCount cost it replaced (null = first cost on record)
ALTER TABLE inventory_adjustments ADD COLUMN IF NOT EXISTS sale_price       NUMERIC(12,2); -- sale price written this receipt (VAT-incl), null = unchanged

CREATE INDEX IF NOT EXISTS inventory_adjustments_unit_cost_idx
  ON inventory_adjustments (sku, created_at DESC)
  WHERE unit_cost IS NOT NULL;
