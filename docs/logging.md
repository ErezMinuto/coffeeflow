# System logging

Durable, queryable logs for the edge functions — so a bug can be read back
instead of reproduced.

## Why this exists

Before this, the only log was `console.log` inside each function. That is
fine for tailing a function you are actively poking at, and useless for
everything else:

- **Per-function.** A failure that starts in `organic-orchestrator` and
  surfaces in `meta-publish` cannot be followed across the hop.
- **Ephemeral.** The symptoms we actually hit — a sync that went stale days
  ago, a bot that quietly stopped recording — are noticed long after the
  console lines have aged out.
- **Not queryable.** "Every error in the last 24h" is not a question you can
  ask across 59 functions in the dashboard log viewer.

The result was a recurring failure shape: something breaks, it returns HTTP
200 anyway, and nobody finds out until a number looks wrong weeks later.

## The pieces

| Piece | Path | What it does |
|---|---|---|
| Table | `supabase/migrations/20260920_system_logs.sql` | `system_logs` + the `system_log_runs` rollup view + a daily 30-day purge |
| Logger | `supabase/functions/_shared/logger.ts` | What functions call. Writes to the table *and* to console |
| Tests | `supabase/functions/_shared/logger_test.ts` | Behaviour tests against a fake PostgREST |
| Reader | `scripts/logs.sh` | How you read any of it |

## Reading logs

Reads with the service-role key, because `system_logs` has been admin-read since
`20261018c` and the anon key can no longer see it. Uses `SUPABASE_SERVICE_ROLE_KEY`
from your session; with only `SUPABASE_ACCESS_TOKEN` set, it looks up the `eyJ`
service_role key and caches it in the session temp dir (mode 600). Run
`./scripts/secrets-doctor.sh` to see what is set. Everything here is read-only:
the script only sends GETs and never prints the key.

```bash
./scripts/logs.sh errors            # what is broken (last 24h)
./scripts/logs.sh runs              # every invocation and how it ended
./scripts/logs.sh fn meta-sync      # one function
./scripts/logs.sh run <run-id>      # the full trace of one invocation
./scripts/logs.sh search "429"      # find a string across messages/stacks
./scripts/logs.sh stats             # error counts per function
./scripts/logs.sh tail              # follow new lines
```

Flags: `--since 30m|6h|7d`, `--limit N`, `--level error`, `--fn <name>`,
`--status error|partial|incomplete`, `--json`.

### The usual path

```bash
./scripts/logs.sh errors                  # 1. which function is unhappy
./scripts/logs.sh runs --fn woo-orders-sync   # 2. find the bad run, copy its id
./scripts/logs.sh run 3f2a…               # 3. read the whole trace in order
```

### Run statuses

`success` · `partial` (finished, some steps failed) · `error` ·
**`incomplete`** — the run never wrote a terminal line, meaning it was killed
mid-flight by a worker timeout or OOM. That one is worth paying attention to:
it is the signature of the wall-clock-limit failures that return nothing at
all to the caller.

## Adding logging to a function

```ts
import { createLogger } from '../_shared/logger.ts'

serve(async (req) => {
  const log = createLogger('my-function')
  try {
    log.info('run.start', 'doing the thing', { mode })
    // …
    await log.finish('success', { rows: n })
    return jsonResponse({ ok: true, run_id: log.runId })
  } catch (err) {
    log.error('run.throw', 'aborted', undefined, err)
    await log.finish('error')
    return jsonResponse({ error: String(err), run_id: log.runId }, 500)
  }
})
```

Rules of thumb:

- **Always `await log.finish(...)`.** Without it the run reads as
  `incomplete` and you lose the ability to trust that marker.
- **Return `run_id` in the HTTP response.** It turns "the sync looked weird
  this morning" into one command.
- **Use stable `event` keys** (`woo.fetch.fail`, not a sentence). Prose gets
  reworded; the key is what you grep for six months later.
- **Log the quiet failures**, not just thrown ones: zero rows written, an
  empty feed, a response that parsed to nothing. Those are the ones that hurt,
  precisely because nothing throws.
- **Don't log secrets.** `data` is stored as-is; tokens and keys do not
  belong in it.

### Levels

`debug` (off by default — set `LOG_LEVEL=debug`) · `info` · `warn` · `error`.
Warnings and errors are written immediately; info and debug are batched.

### Env

| Var | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Minimum level written to the table |
| `LOG_TO_DB` | `true` | `false` keeps console output, stops writing rows |

## Design notes worth knowing

**It writes as it goes, rather than once at the end.** That is deliberate. The
failure that motivated the table — `google-sync` exceeding the wall-clock
limit — kills the worker before any `catch` block runs, so an end-of-run flush
would write *nothing* for exactly the runs you most need. Errors and warnings
go out immediately; info batches on 25 lines or 2 seconds. A run that dies
mid-flight still reads back as a partial trace ending where it died.

**It cannot break its caller.** Every write path is wrapped. The worst case is
a lost line, never a failed request.

**It writes to console too.** Console is how you tail a function live, and the
only thing that still works if the database is what is broken.

**Editing `logger.ts` makes every importing function stale.** Supabase bundles
imports at deploy time, so a change here only takes effect in functions that
are redeployed afterwards. Keep it stable.

## Retention

30 days, purged daily at 02:00 UTC by `system-logs-purge-daily`, which calls
`purge_system_logs(30)` in 10k batches so it never holds a long lock. The cron
is registered in `health-watchdog`'s `EXPECTED_CRONS`, so if it stops firing
you will hear about it.

`purge_system_logs` is SECURITY DEFINER, so only `service_role` may EXECUTE it
(the cron runs as its owner, `postgres`), and it refuses a window under 7 days.
`scripts/ci/purge_functions_check.sql` (`qa-scan.sh --db`) fails if any
`purge_*` function becomes callable with the anon or user key again.

30 days is chosen to cover slow-burn failures: a sync that quietly stops
(`woo-orders-sync` sat ~6 days stale once) or anything on a weekly cadence
needs more history than a fortnight.

## Currently instrumented

| Function | Why it was picked |
|---|---|
| `industry-intelligence-sync` | Returned `ok:true` with 0 stored when feeds 403'd; now grades its own run |
| `woo-orders-sync` | Froze ~6 days unnoticed; a Woo throw was an unhandled rejection writing nothing |
| `google-sync` | The wall-clock timeout case; 11 per-block failures are now attributable |
| `meta-sync` | Wrote `status:'success'` unconditionally, even when every block threw |
| `coffee-bot` | Stock writes discarded their errors — employees saw "✅ נרשמה אריזה" while nothing was recorded |

**Every function `pg_cron` calls now logs** (step 1b, 2026-11-07, PRs #515,
#517, #520, #521/#522, #523):

| Batch | Functions |
|---|---|
| 1 — data syncs (inline `createLogger`) | `stock-update` (MFlow sells + revenue), `woo-stock-check`, `woo-products-enrich`, `ga4-sync`, `rfm-sync` |
| 2 — workers | `mission-worker`, `organic-orchestrator` (inline, per-phase lines), `health-watchdog`, `email-automation-scheduler`, `strategist-executor` |
| 3 — queue workers | `seo-worker-research`, `seo-worker-techseo`, `seo-worker-writer`, `seo-worker-visual`, `organic-worker-instagram` |
| 4 — strategist + agents | `strategist-brain`, `strategist-evaluator`, `evaluator-tick`, `scout-tick`, `marketing-advisor` (cron agents only) |
| 5 — small jobs | `ai-visibility-probe`, `attendance-reminder`, `green-stock-alert`, `purge-old-media`, `employee-bot` (cron actions only) |

Functions not called by cron (webhooks, dashboard endpoints) still use
`console.log` only. Add the logger as you touch them.

## Wrapping a long handler: `_shared/run_logged.ts`

For a handler with many exit paths, wrap it instead of editing every return:

```ts
import { runLogged, queueWorkerJudge } from '../_shared/run_logged.ts'

serve(runLogged('my-function', async (req, log) => {
  // …handler unchanged…
}, {
  judge: (out, res, scope) => ({ summary: { processed: out?.processed } }),
}))
```

It reads the handler's own JSON reply after it returns, records the run's
outcome (HTTP 200 + `ok:false` counts as an error), always awaits `finish()`,
and adds `run_id` to the reply (`log_run_id` if the reply already has a
`run_id`) plus an `x-run-id` header. Behaviour of the handler is unchanged.

- **Only what `judge` returns is logged.** Default summary is the HTTP status
  alone; name each field. Error text is email-masked. Never log names, emails,
  prompt or model text, or money.
- **Refused requests write nothing**: OPTIONS, 401, 403, 405, and anything
  `skip` (after the handler, headers/URL only) or `scope` (before the handler,
  from a request clone, may read the body; `null` = not logged) rules out. Use
  `scope` when only some calls are scheduled work (`marketing-advisor`
  agents, `employee-bot` actions).
- **`drop: true`** from `judge` writes no rows for an empty tick (frequent
  crons with nothing to do). Refused once the run failed, a warning is
  pending, or the handler logged anything, so a run is never left
  `incomplete`. `queueWorkerJudge` is the shared judge for `seo_tasks` queue
  workers.
- Log one line (e.g. `task.claimed`) as soon as real work starts, so a
  wall-clock kill reads back `incomplete` instead of leaving no trace.
- Check it parses: run `NO_COLOR=1 deno check` and treat **any** `error` line
  as a failure (a parse error prints lowercase `error:` and no `ERROR`), or
  parse with esbuild like the deploy guard does. #521 shipped a missing `)`
  that a grep for `ERROR` did not catch.

Tests: `deno test --allow-env --allow-net supabase/functions/_shared/run_logged_test.ts`.
