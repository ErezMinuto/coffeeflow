// Pure helpers for google-search-sync: turn Search Console API rows into
// google_search_console rows, drop repeated keys, and split into batches.
// Kept apart from index.ts so they can be tested without a server.

export interface GscApiRow {
  keys?: unknown[]
  clicks?: number
  impressions?: number
  ctr?: number
  position?: number
}

export interface GscDbRow {
  date: string
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  synced_at: string
}

// Same columns as before. Keyword rows: keys = [query, date], page = null.
// Page rows: keys = [page, date], stored under keyword '__page__'.
export function toDbRows(keywordRows: GscApiRow[], pageRows: GscApiRow[], syncedAt: string): GscDbRow[] {
  const metrics = (r: GscApiRow) => ({
    clicks:      Math.round(r.clicks ?? 0),
    impressions: Math.round(r.impressions ?? 0),
    ctr:         r.ctr ?? 0,
    position:    r.position ?? 0,
    synced_at:   syncedAt,
  })
  const out: GscDbRow[] = []
  for (const r of keywordRows) {
    const [keyword, date] = (r.keys ?? []) as [string, string]
    out.push({ date, keyword, page: null, ...metrics(r) })
  }
  for (const r of pageRows) {
    const [page, date] = (r.keys ?? []) as [string, string]
    out.push({ date, keyword: '__page__', page, ...metrics(r) })
  }
  return out
}

// The unique key is (date, keyword, page) with NULL pages equal. A single
// upsert that carries the same key twice fails with "ON CONFLICT DO UPDATE
// command cannot affect row a second time", so keep one row per key (the last).
export function dedupeByKey(rows: GscDbRow[]): GscDbRow[] {
  const byKey = new Map<string, GscDbRow>()
  for (const r of rows) byKey.set(`${r.date}\u0000${r.keyword}\u0000${r.page ?? '\u0001'}`, r)
  return [...byKey.values()]
}

export function chunk<T>(rows: T[], size: number): T[][] {
  if (!(size > 0)) throw new Error(`chunk size must be positive, got ${size}`)
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

// deno-lint-ignore no-explicit-any
type Upsert = (batch: GscDbRow[]) => PromiseLike<{ error: any }>

// Upserts every batch in order and throws on the first error, so a failed write
// fails the run instead of being counted as synced. Returns the rows written.
export async function upsertInBatches(rows: GscDbRow[], upsert: Upsert, size = 500): Promise<number> {
  let written = 0
  for (const batch of chunk(dedupeByKey(rows), size)) {
    const { error } = await upsert(batch)
    if (error) throw new Error(`google_search_console upsert failed after ${written} rows: ${error.message ?? String(error)}`)
    written += batch.length
  }
  return written
}

// Search Console returns at most 25,000 rows per searchAnalytics.query call;
// more rows come from repeating the call with startRow. A page shorter than
// rowLimit is the last one. Each page is handed to onPage before the next is
// fetched, so a run never holds more than one page in memory (holding a whole
// 90-day window, ~130k rows, hit the edge worker's resource limit). Throws past
// maxRows rather than stopping silently. Returns the number of rows seen.
export async function forEachGscPage(
  fetchPage: (startRow: number, rowLimit: number) => Promise<GscApiRow[]>,
  onPage: (rows: GscApiRow[]) => Promise<void>,
  rowLimit = 25_000,
  maxRows = 100_000,
): Promise<number> {
  let seen = 0
  for (;;) {
    const page = await fetchPage(seen, rowLimit)
    if (page.length) await onPage(page)
    seen += page.length
    if (page.length < rowLimit) return seen
    if (seen >= maxRows) throw new Error(`Search Console returned more than ${maxRows} rows for one window, use a shorter date range`)
  }
}

export const DEFAULT_WINDOW_DAYS = 5   // Search Console revises roughly the last 3 days
export const MAX_WINDOW_DAYS = 14      // ~20k rows: well inside one worker's budget

const DAY = 86_400_000
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

// The date window for one run. No body: the last DEFAULT_WINDOW_DAYS days
// ending yesterday. A backfill passes { start_date, end_date } (YYYY-MM-DD,
// at most MAX_WINDOW_DAYS long, inside Search Console's 16 months, not after
// yesterday). Returns an error string instead of throwing so the caller can
// answer 400.
export function syncWindow(body: unknown, now = Date.now()): { startDate: string; endDate: string } | { error: string } {
  const yesterday = iso(now - DAY)
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (b.start_date == null && b.end_date == null) {
    return { startDate: iso(now - DEFAULT_WINDOW_DAYS * DAY), endDate: yesterday }
  }
  const re = /^\d{4}-\d{2}-\d{2}$/
  const s = String(b.start_date ?? ''), e = String(b.end_date ?? '')
  if (!re.test(s) || !re.test(e) || iso(Date.parse(s)) !== s || iso(Date.parse(e)) !== e) {
    return { error: 'start_date and end_date must both be valid YYYY-MM-DD dates' }
  }
  if (s > e) return { error: 'start_date is after end_date' }
  if (e > yesterday) return { error: `end_date must be ${yesterday} or earlier` }
  if (s < iso(now - 485 * DAY)) return { error: 'start_date is older than Search Console keeps (16 months)' }
  const span = (Date.parse(e) - Date.parse(s)) / DAY + 1
  if (span > MAX_WINDOW_DAYS) return { error: `window is ${span} days, at most ${MAX_WINDOW_DAYS} per run` }
  return { startDate: s, endDate: e }
}

// ── Search + page (SEO agent Phase 1) ───────────────────────────────────────
// One call per window: dimensions [query, page], summed over QUERY_PAGE_DAYS,
// so every search is tied to the page that ranks for it. 'current' ends
// yesterday; 'previous' is the window before it, for week-on-week losses.

export const QUERY_PAGE_DAYS = 28

export interface QueryPageRow {
  period_end:  string
  period_days: number
  query:       string
  page:        string
  clicks:      number
  impressions: number
  ctr:         number
  position:    number
  synced_at:   string
}

export function queryPageWindow(which: unknown, now = Date.now()): { startDate: string; endDate: string } | { error: string } {
  const back = which === 'previous' ? QUERY_PAGE_DAYS : which === 'current' || which == null ? 0 : -1
  if (back < 0) return { error: "window must be 'current' or 'previous'" }
  const end = now - DAY - back * DAY
  return { startDate: iso(end - (QUERY_PAGE_DAYS - 1) * DAY), endDate: iso(end) }
}

export function toQueryPageRows(rows: GscApiRow[], periodEnd: string, syncedAt: string): QueryPageRow[] {
  const byKey = new Map<string, QueryPageRow>()
  for (const r of rows) {
    const [query, page] = (r.keys ?? []) as [string, string]
    if (typeof query !== 'string' || typeof page !== 'string' || !query || !page) continue
    byKey.set(`${query}\u0000${page}`, {
      period_end: periodEnd, period_days: QUERY_PAGE_DAYS, query, page,
      clicks: Math.round(r.clicks ?? 0), impressions: Math.round(r.impressions ?? 0),
      ctr: r.ctr ?? 0, position: r.position ?? 0, synced_at: syncedAt,
    })
  }
  return [...byKey.values()]
}

// ── URL Inspection (SEO agent Phase 1) ──────────────────────────────────────
// Google's own view of a page: indexed or not, why, and which canonical it
// chose. Quota is 2,000 inspections a day per site; the weekly job inspects
// only the pages that earn money.

export const INSPECT_MAX_URLS = 60

export interface InspectionRow {
  url:              string
  verdict:          string | null
  coverage_state:   string | null
  indexing_state:   string | null
  robots_txt_state: string | null
  page_fetch_state: string | null
  google_canonical: string | null
  user_canonical:   string | null
  last_crawl_time:  string | null
  rich_results:     unknown
  error:            string | null
}

// deno-lint-ignore no-explicit-any
export function toInspectionRow(url: string, body: any): InspectionRow {
  const r = body?.inspectionResult?.indexStatusResult ?? {}
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    url,
    verdict:          s(r.verdict),
    coverage_state:   s(r.coverageState),
    indexing_state:   s(r.indexingState),
    robots_txt_state: s(r.robotsTxtState),
    page_fetch_state: s(r.pageFetchState),
    google_canonical: s(r.googleCanonical),
    user_canonical:   s(r.userCanonical),
    last_crawl_time:  s(r.lastCrawlTime),
    rich_results:     body?.inspectionResult?.richResultsResult ?? null,
    error:            null,
  }
}

/** Only absolute https URLs on the site itself, deduped, capped. */
export function cleanInspectUrls(input: unknown, siteUrl: string, max = INSPECT_MAX_URLS): string[] {
  if (!Array.isArray(input)) return []
  let host = ''
  try { host = new URL(siteUrl).host } catch { return [] }
  const out = new Set<string>()
  for (const u of input) {
    if (typeof u !== 'string') continue
    try {
      const x = new URL(u)
      if (x.protocol === 'https:' && x.host === host) out.add(x.href)
    } catch { /* skip */ }
    if (out.size >= max) break
  }
  return [...out]
}
