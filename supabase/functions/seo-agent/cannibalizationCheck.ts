// Minuto SEO Agent — pre-flight keyword-cannibalization check.
//
// Before a text_generation task actually drafts an article, we ask the
// WP REST API whether an existing post (ANY status: draft, publish,
// pending, future, private) already covers the same keyword/topic.
// Publishing a second near-duplicate splits ranking signals between two
// URLs (cannibalization) — so if a conflict exists the writer worker
// FAILS the task and surfaces the conflicting post(s) to the admin,
// instead of silently drafting a duplicate.
//
// This module now covers BOTH halves of the belt-and-suspenders check:
//
//   • checkKeywordCannibalization() — the PIPELINE-LAYER half. The writer
//     worker calls it at claim time; on a conflict it fails the task and
//     hands the admin the conflicting URLs.
//
//   • checkCannibalizationForQueue() + buildCannibalizationConflictBrief()
//     — the PRE-QUEUE gate. The mission worker and orchestrator call it
//     immediately BEFORE queuing a text_generation task. On a conflict
//     they DON'T queue the task at all; instead they insert a
//     dynamic_experiment (subtype: cannibalization_conflict) with
//     approval_required so the conflict surfaces in Erez's pending-
//     approvals queue rather than as a silently-failed task. The gate
//     uses a token-intersection ratio (Hebrew stop-words stripped) so it
//     catches paraphrased/reordered titles the exact/contains check
//     might miss.
//
// Uses the same WP Application Password env vars as blog-publish,
// wpPublishDetector, and the visual worker's featured-image attach:
// WP_BLOG_POST_USER_NAME + WP_BLOG_POST_PASS. WOO_URL for the base URL.

import type { DynamicExperimentBrief } from './types.ts'

const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

// Similarity threshold — configurable so we can tighten/loosen without a
// redeploy. Values:
//   'title_contains' (DEFAULT) — a returned post conflicts when its title
//        contains the keyword, the keyword contains its title, or either
//        title contains the other. Broad on purpose: catches paraphrased
//        titles (criterion 5: "avoid false negatives on paraphrased titles").
//   'keyword_exact' — a returned post conflicts only when its normalized
//        title EQUALS the normalized keyword. Narrow; fewer false positives.
const MATCH_MODE = (Deno.env.get('SEO_CANNIBAL_MATCH') ?? 'title_contains').trim() as
  | 'title_contains'
  | 'keyword_exact'

// Pre-queue gate threshold: the minimum share of the KEYWORD's tokens that
// must also appear in a candidate post's title (or slug) for that post to
// count as a cannibalization conflict. Default 0.6 per the signal's spec —
// tunable via env without a redeploy. Clamped to (0, 1].
const TOKEN_OVERLAP_MIN = (() => {
  const raw = Number(Deno.env.get('SEO_CANNIBAL_TOKEN_OVERLAP') ?? '')
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.6
})()

// Common Hebrew (+ a few English) stop-words stripped before the token
// overlap is computed, so filler words don't dilute the ratio. Kept small
// and high-frequency on purpose — this is a similarity heuristic, not a
// linguistic parser.
const STOPWORDS = new Set([
  'של', 'את', 'על', 'לפי', 'עם', 'גם', 'כל', 'או', 'כי', 'זה', 'זו', 'אלה',
  'הוא', 'היא', 'הם', 'הן', 'יש', 'אין', 'מה', 'מי', 'לא', 'כן', 'אני', 'אתה',
  'אנחנו', 'אך', 'רק', 'עד', 'אם', 'כמו',
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with',
])

export interface CannibalConflict {
  id:     number
  title:  string
  status: string
  link:   string
  slug?:  string
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

// Case-insensitive, Hebrew+English-safe normalization: lowercase, strip
// Hebrew niqqud, replace punctuation/quotes with spaces, collapse
// whitespace. Mirrors the writer worker's slugifyKeyword niqqud strip so
// "קפֶה" and "קפה" compare equal.
function normalize(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')          // strip Hebrew niqqud/te'amim
    .replace(/["'“”‘’׳״]/g, ' ')     // quotes/gershayim → space
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // any non-letter/number → space
    .replace(/\s+/g, ' ')
    .trim()
}

// Normalize → split → drop stop-words and 1-char tokens (bare Hebrew
// prefixes, stray digits). Returns the meaningful comparison tokens.
function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter(t => t.length >= 2 && !STOPWORDS.has(t))
}

// Fraction of the KEYWORD's tokens that also appear in `candidate`.
// Asymmetric on purpose: "does the existing post cover (most of) what this
// keyword is about?" A short keyword fully contained in a longer title
// scores 1.0; an unrelated title scores ~0.
function tokenOverlapRatio(keyword: string, candidate: string): number {
  const kw = tokens(keyword)
  if (kw.length === 0) return 0
  const cand = new Set(tokens(candidate))
  let hits = 0
  for (const t of kw) if (cand.has(t)) hits++
  return hits / kw.length
}

// Decide whether one existing post title conflicts with our brief
// (title_contains / keyword_exact modes — used by the writer worker's
// claim-time check).
function titleConflicts(existingTitle: string, keyword: string, targetTitle: string): boolean {
  const t  = normalize(existingTitle)
  const kw = normalize(keyword)
  if (!t || !kw) return false

  if (MATCH_MODE === 'keyword_exact') {
    return t === kw
  }

  // title_contains (default, broad):
  const tt = normalize(targetTitle)
  return (
    t.includes(kw) ||
    kw.includes(t) ||
    (tt.length > 0 && (t.includes(tt) || tt.includes(t)))
  )
}

// Query WP for posts overlapping `keyword` across every status. Returns
// the raw candidate posts (title HTML stripped). Never throws — infra
// failures resolve to {checked:false} and callers fail open. This is the
// single WP round-trip both public entry points share, so a text_generation
// task incurs at most ONE extra API call at its queuing site.
async function fetchCandidatePosts(
  keyword: string,
): Promise<{ posts: CannibalConflict[]; checked: boolean; reason?: string }> {
  const kw = (keyword ?? '').trim()
  if (!kw) return { posts: [], checked: false, reason: 'empty keyword' }

  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    console.warn('[cannibalization] WP credentials missing; skipping (fail-open)')
    return { posts: [], checked: false, reason: 'WP credentials missing' }
  }

  const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
  // context=edit + explicit status list surfaces drafts/pending/future/
  // private (an anon GET only sees 'publish'). WP accepts a comma-joined
  // status list on the collection endpoint.
  const params = new URLSearchParams({
    search:   kw,
    status:   'publish,draft,pending,future,private',
    per_page: '20',
    _fields:  'id,title,slug,status,link',
    context:  'edit',
    orderby:  'relevance',
  })

  let arr: unknown
  try {
    const r = await fetch(`${WP_URL}/wp-json/wp/v2/posts?${params.toString()}`, {
      headers: { Authorization: auth },
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      console.warn(`[cannibalization] WP search HTTP ${r.status}: ${body.slice(0, 200)} (fail-open)`)
      return { posts: [], checked: false, reason: `WP search HTTP ${r.status}` }
    }
    arr = await r.json()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[cannibalization] WP search threw: ${msg} (fail-open)`)
    return { posts: [], checked: false, reason: msg }
  }

  const stripHtml = (s: unknown) => typeof s === 'string'
    ? s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    : ''

  const posts: CannibalConflict[] = (Array.isArray(arr) ? arr : [])
    .map((p) => {
      const post = p as { id?: number; title?: { rendered?: string; raw?: string }; slug?: string; status?: string; link?: string }
      return {
        id:     typeof post.id === 'number' ? post.id : 0,
        title:  stripHtml(post.title?.raw ?? post.title?.rendered ?? ''),
        status: String(post.status ?? 'unknown'),
        link:   String(post.link ?? ''),
        slug:   String(post.slug ?? ''),
      }
    })
    .filter((c) => c.id > 0)

  return { posts, checked: true }
}

// PIPELINE-LAYER check (writer worker, claim time). Fetches candidates and
// filters by the configured title-similarity threshold. Returns the
// surviving conflicts (may be empty). Never throws.
export async function checkKeywordCannibalization(
  keyword: string,
  title: string,
): Promise<CannibalizationResult> {
  const { posts, checked, reason } = await fetchCandidatePosts(keyword)
  if (!checked) return { conflicts: [], checked: false, reason }
  const conflicts = posts.filter((c) => titleConflicts(c.title, keyword, title))
  return { conflicts, checked: true }
}

// PRE-QUEUE gate (mission worker + orchestrator, BEFORE queuing a
// text_generation task). Same WP round-trip as above, but matches by a
// token-intersection ratio: a candidate conflicts when ≥ TOKEN_OVERLAP_MIN
// of the keyword's meaningful tokens also appear in the post's title OR
// slug. Catches reordered/paraphrased titles the substring check misses.
// Never throws — callers fail open (queue anyway) when checked=false.
export async function checkCannibalizationForQueue(
  keyword: string,
  title: string,
): Promise<CannibalizationResult> {
  const { posts, checked, reason } = await fetchCandidatePosts(keyword)
  if (!checked) return { conflicts: [], checked: false, reason }
  const conflicts = posts.filter((c) => {
    const titleRatio = tokenOverlapRatio(keyword, c.title)
    const slugRatio  = tokenOverlapRatio(keyword, c.slug ?? '')
    // The intended article title is also weighed so a keyword-light brief
    // with a descriptive title still gets caught.
    const fromTitle  = title ? tokenOverlapRatio(title, c.title) : 0
    return Math.max(titleRatio, slugRatio, fromTitle) >= TOKEN_OVERLAP_MIN
  })
  return { conflicts, checked: true }
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
