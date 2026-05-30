// Minuto — woo_products long-description enricher.
//
// The existing product sync writes name / slug / permalink / short_desc /
// price / stock — but NOT the long description (the rich content that has
// origin stories, deep tasting notes, processing detail). The agent needs
// that text to write articles that actually reference Minuto products + to
// SEARCH the catalog by terms that only appear in the long body (e.g.
// "anaerobic", "co-fermentation", "Yirgacheffe washed", farm names).
//
// This function pulls descriptions from the WC REST API and UPDATES the
// woo_products.description column added by the migration. It only touches
// that one column, so the existing sync (whatever writes the rest) is
// undisturbed. Runs daily via cron + on-demand (POST {}).
//
// Strategy:
//   • Page through WC products (per_page=50) until we've covered everyone
//     in stock OR we hit the per-invocation budget (edge wall-clock).
//   • Prioritize: products where description IS NULL come FIRST (backfill).
//     Then refresh the rest in chunks across days.
//   • For each WC product: UPDATE woo_products SET description = ... WHERE
//     woo_id = WC.id. If the row doesn't exist locally, skip (the regular
//     sync will create it; we'll enrich it next run).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WOO_URL       = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WOO_KEY       = Deno.env.get('WOO_KEY')    ?? ''
const WOO_SECRET    = Deno.env.get('WOO_SECRET') ?? ''

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const BUDGET_MS = 120_000     // leave headroom under the gateway
const PAGE_SIZE = 50

// HTML-strip + whitespace-collapse — descriptions in WC are usually rich
// HTML (paragraphs, lists, embedded media); we want clean text for search +
// agent consumption. Cap at 8000 chars to keep payloads sane.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8000)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return j({ error: 'POST only' }, 405)

  if (!WOO_KEY || !WOO_SECRET) return j({ error: 'WOO_KEY / WOO_SECRET not configured' }, 500)

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE)
  const startedAt = Date.now()
  const stats = { pages: 0, scanned: 0, updated: 0, missing_locally: 0, errors: [] as string[], hit_budget: false }

  // Backfill first: enumerate the woo_ids that still need descriptions.
  // If none, refresh the oldest-updated ones in a round-robin so freshness
  // is maintained over time.
  const { data: needBackfill } = await sb
    .from('woo_products')
    .select('woo_id')
    .is('description', null)
    .eq('stock_status', 'instock')
    .order('woo_id', { ascending: true })
    .limit(500)
  const backfillIds = new Set((needBackfill ?? []).map((r: any) => Number(r.woo_id)))
  console.log(`[woo-products-enrich] backfill candidates: ${backfillIds.size}`)

  let page = 1
  // Page WC products until the budget is spent OR we've covered everything.
  // If there are backfill rows, prioritize fetching ANY WC product since we
  // need to map by woo_id (we don't know which page each id is on); we'll
  // upsert on match.
  while (true) {
    if (Date.now() - startedAt > BUDGET_MS) { stats.hit_budget = true; break }

    const url = `${WOO_URL}/wp-json/wc/v3/products` +
                `?per_page=${PAGE_SIZE}&page=${page}&status=publish` +
                `&consumer_key=${encodeURIComponent(WOO_KEY)}` +
                `&consumer_secret=${encodeURIComponent(WOO_SECRET)}`
    let res: Response
    try {
      res = await fetch(url, { method: 'GET', redirect: 'manual' })
    } catch (e: any) {
      stats.errors.push(`page ${page} fetch threw: ${e?.message ?? e}`)
      break
    }
    if (res.status === 401 || res.status === 403) {
      stats.errors.push(`page ${page} auth failed (${res.status}) — check WOO_KEY/SECRET`)
      break
    }
    if (res.status >= 300 && res.status < 400) {
      stats.errors.push(`page ${page} returned redirect ${res.status} — WOO_URL must be canonical`)
      break
    }
    if (!res.ok) {
      stats.errors.push(`page ${page} HTTP ${res.status}`)
      break
    }
    let arr: any[] = []
    try { arr = await res.json() } catch { stats.errors.push(`page ${page} non-JSON`); break }
    if (!Array.isArray(arr) || arr.length === 0) break  // end of pages

    stats.pages++
    stats.scanned += arr.length

    for (const p of arr) {
      const wooId = Number(p.id)
      if (!wooId) continue
      const desc = stripHtml(String(p.description ?? ''))
      if (!desc) continue   // nothing to write
      const { data: updated, error: upErr } = await sb
        .from('woo_products')
        .update({ description: desc, synced_at: new Date().toISOString() })
        .eq('woo_id', wooId)
        .select('id')
      if (upErr) { stats.errors.push(`update ${wooId}: ${upErr.message}`); continue }
      if (!updated || updated.length === 0) { stats.missing_locally++; continue }
      stats.updated++
    }

    // Stop early once we've covered all the backfill candidates AND we're
    // not on a tiny first run.
    if (backfillIds.size > 0) {
      for (const p of arr) backfillIds.delete(Number(p.id))
      if (backfillIds.size === 0 && page >= 1) { /* keep going to refresh */ }
    }

    if (arr.length < PAGE_SIZE) break  // last page
    page++
    if (page > 50) break  // hard safety: 50 pages × 50 = 2500 products
  }

  return j({
    ok: true,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    stats,
  })
})
