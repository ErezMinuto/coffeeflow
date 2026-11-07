// CoffeeFlow — one system_logs run per scheduled invocation, without editing
// every exit path of a long handler.
//
//   serve(runLogged('mission-worker', async (req, log) => { ...unchanged... }, {
//     judge: (out) => ({ summary: { processed: out?.processed } }),
//   }))
//
// The handler keeps every return it already had. After it returns, this reads
// the handler's own JSON reply, records the outcome as the run's terminal row,
// and adds `run_id` to the reply (and an `x-run-id` header).
//
// Rules it enforces, so each caller doesn't have to remember them:
//   • A run that the handler refused before doing anything (OPTIONS, 401, 403,
//     405) writes NOTHING. The handler logs nothing before its auth check, so an
//     unauthenticated caller cannot add rows to system_logs.
//   • finish() is always awaited, including when the handler throws (the error
//     is logged, then re-thrown so the caller's 500 behaviour is unchanged).
//   • Only what `judge` returns reaches the table. Replies here carry customer
//     emails, prompt text and ₪ figures; the default summary is the HTTP status
//     alone, so a caller has to name each field it logs. The reply's own error
//     text is logged on failure with email addresses masked.
//
// This file is new and imported only by the functions that use it, so editing
// it does not make every function stale the way editing logger.ts does.

import { createLogger, type Logger, type RunStatus } from './logger.ts'

export interface RunJudgement {
  /** Overrides the default status (error when !res.ok or reply.ok === false or
   *  reply.error is set; success otherwise). Use 'partial' for "ran, some
   *  items failed". */
  status?: RunStatus
  /** Counts and flags only. Never emails, names, prompt text or money. */
  summary?: Record<string, unknown>
  /** Quiet failures worth a warn line: [event, message, data?]. */
  warnings?: Array<[string, string, Record<string, unknown>?]>
}

export interface RunLoggedOptions {
  judge?: (out: any, res: Response) => RunJudgement | undefined
  /** Extra "don't log this request" rule (e.g. a public route, or a function
   *  with no caller check of its own). Checked after the handler returns, so it
   *  may only read request headers/URL, never the body. The handler must not
   *  have logged on a skipped path, or its lines are left without a terminal row. */
  skip?: (req: Request, res: Response) => boolean | Promise<boolean>
}

const REFUSED = new Set([401, 403, 405])

/** Error text sometimes quotes the customer it failed on. */
export const redactEmails = (s: string) => s.replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[a-z]{2,}/gi, '<email>')

export function runLogged(
  fn: string,
  handler: (req: Request, log: Logger) => Promise<Response>,
  opts: RunLoggedOptions = {},
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const log = createLogger(fn)
    let res: Response
    try {
      res = await handler(req, log)
    } catch (err) {
      log.error('run.throw', 'unhandled error', undefined, err)
      await log.finish('error')
      throw err
    }

    // Nothing was emitted for these, so returning without finish() writes no rows.
    if (req.method === 'OPTIONS' || REFUSED.has(res.status)) return res
    try { if (await opts.skip?.(req, res)) return res } catch { /* a broken skip rule logs the run */ }

    try {
      let out: any = null
      const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
      if (isJson) { try { out = await res.clone().json() } catch { out = null } }

      let j: RunJudgement | undefined
      try { j = opts.judge?.(out, res) } catch (e) {
        // A judge bug must not cost the run its terminal row.
        log.warn('run.judge.fail', 'judge threw; using the default status', undefined, e)
      }
      for (const [event, message, data] of j?.warnings ?? []) log.warn(event, message, data)

      const failed = !res.ok || out?.ok === false || (out?.error != null && out?.ok !== true)
      const status: RunStatus = j?.status ?? (failed ? 'error' : 'success')
      if (status === 'error' && failed) {
        // The handler's own message, capped. Callers whose errors can carry
        // customer data must redact them in the handler or set status/summary.
        const msg = typeof out?.error === 'string' ? out.error : `HTTP ${res.status}`
        log.error('run.fail', redactEmails(String(msg)).slice(0, 500), { http_status: res.status })
      }
      await log.finish(status, { http_status: res.status, ...(j?.summary ?? {}) })

      const headers = new Headers(res.headers)
      headers.set('x-run-id', log.runId)
      if (out && typeof out === 'object' && !Array.isArray(out)) {
        // The body grows by run_id; a copied Content-Length would truncate it.
        headers.delete('content-length')
        return new Response(JSON.stringify({ ...out, run_id: log.runId }), { status: res.status, statusText: res.statusText, headers })
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch (e) {
      // Logging must never break the reply. Best effort to close the run.
      try { await log.finish('error', { http_status: res.status, _logger_fail: true }) } catch { /* nothing left */ }
      return res
    }
  }
}
