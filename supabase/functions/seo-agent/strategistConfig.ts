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

// ── Token pricing (USD per 1M tokens) ────────────────────────────────────────
// Used only to estimate est_usd for the cost ledger / kill-switch — the real
// invoice is Anthropic's. Keep in sync with platform pricing.
interface ModelPrice { input: number; output: number }
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-8':   { input: 5,  output: 25 },
  'claude-opus-4-7':   { input: 5,  output: 25 },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 },
  'claude-fable-5':    { input: 10, output: 50 },
}
// Cache reads cost ~0.1× the input rate; cache writes (5-min TTL) ~1.25×.
const CACHE_READ_MULT = 0.1
const CACHE_WRITE_MULT = 1.25

export interface TokenUsage {
  model: string
  inputTokens: number          // uncached input (full price)
  outputTokens: number
  cacheReadTokens: number       // served from cache (~0.1×)
  cacheCreationTokens: number   // written to cache (~1.25×)
}

/** Estimate the USD cost of one Claude call from its returned token usage. */
export function estimateUsd(u: TokenUsage): number {
  const p = MODEL_PRICES[u.model] ?? MODEL_PRICES['claude-opus-4-8']  // unknown → price as Opus (conservative)
  const dollars =
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.input * CACHE_READ_MULT +
      u.cacheCreationTokens * p.input * CACHE_WRITE_MULT) / 1_000_000
  return Math.round(dollars * 10_000) / 10_000  // 4dp, matches ledger NUMERIC(10,4)
}
