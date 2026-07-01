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
// This is the pipeline-layer half of the belt-and-suspenders check the
// signal asks for: the chat agent is separately prompted to run
// list_posts(search: keyword, status: 'any') before it calls
// queue_task('text_generation'), and this module re-verifies at the
// worker so orchestrator- and mission-queued tasks are covered too.
//
// Uses the same WP Application Password env vars as blog-publish,
// wpPublishDetector, and the visual worker's featured-image attach:
// WP_BLOG_POST_USER_NAME + WP_BLOG_POST_PASS. WOO_URL for the base URL.

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

export interface CannibalConflict {
  id:     number
  title:  string
  status: string
  link:   string
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

// Decide whether one existing post title conflicts with our brief.
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

// Query WP for posts overlapping `keyword` across every status, then
// filter by the configured title-similarity threshold. Returns the
// surviving conflicts (may be empty). Never throws — infra failures
// resolve to {checked:false}, and the caller fails open.
export async function checkKeywordCannibalization(
  keyword: string,
  title: string,
): Promise<CannibalizationResult> {
  const kw = (keyword ?? '').trim()
  if (!kw) return { conflicts: [], checked: false, reason: 'empty keyword' }

  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    console.warn('[cannibalization] WP credentials missing; skipping (fail-open)')
    return { conflicts: [], checked: false, reason: 'WP credentials missing' }
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
      return { conflicts: [], checked: false, reason: `WP search HTTP ${r.status}` }
    }
    arr = await r.json()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[cannibalization] WP search threw: ${msg} (fail-open)`)
    return { conflicts: [], checked: false, reason: msg }
  }

  const stripHtml = (s: unknown) => typeof s === 'string'
    ? s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    : ''

  const conflicts: CannibalConflict[] = (Array.isArray(arr) ? arr : [])
    .map((p) => {
      const post = p as { id?: number; title?: { rendered?: string; raw?: string }; status?: string; link?: string }
      return {
        id:     typeof post.id === 'number' ? post.id : 0,
        title:  stripHtml(post.title?.raw ?? post.title?.rendered ?? ''),
        status: String(post.status ?? 'unknown'),
        link:   String(post.link ?? ''),
      }
    })
    .filter((c) => c.id > 0 && titleConflicts(c.title, kw, title))

  return { conflicts, checked: true }
}
