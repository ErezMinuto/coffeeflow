// Minuto SEO Agent — keyword-cannibalization check.
//
// Before a text_generation task is queued, and again before the writer
// drafts it, we check whether an existing post (ANY status: draft, publish,
// pending, future, private) already covers the same topic. A second
// near-duplicate splits ranking signals between two URLs (cannibalization),
// so on a conflict the article is NOT written; the conflict is surfaced to
// the admin instead.
//
//   • checkCannibalizationForQueue() + buildCannibalizationConflictBrief()
//     — the PRE-QUEUE gate (mission worker + orchestrator). On a conflict
//     they file a dynamic_experiment (cannibalization_conflict,
//     approval_required) instead of the text_generation task.
//
//   • checkKeywordCannibalization() — the WRITER gate, at claim time. It is
//     the one chokepoint every blog task passes through, whichever path
//     queued it, so it applies the SAME matcher as the pre-queue gate.
//
// How matching works, and why (2026-10-12 rewrite):
//
//   The old version asked WP's `?search=` for candidates. WP search ANDs
//   every word, so one extra word in the new keyword ("מומלצת", "תהליכי")
//   hid the very post it should have found — "פולי קפה למכונת אספרסו ביתית"
//   never returned the near-identical #80764, and 7 duplicate pairs went
//   live. It then compared exact tokens, so Hebrew prefixes broke matches
//   ("למכונת" ≠ "מכונת", "מברזיל" ≠ "ברזיל").
//
//   Now: fetch the WHOLE post index once (a few hundred titles), and score
//   locally. Tokens match when they are equal after stripping up to two
//   Hebrew prefix letters (ו ה ב כ ל מ ש). Each token is weighted by how
//   rare it is across the existing titles (IDF), so generic words that
//   appear everywhere ("קפה", "פולי", "מדריך") barely count and topic words
//   ("קפאין", "טחינה", "ברזיל") decide the match.
//
// Uses the same WP Application Password env vars as blog-publish:
// WP_BLOG_POST_USER_NAME + WP_BLOG_POST_PASS. WOO_URL for the base URL.

import type { DynamicExperimentBrief } from './types.ts'

const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

// Minimum IDF-weighted share of the new article's topic that an existing
// post must cover to count as a conflict. Tunable via env without a
// redeploy. Clamped to (0, 1]. Default chosen against the live blog
// history — see cannibalizationCheck_test.ts.
const OVERLAP_MIN = (() => {
  const raw = Number(Deno.env.get('SEO_CANNIBAL_TOKEN_OVERLAP') ?? '')
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.6
})()

// Keyword overlap required before the intended TITLE is weighed at all.
const TITLE_GATE = 0.35

// Function words that carry no topic. Generic DOMAIN words ("קפה",
// "מדריך") are deliberately NOT listed — IDF already discounts them, and
// a hand list would drift out of date as the blog grows.
const STOPWORDS = new Set([
  'של', 'את', 'על', 'לפי', 'עם', 'גם', 'כל', 'או', 'כי', 'זה', 'זו', 'אלה',
  'הוא', 'היא', 'הם', 'הן', 'יש', 'אין', 'מה', 'מי', 'לא', 'כן', 'אני', 'אתה',
  'אנחנו', 'אך', 'רק', 'עד', 'אם', 'כמו', 'איך', 'למה', 'איזה', 'איזו', 'מתי',
  'ולמה', 'שלך', 'שלכם', 'לך', 'לכם', 'יותר', 'הכי', 'בין', 'אחרי', 'לפני',
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'vs',
  // SEO intent modifiers. They never change WHICH topic a page is about
  // ("מטחנת קפה ידנית מומלצת" is the manual-grinder topic), but they are
  // rare in titles, so IDF would otherwise make them the heaviest token.
  'מומלץ', 'מומלצת', 'מומלצים', 'מומלצות', 'הטוב', 'הטובה', 'הטובים', 'ביותר',
  'מדריך', 'המדריך', 'המלא', 'המלאה', 'מקיף', 'חדש', 'חדשה', 'best', 'guide',
  '2024', '2025', '2026', '2027',
])

const HEB_PREFIXES = new Set(['ו', 'ה', 'ב', 'כ', 'ל', 'מ', 'ש'])

export interface CannibalConflict {
  id:     number
  title:  string
  status: string
  link:   string
  slug?:  string
  // Overlap score that triggered the conflict (0..1). Absent on synthetic
  // conflicts (in-plan / already-queued) that the orchestrator builds.
  score?: number
}

export interface CannibalizationResult {
  // Posts that overlap the target keyword/title. Empty ⇒ safe to write.
  conflicts: CannibalConflict[]
  // false when we could NOT actually run the check (creds missing / WP
  // unreachable). The caller must FAIL-OPEN on !checked — never block
  // article generation on a transient WP outage.
  checked:   boolean
  // Human-readable reason when checked=false.
  reason?:   string
}

// Lowercase, strip Hebrew niqqud, punctuation → space, collapse whitespace.
function normalize(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')          // strip Hebrew niqqud/te'amim
    .replace(/["'“”‘’׳״]/g, '')      // quotes/gershayim are part of the word (גוג'י, ע"י)
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // any other non-letter/number → space
    .replace(/\s+/g, ' ')
    .trim()
}

// Meaningful comparison tokens: stop-words and 1-char tokens dropped.
function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter(t => t.length >= 2 && !STOPWORDS.has(t))
}

// Hebrew inflection endings: plural (ות/ים), construct/feminine (ת/ה).
// "שיטה" / "שיטת" / "שיטות" all reduce to "שיט".
const HEB_SUFFIXES = ['יות', 'ות', 'ים', 'ת', 'ה']

function stripSuffix(t: string): string {
  for (const suf of HEB_SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, -suf.length)
  }
  return t
}

// A token plus its forms with up to two leading Hebrew prefix letters
// stripped ("למכונת" → "מכונת", "והקפה" → "קפה"), each also with its
// inflection ending stripped. A stem must keep at least 3 letters so short
// words aren't reduced to noise. Two tokens match when their variant sets
// intersect.
function variants(t: string): string[] {
  const out = new Set([t, stripSuffix(t)])
  let cur = t
  for (let i = 0; i < 2; i++) {
    if (cur.length - 1 < 3 || !HEB_PREFIXES.has(cur[0])) break
    cur = cur.slice(1)
    out.add(cur)
    out.add(stripSuffix(cur))
  }
  return [...out]
}

// WP slugs come back percent-encoded ("%d7%a7%d7%a4%d7%94-..."); decode so
// Hebrew slugs compare as words. Falls back to the raw slug on bad input.
function decodeSlug(slug: string): string {
  try { return decodeURIComponent(slug) } catch { return slug }
}

export interface IndexedPost {
  id:     number
  title:  string
  status: string
  link:   string
  slug:   string
}

// Pure scorer over a post index. Exported for tests.
export function buildMatcher(posts: IndexedPost[]) {
  // Per-post variant sets for title and slug.
  const docs = posts.map((p) => {
    const titleVars = new Set(tokens(p.title).flatMap(variants))
    const slugVars  = new Set(tokens(decodeSlug(p.slug).replace(/-/g, ' ')).flatMap(variants))
    return { post: p, titleVars, slugVars }
  })

  // Document frequency per variant, over titles. A token's df is the
  // number of titles that contain ANY of its variants.
  const df = new Map<string, number>()
  for (const d of docs) for (const v of d.titleVars) df.set(v, (df.get(v) ?? 0) + 1)
  const N = Math.max(docs.length, 1)
  const idf = (t: string): number => {
    let f = 0
    for (const v of variants(t)) f = Math.max(f, df.get(v) ?? 0)
    return Math.log((N + 1) / (f + 1)) + 0.1
  }

  const covers = (vars: Set<string>, t: string) => variants(t).some(v => vars.has(v))

  // IDF-weighted share of `text`'s tokens that the existing post covers.
  const coverage = (text: string, vars: Set<string>): number => {
    const toks = [...new Set(tokens(text))]
    if (toks.length === 0) return 0
    let hit = 0, total = 0
    for (const t of toks) {
      const w = idf(t)
      total += w
      if (covers(vars, t)) hit += w
    }
    return total > 0 ? hit / total : 0
  }

  return {
    // Score each post against a new article (keyword + intended title).
    // The keyword is the topic; the title adds the angle. Coverage is
    // measured against the existing post's title AND slug (slugs often
    // keep the original keyword after a title is re-hooked).
    //
    // The title only counts once the keyword already partly overlaps.
    // Otherwise two different topics written from the same title template
    // ("Clever Dripper: איזה פולי קפה יעשו לך..." vs "AeroPress: איזה פולי
    // קפה יעשו לך...") would collide on the template words alone.
    score(keyword: string, title: string): Array<{ post: IndexedPost; score: number }> {
      return docs.map((d) => {
        const both   = new Set([...d.titleVars, ...d.slugVars])
        const kwCov  = coverage(keyword, both)
        const ttlCov = title && kwCov >= TITLE_GATE ? coverage(title, both) : 0
        return { post: d.post, score: Math.max(kwCov, ttlCov) }
      })
    },
  }
}

// Pure conflict finder. Exported for tests.
export function findConflicts(
  keyword: string,
  title: string,
  posts: IndexedPost[],
  opts: { threshold?: number; excludeIds?: number[] } = {},
): CannibalConflict[] {
  const threshold = opts.threshold ?? OVERLAP_MIN
  const exclude   = new Set(opts.excludeIds ?? [])
  return buildMatcher(posts)
    .score(keyword, title)
    .filter(r => !exclude.has(r.post.id) && r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(r => ({ ...r.post, score: Math.round(r.score * 100) / 100 }))
}

// Every post on the site (all non-trash statuses), paged. Cached for the
// life of the worker so a plan with several articles costs one fetch.
let indexCache: { at: number; posts: IndexedPost[] } | null = null
const INDEX_TTL_MS = 5 * 60_000

async function fetchPostIndex(): Promise<{ posts: IndexedPost[]; checked: boolean; reason?: string }> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return { posts: indexCache.posts, checked: true }
  }
  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    console.warn('[cannibalization] WP credentials missing; skipping (fail-open)')
    return { posts: [], checked: false, reason: 'WP credentials missing' }
  }
  const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
  const stripHtml = (s: unknown) => typeof s === 'string'
    ? s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#8211;|&#8212;/g, ' ').replace(/\s+/g, ' ').trim()
    : ''

  const posts: IndexedPost[] = []
  try {
    for (let page = 1; page <= 20; page++) {
      // context=edit + explicit status list surfaces drafts/pending/future/
      // private (an anon GET only sees 'publish'). Trash is excluded, so a
      // post the admin deletes stops blocking its topic.
      const params = new URLSearchParams({
        status:   'publish,draft,pending,future,private',
        per_page: '100',
        page:     String(page),
        _fields:  'id,title,slug,status,link',
        context:  'edit',
      })
      const r = await fetch(`${WP_URL}/wp-json/wp/v2/posts?${params.toString()}`, {
        headers: { Authorization: auth },
      })
      if (r.status === 400 && page > 1) break   // WP: page past the end
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        console.warn(`[cannibalization] WP index HTTP ${r.status}: ${body.slice(0, 200)} (fail-open)`)
        return { posts: [], checked: false, reason: `WP index HTTP ${r.status}` }
      }
      const arr = await r.json() as Array<{ id?: number; title?: { raw?: string; rendered?: string }; slug?: string; status?: string; link?: string }>
      for (const p of Array.isArray(arr) ? arr : []) {
        if (typeof p.id !== 'number') continue
        posts.push({
          id:     p.id,
          title:  stripHtml(p.title?.raw ?? p.title?.rendered ?? ''),
          status: String(p.status ?? 'unknown'),
          link:   String(p.link ?? ''),
          slug:   String(p.slug ?? ''),
        })
      }
      const totalPages = Number(r.headers.get('x-wp-totalpages') ?? '1')
      if (!Array.isArray(arr) || arr.length < 100 || page >= totalPages) break
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[cannibalization] WP index threw: ${msg} (fail-open)`)
    return { posts: [], checked: false, reason: msg }
  }

  indexCache = { at: Date.now(), posts }
  return { posts, checked: true }
}

async function check(
  keyword: string,
  title: string,
  excludeIds: number[] = [],
): Promise<CannibalizationResult> {
  if (!(keyword ?? '').trim() && !(title ?? '').trim()) {
    return { conflicts: [], checked: false, reason: 'empty keyword' }
  }
  const { posts, checked, reason } = await fetchPostIndex()
  if (!checked) return { conflicts: [], checked: false, reason }
  return { conflicts: findConflicts(keyword, title, posts, { excludeIds }), checked: true }
}

// WRITER gate (claim time). Same matcher as the pre-queue gate so a task
// queued by a path that skipped the pre-queue gate is still caught here.
// `excludeIds` lets a rewrite brief ignore the post it is replacing.
// Never throws — callers fail open on checked=false.
export function checkKeywordCannibalization(
  keyword: string,
  title: string,
  excludeIds: number[] = [],
): Promise<CannibalizationResult> {
  return check(keyword, title, excludeIds)
}

// PRE-QUEUE gate (mission worker + orchestrator, BEFORE queuing a
// text_generation task). Never throws — callers fail open on checked=false.
export function checkCannibalizationForQueue(
  keyword: string,
  title: string,
  excludeIds: number[] = [],
): Promise<CannibalizationResult> {
  return check(keyword, title, excludeIds)
}

// Pick which remediation to recommend. A LIVE (published) conflict is the
// canonical URL — fold the new angle into it. If every conflict is still a
// draft/pending/future, the duplicate never went live — delete it (and set
// up a redirect if it ever had a URL) rather than consolidate.
function recommendationFor(conflicts: CannibalConflict[]): string {
  return conflicts.some((c) => c.status === 'publish')
    ? 'consolidate into existing post'
    : 'delete draft and redirect'
}

// Build the dynamic_experiment brief the mission worker / orchestrator
// inserts INSTEAD of the blocked text_generation task. Shape matches the
// scout-tick / health-watchdog dynamic_experiment pattern (description +
// approval_required + details) so it renders in the pending-approvals queue
// the chat agent already surfaces.
export function buildCannibalizationConflictBrief(args: {
  keyword:   string
  title:     string
  conflicts: CannibalConflict[]
}): DynamicExperimentBrief {
  const { keyword, title, conflicts } = args
  const top            = conflicts[0]
  const recommendation = recommendationFor(conflicts)
  const list = conflicts
    .map((c) => `#${c.id} "${c.title}" [${c.status}] ${c.link}`)
    .join(' ; ')

  return {
    description:
      `Keyword-cannibalization conflict — did NOT queue a new article for ` +
      `"${keyword}"${title && title !== keyword ? ` (title "${title}")` : ''}. ` +
      `${conflicts.length} existing post(s) already cover this topic: ${list}. ` +
      `Recommendation: ${recommendation}. Queuing was skipped to avoid splitting ` +
      `ranking signals across near-duplicate URLs — approve after you dedupe/redirect, ` +
      `or cancel this proposal.`,
    approval_required: true,
    details: {
      conflict_subtype:        'cannibalization_conflict',
      intended_keyword:        keyword,
      intended_title:          title || keyword,
      conflicting_post_url:    top?.link ?? '',
      conflicting_post_status: top?.status ?? '',
      recommendation,
      conflicting_posts: conflicts.map((c) => ({
        id:     c.id,
        title:  c.title,
        status: c.status,
        url:    c.link,
        slug:   c.slug ?? '',
      })),
    },
  }
}
