// Request shape for the functions that call the Anthropic Messages API with
// their own fetch (the Telegram bots, generate-schedule, the ingesters).
// Functions on the seo-agent stack go through seo-agent/claude.ts instead.
//
// Opus 5.5 (the system-wide Claude model since 2026-09-26) differs from the
// Sonnet 4.6 / Haiku 4.5 these sites were written for in four ways that matter:
//   • it always thinks, and the thinking counts toward max_tokens, so a cap
//     sized for a one-line JSON reply (120, 200 …) cuts the reply off;
//   • it rejects temperature / top_p / top_k with a 400;
//   • a response can start with a thinking block, so content[0] is not
//     necessarily the text — read text blocks by type (claudeText);
//   • its safety classifiers can decline a request; fallbacks:"default" has
//     Anthropic re-serve it on another model inside the same call.
// Effort is the only lever on how long it thinks. These call sites are small
// extraction/classification jobs, several behind a Telegram webhook, so 'low'.

export const CLAUDE_MODEL = 'claude-opus-5-5'

const MIN_MAX_TOKENS = 16_000

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function claudeHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key':         apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta':    'server-side-fallback-2026-07-01',
    'Content-Type':      'application/json',
  }
}

export function claudeBody(args: {
  system?: unknown
  messages: unknown[]
  maxTokens?: number
  effort?: ClaudeEffort
  tools?: unknown[]
}): Record<string, unknown> {
  return {
    model:         CLAUDE_MODEL,
    max_tokens:    Math.max(args.maxTokens ?? 0, MIN_MAX_TOKENS),
    output_config: { effort: args.effort ?? 'low' },
    fallbacks:     'default',
    ...(args.system !== undefined ? { system: args.system } : {}),
    messages:      args.messages,
    ...(args.tools ? { tools: args.tools } : {}),
  }
}

/** Concatenated text blocks of a Messages API response (thinking blocks skipped). */
export function claudeText(json: { content?: Array<{ type?: string; text?: string }> } | null | undefined): string {
  return (json?.content ?? [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')
}
