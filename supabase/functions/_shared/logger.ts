// CoffeeFlow — structured logging for edge functions.
//
// Usage (the whole API):
//
//   import { createLogger } from '../_shared/logger.ts'
//
//   const log = createLogger('woo-orders-sync')
//   log.info('sync.start', 'pulling orders', { days: 7 })
//   try {
//     ...
//     await log.finish('success', { orders: 42 })
//   } catch (err) {
//     log.error('sync.fail', 'order pull failed', { days: 7 }, err)
//     await log.finish('error')
//   }
//
// Everything lands in the `system_logs` table, correlated by run_id, and is
// read back with `scripts/logs.sh`.
//
// ── Three rules this module is built around ────────────────────────────
//
// 1. IT MUST NEVER BREAK ITS CALLER. A logger that throws turns an
//    observability feature into an outage. Every write path here is wrapped;
//    the worst case is that a line is lost, never that the bot stops replying.
//
// 2. IT MUST NOT LOSE THE LINES THAT MATTER WHEN THE WORKER IS KILLED.
//    This is the whole reason it does not simply buffer everything and write
//    once at the end. The failure that motivated this table — google-sync
//    exceeding the wall-clock limit — kills the worker before any catch block
//    runs, so an end-of-run flush would write exactly nothing for precisely
//    the runs you most need to read. Instead: errors and warnings flush
//    immediately, info/debug flush on a small buffer or a short timer, and a
//    run that dies mid-flight still reads back as a partial trace ending
//    where it died. The `system_log_runs` view reports those as 'incomplete'.
//
// 3. IT MUST STILL WRITE TO console. Console is how you tail a function live
//    in the Supabase dashboard, and it is the only thing that survives if the
//    database itself is the thing that is broken. Every line goes to both.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type RunStatus = 'success' | 'partial' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

// LOG_LEVEL trims what reaches the TABLE (console always gets everything at or
// above the same threshold). Default 'info': debug lines are for a session
// where you have deliberately turned them on, not for permanent storage.
const MIN_LEVEL: LogLevel = (() => {
  const raw = (Deno.env.get('LOG_LEVEL') ?? 'info').toLowerCase()
  return (raw in LEVEL_RANK ? raw : 'info') as LogLevel
})()

// Kill switch. Set LOG_TO_DB=false to keep console output but stop writing
// rows — useful if the table ever becomes the problem.
const LOG_TO_DB = (Deno.env.get('LOG_TO_DB') ?? 'true').toLowerCase() !== 'false'

const FLUSH_SIZE = 25      // lines buffered before an early write
const FLUSH_MS   = 2000    // …or this long since the first buffered line
const MAX_ROWS   = 2000    // hard cap per run; a runaway loop must not fill the table
const MAX_MSG    = 4000    // chars
const MAX_DATA   = 8000    // chars of serialised `data`

interface LogRow {
  fn: string
  run_id: string
  seq: number
  level: LogLevel
  event: string | null
  message: string
  data: unknown
  duration_ms: number | null
  error_name: string | null
  error_stack: string | null
  run_status: string | null
}

// `data` is caller-supplied and frequently holds an API response or an AI
// prompt. Serialising that unbounded would write multi-megabyte rows, so it is
// capped — and capped visibly, with a marker, so a truncated payload is never
// mistaken for the whole story. Circular references are tolerated rather than
// thrown on, because a logger is the wrong place to be strict.
function safeData(data: unknown): unknown {
  if (data === undefined || data === null) return null
  try {
    const json = JSON.stringify(data)
    if (json === undefined) return { _unserialisable: typeof data }
    if (json.length <= MAX_DATA) return JSON.parse(json)
    return { _truncated: true, _original_chars: json.length, preview: json.slice(0, MAX_DATA) }
  } catch {
    // Circular, a BigInt, a Proxy that throws — record the shape, drop the value.
    return { _unserialisable: typeof data }
  }
}

function errorFields(err: unknown): { name: string | null; stack: string | null } {
  if (!err) return { name: null, stack: null }
  if (err instanceof Error) {
    return { name: err.name || 'Error', stack: (err.stack ?? err.message ?? '').slice(0, 8000) }
  }
  try { return { name: 'NonError', stack: String(err).slice(0, 8000) } }
  catch { return { name: 'NonError', stack: null } }
}

export interface Logger {
  /** Correlation id for this invocation. Log it in your HTTP response so a
   *  user-reported failure can be traced back to its rows. */
  runId: string
  debug(event: string, message: string, data?: unknown): void
  info (event: string, message: string, data?: unknown): void
  warn (event: string, message: string, data?: unknown, err?: unknown): void
  error(event: string, message: string, data?: unknown, err?: unknown): void
  /** Writes the terminal row and drains the buffer. Always await this — it is
   *  what turns a run from 'incomplete' into a real outcome. */
  finish(status: RunStatus, data?: unknown): Promise<void>
  /** Force a write without ending the run. Rarely needed; finish() drains. */
  flush(): Promise<void>
}

export function createLogger(fn: string, opts?: { runId?: string }): Logger {
  const runId = opts?.runId ?? crypto.randomUUID()
  const startedAt = Date.now()

  let seq = 0
  let dropped = 0
  let buffer: LogRow[] = []
  // Deno's setTimeout returns a Timeout object under `deno check`, a number
  // in the edge runtime. Deriving the type keeps both happy.
  let timer: ReturnType<typeof setTimeout> | undefined
  // Every in-flight write. finish() awaits these so the worker is not torn
  // down with a POST still in the air.
  const inFlight = new Set<Promise<void>>()

  // Configuration problems have to be loud at construction, because the
  // symptom otherwise is "logging silently does nothing" — the exact class of
  // bug this table exists to kill.
  const canWrite = LOG_TO_DB && !!SUPABASE_URL && !!SERVICE_ROLE
  if (LOG_TO_DB && !canWrite) {
    console.warn(`[logger] ${fn}: DB logging off — SUPABASE_URL/SERVICE_ROLE_KEY missing. Console only.`)
  } else if (canWrite && !SERVICE_ROLE.startsWith('eyJ')) {
    // A sb_secret_* key does not assign the PostgREST role properly and makes
    // INSERTs fail. Known trap in this project; say so rather than dropping
    // every row into a 401 nobody reads.
    console.warn(`[logger] ${fn}: SUPABASE_SERVICE_ROLE_KEY is not a JWT (eyJ…). Inserts will likely fail.`)
  }

  async function write(rows: LogRow[]): Promise<void> {
    if (!rows.length || !canWrite) return
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/system_logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_ROLE,
          'Authorization': `Bearer ${SERVICE_ROLE}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(rows),
      })
      if (!res.ok) {
        // Read the body so the reason is visible, then give up on these rows.
        const detail = await res.text().catch(() => '')
        console.warn(`[logger] ${fn}: insert failed ${res.status} ${detail.slice(0, 300)}`)
      }
    } catch (err) {
      // Network blip, DNS, worker shutting down mid-POST. Losing a log line is
      // acceptable; propagating this into the caller is not.
      console.warn(`[logger] ${fn}: insert threw — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function track(p: Promise<void>): void {
    inFlight.add(p)
    p.finally(() => inFlight.delete(p)).catch(() => {})
  }

  function flushNow(): Promise<void> {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    if (!buffer.length) return Promise.resolve()
    const rows = buffer
    buffer = []
    const p = write(rows)
    track(p)
    return p
  }

  function scheduleFlush(): void {
    if (timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; void flushNow() }, FLUSH_MS)
  }

  function emit(
    level: LogLevel,
    event: string,
    message: string,
    data?: unknown,
    err?: unknown,
    extra?: { duration_ms?: number; run_status?: string },
  ): void {
    try {
      // Console first and unconditionally-ish: if anything below goes wrong,
      // the line still exists somewhere.
      const tag = `[${fn}:${runId.slice(0, 8)}] ${event} — ${message}`
      const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      if (data !== undefined && data !== null) consoleFn(tag, data); else consoleFn(tag)
      if (err) console.error(`[${fn}:${runId.slice(0, 8)}]`, err)

      if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return
      if (!canWrite) return

      // The terminal row is exempt from the cap. Dropping it would leave a
      // run that genuinely finished reading back as 'incomplete' — the marker
      // reserved for runs killed mid-flight — which is worse than the extra
      // row, because it makes the one status you cannot fake untrustworthy.
      const isTerminal = !!extra?.run_status
      if (seq >= MAX_ROWS && !isTerminal) {
        // Log the cap once, then go console-only for the rest of the run.
        if (dropped === 0) console.warn(`[logger] ${fn}: hit ${MAX_ROWS}-row cap for run ${runId}; remaining lines are console-only`)
        dropped++
        return
      }

      const { name, stack } = errorFields(err)
      buffer.push({
        fn,
        run_id: runId,
        seq: seq++,
        level,
        event: event || null,
        message: String(message ?? '').slice(0, MAX_MSG),
        data: safeData(data),
        duration_ms: extra?.duration_ms ?? null,
        error_name: name,
        error_stack: stack,
        run_status: extra?.run_status ?? null,
      })

      // Errors and warnings go out immediately. They are rare, they are the
      // reason anyone opens this table, and they are disproportionately likely
      // to be followed by the worker dying before a buffered flush lands.
      if (level === 'error' || level === 'warn' || buffer.length >= FLUSH_SIZE) void flushNow()
      else scheduleFlush()
    } catch (loggerErr) {
      // Absolute last resort. The logger failing must not surface as the
      // caller's failure.
      try { console.warn(`[logger] ${fn}: emit failed`, loggerErr) } catch { /* nothing left to try */ }
    }
  }

  return {
    runId,
    debug: (e, m, d) => emit('debug', e, m, d),
    info:  (e, m, d) => emit('info',  e, m, d),
    warn:  (e, m, d, err) => emit('warn',  e, m, d, err),
    error: (e, m, d, err) => emit('error', e, m, d, err),

    flush: () => flushNow().catch(() => {}),

    async finish(status: RunStatus, data?: unknown): Promise<void> {
      const duration = Date.now() - startedAt
      emit(
        status === 'error' ? 'error' : 'info',
        'run.finish',
        `run ${status} in ${duration}ms`,
        dropped > 0 ? { ...(data as Record<string, unknown> ?? {}), _dropped_lines: dropped } : data,
        undefined,
        { duration_ms: duration, run_status: status },
      )
      try {
        await flushNow()
        // Drain anything still in the air, including writes started earlier.
        // Without this the worker can be recycled with the final POST pending,
        // which is how a run ends up looking 'incomplete' despite finishing.
        while (inFlight.size) await Promise.allSettled([...inFlight])
      } catch { /* finish() is the last thing a handler does; never throw here */ }
    },
  }
}

// Convenience wrapper for the common shape: one HTTP handler, one run.
//
// It guarantees the two things that are easy to forget by hand — that a thrown
// error is recorded before it propagates, and that finish() is always called
// so the run does not read back as 'incomplete'. The run id is attached as a
// response header so a failure someone reports from the dashboard can be
// traced without guessing at timestamps.
export function withLogging(
  fn: string,
  handler: (req: Request, log: Logger) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const log = createLogger(fn)
    try {
      const res = await handler(req, log)
      // A handler that already called finish() simply writes a second terminal
      // line; the view takes the worst status, so this stays truthful.
      await log.finish(res.ok ? 'success' : 'error', { http_status: res.status })
      const headers = new Headers(res.headers)
      headers.set('x-run-id', log.runId)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch (err) {
      log.error('run.throw', 'unhandled error', undefined, err)
      await log.finish('error')
      throw err
    }
  }
}
