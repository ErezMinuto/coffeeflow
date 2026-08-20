// Minuto Strategist Brain — single source of truth for the brain's knobs.
//
// Everything tunable about the strategist tier lives here: which model, how
// hard it thinks, how often it runs, the spend ceiling, and the token prices
// used to estimate cost. Change cadence/budget/effort in ONE place — never
// scatter these across the runner.

import { MODEL_STRATEGIST } from './claude.ts'

// ── Reasoning ──────────────────────────────────────────────────────────────
// The brain runs on Opus 4.8 (see claude.ts). 'high' effort is the default for
// strategy work; the loop is bounded so it can't run away on cost.
export const STRATEGIST_MODEL = MODEL_STRATEGIST
export const STRATEGIST_EFFORT: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high'

// Hard cap on ReAct steps per run (also enforced by strategist_runs.max_steps).
// A run that hits this without concluding is failed-safe, never looped forever.
export const STRATEGIST_MAX_STEPS = 12

// Per-step output cap. Opus 4.8 runs adaptive thinking, whose tokens count
// toward output — so this must leave room for a real reasoning pass PLUS the
// structured tool call that follows it. Generous, but still bounded so one step
// can't run away on latency under the edge wall-clock (the 95s per-call timeout
// in the runner is the harder stop).
export const STRATEGIST_MAX_TOKENS = 12000

// One advance-invocation runs multiple steps in a tight loop (keeps the prompt
// cache hot within the invocation), then checkpoints and lets the next cron
// tick resume. Stop the in-process loop once we approach this soft budget so
// we never hit the ~150s edge hard cap mid-request.
export const ADVANCE_SOFT_BUDGET_MS = 110_000

// ── Budget ─────────────────────────────────────────────────────────────────
// Hard monthly ceiling for the WHOLE agent stack (metered API). The kickoff
// checks month-to-date spend in agent_cost_ledger against this and skips +
// alerts if exceeded. The budget gates FREQUENCY (skip a run), never depth —
// each run that does fire still thinks fully.
export const BUDGET_CEILING_USD = 150
export const BUDGET_TARGET_USD = 90

// ── Token pricing ────────────────────────────────────────────────────────────
// Moved to pricing.ts so callClaude can price its own calls without an import
// cycle (strategistConfig → claude → strategistConfig). Re-exported here so
// existing importers keep working unchanged.
export { estimateUsd } from './pricing.ts'
export type { TokenUsage } from './pricing.ts'
