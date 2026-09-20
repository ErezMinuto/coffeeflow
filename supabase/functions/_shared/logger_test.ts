// Behaviour tests for logger.ts, run against a fake PostgREST that records
// what would have been inserted.
//
//   deno run --allow-net --allow-env supabase/functions/_shared/logger_test.ts
//
// These cover the properties the logger is relied on for and which are easy
// to regress: that errors are written immediately rather than buffered, that
// a run always gets a terminal row, and that nothing in here can throw into
// the calling function.
import { createLogger } from './logger.ts'

const received: any[] = []
let failNext = false

const server = Deno.serve({ port: 8799, onListen: () => {} }, async (req) => {
  if (failNext) { failNext = false; return new Response('{"message":"boom"}', { status: 400 }) }
  const rows = await req.json()
  received.push(...rows)
  return new Response('', { status: 201 })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) failures++
}

// 1. error flushes immediately (does not wait for the buffer/timer)
{
  received.length = 0
  const log = createLogger('test-fn')
  log.error('boom.now', 'immediate', { a: 1 }, new Error('kaboom'))
  await sleep(250)
  check('error flushes immediately', received.length === 1, `got ${received.length}`)
  check('error carries stack', !!received[0]?.error_stack?.includes('kaboom'))
  check('run_id is a uuid', /^[0-9a-f-]{36}$/.test(received[0]?.run_id ?? ''))
  await log.finish('error')
}

// 2. info buffers, then flushes on the timer
{
  received.length = 0
  const log = createLogger('test-fn')
  log.info('step.one', 'buffered')
  await sleep(150)
  check('info is buffered, not written instantly', received.length === 0, `got ${received.length}`)
  await sleep(2200)
  check('info flushes on the timer', received.length === 1, `got ${received.length}`)
  await log.finish('success')
}

// 3. the size threshold triggers an early write
{
  received.length = 0
  const log = createLogger('test-fn')
  for (let i = 0; i < 25; i++) log.info('bulk', `line ${i}`)
  await sleep(300)
  check('25 buffered lines flush without waiting', received.length === 25, `got ${received.length}`)
  await log.finish('success')
}

// 4. finish() drains and writes a terminal row
{
  received.length = 0
  const log = createLogger('test-fn')
  log.info('a', 'one')
  await log.finish('success', { items: 3 })
  check('finish drains the buffer', received.length === 2, `got ${received.length}`)
  const term = received.find(r => r.run_status)
  check('terminal row is marked', term?.run_status === 'success')
  check('terminal row has a duration', typeof term?.duration_ms === 'number')
  check('all rows share one run_id', new Set(received.map(r => r.run_id)).size === 1)
  check('seq increases', received[0].seq === 0 && received[1].seq === 1)
}

// 5. oversized data is truncated, not dropped
{
  received.length = 0
  const log = createLogger('test-fn')
  log.error('big', 'huge payload', { blob: 'x'.repeat(50_000) })
  await sleep(250)
  check('oversized data truncated', received[0]?.data?._truncated === true)
  check('truncation keeps a preview', (received[0]?.data?.preview ?? '').length > 1000)
  await log.finish('success')
}

// 6. circular data does not throw
{
  received.length = 0
  const circular: any = { name: 'loop' }; circular.self = circular
  const log = createLogger('test-fn')
  let threw = false
  try { log.error('circ', 'circular', circular) } catch { threw = true }
  await sleep(250)
  check('circular data does not throw', !threw)
  check('circular data recorded as unserialisable', received[0]?.data?._unserialisable === 'object')
  await log.finish('success')
}

// 7. an HTTP failure from the log endpoint never reaches the caller
{
  received.length = 0
  failNext = true
  const log = createLogger('test-fn')
  let threw = false
  try { log.error('x', 'endpoint will 400'); await log.finish('error') } catch { threw = true }
  check('a rejected insert does not throw', !threw)
}

// 8. the row cap holds
{
  received.length = 0
  const log = createLogger('test-fn')
  for (let i = 0; i < 2100; i++) log.info('flood', `${i}`)
  await log.finish('success')
  // MAX_ROWS capped lines + the terminal row, which is deliberately exempt.
  check('row cap enforced', received.length === 2001, `got ${received.length}`)
  // Find the terminal row by its marker rather than by position: the batched
  // writes are concurrent, so arrival order is not guaranteed.
  const capTerm = received.find(r => r.run_status)
  check('dropped lines reported', JSON.stringify(capTerm?.data ?? {}).includes('_dropped_lines'))
}

await server.shutdown()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
Deno.exit(failures === 0 ? 0 : 1)
