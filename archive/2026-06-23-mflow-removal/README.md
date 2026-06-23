# MFlow scraper / sync removal — 2026-06-23

MFlow (the old POS) was replaced by **iCount** as the point-of-sale and stock
source. The MFlow integration is decommissioned. Coffee `packed_stock` is now
decremented by the iCount sales sync (`icount-webhook`) instead of the nightly
MFlow scraper.

## Removed
- `workers/mflow-scraper/` — Railway-hosted Node/Puppeteer worker. Logged into
  MFlow nightly (own `node-cron`, 05:00 Asia/Jerusalem), deducted sold qty from
  `products.packed_stock`, and sent low-stock Telegram alerts. **The Railway
  service itself is paused/deleted separately in the Railway dashboard.**
- `src/MFlowSync.jsx` — manual MFlow sales-entry / sync UI (wrote stock to Supabase).
- `src/components/purchases/Purchases.jsx` + the `/purchases` route and nav item —
  the Purchases page rendered nothing but `<MFlowSync>`, so it was retired too.
- `api/mflow-import-products.js`, `api/mflow-sync-sales.js` — legacy dormant
  Vercel-function scrapers (superseded long ago by the Railway worker).

## Intentionally KEPT (not the scraper — different meaning of "mflow")
- `supabase/functions/woo-orders-sync/index.ts` and `marketing-advisor/index.ts`
  filter out **B2B orders** tagged "Advanced Purchase Tracking (APT)" (referred to
  as "mflow" B2B) so they don't pollute B2C analytics. That order-source filtering
  is unrelated to the scraper and stays.

Full source of the removed code is in git history prior to this commit
(branch `chore/remove-mflow`).
