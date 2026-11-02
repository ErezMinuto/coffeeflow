// Tests for the strategist closed loop's rules and claims.
//
//   deno run --allow-read --allow-env supabase/functions/_shared/strategist_loop_test.ts
//
// Same style as strategist-executor/ledger_test.ts: a fake table that applies
// each UPDATE as one compare-and-set, so overlapping workers race as in prod.

import {
  autoApproveOn, critiqueOn, deterministicIssues, feedbackForDrafter, LOOP_OFF,
  nextStateAfterCritique, normaliseVerdict, passes, readLoopConfig, handBackForCritique,
} from './strategist_loop.ts'
import { claimLoopRows, finishLoopRow, sweepStaleLoop, MAX_CRITIQUE_ATTEMPTS } from './strategist_loop_ledger.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const jitter = () => new Promise(r => setTimeout(r, Math.random() * 10))

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>
function fakeTable(tables: Record<string, Row[]>) {
  const from = (t: string) => {
    const rows = tables[t] ?? (tables[t] = [])
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null
    let limit = Infinity
    // deno-lint-ignore no-explicit-any
    const q: any = {
      select() { return q },
      update(p: Row) { patch = p; return q },
      eq(c: string, v: unknown) { filters.push(r => r[c] === v); return q },
      is(c: string, v: unknown) { filters.push(r => (r[c] ?? null) === v); return q },
      in(c: string, vs: unknown[]) { filters.push(r => vs.includes(r[c])); return q },
      lt(c: string, v: string) { filters.push(r => r[c] != null && r[c] < v); return q },
      order() { return q },
      limit(n: number) { limit = n; return q },
      async run() {
        await jitter()
        const hit = rows.filter(r => filters.every(f => f(r))).slice(0, limit)
        if (patch) for (const r of hit) Object.assign(r, patch)
        return { data: hit.map(r => ({ ...r })), error: null }
      },
      async maybeSingle() { const { data, error } = await q.run(); return { data: data?.[0] ?? null, error } },
      // deno-lint-ignore no-explicit-any
      then(res: any, rej: any) { return q.run().then(res, rej) },
    }
    return q
  }
  return { from }
}
const rec = (id: string, extra: Row = {}): Row => ({
  id, status: 'awaiting_critique', action_type: 'email_campaign', created_at: id,
  locked_until: null, worker_id: null, critique_attempts: 0, revision_count: 0, ...extra,
})

// ── Verdict rules ────────────────────────────────────────────────────────────
{
  const v = normaliseVerdict({ pass: true, issues: [{ severity: 'critical', rule: 'x', detail: 'y' }], feedback: '' })
  check('pass:true with a critical issue is a reject', !passes(v))
  check('contradictory verdict with revisions left → revising', nextStateAfterCritique(v, 0, 2) === 'revising')
  check('contradictory verdict at the cap → needs_human', nextStateAfterCritique(v, 2, 2) === 'needs_human')
}
{
  const v = normaliseVerdict({ pass: true, issues: [{ severity: 'low', rule: 'tone', detail: 'could be warmer' }], feedback: '' })
  check('pass with only low issues → exporting', nextStateAfterCritique(v, 0, 2) === 'exporting')
}
check('unreadable critic output is a reject', !passes(normaliseVerdict(null)))
check('pass:"true" (string) is not a pass', !passes(normaliseVerdict({ pass: 'true', issues: [] })))
check('unknown severity counts as high', normaliseVerdict({ pass: true, issues: [{ severity: 'meh', rule: 'r', detail: 'd' }] }).issues[0].severity === 'high')
{
  const fb = feedbackForDrafter({ pass: false, issues: [{ severity: 'high', rule: 'weekly_roasting', detail: 'says daily' }, { severity: 'low', rule: 'tone', detail: 'x' }], feedback: 'Fix the claim.' })
  check('feedback carries blocking issues only', fb.includes('weekly_roasting') && !fb.includes('[tone]') && fb.startsWith('Fix the claim.'))
}

// ── Deterministic brand checks ───────────────────────────────────────────────
const rules = (t: string, s: unknown) => deterministicIssues(t, s).map(i => i.rule)
check('em dash caught', rules('email_campaign', { body: 'קפה טרי — ישר אליכם' }).includes('no_em_dash'))
check('daily roasting caught', rules('email_campaign', { body: 'אנחנו קולים כל בוקר את הפולים' }).includes('weekly_roasting'))
check('weekly roasting allowed', !rules('email_campaign', { body: 'קולים פולים טריים בכל שבוע' }).includes('weekly_roasting'))
check('"מקלה" caught', rules('email_campaign', { subject: 'המקלה שלנו' }).includes('brand_naming'))
check('"בית קלייה" allowed', !rules('email_campaign', { subject: 'בית קלייה ספיישלטי' }).includes('brand_naming'))
check('250g bag caught', rules('email_campaign', { body: 'שקית 250 גרם' }).includes('bag_size_330g'))
check('Veneto in an email caught', rules('email_campaign', { products: [{ name: 'Veneto Delux 1kg' }] }).includes('brand_guard'))
check('Veneto in a blog caught', rules('content_blog', { body: 'השוואה ל-Veneto' }).includes('reseller_brand'))
check('URLs and HTML are not copy', rules('email_campaign', { htmlContent: '<p>—</p>', ctaUrl: 'https://x/—', image_url: 'https://y/—' }).length === 0)
check('a key merely containing "url" text is still copy', rules('email_campaign', { curly: 'קפה — טרי' }).includes('no_em_dash'))
check('clean Hebrew passes', rules('email_campaign', { subject: 'פולים טריים מהקלייה השבועית', body: 'קפה ספיישלטי, קלוי בכל שבוע, ישר אליכם.' }).length === 0)

// ── Config ───────────────────────────────────────────────────────────────────
{
  const db = fakeTable({ ops_profile: [] })
  const cfg = await readLoopConfig(db)
  check('missing config = loop off', JSON.stringify(cfg) === JSON.stringify(LOOP_OFF) && !critiqueOn(cfg, 'email_campaign'))
}
{
  const db = fakeTable({ ops_profile: [{ key: 'strategist_loop', value: { critique: { email_campaign: true, ad_meta: true, ad_google: true }, auto_approve: { email_campaign: true, content_blog: true }, max_revisions: 99, max_auto_approve_per_run: 3 } }] })
  const cfg = await readLoopConfig(db)
  check('max_revisions clamped to 2', cfg.max_revisions === 2)
  check('critique on for an implemented type', critiqueOn(cfg, 'email_campaign'))
  check('critique stays off for a type with no loop code yet', !critiqueOn(cfg, 'ad_google'))
  check('ad_meta loop on when switched on', critiqueOn(cfg, 'ad_meta'))
  check('auto-approve needs the critic on', autoApproveOn(cfg, 'email_campaign') && !autoApproveOn(cfg, 'content_blog'))
}
{
  const db = fakeTable({ ops_profile: [{ key: 'strategist_loop', value: { critique: { content_blog: true, content_ig: true, email_campaign: false } } }] })
  const cfg = await readLoopConfig(db)
  check('blog + IG loop on when switched on', critiqueOn(cfg, 'content_blog') && critiqueOn(cfg, 'content_ig'))
  check('per-type switch respected (email off)', !critiqueOn(cfg, 'email_campaign'))
}
{
  const db = { from() { throw new Error('boom') } }
  check('config read that throws = loop off', (await readLoopConfig(db)).max_auto_approve_per_run === 0)
}

// ── Claims ───────────────────────────────────────────────────────────────────
{
  const rows = [rec('a'), rec('b'), rec('c'), rec('d', { worker_id: 'someone' })]
  const db = fakeTable({ strategic_recommendations: rows })
  const got = await Promise.all(['w1', 'w2', 'w3'].map(w => claimLoopRows(db, 'awaiting_critique', w, 5)))
  const ids = got.flat().map(r => r.id)
  check('each unclaimed draft claimed exactly once', ids.length === 3 && new Set(ids).size === 3, ids.join(','))
  check('an already-claimed draft is not taken', !ids.includes('d'))
  check('claim counts a critique attempt', rows.filter(r => r.id !== 'd').every(r => r.critique_attempts === 1))
}
{
  const rows = [rec('a', { worker_id: 'w1' })]
  const db = fakeTable({ strategic_recommendations: rows })
  check('finish refused for another worker', (await finishLoopRow(db, 'a', 'w2', 'awaiting_critique', { status: 'exporting' })) !== null && rows[0].status === 'awaiting_critique')
  check('finish by the holder moves the row', (await finishLoopRow(db, 'a', 'w1', 'awaiting_critique', { status: 'exporting', worker_id: null })) === null && rows[0].status === 'exporting')
}

// ── Sweeps ───────────────────────────────────────────────────────────────────
{
  const past = new Date(Date.now() - 60_000).toISOString()
  const rows = [
    rec('crit-retry', { worker_id: 'dead', locked_until: past, critique_attempts: 1 }),
    rec('crit-give-up', { worker_id: 'dead', locked_until: past, critique_attempts: MAX_CRITIQUE_ATTEMPTS }),
    rec('exp-dead', { status: 'exporting', worker_id: 'dead', locked_until: past }),
    rec('exp-unclaimed', { status: 'exporting', worker_id: null, locked_until: null }),
  ]
  const db = fakeTable({ strategic_recommendations: rows })
  await sweepStaleLoop(db)
  const by = (id: string) => rows.find(r => r.id === id)!
  check('dead critique released for retry', by('crit-retry').status === 'awaiting_critique' && by('crit-retry').worker_id === null)
  check('critique that died too often → needs_human', by('crit-give-up').status === 'needs_human')
  check('dead export → failed, never re-exported', by('exp-dead').status === 'failed' && /may already exist/.test(by('exp-dead').draft_error))
  check('unclaimed export left alone', by('exp-unclaimed').status === 'exporting')
}

// ── Hand-back ────────────────────────────────────────────────────────────────
{
  const rows = [rec('h', { status: 'drafting', worker_id: 'async:task-1' }), rec('gone', { status: 'dismissed' })]
  const db = fakeTable({ strategic_recommendations: rows })
  check('hand-back queues the draft for the critic', (await handBackForCritique(db, 'h', { body: 'x' })) === null && rows[0].status === 'awaiting_critique' && rows[0].worker_id === null)
  check('hand-back refused for a dismissed rec', (await handBackForCritique(db, 'gone', { body: 'x' })) !== null && rows[1].status === 'dismissed')
}

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
