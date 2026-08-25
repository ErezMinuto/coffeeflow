// Token pricing + cost estimation for the Claude call stack.
//
// This lives in its OWN module (not strategistConfig.ts) purely to break an
// import cycle: strategistConfig.ts imports MODEL_STRATEGIST from claude.ts,
// so claude.ts cannot import back from strategistConfig.ts to price its own
// calls. pricing.ts imports nothing, so both can depend on it safely.
// strategistConfig.ts re-exports estimateUsd, so existing importers (db.ts,
// strategist-brain) keep working unchanged.

// USD per 1M tokens. Used only to estimate est_usd for the cost ledger and the
// monthly kill-switch — the real invoice is Anthropic's. Keep in sync with
// platform pricing.
interface ModelPrice { input: number; output: number }
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-4-8':   { input: 5,  output: 25 },
  'claude-opus-4-7':   { input: 5,  output: 25 },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 },
  'claude-fable-5':    { input: 10, output: 50 },
  // Gemini (provider switch — see gemini.ts). Priced here so both providers land
  // in agent_cost_ledger on the same basis.
  //
  // ONLY MODELS WITH PUBLISHED RATES ARE LISTED, and only ids confirmed to exist
  // via GET /v1beta/models. The first version of this block invented entries for
  // 'gemini-3.1-flash' and 'gemini-3.1-pro' — NEITHER MODEL EXISTS, so the rates
  // were fiction attached to ids that 404.
  //
  // A Gemini 3.x model is deliberately NOT listed: its rates are unconfirmed, and
  // the unknown-model fallback below prices as Opus. That over-states 3.x spend,
  // which is the safe direction — the monthly kill-switch trips early rather than
  // late. Add a 3.x entry only with a rate taken from Google's pricing page.
  'gemini-2.5-flash':  { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':    { input: 1.25, output: 10 },
}
// Cache reads cost ~0.1× the input rate; cache writes (5-min TTL) ~1.25×.
const CACHE_READ_MULT = 0.1
const CACHE_WRITE_MULT = 1.25

export interface TokenUsage {
  model: string
  inputTokens: number           // uncached input (full price)
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
