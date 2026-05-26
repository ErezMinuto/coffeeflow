// Minuto SEO Agent — Visual Worker.
//
// Cron-polled (every 2 min via pg_cron) worker that processes one
// `visual_generation` task per invocation. Reads `brief_data`
// (VisualGenerationBrief), routes by `render_mode` to the existing
// image-generation edge functions, then — if `destination='blog_banner'`
// and the parent text task has produced a `wp_post_id` — attaches the
// rendered image to the WP draft as its featured image.
//
// Architectural decisions:
//
// 1. ONE TASK PER INVOCATION. Same lock-mechanic semantics as the
//    writer worker. Idle if no eligible row.
//
// 2. WE DO NOT REIMPLEMENT IMAGE GENERATION. Routes to:
//      render_mode='no_bag'   → visual-test  with use_reference:false
//      render_mode='bag_hero' → vertex-imagen-edit with render_mode:'bag_hero'
//    These functions own the locked Minuto visual identity (style anchor,
//    Strada X / Coffee-Tech roaster references, Scene Director rewrite
//    from PR #88). We pass scene_brief through faithfully — NEVER bypass
//    the Scene Director.
//
// 3. FEATURED-IMAGE ATTACH. The existing blog-publish edge function only
//    supports attaching a featured image AT POST CREATION TIME (one-shot
//    POST /wp/v2/posts with featured_media set). Our flow is split: the
//    writer task creates the WP post first, the visual task arrives
//    later. So we cannot reuse blog-publish for the attach. Instead we
//    follow the SAME two-step WP REST pattern blog-publish uses for
//    media creation:
//      a) POST /wp/v2/media with the image bytes → media_id
//      b) POST /wp/v2/posts/{id} with featured_media = media_id  ← UPDATE
//    Auth and headers are byte-identical (Basic auth on
//    WP_BLOG_POST_USER_NAME : WP_BLOG_POST_PASS, same env vars). If the
//    parent text task hasn't completed yet (no wp_post_id), we release
//    the row back to 'pending' and re-try on the next tick — the cron
//    will pick it up after the writer finishes.
//
// 4. ON FAILURE: linear retry via markTaskFailed (same semantics as
//    Session A's writer worker). attempts>=max_attempts flips to 'failed'.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  createSupabase,
  claimNextTask,
  markTaskCompleted,
  markTaskFailed,
} from '../seo-agent/db.ts'
import type { SeoTaskRow, VisualGenerationBrief } from '../seo-agent/types.ts'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY')!
// Same env-var pair blog-publish uses. The featured-image attach reuses
// the same WP Application Password — no new credentials to manage.
const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const workerId = `visual-${crypto.randomUUID().slice(0, 8)}`
  const supabase = createSupabase()

  // ── 1. Claim one task ────────────────────────────────────────────────
  let task: SeoTaskRow | null
  try {
    task = await claimNextTask(supabase, 'visual_generation', workerId)
  } catch (e: any) {
    console.error(`[seo-worker-visual] ${workerId} claim failed: ${e?.message ?? e}`)
    return jsonResponse({ processed: 0, worker_id: workerId, error: e?.message ?? String(e) }, 500)
  }
  if (!task) {
    return jsonResponse({ processed: 0, worker_id: workerId })
  }
  console.log(`[seo-worker-visual] ${workerId} claimed task ${task.id} attempt=${task.attempts}`)

  // ── 2. Parse + validate brief ────────────────────────────────────────
  const brief = task.brief_data as VisualGenerationBrief
  if (!brief || typeof brief.scene_brief !== 'string' || !brief.scene_brief.trim()) {
    await safeMarkFailed(supabase, task, 'brief_data.scene_brief is required (non-empty)', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'brief invalid' })
  }
  const aspect      = brief.aspect      ?? 'feed_square'
  const renderMode  = brief.render_mode ?? 'bag_hero'
  const destination = brief.destination ?? 'blog_banner'
  if (renderMode !== 'no_bag' && renderMode !== 'bag_hero') {
    await safeMarkFailed(supabase, task, `unknown render_mode "${renderMode}"`, true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'unknown render_mode' })
  }
  if (renderMode === 'bag_hero' && !brief.product_name?.trim()) {
    // vertex-imagen-edit requires one of reference_image_url / product_id /
    // product_name. The orchestrator's VisualGenerationBrief only exposes
    // product_name, so it must be set for bag_hero. Permanent failure —
    // the brief is malformed, no point retrying.
    await safeMarkFailed(supabase, task, 'bag_hero render_mode requires product_name in brief_data', true)
    return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'product_name missing for bag_hero' })
  }

  // ── 3. Resolve parent (only required for blog_banner attach) ─────────
  // For blog_banner: we need the WP post_id from the parent text task's
  // result_data. If parent isn't completed yet, release this row back to
  // 'pending' so the next cron tick can pick it up after the writer
  // finishes. parent_task_id is enforced via claimNextTask's depends_on
  // check ONLY when the orchestrator wires depends_on; today it wires
  // parent_task_id without depends_on (see seo-orchestrator/index.ts
  // around the parent_task_index → parent_task_id translation), so we
  // do the parent-readiness check inline here.
  let parentWpPostId: number | null = null
  let parentEditUrl:  string | null = null
  if (task.parent_task_id) {
    const { data: parent, error: parentErr } = await supabase
      .from('seo_tasks')
      .select('status, result_data')
      .eq('id', task.parent_task_id)
      .maybeSingle()
    if (parentErr) {
      // Treat as transient — retry next tick.
      await safeMarkFailed(supabase, task, `parent lookup failed: ${parentErr.message}`, false)
      return jsonResponse({ processed: 1, worker_id: workerId, task_id: task.id, ok: false, error: 'parent lookup error' })
    }
    if (destination === 'blog_banner') {
      if (!parent || parent.status !== 'completed') {
        // Writer task hasn't finished. Re-queue (status='pending',
        // attempts decremented? — markTaskFailed-transient does NOT
        // decrement, so attempts keeps climbing. With max_attempts=3
        // and a 2-min cron, that's a 6-min window for the writer to
        // finish before this row permanently fails. Most writer runs
        // finish in <60s, so this is comfortable. If it becomes a
        // problem, bump max_attempts on visual tasks specifically.)
        await safeMarkFailed(
          supabase,
          task,
          `parent text task ${task.parent_task_id} not yet completed (status=${parent?.status ?? 'missing'})`,
          false,
        )
        return jsonResponse({
          processed: 1,
          worker_id: workerId,
          task_id:   task.id,
          ok:        false,
          retry:     true,
          reason:    'parent_not_ready',
        })
      }
      const result = (parent.result_data ?? {}) as { wp_post_id?: number; edit_url?: string }
      if (typeof result.wp_post_id === 'number' && Number.isFinite(result.wp_post_id)) {
        parentWpPostId = result.wp_post_id
        parentEditUrl  = result.edit_url ?? null
      } else {
        // Parent completed but didn't expose wp_post_id — render the
        // image anyway, just skip the attach with a warning. The
        // image_url ends up in our result_data so a human can attach
        // manually from the admin UI later.
        console.warn(`[seo-worker-visual] ${workerId} parent ${task.parent_task_id} completed but result_data has no wp_post_id`)
      }
    }
  } else if (destination === 'blog_banner') {
    // blog_banner with no parent — render anyway, skip the attach.
    // Logged so a human can decide whether to attach manually.
    console.warn(`[seo-worker-visual] ${workerId} blog_banner task has no parent_task_id; will render but cannot attach`)
  }

  // ── 4. Route to render function ──────────────────────────────────────
  const renderFunction = renderMode === 'no_bag' ? 'visual-test' : 'vertex-imagen-edit'
  let imageUrl: string
  let renderResponse: Record<string, unknown> = {}
  try {
    if (renderMode === 'no_bag') {
      // visual-test handles 'no_bag' by skipping the bag reference
      // entirely (use_reference:false short-circuits the bag-resolution
      // block at the top of its serve() handler). Scene brief passes
      // through verbatim to Gemini.
      const res = await fetch(`${SUPABASE_URL}/functions/v1/visual-test`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
        body: JSON.stringify({
          scene_brief:   brief.scene_brief,
          aspect,
          use_reference: false,
        }),
      })
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok || !json.url || typeof json.url !== 'string') {
        throw new Error(`visual-test HTTP ${res.status}: ${(json.error as string) ?? JSON.stringify(json).slice(0, 300)}`)
      }
      imageUrl = json.url
      renderResponse = json
    } else {
      // bag_hero: hand off to vertex-imagen-edit with render_mode set.
      // The Scene Director rewrite (PR #88) faithfully translates the
      // scene_brief into the empty-surface Stage 1 prompt; we MUST NOT
      // bypass it (no skip_director flag here). product_name is passed
      // through so woo_products lookup can resolve the byte-perfect bag.
      const res = await fetch(`${SUPABASE_URL}/functions/v1/vertex-imagen-edit`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
        body: JSON.stringify({
          scene_brief:  brief.scene_brief,
          aspect,
          render_mode:  'bag_hero',
          product_name: brief.product_name,
        }),
      })
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok || !json.url || typeof json.url !== 'string') {
        throw new Error(`vertex-imagen-edit HTTP ${res.status}: ${(json.error as string) ?? JSON.stringify(json).slice(0, 300)}`)
      }
      imageUrl = json.url
      renderResponse = json
    }
    console.log(`[seo-worker-visual] ${workerId} rendered via ${renderFunction}: ${imageUrl}`)
  } catch (e: any) {
    const msg = `render (${renderFunction}) failed: ${e?.message ?? e}`
    const permanently = task.attempts >= task.max_attempts
    await safeMarkFailed(supabase, task, msg, permanently)
    return jsonResponse({
      processed: 1,
      worker_id: workerId,
      task_id:   task.id,
      ok:        false,
      error:     msg,
      permanent: permanently,
    }, 500)
  }

  // ── 5. Attach to WP draft (blog_banner only, when parent has wp_post_id)
  // Two-step WP REST flow — same auth + headers blog-publish uses for
  // the create-with-featured-image case. Step (a) uploads the image
  // bytes to /wp/v2/media, step (b) PUTs the new media_id onto the
  // existing post. We don't reuse blog-publish here because it only
  // supports POSTing a NEW post; for an existing post we need the
  // /wp/v2/posts/{id} update endpoint.
  let attachedMediaId:  number | null = null
  let attachError:      string | null = null
  if (destination === 'blog_banner' && parentWpPostId) {
    if (!WP_USERNAME || !WP_APP_PASSWORD) {
      attachError = 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not configured'
      console.warn(`[seo-worker-visual] ${workerId} ${attachError}`)
    } else {
      try {
        attachedMediaId = await attachFeaturedImage({
          wpUrl:       WP_URL,
          username:    WP_USERNAME,
          appPassword: WP_APP_PASSWORD,
          postId:      parentWpPostId,
          imageUrl,
          titleHint:   (renderResponse.scene_brief as string)?.slice(0, 60) ?? 'seo banner',
        })
        console.log(`[seo-worker-visual] ${workerId} attached media_id=${attachedMediaId} to post_id=${parentWpPostId}`)
      } catch (e: any) {
        attachError = e?.message ?? String(e)
        console.warn(`[seo-worker-visual] ${workerId} attach failed: ${attachError}`)
      }
    }
  }

  // ── 6. Mark completed ────────────────────────────────────────────────
  try {
    await markTaskCompleted(supabase, task.id, {
      image_url:        imageUrl,
      render_function:  renderFunction,
      render_mode:      renderMode,
      destination,
      aspect,
      wp_post_id:       parentWpPostId,
      wp_edit_url:      parentEditUrl,
      attached_media_id: attachedMediaId,
      attach_error:     attachError,
      render_response:  pickRenderSummary(renderResponse),
    })
  } catch (e: any) {
    console.error(`[seo-worker-visual] ${workerId} markTaskCompleted failed: ${e?.message ?? e}`)
    return jsonResponse({
      processed: 1,
      worker_id: workerId,
      task_id:   task.id,
      ok:        false,
      error:     `image_url=${imageUrl} (render succeeded) but result write failed: ${e?.message ?? e}`,
    }, 500)
  }

  return jsonResponse({
    processed:        1,
    worker_id:        workerId,
    task_id:          task.id,
    ok:               true,
    image_url:        imageUrl,
    render_function:  renderFunction,
    render_mode:      renderMode,
    destination,
    wp_post_id:       parentWpPostId,
    attached_media_id: attachedMediaId,
    attach_error:     attachError,
  })
})

// ─────────────────────────────────────────────────────────────────────────
// WP featured-image attach. Two REST calls:
//   1. POST /wp/v2/media — upload the rendered image bytes, get media_id
//   2. POST /wp/v2/posts/{id} — update with featured_media = media_id
// Auth + filename-sanitization pattern identical to blog-publish/uploadMedia.
// ─────────────────────────────────────────────────────────────────────────
async function attachFeaturedImage(args: {
  wpUrl:        string
  username:     string
  appPassword:  string
  postId:       number
  imageUrl:     string
  titleHint:    string
}): Promise<number> {
  const auth = 'Basic ' + btoa(`${args.username}:${args.appPassword}`)

  // 1. Fetch the rendered image bytes from Supabase Storage.
  const imgRes = await fetch(args.imageUrl)
  if (!imgRes.ok) throw new Error(`image fetch ${imgRes.status} from ${args.imageUrl}`)
  const mime  = imgRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
  const bytes = new Uint8Array(await imgRes.arrayBuffer())

  // 2. Sanitize filename — must be pure ASCII (Content-Disposition is a
  //    ByteString). Pattern lifted verbatim from blog-publish/uploadMedia.
  const ext      = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
  const safeName = args.titleHint.toLowerCase()
    .replace(/[^\x20-\x7e]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'seo-banner'

  // 3. Upload to /wp/v2/media.
  const mediaRes = await fetch(`${args.wpUrl}/wp-json/wp/v2/media`, {
    method:  'POST',
    headers: {
      Authorization:        auth,
      'Content-Type':       mime,
      'Content-Disposition': `attachment; filename="${safeName}.${ext}"`,
    },
    body: bytes,
  })
  if (!mediaRes.ok) {
    const errText = await mediaRes.text().catch(() => '')
    throw new Error(`WP media ${mediaRes.status}: ${errText.slice(0, 300)}`)
  }
  const mediaJson = await mediaRes.json() as { id?: number }
  if (typeof mediaJson.id !== 'number') {
    throw new Error(`WP media returned no id: ${JSON.stringify(mediaJson).slice(0, 200)}`)
  }
  const mediaId = mediaJson.id

  // 4. Update the existing post with featured_media. WP REST uses POST
  //    (not PUT) on the /posts/{id} endpoint for partial updates.
  const postRes = await fetch(`${args.wpUrl}/wp-json/wp/v2/posts/${encodeURIComponent(String(args.postId))}`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ featured_media: mediaId }),
  })
  if (!postRes.ok) {
    const errText = await postRes.text().catch(() => '')
    throw new Error(`WP post update ${postRes.status}: ${errText.slice(0, 300)}`)
  }
  return mediaId
}

// markTaskFailed throws on its own DB errors; swallow so the HTTP
// response we already prepared still flushes cleanly.
async function safeMarkFailed(
  supabase: ReturnType<typeof createSupabase>,
  task: SeoTaskRow,
  msg: string,
  permanent: boolean,
): Promise<void> {
  try {
    await markTaskFailed(supabase, task.id, msg, permanent)
  } catch (e: any) {
    console.error(`[seo-worker-visual] markTaskFailed write failed: ${e?.message ?? e}`)
  }
}

// Trim render-function response to the fields useful for downstream
// debugging without bloating the result_data JSONB.
function pickRenderSummary(r: Record<string, unknown>): Record<string, unknown> {
  return {
    aspect:                r.aspect,
    ratio:                 r.ratio,
    bytes:                 r.bytes,
    pipeline:              r.pipeline,
    used_reference:        r.used_reference,
    bag_source:            r.bag_source,
    bag_url:               r.bag_url,
    visual_director_model: r.visual_director_model,
    visual_director_error: r.visual_director_error,
    surface:               r.surface,
    style_ref:             r.style_ref,
  }
}
