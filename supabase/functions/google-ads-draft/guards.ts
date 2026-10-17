// The checks that stand between a request and the Google Ads account: who may
// call, which actions exist, and the google_ad_drafts bookkeeping that keeps
// create idempotent and the monthly cap honest. Kept out of index.ts so they
// can be tested without Google (guards_test.ts).

// ── Actions ──────────────────────────────────────────────────────────────────

export const ACTIONS = [
  'dry_run', 'accounts', 'create', 'insights', 'search_terms',
  'update_campaign', 'update_targeting', 'list', 'delete', 'spend',
] as const
export type Action = typeof ACTIONS[number]

// The handler's branches end in a fall-through to create, so an unrecognised
// action has to be refused here — a typo would otherwise build a campaign.
export function parseAction(v: unknown): Action {
  const action = String(v ?? '').trim()
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`'action' must be one of ${ACTIONS.join('|')}${action ? ` — got '${action}'` : ''}`)
  }
  return action as Action
}

// ── Caller ───────────────────────────────────────────────────────────────────

// The function runs with verify_jwt off and acts with the service role, so it
// must check the caller itself. Its only caller is marketing-advisor, which
// sends the service-role key. The public anon key is NOT enough: it ships in
// the frontend bundle.
//
// A plain comparison covers marketing-advisor (both functions read the same
// injected env var). The same project's service role can also arrive in the
// other format — legacy eyJ JWT vs sb_secret_ — and the two never compare
// equal, so a key that doesn't match is asked about instead: only a
// service-role key may list Auth users.
export async function isServiceCaller(
  req: Request,
  opts: { supabaseUrl: string; serviceKey: string; fetchFn?: typeof fetch },
): Promise<boolean> {
  const token = bearer(req) ?? req.headers.get('apikey')?.trim() ?? ''
  if (!token) return false
  if (opts.serviceKey && constantTimeEqual(token, opts.serviceKey)) return true
  try {
    const res = await (opts.fetchFn ?? fetch)(`${opts.supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    })
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}

function bearer(req: Request): string | null {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

// ── Draft claims ─────────────────────────────────────────────────────────────
//
// A create reserves its idea_id BEFORE the Google mutate, by inserting a
// placeholder row that unique(idea_id) lets only one request win. The loser
// learns another create is under way instead of building a twin campaign.
// The winner fills the row in after the mutate, or deletes it if the mutate
// failed.

type SupabaseLike = { from: (table: string) => any }

export const CLAIM_STATUS = 'CREATING'
export const CLAIM_CAMPAIGN_ID = 'pending'   // campaign_id is NOT NULL
// A claim this old outlived any real create (Google mutate + images). The
// worker was killed between mutate and record, so a campaign may exist in
// Google that the table does not know about.
export const CLAIM_STALE_MS = 15 * 60 * 1000

export type ClaimResult =
  | { kind: 'claimed'; id: number }
  | { kind: 'taken'; row: Record<string, any> }

export async function claimIdea(
  supabase: SupabaseLike,
  row: { idea_id: string; customer_id: string; campaign_name?: string; daily_budget_ils: number; spec: unknown },
): Promise<ClaimResult> {
  const { data, error } = await supabase
    .from('google_ad_drafts')
    .insert({ ...row, campaign_id: CLAIM_CAMPAIGN_ID, status: CLAIM_STATUS })
    .select('id')
    .single()
  if (!error) return { kind: 'claimed', id: Number(data.id) }

  if (error.code === '23505') {
    const { data: taken, error: readErr } = await supabase
      .from('google_ad_drafts')
      .select('*')
      .eq('idea_id', row.idea_id)
      .maybeSingle()
    if (readErr) throw new Error(`cannot read google_ad_drafts (${readErr.message})`)
    if (!taken) throw new Error(`idea ${row.idea_id} was claimed and released while this request ran — retry`)
    return { kind: 'taken', row: taken }
  }
  throw new Error(`cannot record the draft in google_ad_drafts (${error.message}) — refusing to create a campaign we could not track`)
}

export function isClaim(row: Record<string, any>): boolean {
  return row.status === CLAIM_STATUS
}

export function isStaleClaim(row: Record<string, any>, now = Date.now()): boolean {
  return isClaim(row) && now - Date.parse(String(row.created_at)) > CLAIM_STALE_MS
}

// What to tell a caller whose idea_id is held by a claim.
export function claimConflict(row: Record<string, any>, now = Date.now()): { status: number; body: Record<string, unknown> } {
  if (isStaleClaim(row, now)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `a create for idea ${row.idea_id} started at ${row.created_at} and never finished. ` +
          `A campaign named "${row.campaign_name ?? '?'}" may exist in Google Ads without being recorded. ` +
          `Check Google Ads first; then delete google_ad_drafts row ${row.id} to allow a retry.`,
        stale_claim_id: row.id,
      },
    }
  }
  return {
    status: 409,
    body: { ok: false, in_progress: true, error: `a create for idea ${row.idea_id} is already in progress — not starting a second one` },
  }
}

// Deleting is filtered on the claim status so a row that has already been
// filled in is never removed by a late failure path.
export async function releaseClaim(supabase: SupabaseLike, id: number): Promise<void> {
  await supabase.from('google_ad_drafts').delete().eq('id', id).eq('status', CLAIM_STATUS)
}

export async function finalizeClaim(supabase: SupabaseLike, id: number, fields: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase
    .from('google_ad_drafts')
    .update({ ...fields, status: 'PAUSED' })
    .eq('id', id)
    .select('id')
  if (error) return error.message
  if (!data?.length) return `draft row ${id} no longer exists`
  return null
}

// ── Budget bookkeeping ───────────────────────────────────────────────────────

// Planned spend already committed by drafts created this calendar month —
// daily_budget_ils × duration_days across google_ad_drafts. Deleted drafts are
// gone from the table, so they drop out on their own. In-flight claims count
// too: their campaign is about to exist.
export async function committedThisMonth(supabase: SupabaseLike): Promise<number> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const { data } = await supabase
    .from('google_ad_drafts')
    .select('daily_budget_ils, spec, created_at')
    .gte('created_at', monthStart)
  let sum = 0
  for (const row of (data ?? []) as any[]) {
    const daily = Number(row.daily_budget_ils ?? 0)
    const duration = Math.max(1, Number(row?.spec?.duration_days ?? 14))
    sum += daily * duration
  }
  return sum
}

// committedThisMonth() reads daily_budget_ils from the drafts table, so a
// budget edited in Google has to be written back or the monthly cap keeps
// counting the old figure. Campaigns this function never created have no row;
// that is a no-op, not an error. Returns a warning, or null when in sync.
export async function syncDraftBudget(supabase: SupabaseLike, campaignId: string, dailyIls: number): Promise<string | null> {
  const { error } = await supabase
    .from('google_ad_drafts')
    .update({ daily_budget_ils: dailyIls })
    .eq('campaign_id', campaignId)
  return error
    ? `Google budget updated, but google_ad_drafts was not (${error.message}) — the monthly cap still counts the old budget for campaign ${campaignId}`
    : null
}
