// How to ask a Gemini model for "no thinking" — the knob differs per model, and
// sending the wrong one is a 400 on EVERY request, not a degraded answer.
//
// WHY THIS EXISTS. gemini-2.5-flash is deprecated: from 2026-12-01 every request
// to it is redirected to gemini-3.5-flash-lite. Every caller here sent the 2.5
// form `{ thinkingBudget: 0 }` (thinking spends maxOutputTokens before any
// visible text, so tight-cap callers got truncated JSON). Probed against the
// live API on 2026-11-03:
//
//   model                    thinkingBudget:0   thinkingLevel:'minimal'
//   gemini-2.5-flash         ok                 400 "not supported"
//   gemini-3.5-flash-lite    400                ok
//   gemini-3.6-flash         ok                 ok
//   gemini-3.8-flash         ok                 400 "MINIMAL is not supported"
//   gemini-3.1-pro-preview   400 (thinking-only) 400 (MINIMAL unsupported)
//
// So no single config works across the redirect, and a static table goes stale
// as ids change. offThinkingConfig() picks by tier name; callers that make the
// request themselves should also retry once with alternateThinkingConfig() when
// a 400 names the thinking config (see isThinkingConfigError), which covers the
// next id that breaks the pattern.

export type ThinkingConfig = { thinkingBudget: number } | { thinkingLevel: string }

// Pro tiers reason by design and treat "no thinking" as invalid rather than as
// a cheaper mode. Matching on the tier name rather than an allow-list of exact
// ids, because Gemini ids change often and a stale list fails the same silent way.
export function modelRequiresThinking(model: string): boolean {
  return /(^|[-_])pro([-_]|$)/i.test(model)
}

/**
 * The thinkingConfig that turns thinking off (or as low as the model allows),
 * or null when the model must be left on its own default (pro tiers).
 */
export function offThinkingConfig(model: string): ThinkingConfig | null {
  if (modelRequiresThinking(model)) return null
  // 2.x only understands a token budget; thinkingLevel is a 400 there.
  if (/^gemini-2\./.test(model)) return { thinkingBudget: 0 }
  // 3.x Flash-Lite rejects a zero budget but takes the 3.x level knob.
  if (/(^|[-_])lite([-_]|$)/i.test(model)) return { thinkingLevel: 'minimal' }
  // 3.x Flash: a zero budget works on 3.5/3.6/3.8, while 'minimal' is refused
  // by 3.8 — so the budget form is the one that spans the tier.
  return { thinkingBudget: 0 }
}

/** The other "off" form, for a single retry after a thinking-config 400. */
export function alternateThinkingConfig(cfg: ThinkingConfig): ThinkingConfig {
  return 'thinkingBudget' in cfg ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 }
}

/**
 * True when a 400 is plausibly about the thinking config. Gemini's message is
 * sometimes specific ("Thinking level ... not supported", "Budget 0 is
 * invalid") and sometimes only "Request contains an invalid argument." (what
 * 3.5-flash-lite says to thinkingBudget:0), so the generic form counts too —
 * the retry is one extra call, and only when a thinkingConfig was sent.
 */
export function isThinkingConfigError(status: number, body: string): boolean {
  if (status !== 400) return false
  return /thinking|budget|invalid argument/i.test(body)
}
