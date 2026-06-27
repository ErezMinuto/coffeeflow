// Minuto Strategist Brain — Phase 2a executor (hands, draft-only).
//
// Claims APPROVED strategic_recommendations and turns them into DRAFTED work in
// the EXISTING content pipeline — it never sends or publishes. Phase 2a handles
// `content_blog` (→ a text_generation seo_task the Writer Worker drafts as a WP
// draft for review). `content_ig` and `email_campaign` are recognized but
// deferred to Phase 2b (they need caption+visual pairing / email HTML); those
// rows stay 'approved' until that lands.
//
// Reuses the seo_tasks queue + Writer Worker wholesale — this is lean glue, not
// a second orchestrator. Cron-polled; cheap and idle when nothing is approved.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabase, insertTasks } from '../seo-agent/db.ts'
import type { NewSeoTask, RecommendationRow, TextGenerationBrief } from '../seo-agent/types.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const LOCK_MINUTES = 5
const BATCH = 5  // recs per invocation — cheap DB inserts, no model calls

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Phase 2a executes these action types; others wait for 2b.
const SUPPORTED: RecommendationRow['action_type'][] = ['content_blog']

async function claimRecs(supabase: SupabaseClient, workerId: string): Promise<RecommendationRow[]> {
  const nowMs = Date.now()
  const { data, error } = await supabase
    .from('strategic_recommendations')
    .select('*')
    .eq('status', 'approved')
    .in('action_type', SUPPORTED)
    .order('created_at', { ascending: true })
    .limit(BATCH * 2)
  if (error) throw new Error(`claimRecs select failed: ${error.message}`)
  const claimed: RecommendationRow[] = []
  for (const r of (data ?? []) as RecommendationRow[]) {
    if (r.locked_until && new Date(r.locked_until).getTime() > nowMs) continue
    const lockedUntil = new Date(nowMs + LOCK_MINUTES * 60_000).toISOString()
    let q = supabase
      .from('strategic_recommendations')
      .update({ locked_until: lockedUntil, worker_id: workerId, updated_at: new Date().toISOString() })
      .eq('id', r.id)
      .eq('status', 'approved')
    q = r.locked_until === null ? q.is('locked_until', null) : q.eq('locked_until', r.locked_until)
    const { data: got } = await q.select('*').maybeSingle()
    if (got) claimed.push(got as RecommendationRow)
    if (claimed.length >= BATCH) break
  }
  return claimed
}

// Map a content_blog recommendation into a valid TextGenerationBrief. The brain
// supplies the strategic inputs (keyword/topic, key_points, why_now); we fill the
// brief shape with safe fallbacks so the Writer Worker always gets a valid brief.
function blogBrief(rec: RecommendationRow): TextGenerationBrief {
  const p = rec.action_params ?? {}
  const keyword = (p.keyword as string) || (p.topic as string) || rec.title
  return {
    keyword,
    title:               (p.topic as string) || (p.keyword as string) || rec.title,
    key_points:          Array.isArray(p.key_points) ? (p.key_points as string[]) : [],
    products_to_mention: Array.isArray(p.products) ? (p.products as string[]) : [],
    why_now:             (p.why_now as string) || rec.rationale || undefined,
  }
}

async function draftRec(supabase: SupabaseClient, rec: RecommendationRow): Promise<{ id: string; status: string; draft_ref?: string; error?: string }> {
  try {
    let task: NewSeoTask
    if (rec.action_type === 'content_blog') {
      task = {
        task_type:           'text_generation',
        brief_data:          blogBrief(rec),
        rationale:           `[strategist] ${rec.title}`,
        orchestrator_run_id: rec.run_id ?? rec.id,
      }
    } else {
      // Shouldn't happen (claim filters to SUPPORTED), but fail safe.
      throw new Error(`action_type ${rec.action_type} not executable in Phase 2a`)
    }
    const [inserted] = await insertTasks(supabase, [task])
    if (!inserted) throw new Error('insertTasks returned no row')
    await supabase
      .from('strategic_recommendations')
      .update({ status: 'drafted', draft_ref: inserted.id, draft_error: null, locked_until: null, updated_at: new Date().toISOString() })
      .eq('id', rec.id)
    return { id: rec.id, status: 'drafted', draft_ref: inserted.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await supabase
      .from('strategic_recommendations')
      .update({ status: 'failed', draft_error: msg.slice(0, 1000), locked_until: null, updated_at: new Date().toISOString() })
      .eq('id', rec.id)
    return { id: rec.id, status: 'failed', error: msg }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const supabase = createSupabase()
  const workerId = `exec-${crypto.randomUUID().slice(0, 8)}`
  try {
    const recs = await claimRecs(supabase, workerId)
    if (recs.length === 0) return json({ ok: true, idle: 'no approved recommendations to draft' })
    const results = []
    for (const rec of recs) results.push(await draftRec(supabase, rec))
    return json({ ok: true, drafted: results.filter(r => r.status === 'drafted').length, failed: results.filter(r => r.status === 'failed').length, results })
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
