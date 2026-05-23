import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Orchestrator that drafts ONE blog post from the latest organic_content
// advisor report and pushes it to WordPress as status='draft'.
//
// Why a separate function:
//   The full chain (research + 3 enrichments + Sonnet blog draft + banner +
//   WP push) exceeds the 150s edge-runtime cap on a single invocation. We
//   split: marketing-advisor does research + enrichment + saves the report;
//   this function reads that report, drafts the blog, pushes to WP, and
//   PATCHes report.blog_drafted back. Each step gets its own ~150s budget.
//
// Pipeline:
//   1. Read advisor_reports row for organic_content + week_start.
//   2. Skip if no recommendations OR blog_drafted.ok already (idempotent).
//   3. Pick recs[0] — cannibalism guardrail (filterDuplicateRecommendations
//      + done-actions cross-check) already ran upstream in marketing-advisor.
//   4. POST marketing-advisor {agent:'blog_writer', ...} → markdown post.
//   5. POST marketing-advisor {agent:'blog_banner', ...} → banner URL.
//   6. POST blog-publish → WP draft.
//   7. PATCH advisor_reports.report with blog_drafted = { ok, wp_id, ... }.
//
// Body: { week_start?: string }  // ISO date (YYYY-MM-DD); defaults to
//                                 //  current week's Sunday in IL time
//                                 //  (Sunday = start of the IL business week).
//
// Response: { ok, skipped?, blog_drafted, message? }

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY')!

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405, corsHeaders)

  let body: { week_start?: string }
  try {
    body = await req.json().catch(() => ({})) as { week_start?: string }
  } catch {
    body = {}
  }

  const weekStart = body.week_start ?? currentWeekStartIL()
  const supabase  = createClient(SUPABASE_URL, SERVICE_ROLE)

  // ── 1. Read the latest organic_content report ─────────────────────────
  const { data: rows, error: readErr } = await supabase
    .from('advisor_reports')
    .select('week_start, report')
    .eq('agent_type', 'organic_content')
    .eq('week_start', weekStart)
    .limit(1)
  if (readErr) return jsonResponse({ error: `read advisor_reports: ${readErr.message}` }, 500, corsHeaders)
  if (!rows || rows.length === 0) {
    return jsonResponse({ skipped: true, message: `no organic_content report for week_start=${weekStart}` }, 200, corsHeaders)
  }
  const report = rows[0].report as any

  // ── 2. Idempotency + sanity ───────────────────────────────────────────
  if (report?.blog_drafted?.ok === true) {
    return jsonResponse({
      skipped:      true,
      message:      'blog_drafted already exists for this report (idempotent skip)',
      blog_drafted: report.blog_drafted,
    }, 200, corsHeaders)
  }
  const recs = Array.isArray(report?.google_organic_recommendations) ? report.google_organic_recommendations : []
  if (recs.length === 0) {
    return jsonResponse({ skipped: true, message: 'no google_organic_recommendations in report' }, 200, corsHeaders)
  }
  const rec = recs[0] as {
    keyword?: string;
    suggested_title?: string;
    key_points?: string[];
    current_position?: number;
    search_volume_signal?: string;
    products_to_mention?: string[];
  }
  if (!rec.keyword || !rec.suggested_title) {
    return jsonResponse({ skipped: true, message: 'top recommendation missing keyword/suggested_title' }, 200, corsHeaders)
  }

  console.log(`[blog-auto-publish] drafting for "${rec.keyword}" → "${rec.suggested_title}"`)

  // ── 3. Draft the post via marketing-advisor's blog_writer agent ───────
  const writerRes = await fetch(`${SUPABASE_URL}/functions/v1/marketing-advisor`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({
      agent:                'blog_writer',
      keyword:              rec.keyword,
      title:                rec.suggested_title,
      key_points:           Array.isArray(rec.key_points) ? rec.key_points : [],
      position:             rec.current_position,
      search_volume_signal: rec.search_volume_signal,
      products_to_mention:  rec.products_to_mention,
    }),
  })
  const writerJson = await writerRes.json().catch(() => ({})) as { title?: string; meta_description?: string; slug?: string; body?: string; error?: string }
  if (!writerRes.ok || writerJson.error || !writerJson.body || !writerJson.title) {
    return await fail(supabase, weekStart, `blog_writer failed: HTTP ${writerRes.status}: ${writerJson.error ?? '(no body)'}`, corsHeaders)
  }
  const post = {
    title:            writerJson.title,
    body:             writerJson.body,
    slug:             writerJson.slug ?? '',
    meta_description: writerJson.meta_description ?? '',
  }

  // ── 4. Generate banner (non-fatal — draft still pushed without it) ────
  let bannerUrl: string | null = null
  try {
    const bannerRes = await fetch(`${SUPABASE_URL}/functions/v1/marketing-advisor`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
      body: JSON.stringify({
        agent:               'blog_banner',
        title:               post.title,
        keyword:             rec.keyword,
        products_to_mention: rec.products_to_mention ?? [],
      }),
    })
    const bannerJson = await bannerRes.json().catch(() => ({})) as { banner_url?: string | null; error?: string }
    if (bannerRes.ok && bannerJson.banner_url) {
      bannerUrl = bannerJson.banner_url
      console.log(`[blog-auto-publish] banner: ${bannerUrl}`)
    } else {
      console.warn(`[blog-auto-publish] banner generation failed (non-fatal): HTTP ${bannerRes.status}: ${bannerJson.error ?? '(no error)'}`)
    }
  } catch (be: any) {
    console.warn(`[blog-auto-publish] banner generation threw (non-fatal): ${be?.message ?? be}`)
  }

  // ── 5. Push to WordPress as draft ─────────────────────────────────────
  const pubRes = await fetch(`${SUPABASE_URL}/functions/v1/blog-publish`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({
      title:              post.title,
      content_markdown:   post.body,
      slug:               post.slug,
      excerpt:            post.meta_description,
      featured_image_url: bannerUrl ?? undefined,
      status:             'draft',
    }),
  })
  const pubJson = await pubRes.json().catch(() => ({})) as { ok?: boolean; id?: number; link?: string; edit_url?: string; status?: string; error?: string; warnings?: string[] }
  if (!pubRes.ok || !pubJson.ok) {
    return await fail(supabase, weekStart, `blog-publish failed: HTTP ${pubRes.status}: ${pubJson.error ?? '(no error)'}`, corsHeaders, { banner_url: bannerUrl })
  }

  // ── 6. PATCH report.blog_drafted ──────────────────────────────────────
  const blogDrafted = {
    ok:         true,
    wp_id:      pubJson.id,
    edit_url:   pubJson.edit_url,
    link:       pubJson.link,
    status:     pubJson.status,
    title:      post.title,
    slug:       post.slug,
    keyword:    rec.keyword,
    banner_url: bannerUrl,
    warnings:   pubJson.warnings,
    drafted_at: new Date().toISOString(),
  }
  await patchReport(supabase, weekStart, { ...report, blog_drafted: blogDrafted })

  console.log(`[blog-auto-publish] ✓ WP draft id=${pubJson.id} edit_url=${pubJson.edit_url}`)
  return jsonResponse({ ok: true, blog_drafted: blogDrafted }, 200, corsHeaders)
})

// ─────────────────────────────────────────────────────────────────────────
async function patchReport(supabase: ReturnType<typeof createClient>, weekStart: string, newReport: unknown) {
  const { error } = await supabase
    .from('advisor_reports')
    .update({ report: newReport, updated_at: new Date().toISOString() })
    .eq('agent_type', 'organic_content')
    .eq('week_start', weekStart)
  if (error) console.error(`[blog-auto-publish] PATCH report failed: ${error.message}`)
}

async function fail(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  message: string,
  cors: Record<string, string>,
  extras: Record<string, unknown> = {},
): Promise<Response> {
  console.error(`[blog-auto-publish] ${message}`)
  const { data: rows } = await supabase
    .from('advisor_reports')
    .select('report')
    .eq('agent_type', 'organic_content')
    .eq('week_start', weekStart)
    .limit(1)
  const report = (rows?.[0]?.report as any) ?? {}
  await patchReport(supabase, weekStart, { ...report, blog_drafted: { ok: false, error: message, ...extras, drafted_at: new Date().toISOString() } })
  return jsonResponse({ ok: false, error: message, ...extras }, 200, cors)
}

// Current IL week's start (Sunday) as YYYY-MM-DD. Matches the date math
// used inside marketing-advisor/index.ts so we always read the same row.
function currentWeekStartIL(): string {
  const now    = new Date()
  // IL = UTC+2 (winter) / UTC+3 (summer). For the week-start anchor we
  // don't need DST precision — what matters is that "today in IL" maps
  // to the same Sunday as the agent computed when it wrote the report.
  // Use +2hr offset to be safe (worst case the cron fires 5min off-week
  // around 03:00 IL on a Sunday — negligible).
  const il     = new Date(now.getTime() + 2 * 3600_000)
  const dow    = il.getUTCDay()  // 0=Sun
  const sunday = new Date(il.getTime() - dow * 24 * 3600_000)
  return sunday.toISOString().slice(0, 10)
}

function jsonResponse(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
