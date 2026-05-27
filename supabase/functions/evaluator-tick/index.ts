// Minuto Organic Marketing — daily experiment-evaluator tick.
//
// The orchestrator (Sun + Wed 05:00 UTC) runs evaluateDueExperiments as
// its Step 0b. That leaves 5 days where experiments whose min_lookback_days
// window elapses sit unevaluated until the next strategic cycle. Same
// latency-pattern gap the scout closes for new signals — this one closes
// it for autonomous learning.
//
// Daily 06:30 UTC (right after ga4-sync's 06:00 daily refresh) — fresh
// GA4 + Meta data, evaluator runs, any newly-due experiments get scored
// and (if winner emerges) Claude synthesizes a prescriptive rule into
// seo_learnings. By Sunday/Wednesday's orchestrator tick, the rule is
// already in the STANDING LEARNINGS block.
//
// Reuses the existing seo-agent/experimentEvaluator.ts module verbatim —
// same gates (sample_size + 1.5× win_margin), same HEURISTIC_SYSTEM_PROMPT,
// same write path. This is a thin wrapper.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { evaluateDueExperiments } from '../seo-agent/experimentEvaluator.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
  const startedAt = new Date().toISOString()

  try {
    const summary = await evaluateDueExperiments(supabase)
    console.log(`[evaluator-tick] evaluated:${summary.evaluated} inconclusive:${summary.inconclusive} skipped:${summary.skipped.length}`)
    return jsonResponse({ ok: true, started_at: startedAt, finished_at: new Date().toISOString(), summary })
  } catch (e: any) {
    console.error(`[evaluator-tick] threw: ${e?.message ?? e}`)
    return jsonResponse({ ok: false, error: e?.message ?? String(e) }, 500)
  }
})
