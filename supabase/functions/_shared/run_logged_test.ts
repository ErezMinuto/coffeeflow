// Behaviour tests for run_logged.ts against a fake PostgREST.
//   deno test --allow-env supabase/functions/_shared/run_logged_test.ts
//
// What matters: refused requests write nothing, every logged run gets exactly
// one terminal row, run_id reaches the reply, and nothing the judge leaves out
// (emails, text) reaches the table.

Deno.env.set('SUPABASE_URL', 'http://fake.local')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'eyJfake')

const rows: any[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/rest/v1/system_logs')) {
    rows.push(...JSON.parse(String(init?.body ?? '[]')))
    return new Response(null, { status: 201 })
  }
  return realFetch(input as any, init)
}) as typeof fetch

const { runLogged, redactEmails, queueWorkerJudge } = await import('./run_logged.ts')

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
const post = () => new Request('http://x/fn', { method: 'POST', body: '{}' })
const terminal = () => rows.filter((r) => r.run_status)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

Deno.test('refused requests (401/403/405/OPTIONS) write no rows', async () => {
  rows.length = 0
  for (const status of [401, 403, 405]) await runLogged('t', async () => json({ error: 'no' }, status))(post())
  await runLogged('t', async () => new Response('ok'))(new Request('http://x', { method: 'OPTIONS' }))
  assert(rows.length === 0, `expected 0 rows, got ${rows.length}`)
})

Deno.test('skip() writes no rows', async () => {
  rows.length = 0
  await runLogged('t', async () => new Response(null, { status: 302 }), { skip: () => true })(post())
  assert(rows.length === 0, `expected 0 rows, got ${rows.length}`)
})

Deno.test('async skip() writes no rows; a throwing skip still logs', async () => {
  rows.length = 0
  await runLogged('t', async () => json({ ok: true }), { skip: async () => true })(post())
  assert(rows.length === 0, `expected 0 rows, got ${rows.length}`)
  await runLogged('t', async () => json({ ok: true }), { skip: async () => { throw new Error('x') } })(post())
  assert(terminal().length === 1, 'throwing skip should still log the run')
})

Deno.test('content-length is dropped when run_id grows the body', async () => {
  rows.length = 0
  const res = await runLogged('t', async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '11' } }))(post())
  assert(res.headers.get('content-length') === null, 'stale content-length kept')
  assert(typeof (await res.json()).run_id === 'string', 'run_id missing')
})

Deno.test('success: one terminal row, run_id in body and header, judge summary only', async () => {
  rows.length = 0
  const res = await runLogged('t', async () => json({ ok: true, n: 3, email: 'a@b.co' }), {
    judge: (out) => ({ summary: { n: out.n } }),
  })(post())
  const body = await res.json()
  assert(typeof body.run_id === 'string' && body.run_id === res.headers.get('x-run-id'), 'run_id missing')
  assert(body.email === 'a@b.co' && body.n === 3, 'reply body changed')
  const t = terminal()
  assert(t.length === 1 && t[0].run_status === 'success', 'want one success row')
  assert(t[0].data.n === 3 && !JSON.stringify(rows).includes('a@b.co'), 'summary leaked or missing')
})

Deno.test('ok:false with HTTP 200 is an error run; email in the error is masked', async () => {
  rows.length = 0
  await runLogged('t', async () => json({ ok: false, error: 'send to jane.doe@example.com failed' }))(post())
  assert(terminal()[0]?.run_status === 'error', 'want error')
  assert(!JSON.stringify(rows).includes('jane.doe@example.com'), 'email leaked')
  assert(JSON.stringify(rows).includes('<email>'), 'email not masked')
})

Deno.test('judge status and warnings are recorded', async () => {
  rows.length = 0
  await runLogged('t', async () => json({ ok: true, failed: 2 }), {
    judge: () => ({ status: 'partial', warnings: [['x.fail', '2 failed', { failed: 2 }]] }),
  })(post())
  assert(terminal()[0]?.run_status === 'partial', 'want partial')
  assert(rows.some((r) => r.event === 'x.fail' && r.level === 'warn'), 'warning missing')
})

Deno.test('a throwing judge still finishes the run', async () => {
  rows.length = 0
  const res = await runLogged('t', async () => json({ ok: true }), { judge: () => { throw new Error('bug') } })(post())
  assert(res.status === 200, 'reply lost')
  assert(terminal().length === 1, 'no terminal row')
})

Deno.test('a throwing handler is logged, finished, and re-thrown', async () => {
  rows.length = 0
  let threw = false
  try { await runLogged('t', async () => { throw new Error('boom') })(post()) } catch { threw = true }
  assert(threw, 'did not re-throw')
  assert(terminal()[0]?.run_status === 'error', 'no error terminal row')
})

Deno.test('non-JSON reply passes through with the header', async () => {
  rows.length = 0
  const res = await runLogged('t', async () => new Response('plain', { status: 200 }))(post())
  assert((await res.text()) === 'plain' && !!res.headers.get('x-run-id'), 'body or header wrong')
  assert(terminal().length === 1, 'no terminal row')
})

Deno.test('redactEmails', () => {
  assert(redactEmails('x: a.b+c@mail.co.il, y') === 'x: <email>, y', redactEmails('x: a.b+c@mail.co.il, y'))
  assert(redactEmails('no email here') === 'no email here', 'changed clean text')
})

Deno.test('queue worker: empty tick writes no rows', async () => {
  rows.length = 0
  await runLogged('w', async () => json({ processed: 0, worker_id: 'x' }), { judge: queueWorkerJudge })(post())
  assert(rows.length === 0, `expected 0 rows, got ${rows.length}`)
})

Deno.test('queue worker: parent-not-ready polling writes no rows', async () => {
  rows.length = 0
  await runLogged('w', async () => json({ processed: 1, task_id: 't', ok: false, retry: true, reason: 'parent_not_ready' }), { judge: queueWorkerJudge })(post())
  assert(rows.length === 0, `expected 0 rows, got ${rows.length}`)
})

Deno.test('queue worker: drop is refused once the handler logged (no orphaned lines)', async () => {
  rows.length = 0
  await runLogged('w', async (_r, log) => { log.info('task.claimed', 'c'); return json({ processed: 1, task_id: 't', ok: false, retry: true }) }, { judge: queueWorkerJudge })(post())
  assert(terminal().length === 1 && terminal()[0].run_status === 'success', 'want one success terminal row')
})

Deno.test('queue worker: an idle tick that errored is logged', async () => {
  rows.length = 0
  await runLogged('w', async () => json({ processed: 0, worker_id: 'x', error: 'claim failed' }, 500), { judge: queueWorkerJudge })(post())
  assert(terminal()[0]?.run_status === 'error', 'want error')
})

Deno.test('queue worker: ok:false without error is success; failed:true at HTTP 200 is error', async () => {
  rows.length = 0
  await runLogged('w', async () => json({ processed: 1, task_id: 't', ok: false, reason: 'parent_superseded' }), { judge: queueWorkerJudge })(post())
  assert(terminal()[0]?.run_status === 'success', 'superseded should be success')
  rows.length = 0
  await runLogged('w', async () => json({ processed: 0, task_id: 't', failed: true, permanent: true, error: 'x' }, 200), { judge: queueWorkerJudge })(post())
  assert(terminal()[0]?.run_status === 'error', 'failed:true should be error')
})

Deno.test('queue worker: only allowlisted scalars are logged', async () => {
  rows.length = 0
  await runLogged('w', async () => json({
    processed: 1, task_id: 't', ok: true, caption_he: 'SECRET CAPTION', image_url: 'https://img/x.png',
    meta_response: { token: 'abc' }, tokens: { input: 10, output: 5 }, attach_error: 'wp 500',
  }), { judge: queueWorkerJudge })(post())
  const dump = JSON.stringify(rows)
  assert(!dump.includes('SECRET CAPTION') && !dump.includes('img/x.png') && !dump.includes('abc'), 'non-allowlisted field leaked')
  assert(terminal()[0].data.tokens_in === 10, 'tokens missing')
  assert(rows.some((r) => r.event === 'attach.fail'), 'attach warning missing')
})

Deno.test('a handler-owned run_id is kept; the log id goes in log_run_id', async () => {
  rows.length = 0
  const res = await runLogged('t', async () => json({ ok: true, run_id: 'strategist-run-1' }))(post())
  const body = await res.json()
  assert(body.run_id === 'strategist-run-1', 'handler run_id overwritten')
  assert(typeof body.log_run_id === 'string' && body.log_run_id === res.headers.get('x-run-id'), 'log_run_id missing')
})

Deno.test('scope: null writes no rows and the handler still reads the body; an object is logged', async () => {
  rows.length = 0
  const scope = async (r: Request) => { const b = await r.json(); return b.agent === 'cron_agent' ? { agent: b.agent } : null }
  const handler = async (r: Request) => json({ ok: true, got: (await r.json()).agent })
  const a = await runLogged('t', handler, { scope })(new Request('http://x', { method: 'POST', body: JSON.stringify({ agent: 'chat' }) }))
  assert((await a.json()).got === 'chat' && rows.length === 0, 'unscoped request was logged or lost its body')
  const b = await runLogged('t', handler, { scope })(new Request('http://x', { method: 'POST', body: JSON.stringify({ agent: 'cron_agent' }) }))
  assert((await b.json()).got === 'cron_agent', 'scoped request lost its body')
  assert(terminal()[0]?.data?.agent === 'cron_agent', 'scope label missing from summary')
})
