// Run: deno run -A supabase/functions/_shared/site_change_log_test.ts
import {
  beginChange, finishChange, parseChangeContext, sameValue, undoBlocker, type ChangeRow,
} from './site_change_log.ts'
import { cleanFaq, faqFromHtml, parseStoredFaq, pickPostFields } from './site_io.ts'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}

// Records every PostgREST call and answers from a queue.
function fakeRest(answers: unknown[]) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null })
    const a = answers.length ? answers.shift() : []
    return Promise.resolve(new Response(JSON.stringify(a), { status: 200 }))
  }) as typeof fetch
  return { calls, opts: { supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', fetchFn } }
}

const ID = '11111111-2222-4333-8444-555555555555'
const ID2 = '66666666-7777-4888-9999-000000000000'

// ── parseChangeContext ──
{
  const c = parseChangeContext({ change_id: 'not-a-uuid', undo_of: ID, reason: '  why  ', approved_by: 42 })
  check('bad change_id dropped', c.change_id === undefined)
  check('valid undo_of kept', c.undo_of === ID)
  check('reason trimmed', c.reason === 'why')
  check('non-string approved_by dropped', c.approved_by === undefined)
  check('garbage → empty', JSON.stringify(parseChangeContext('x')) === '{}')
}

// ── sameValue ──
check('key order ignored', sameValue({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 }))
check('array order matters', !sameValue([1, 2], [2, 1]))
check('undefined equals null', sameValue(undefined, null))

// ── undoBlocker ──
{
  const row = { status: 'applied', before_source: 'wp_plugin', after: [{ q: 'q', a: 'a' }] } as unknown as ChangeRow
  check('undo allowed when page unchanged', undoBlocker(row, [{ q: 'q', a: 'a' }]) === null)
  check('undo blocked when page changed since', (undoBlocker(row, [{ q: 'q2', a: 'a' }]) ?? '').includes('changed since'))
  check('undo blocked unless applied', (undoBlocker({ ...row, status: 'undone' } as ChangeRow, row.after) ?? '').includes('applied'))
  check('undo blocked with no backup', (undoBlocker({ ...row, before_source: 'none' } as ChangeRow, row.after) ?? '').includes('not recorded'))
}

// ── beginChange: new row ──
{
  const r = fakeRest([[{ id: ID }]])
  const id = await beginChange({ target_type: 'post_faq', target_id: 7, before: [], before_source: 'wp_plugin', after: [{ q: 'q', a: 'a' }], source_fn: 'set-post-faq', ctx: {} }, r.opts)
  check('new row id returned', id === ID)
  check('inserts (POST)', r.calls[0].method === 'POST')
  check('status applying before the site write', r.calls[0].body.status === 'applying')
  check('backup saved in the same insert', Array.isArray(r.calls[0].body.before))
  check('operator approval recorded as service', r.calls[0].body.approved_by === 'service')
}

// ── beginChange: approving a proposal ──
{
  const r = fakeRest([[{ id: ID }]])
  await beginChange({ target_type: 'post_faq', target_id: 7, before: [], before_source: 'wp_plugin', after: [], source_fn: 'x', ctx: { change_id: ID, approved_by: 'user_1' } }, r.opts)
  check('proposal patched, not inserted', r.calls[0].method === 'PATCH')
  check('only a still-proposed row', r.calls[0].url.includes('status=eq.proposed'))
  check('only for the same target', r.calls[0].url.includes('target_type=eq.post_faq') && r.calls[0].url.includes('target_id=eq.7'))
  check('approver recorded', r.calls[0].body.approved_by === 'user_1')

  const r2 = fakeRest([[]])
  let threw = false
  try { await beginChange({ target_type: 'post_faq', target_id: 7, before: [], before_source: 'wp_plugin', after: [], source_fn: 'x', ctx: { change_id: ID } }, r2.opts) } catch { threw = true }
  check('an already-handled proposal can not be applied again', threw)
}

// ── finishChange ──
{
  const r = fakeRest([[{ undo_of: ID2 }], [{ approved_by: 'user_1' }], []])
  const res = await finishChange(ID, { ok: true, after: ['stored'] }, r.opts)
  check('logged', res.logged)
  check('marked applied with stored value', r.calls[0].body.status === 'applied' && r.calls[0].body.after[0] === 'stored')
  check('the undone change is marked undone', r.calls[2].url.includes(`id=eq.${ID2}`) && r.calls[2].body.status === 'undone' && r.calls[2].body.undone_by === 'user_1')

  const r2 = fakeRest([[{ undo_of: null }]])
  await finishChange(ID, { ok: false, error: 'boom' }, r2.opts)
  check('failure recorded', r2.calls[0].body.status === 'failed' && r2.calls[0].body.error === 'boom')
  check('failure does not touch other rows', r2.calls.length === 1)
}

// ── site_io parsers ──
check('cleanFaq drops incomplete pairs', JSON.stringify(cleanFaq([{ q: ' a ', a: ' b ' }, { q: 'x' }, null])) === '[{"q":"a","a":"b"}]')
check('stored FAQ string parsed', parseStoredFaq('[{"q":"a","a":"b"}]').length === 1)
check('empty stored FAQ = none', parseStoredFaq('').length === 0 && parseStoredFaq(undefined).length === 0)
{
  const html = '<script type="application/ld+json" data-source="minuto-product-faq">{"mainEntity":[{"name":"Q1","acceptedAnswer":{"text":"A1"}}]}</script>'
  check('FAQ read from the page JSON-LD', faqFromHtml(html)?.[0]?.q === 'Q1')
  check('no FAQ block → null', faqFromHtml('<html></html>') === null)
}
check('pickPostFields keeps only changed fields', JSON.stringify(pickPostFields({ title: 'T', content: 'C' }, { title: 'x' })) === '{"title":"T"}')

if (failed) { console.log(`\n${failed} failed`); Deno.exit(1) }
console.log('\nall passed')
