// ============================================================================
// Runtime sentinel — software bugs the freshness/cron checks cannot see.
// ============================================================================
//
// The rest of the watchdog asks "is the system running?". This asks "is it
// running CORRECTLY?" — three failure shapes that all looked healthy from the
// outside while they were happening:
//
//   1. visual QA spikes   — the visual worker fails all its QA attempts, the
//                           task is parked review_required, and the critique
//                           names the SAME defect task after task. That is a
//                           prompt bug (e.g. the hard-coded "must show ONLY the
//                           espresso machine" tail in a bag render), not bad
//                           luck. One failure is noise; a repeat is a bug.
//   2. chat runaway loops — handle-seo-chat gives up after MAX_TOOL_LOOPS or
//                           its time budget, or keeps nudging a worker that
//                           answers parent_not_ready.
//   3. edge crashes       — system_logs runs that threw, or never wrote a
//                           terminal line at all (killed by the wall clock).
//
// Everything here is PURE: rows in, findings out. index.ts does the queries
// and bug_signals.ts does the writes, so the thresholds are testable without a
// database. See runtime_sentinel_test.ts.
//
// A finding that is a concrete, repeatable code bug carries a `signal`, which
// index.ts files into strategist_signals (status 'open') for the fixer agent.
// A one-off carries no signal: it goes in the email, and only a repeat earns a
// place in the fixer's queue.

export type SentinelCategory = 'visual_qa_spike' | 'chat_runaway' | 'edge_crash' | 'edge_timeout_risk'

export interface BugSignalDraft {
  /** Stable across runs — the same bug must never be filed twice. Hyphens only (used in a LIKE). */
  key: string
  /** Short; bug_signals.ts prefixes "Automated Watchdog: ". */
  title: string
  /** Structured: what happened, where to look, and a query that reproduces it. */
  detail: string
  evidence: Record<string, unknown>
}

export interface SentinelFinding {
  severity: 'WARN' | 'ERROR'
  category: SentinelCategory
  message: string
  context: Record<string, unknown>
  signal?: BugSignalDraft
}

const HOUR = 3600 * 1000
const ago = (now: number, iso: string) => (now - new Date(iso).getTime()) / HOUR

// ────────────────────────────────────────────────────────────────────────────
// 1. Visual QA loop failure spike
// ────────────────────────────────────────────────────────────────────────────

export interface VisualCritique {
  passes?: boolean
  missing?: string[]
  issues?: string[]
}

/** A visual_generation task whose QA loop gave up (result_data.review_required = true). */
export interface FailedVisualTask {
  id: string
  updated_at: string
  /** Single-image tasks: the last attempt's critique. */
  qa_last_critique?: VisualCritique | null
  /** Carousels: per-slide outcome; the last attempt of a failed slide holds its critique. */
  slide_qa?: Array<{ slide?: number; passed?: boolean; attempts?: Array<{ critique?: VisualCritique }> }> | null
}

/**
 * Recurring defect families, matched against the critique text. The regexes
 * were written against 60 days of real qa_last_critique rows, not guessed:
 * every pattern below appeared in at least two of them.
 *
 * Order matters only for readability — a critique can match several.
 */
export const CRITIQUE_PATTERNS: Array<{ id: string; label: string; re: RegExp; where: string }> = [
  {
    id: 'prompt-contradiction',
    label: 'the prompt contradicts itself (a hard-coded override fights the brief)',
    // "The brief states 'The image must show ONLY the espresso machine …'" on a
    // render that was asked for a bag — the stripConflictingTerms tail.
    re: /\bmust show only\b|\bnothing else\b|\bcontradict|\bnot visible, implied\b/i,
    where: 'supabase/functions/seo-worker-visual/index.ts (stripConflictingTerms / buildAugmentedSceneBrief)',
  },
  {
    id: 'forbidden-element',
    label: 'a forbidden element keeps appearing (hands, loose beans, a bag the brief excluded)',
    re: /\bexplicitly forbids?\b|\bforbidden\b|\bmust not (?:show|include|appear)/i,
    where: 'supabase/functions/seo-worker-visual/index.ts (negative directives) + _shared/visual_identity.ts',
  },
  {
    id: 'garbled-text',
    label: 'garbled or wrong text on the bag (wordmark / product name)',
    re: /\bgibberish\b|\bgarbled\b|\billegible\b|\bmisspel|\b(?:wordmark|product name)\b[^.]*\b(?:instead of|incorrect|wrong|not match|missing)/i,
    where: 'supabase/functions/seo-worker-visual/index.ts (bag reference / product name injection)',
  },
  {
    id: 'missing-equipment',
    label: 'required equipment is missing from the render',
    re: /\b(?:espresso machine|grinder|aeropress|dripper|v60|chemex|kettle|scale|portafilter)\b[^.]*\b(?:missing|absent|not present|not visible|no )|\bno (?:espresso machine|grinder)\b/i,
    where: 'supabase/functions/seo-worker-visual/index.ts (co-subject handling) + _shared/visual_identity.ts',
  },
  {
    id: 'wrong-aspect',
    label: 'wrong aspect ratio / orientation',
    re: /\b(?:landscape|horizontal|portrait|aspect ratio|9:16|16:9)\b[^.]*\b(?:instead|not|wrong)\b/i,
    where: 'supabase/functions/seo-worker-visual/index.ts (ASPECT_TO_RATIO)',
  },
]

/** Every critique a failed task produced on its LAST attempt (one per failed slide for a carousel). */
export function finalCritiques(task: FailedVisualTask): VisualCritique[] {
  const out: VisualCritique[] = []
  if (task.qa_last_critique) out.push(task.qa_last_critique)
  for (const s of task.slide_qa ?? []) {
    if (s?.passed !== false) continue
    const last = s.attempts?.[s.attempts.length - 1]?.critique
    if (last) out.push(last)
  }
  return out
}

/** Which defect families a critique names. `missing[]` entries count as missing equipment text. */
export function classifyCritique(c: VisualCritique): string[] {
  const text = [...(c.missing ?? []).map(m => `${m} missing`), ...(c.issues ?? [])].join(' \n ')
  return CRITIQUE_PATTERNS.filter(p => p.re.test(text)).map(p => p.id)
}

/** ">2 tasks in 24h on the same critique pattern" — so three is the first that fires. */
export const VISUAL_SPIKE_MIN_TASKS = 3
export const VISUAL_WINDOW_HOURS = 24

export function visualQaFindings(tasks: FailedVisualTask[], now = Date.now()): SentinelFinding[] {
  const recent = tasks.filter(t => ago(now, t.updated_at) <= VISUAL_WINDOW_HOURS)
  // pattern → distinct task ids (a carousel failing 4 slides on the same defect is ONE task)
  const byPattern = new Map<string, { ids: Set<string>; samples: string[] }>()
  for (const t of recent) {
    const crits = finalCritiques(t)
    const patterns = new Set(crits.flatMap(classifyCritique))
    for (const p of patterns) {
      const slot = byPattern.get(p) ?? { ids: new Set(), samples: [] }
      slot.ids.add(t.id)
      const sample = crits.flatMap(c => c.issues ?? []).find(i => CRITIQUE_PATTERNS.find(x => x.id === p)!.re.test(i))
      if (sample && slot.samples.length < 3) slot.samples.push(sample.slice(0, 240))
      byPattern.set(p, slot)
    }
  }

  const findings: SentinelFinding[] = []
  for (const pattern of CRITIQUE_PATTERNS) {
    const slot = byPattern.get(pattern.id)
    if (!slot || slot.ids.size < VISUAL_SPIKE_MIN_TASKS) continue
    const ids = [...slot.ids]
    findings.push({
      severity: 'ERROR',
      category: 'visual_qa_spike',
      message:
        `${ids.length} visual tasks in ${VISUAL_WINDOW_HOURS}h failed every QA attempt on the same defect: ${pattern.label}. ` +
        `A repeat is a prompt bug, not a bad render.`,
      context: { pattern: pattern.id, task_ids: ids, samples: slot.samples },
      signal: {
        key: `visual-qa-${pattern.id}`,
        title: `visual QA keeps failing — ${pattern.label}`,
        detail: [
          `WHAT: ${ids.length} visual_generation tasks in the last ${VISUAL_WINDOW_HOURS}h exhausted all QA attempts ` +
            `(result_data.review_required = true) and their final critiques share one defect family: "${pattern.id}".`,
          `CRITIQUE SAMPLES:\n${slot.samples.map(s => `  - ${s}`).join('\n')}`,
          `WHERE TO LOOK: ${pattern.where}`,
          `TASKS: ${ids.join(', ')}`,
          `REPRODUCE:\n  select id, updated_at, result_data->'qa_last_critique', result_data->'slide_qa'\n` +
            `  from seo_tasks where task_type = 'visual_generation'\n` +
            `    and result_data->>'review_required' = 'true'\n` +
            `    and updated_at > now() - interval '${VISUAL_WINDOW_HOURS} hours';`,
        ].join('\n\n'),
        evidence: { pattern: pattern.id, task_ids: ids, samples: slot.samples, window_hours: VISUAL_WINDOW_HOURS },
      },
    })
  }
  return findings
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Chat agent runaway loops
// ────────────────────────────────────────────────────────────────────────────

export interface ChatRow {
  session_id: string
  role: string
  content: string | null
  created_at: string
}

// The exact strings handle-seo-chat writes (index.ts, end of the tool loop).
// Matched loosely on purpose: the loop count is a constant that may change.
const RUNAWAY_RE = /stopped after \d+ tool-use loops/i
const OUT_OF_TIME_RE = /ran out of time for this turn/i
const PARENT_NOT_READY_RE = /parent_not_ready/

export const CHAT_WINDOW_HOURS = 24
/** A single give-up is a hard request. Two in a week is a pattern worth a fix. */
export const RUNAWAY_SIGNAL_MIN_7D = 2
/** One parent_not_ready answer is the dependency system working. Three in a session is the chat polling a dead end. */
export const PARENT_NOT_READY_MIN_PER_SESSION = 3

export function chatLoopFindings(rows: ChatRow[], now = Date.now()): SentinelFinding[] {
  const findings: SentinelFinding[] = []
  const last24 = rows.filter(r => ago(now, r.created_at) <= CHAT_WINDOW_HOURS)
  const last7d = rows.filter(r => ago(now, r.created_at) <= 7 * 24)

  const runaway24 = last24.filter(r => r.role === 'system' && RUNAWAY_RE.test(r.content ?? ''))
  const runaway7d = last7d.filter(r => r.role === 'system' && RUNAWAY_RE.test(r.content ?? ''))
  const timeout24 = last24.filter(r => r.role === 'system' && OUT_OF_TIME_RE.test(r.content ?? ''))

  if (runaway24.length > 0 || runaway7d.length >= RUNAWAY_SIGNAL_MIN_7D) {
    const sessions = [...new Set(runaway7d.map(r => r.session_id))]
    const repeat = runaway7d.length >= RUNAWAY_SIGNAL_MIN_7D
    findings.push({
      severity: repeat ? 'ERROR' : 'WARN',
      category: 'chat_runaway',
      message:
        `SEO chat hit its tool-loop cap ${runaway24.length}× in ${CHAT_WINDOW_HOURS}h (${runaway7d.length}× in 7d) — ` +
        `the agent gave up mid-task and the admin was told to rephrase.`,
      context: { last_24h: runaway24.length, last_7d: runaway7d.length, sessions },
      signal: repeat
        ? {
            key: 'chat-runaway-tool-loops',
            title: 'SEO chat repeatedly stops after the tool-use loop cap',
            detail: [
              `WHAT: handle-seo-chat ended ${runaway7d.length} turns in 7 days with ` +
                `"(stopped after N tool-use loops — please rephrase your request.)". The agent is repeating tool calls ` +
                `without converging — usually a tool whose result never changes (a poll) or an error it retries blindly.`,
              `SESSIONS: ${sessions.join(', ')}`,
              `WHERE TO LOOK: supabase/functions/handle-seo-chat/index.ts — the tool loop (grep MAX_TOOL_LOOPS) and ` +
                `whichever tool the session called repeatedly.`,
              `REPRODUCE:\n  select session_id, role, left(content, 200), created_at from chat_messages\n` +
                `  where session_id in (${sessions.map(s => `'${s}'`).join(', ')})\n  order by created_at;`,
            ].join('\n\n'),
            evidence: { sessions, occurrences_7d: runaway7d.length },
          }
        : undefined,
    })
  }

  if (timeout24.length > 0) {
    findings.push({
      severity: 'WARN',
      category: 'chat_runaway',
      message: `SEO chat ran out of its time budget ${timeout24.length}× in ${CHAT_WINDOW_HOURS}h — pending steps were not started.`,
      context: { last_24h: timeout24.length, sessions: [...new Set(timeout24.map(r => r.session_id))] },
    })
  }

  // parent_not_ready: a worker refusing a child whose parent isn't done. The
  // chat nudging it over and over is a loop, not progress.
  const pnr = new Map<string, number>()
  for (const r of last24) {
    if (r.role === 'tool' && PARENT_NOT_READY_RE.test(r.content ?? '')) pnr.set(r.session_id, (pnr.get(r.session_id) ?? 0) + 1)
  }
  const looping = [...pnr.entries()].filter(([, n]) => n >= PARENT_NOT_READY_MIN_PER_SESSION)
  if (looping.length > 0) {
    findings.push({
      severity: 'ERROR',
      category: 'chat_runaway',
      message:
        `SEO chat nudged a worker that answered parent_not_ready ${looping.map(([, n]) => n).join('/')}× in ` +
        `${looping.length} session(s) — the chat is polling a child task whose parent is not finished.`,
      context: { sessions: Object.fromEntries(looping) },
      signal: {
        key: 'chat-parent-not-ready-loop',
        title: 'SEO chat loops on parent_not_ready worker nudges',
        detail: [
          `WHAT: in ${CHAT_WINDOW_HOURS}h, ${looping.length} chat session(s) received parent_not_ready from a worker ` +
            `${PARENT_NOT_READY_MIN_PER_SESSION}+ times. The worker is correctly refusing a child task whose parent ` +
            `is still pending; the chat treats it as retryable and nudges again, burning tool loops.`,
          `SESSIONS: ${looping.map(([s, n]) => `${s} (${n}×)`).join(', ')}`,
          `WHERE TO LOOK: supabase/functions/handle-seo-chat/index.ts (worker nudge tool) — and the refusal in ` +
            `seo-worker-visual/index.ts / organic-worker-instagram/index.ts (grep parent_not_ready).`,
          `REPRODUCE:\n  select session_id, created_at, left(content, 300) from chat_messages\n` +
            `  where role = 'tool' and content like '%parent_not_ready%'\n` +
            `    and created_at > now() - interval '${CHAT_WINDOW_HOURS} hours' order by created_at;`,
        ].join('\n\n'),
        evidence: { sessions: Object.fromEntries(looping) },
      },
    })
  }

  return findings
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Edge function crashes and timeouts (system_logs)
// ────────────────────────────────────────────────────────────────────────────

/** One row of the system_log_runs view. */
export interface LogRun {
  run_id: string
  fn: string
  started_at: string
  duration_ms: number | null
  status: 'success' | 'partial' | 'error' | 'incomplete' | string
}

/** An error-level line of a run (system_logs). */
export interface LogErrorLine {
  run_id: string
  event: string | null
  message: string | null
  data: Record<string, unknown> | null
  error_name: string | null
  error_stack: string | null
  run_status: string | null
}

export const CRASH_WINDOW_HOURS = 24
/**
 * A run still in flight looks exactly like a killed one (no terminal line yet).
 * The longest edge run on record is ~133s, so anything older than this is dead.
 */
export const INCOMPLETE_GRACE_MINUTES = 15
/** Supabase edge wall clock. Runs past this share of it are one slow API away from being killed. */
export const EDGE_WALL_CLOCK_MS = 150_000
export const TIMEOUT_RISK_RATIO = 0.85
/** One crash is an alert; a repeat in the window is a bug for the fixer. */
export const CRASH_SIGNAL_MIN = 2

/**
 * HANDLED vs UNHANDLED. Most status='error' runs are a function correctly
 * refusing a request: logger.finish('error', { code: 'duplicate_file' }) —
 * measured 2026-10-24, every error run in 30 days carried a code
 * (unauthorised, duplicate_file, bad_roast_id …). Those are the API working,
 * and filing them as bugs would bury the fixer queue in noise.
 *
 * A run is a CRASH when it threw (any line has an error_name/stack) or ended
 * in error without naming a code.
 */
export function isCrash(lines: LogErrorLine[]): boolean {
  if (lines.some(l => l.error_name || l.error_stack)) return true
  const terminal = lines.find(l => l.run_status === 'error')
  const code = terminal?.data && typeof terminal.data.code === 'string' ? terminal.data.code : null
  return !code
}

/** "at handler (file:///…/functions/meta-sync/index.ts:212:15)" → "meta-sync/index.ts:212" */
export function stackLocation(stack: string | null | undefined): string | null {
  if (!stack) return null
  const m = stack.match(/functions\/([\w-]+\/[\w./-]+\.ts):(\d+)/)
  return m ? `supabase/functions/${m[1]}:${m[2]}` : null
}

export function edgeCrashFindings(runs: LogRun[], errorLines: LogErrorLine[], now = Date.now()): SentinelFinding[] {
  const findings: SentinelFinding[] = []
  const inWindow = runs.filter(r => ago(now, r.started_at) <= CRASH_WINDOW_HOURS)
  const linesByRun = new Map<string, LogErrorLine[]>()
  for (const l of errorLines) linesByRun.set(l.run_id, [...(linesByRun.get(l.run_id) ?? []), l])

  // fn → crashes / killed runs
  const perFn = new Map<string, { crashes: LogRun[]; killed: LogRun[]; handled: number; locs: Set<string>; msgs: Set<string> }>()
  const slot = (fn: string) => {
    if (!perFn.has(fn)) perFn.set(fn, { crashes: [], killed: [], handled: 0, locs: new Set(), msgs: new Set() })
    return perFn.get(fn)!
  }

  for (const r of inWindow) {
    if (r.status === 'incomplete') {
      if (ago(now, r.started_at) * 60 < INCOMPLETE_GRACE_MINUTES) continue // still running
      slot(r.fn).killed.push(r)
    } else if (r.status === 'error') {
      const lines = linesByRun.get(r.run_id) ?? []
      const s = slot(r.fn)
      if (!isCrash(lines)) { s.handled++; continue }
      s.crashes.push(r)
      for (const l of lines) {
        const loc = stackLocation(l.error_stack)
        if (loc) s.locs.add(loc)
        const msg = [l.error_name, l.message].filter(Boolean).join(': ')
        if (msg && l.event !== 'run.finish') s.msgs.add(msg.slice(0, 200))
      }
    }
  }

  for (const [fn, s] of perFn) {
    const bad = s.crashes.length + s.killed.length
    if (bad === 0) continue
    const repeat = s.crashes.length >= CRASH_SIGNAL_MIN || s.killed.length >= CRASH_SIGNAL_MIN
    const runIds = [...s.crashes, ...s.killed].map(r => r.run_id)
    const parts = [
      s.crashes.length ? `${s.crashes.length} unhandled crash(es)` : '',
      s.killed.length ? `${s.killed.length} run(s) killed mid-flight (no terminal log line — wall-clock timeout or OOM)` : '',
    ].filter(Boolean).join(' and ')
    const where = s.locs.size ? [...s.locs].join(', ') : `supabase/functions/${fn}/index.ts`
    findings.push({
      severity: 'ERROR',
      category: 'edge_crash',
      message: `${fn}: ${parts} in ${CRASH_WINDOW_HOURS}h.`,
      context: { fn, crashes: s.crashes.length, killed: s.killed.length, handled_refusals: s.handled, run_ids: runIds.slice(0, 10), locations: [...s.locs] },
      signal: repeat
        ? {
            key: `edge-crash-${fn}`,
            title: `${fn} is crashing (${parts})`,
            detail: [
              `WHAT: ${fn} had ${parts} in the last ${CRASH_WINDOW_HOURS}h. ` +
                `(${s.handled} other error run(s) were handled refusals with a code and are NOT counted.)`,
              s.msgs.size ? `ERRORS:\n${[...s.msgs].slice(0, 5).map(m => `  - ${m}`).join('\n')}` : '',
              `WHERE TO LOOK: ${where}`,
              `RUNS: ${runIds.slice(0, 10).join(', ')}`,
              `REPRODUCE:\n  ./scripts/logs.sh runs --fn ${fn} --since ${CRASH_WINDOW_HOURS}h\n` +
                `  ./scripts/logs.sh run ${runIds[0]}`,
            ].filter(Boolean).join('\n\n'),
            evidence: { fn, run_ids: runIds.slice(0, 20), crashes: s.crashes.length, killed: s.killed.length, locations: [...s.locs] },
          }
        : undefined,
    })
  }

  // Close to the wall clock but still finishing — a WARN, never a signal: the
  // fix is usually batching, and nothing is broken yet.
  const slow = new Map<string, number>()
  for (const r of inWindow) {
    if ((r.duration_ms ?? 0) >= EDGE_WALL_CLOCK_MS * TIMEOUT_RISK_RATIO) slow.set(r.fn, Math.max(slow.get(r.fn) ?? 0, r.duration_ms!))
  }
  for (const [fn, ms] of slow) {
    findings.push({
      severity: 'WARN',
      category: 'edge_timeout_risk',
      message: `${fn} ran ${(ms / 1000).toFixed(0)}s — over ${Math.round(TIMEOUT_RISK_RATIO * 100)}% of the ${EDGE_WALL_CLOCK_MS / 1000}s edge wall clock. One slow upstream call from being killed.`,
      context: { fn, max_duration_ms: ms, wall_clock_ms: EDGE_WALL_CLOCK_MS },
    })
  }

  return findings
}
