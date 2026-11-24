-- Google Merchant Center (Google Shopping) product status, for the SEO audit's
-- "shopping" area, which was blind (strategist capability request
-- seo_audit_merchant_center_access, 2026-11-23).
--
--   merchant_product_status   one row per product in Merchant Center: whether
--                             Google approved, disapproved or demoted it per
--                             destination, and the item-level issues it lists.
--
-- Written by google-sync's merchant block (service role) from the Merchant API
-- (products v1). Admins read it in the dashboard. Describes public product
-- listings; no customer data. Additive only.

CREATE TABLE IF NOT EXISTS public.merchant_product_status (
  product_name          text PRIMARY KEY,             -- accounts/{a}/products/{lang~label~offerId}
  account_id            text NOT NULL,
  offer_id              text NOT NULL,
  content_language      text,
  feed_label            text,
  title                 text,
  link                  text,
  availability          text,
  destination_statuses  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{reportingContext, approvedCountries, pendingCountries, disapprovedCountries}]
  item_issues           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{code, severity, attribute, reportingContext, description, detail, documentation, applicableCountries}]
  worst_severity        text NOT NULL DEFAULT 'NONE'
                        CHECK (worst_severity IN ('NONE', 'NOT_IMPACTED', 'DEMOTED', 'DISAPPROVED')),
  approved_anywhere     boolean NOT NULL DEFAULT false,
  disapproved_anywhere  boolean NOT NULL DEFAULT false,
  google_expires_at     timestamptz,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_product_status_synced_idx ON public.merchant_product_status (synced_at DESC);
CREATE INDEX IF NOT EXISTS merchant_product_status_severity_idx ON public.merchant_product_status (worst_severity);

ALTER TABLE public.merchant_product_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS merchant_product_status_admin_read ON public.merchant_product_status;
CREATE POLICY merchant_product_status_admin_read ON public.merchant_product_status
  FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON TABLE public.merchant_product_status TO authenticated;
GRANT ALL ON TABLE public.merchant_product_status TO service_role;
