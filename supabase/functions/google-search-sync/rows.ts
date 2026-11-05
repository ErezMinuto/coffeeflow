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
  for (const r of rows) byKey.set(JSON.stringify([r.date, r.keyword, r.page]), r)
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
