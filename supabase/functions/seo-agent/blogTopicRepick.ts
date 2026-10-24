// Minuto SEO Agent — closing the loop on the cannibalization gate.
//
// The orchestrator's pre-queue gate (cannibalizationCheck.ts) turns a blog
// task whose keyword overlaps existing WP posts into a pending
// cannibalization_conflict proposal. That is the right call for one article,
// but nothing ever told the strategist it had happened. From 2026-10-07 to
// 10-18 every cycle's blog slot was spent on a keyword the site already
// covers ("פולי קפה איכותיים" twice, "פולי קפה ערביקה" twice), every one was
// blocked, and no article was written for two weeks.
//
// Two parts, both here so they can be tested without a network:
//
//   • collectBlockedKeywords / renderBlockedKeywordsBlock — past conflict
//     proposals rendered into the planning prompt, so the strategist stops
//     re-proposing what was already refused. The 60-day blog list it already
//     sees cannot do this: the gate searches every post on the site, and the
//     overlaps are mostly older than 60 days.
//
//   • buildRepickPrompt / parseRepick / screenRepick — when the gate blocks a
//     blog task inside a run, one small follow-up call asks for a different
//     topic, which goes back through the same gate before it is queued.

import { normalizeForMatch } from './cannibalizationCheck.ts'

export interface BlockedKeyword {
  keyword:    string
  blocked_at: string      // YYYY-MM-DD
  overlaps:   string[]    // titles of the existing posts that caused the block
}

export interface ConflictRow {
  created_at: string
  brief_data: unknown
}

// Past cannibalization_conflict rows (any status) → one entry per keyword,
// newest first. A keyword blocked on several cycles appears once, with the
// most recent date, which is what the prompt needs to say.
export function collectBlockedKeywords(rows: ConflictRow[], limit = 25): BlockedKeyword[] {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const seen = new Set<string>()
  const out: BlockedKeyword[] = []
  for (const r of sorted) {
    const d = ((r.brief_data ?? {}) as { details?: Record<string, unknown> }).details ?? {}
    const keyword = String(d.intended_keyword ?? '').trim()
    const norm = normalizeForMatch(keyword)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    const posts = Array.isArray(d.conflicting_posts) ? d.conflicting_posts : []
    out.push({
      keyword,
      blocked_at: r.created_at.slice(0, 10),
      overlaps: posts
        .map(p => String((p as { title?: unknown })?.title ?? '').trim())
        .filter(Boolean)
        .slice(0, 4),
    })
    if (out.length >= limit) break
  }
  return out
}

export function renderBlockedKeywordsBlock(blocked: BlockedKeyword[]): string {
  if (blocked.length === 0) return '  (none — no blog keyword has been blocked as a duplicate recently)'
  return blocked.map(b => {
    const ov = b.overlaps.length ? ` — already covered by: ${b.overlaps.map(t => `"${t}"`).join('; ')}` : ''
    return `  • "${b.keyword}" (blocked ${b.blocked_at})${ov}`
  }).join('\n')
}

export interface RepickedTopic {
  keyword:             string
  title:               string
  key_points:          string[]
  products_to_mention: string[]
  why_now:             string
  banner_scene_brief?: string
}

export function buildRepickPrompt(args: {
  rejected:      Array<{ keyword: string; title: string; overlaps: string[]; brief: unknown }>
  blocked:       BlockedKeyword[]
  queuedKeywords: string[]
  recentTitles:  string[]
  gscKeywords:   string[]
  opportunities: string[]
  catalogNames:  string[]
}): string {
  const r = args.rejected[0]
  const list = (xs: string[], empty: string) => xs.length ? xs.map(x => `  • ${x}`).join('\n') : `  ${empty}`
  return [
    `Your plan proposed a blog article on "${r.keyword}" ("${r.title}"). It was NOT queued: the site already has posts covering it:`,
    list(r.overlaps.map(t => `"${t}"`), '(titles unavailable)'),
    '',
    'Original brief, for the intent behind it:',
    JSON.stringify(r.brief).slice(0, 1500),
    '',
    'Propose ONE replacement article on a DIFFERENT keyword that no existing post already covers. Serving the same business goal is good; the same topic in other words is not.',
    '',
    '=== KEYWORDS ALREADY BLOCKED AS DUPLICATES — do not use these or close paraphrases ===',
    renderBlockedKeywordsBlock(args.blocked),
    '',
    '=== ALREADY QUEUED OR WRITTEN AS BLOG TASKS — do not use ===',
    list(args.queuedKeywords, '(none)'),
    '',
    '=== RECENT BLOG POSTS — do not overlap ===',
    list(args.recentTitles.slice(0, 40), '(none)'),
    '',
    '=== CANDIDATE DEMAND (GSC queries, then keyword-planner opportunities) ===',
    list([...args.gscKeywords.slice(0, 20), ...args.opportunities.slice(0, 15)], '(none)'),
    '',
    '=== CATALOG (products_to_mention must use EXACT names from here) ===',
    list(args.catalogNames.slice(0, 50), '(empty)'),
    '',
    'Rules: keyword and title in Hebrew. The title must be gender-inclusive (e.g. לכם/ן) and use no em-dashes.',
    'A narrower, more specific long-tail keyword is usually the way to find ground no post covers yet.',
    '',
    'Return ONLY this JSON object, no prose:',
    '{"keyword": "...", "title": "...", "key_points": ["...", "..."], "products_to_mention": ["..."], '
      + '"why_now": "...", "banner_scene_brief": "4-6 sentence English photographer\'s brief for the article banner"}',
  ].join('\n')
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : []

// Shape check only. Whether the topic is acceptable is screenRepick's job.
export function parseRepick(raw: unknown): RepickedTopic | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const keyword = String(o.keyword ?? '').trim()
  const title   = String(o.title ?? '').trim()
  const key_points = asStrings(o.key_points)
  if (!keyword || !title || key_points.length === 0) return null
  const banner = String(o.banner_scene_brief ?? '').trim()
  return {
    keyword,
    title,
    key_points,
    products_to_mention: asStrings(o.products_to_mention),
    why_now: String(o.why_now ?? '').trim(),
    ...(banner ? { banner_scene_brief: banner } : {}),
  }
}

// Local screen before the WP gate: rejects the replacement when its keyword
// equals, contains, or is contained in any forbidden keyword. Containment
// matters because the usual failure is a near-repeat ("פולי קפה ערביקה" →
// "פולי קפה ערביקה איכותיים"). Returns the reason, or null when it passes.
export function screenRepick(topic: RepickedTopic, forbidden: Iterable<string>): string | null {
  const kw = normalizeForMatch(topic.keyword)
  if (!kw) return 'empty keyword'
  for (const f of forbidden) {
    const n = normalizeForMatch(f)
    if (!n) continue
    if (n === kw || kw.includes(n) || n.includes(kw)) return `repeats blocked or queued keyword "${f}"`
  }
  return null
}
