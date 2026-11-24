-- SEO audit, Phase 1 fixes (2026-11-24). Additive only: three nullable columns.
--
-- woo_products.catalog_visibility — WooCommerce's "Catalog visibility" per
--   product (visible | catalog | search | hidden), copied by woo-products-enrich.
--   The audit reads it so a hidden (discontinued) product is reported as
--   "still open to Google", not as an orphan to link.
--
-- site_crawl_pages.listing_pages — for a category page: how many further
--   listing pages (?page=N) the crawler reached through real links.
-- site_crawl_pages.listing_issue — for a category page whose listing Google
--   cannot page through: 'no_page_links' (a rel=next but no real page links;
--   paging only by a JavaScript button) or 'next_repeats_first' (the page that
--   rel=next points to shows the same products as page 1).

alter table public.woo_products      add column if not exists catalog_visibility text;
alter table public.site_crawl_pages  add column if not exists listing_pages integer;
alter table public.site_crawl_pages  add column if not exists listing_issue text;

comment on column public.woo_products.catalog_visibility is 'WooCommerce catalog visibility: visible | catalog | search | hidden (null until the next product sync)';
comment on column public.site_crawl_pages.listing_pages  is 'category pages only: further listing pages (?page=N) reached through real links';
comment on column public.site_crawl_pages.listing_issue  is 'category pages only: no_page_links | next_repeats_first (Google cannot page through the listing)';
