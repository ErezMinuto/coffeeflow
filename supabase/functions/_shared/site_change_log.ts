// Site change log — every write to the live site keeps the value it replaced.
// SEO agent build plan, Phase 0. Table: public.site_change_log
// (migration 20261123120000_site_change_log.sql).
//
// A function that writes to minuto.co.il follows one order, so a write can
// never happen without its backup on record:
//
//   1. read the current value from the site            (the caller)
//   2. beginChange()  → row is 'applying', `before` saved (refuse the write if this fails)
//   3. write to the site                               (the caller)
//   4. finishChange() → 'applied', or 'failed' with the error
//
// A row filed earlier as a proposal (status 'proposed', created by the admin
// chat) is passed in as change_id and moves through the same steps. An undo is
// a new row with undo_of set; when it applies, the original becomes 'undone'.
//
// Talks to PostgREST with the service role, so any edge function can use it
// regardless of which Supabase client it holds.

export type ChangeTargetType =
  | 'post_faq'
  | 'product_faq'
  | 'product_description'
  | 'post_content'
  | 'post_featured_image'
  | 'seo_meta'          // Rank Math title/description/focus keyword on a post, page or product (Phase 2)
  | 'term_seo_meta'     // the same on a product category
  | 'term_description'  // product category text
  | 'product_status'    // WooCommerce product status (publish / draft / …)
  | 'product_short_description' // WooCommerce product short description (next to the price)

export type ChangeStatus = 'proposed' | 'queued' | 'applying' | 'applied' | 'rejected' | 'failed' | 'undone'

export interface ChangeRow {
  id:            string
  created_at:    string
  target_type:   ChangeTargetType
  target_id:     number
  target_url:    string | null
  target_title:  string | null
  before:        unknown
  after:         unknown
  before_source: string | null
  source_fn:     string
  requested_by:  string | null
  reason:        string | null
  approved_by:   string | null
  approved_at:   string | null
  status:        ChangeStatus
  applied_at:    string | null
  error:         string | null
  reject_reason: string | null
  undo_of:       string | null
  undone_at:     string | null
  undone_by:     string | null
}

/** What a writer function accepts in its request body under `change`. */
export interface ChangeContext {
  change_id?:    string   // an approved proposal to apply
  requested_by?: string
  reason?:       string
  approved_by?:  string   // Clerk user id, or 'service'
  undo_of?:      string   // the applied change this write reverses
}

const TARGET_TYPES: ReadonlySet<string> = new Set(['post_faq', 'product_faq', 'product_description', 'post_content', 'post_featured_image', 'seo_meta', 'term_seo_meta', 'term_description', 'product_status', 'product_short_description'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTargetType(v: unknown): v is ChangeTargetType {
  return typeof v === 'string' && TARGET_TYPES.has(v)
}

/** Reads `change` from a request body. Anything malformed is dropped, never trusted. */
export function parseChangeContext(raw: unknown): ChangeContext {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  const uuid = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : undefined)
  return {
    change_id:    uuid(r.change_id),
    requested_by: str(r.requested_by, 100),
    reason:       str(r.reason, 2000),
    approved_by:  str(r.approved_by, 200),
    undo_of:      uuid(r.undo_of),
  }
}

/** Stable comparison of two stored values (key order and whitespace ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function canonical(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

// ── PostgREST access ────────────────────────────────────────────────────────

interface Db { url: string; key: string; fetchFn: typeof fetch }

function db(opts: { supabaseUrl?: string; serviceKey?: string; fetchFn?: typeof fetch } = {}): Db {
  return {
    url:     (opts.supabaseUrl ?? Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
    key:     opts.serviceKey ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    fetchFn: opts.fetchFn ?? fetch,
  }
}

async function rest(d: Db, path: string, init: RequestInit & { prefer?: string } = {}): Promise<unknown> {
  if (!d.url || !d.key) throw new Error('site_change_log: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  const headers: Record<string, string> = {
    apikey: d.key,
    Authorization: `Bearer ${d.key}`,
    'Content-Type': 'application/json',
  }
  if (init.prefer) headers.Prefer = init.prefer
  const res = await d.fetchFn(`${d.url}/rest/v1/${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`site_change_log ${init.method ?? 'GET'} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

export type DbOpts = Parameters<typeof db>[0]

export async function getChange(id: string, opts: DbOpts = {}): Promise<ChangeRow | null> {
  if (!UUID_RE.test(id)) return null
  const rows = await rest(db(opts), `site_change_log?id=eq.${id}&select=*`) as ChangeRow[]
  return rows[0] ?? null
}

/** Files a proposal (status 'proposed'). Nothing is written to the site. */
export async function proposeChange(p: {
  target_type:   ChangeTargetType
  target_id:     number
  target_url?:   string | null
  target_title?: string | null
  after:         unknown
  source_fn:     string
  requested_by?: string
  reason?:       string
}, opts: DbOpts = {}): Promise<ChangeRow> {
  const rows = await rest(db(opts), 'site_change_log?select=*', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify({ ...p, status: 'proposed' }),
  }) as ChangeRow[]
  return rows[0]
}

/**
 * Step 2: records the backup before the site is touched. Returns the row id.
 * Throws when the row can't be written — the caller must then NOT write.
 *
 * With ctx.change_id the proposal row is moved to 'applying' — only from
 * 'proposed', so a proposal can't be applied twice or after a rejection.
 */
export async function beginChange(p: {
  target_type:   ChangeTargetType
  target_id:     number
  target_url?:   string | null
  target_title?: string | null
  before:        unknown
  before_source: string
  after:         unknown
  source_fn:     string
  ctx:           ChangeContext
}, opts: DbOpts = {}): Promise<string> {
  const d = db(opts)
  const now = new Date().toISOString()
  const common = {
    before:        p.before ?? null,
    before_source: p.before_source,
    after:         p.after,
    status:        'applying',
    approved_by:   p.ctx.approved_by ?? 'service',
    approved_at:   now,
    updated_at:    now,
    ...(p.target_url != null ? { target_url: p.target_url } : {}),
    ...(p.target_title != null ? { target_title: p.target_title } : {}),
  }
  if (p.ctx.change_id) {
    // Conditional update: only a still-pending row for the same target: proposed,
    // or approved and queued for the weekly release.
    const rows = await rest(d,
      `site_change_log?id=eq.${p.ctx.change_id}&status=in.(proposed,queued)&target_type=eq.${p.target_type}&target_id=eq.${p.target_id}&select=id`,
      { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(common) },
    ) as Array<{ id: string }>
    if (!rows[0]) throw new Error(`change ${p.ctx.change_id} is not a pending (proposed or queued) change for this ${p.target_type} ${p.target_id}`)
    return rows[0].id
  }
  const rows = await rest(d, 'site_change_log?select=id', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify({
      target_type:  p.target_type,
      target_id:    p.target_id,
      source_fn:    p.source_fn,
      requested_by: p.ctx.requested_by ?? null,
      reason:       p.ctx.reason ?? null,
      undo_of:      p.ctx.undo_of ?? null,
      ...common,
    }),
  }) as Array<{ id: string }>
  return rows[0].id
}

/**
 * Step 4. Best effort: the site write already happened, so a logging error is
 * reported back (`logged: false`) instead of thrown. The backup is safe either
 * way — it was saved in step 2.
 */
export async function finishChange(
  id: string,
  // `after`: the value as the site actually stored it, when it differs from
  // what was sent (WordPress sanitizes text). Undo compares against it.
  outcome: { ok: true; after?: unknown } | { ok: false; error: string },
  opts: DbOpts = {},
): Promise<{ logged: boolean; error?: string }> {
  const d = db(opts)
  const now = new Date().toISOString()
  try {
    const patch = outcome.ok
      ? { status: 'applied', applied_at: now, updated_at: now, ...(outcome.after !== undefined ? { after: outcome.after } : {}) }
      : { status: 'failed', error: outcome.error.slice(0, 2000), updated_at: now }
    const rows = await rest(d, `site_change_log?id=eq.${id}&select=undo_of`, {
      method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch),
    }) as Array<{ undo_of: string | null }>
    const undoOf = rows[0]?.undo_of
    if (outcome.ok && undoOf) {
      const by = (await rest(d, `site_change_log?id=eq.${id}&select=approved_by`) as Array<{ approved_by: string | null }>)[0]?.approved_by ?? null
      await rest(d, `site_change_log?id=eq.${undoOf}&status=eq.applied`, {
        method: 'PATCH', body: JSON.stringify({ status: 'undone', undone_at: now, undone_by: by, updated_at: now }),
      })
    }
    return { logged: true }
  } catch (e) {
    return { logged: false, error: (e as Error).message }
  }
}

/** Owner rejected a proposal. Only a still-'proposed' row changes. */
export async function rejectChange(id: string, by: string, reason: string, opts: DbOpts = {}): Promise<boolean> {
  const now = new Date().toISOString()
  const rows = await rest(db(opts), `site_change_log?id=eq.${id}&status=in.(proposed,queued)&select=id`, {
    method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ status: 'rejected', reject_reason: reason.slice(0, 2000), approved_by: by, approved_at: now, updated_at: now }),
  }) as Array<{ id: string }>
  return rows.length > 0
}

/**
 * The owner approved a proposal for the weekly release: it waits as 'queued'
 * (approved_by / approved_at recorded) until the release publishes it. Only a
 * still-proposed row moves; returns false otherwise.
 */
export async function queueChange(id: string, by: string, opts: DbOpts = {}): Promise<boolean> {
  const now = new Date().toISOString()
  const rows = await rest(db(opts), `site_change_log?id=eq.${id}&status=eq.proposed&select=id`, {
    method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ status: 'queued', approved_by: by, approved_at: now, updated_at: now }),
  }) as Array<{ id: string }>
  return rows.length > 0
}

/**
 * Can this applied change be undone right now? It can when nothing else has
 * changed that field since: the site's current value must still equal what
 * this change wrote. Otherwise an undo would silently discard a later edit.
 */
export function undoBlocker(row: ChangeRow, current: unknown): string | null {
  if (row.status !== 'applied') return `only an applied change can be undone (this one is ${row.status})`
  if (row.before_source === 'none') return 'the old value was not recorded for this change, so it cannot be restored'
  if (!sameValue(current, row.after)) return 'the page has changed since this change was made, so undoing it would overwrite a later edit'
  return null
}
