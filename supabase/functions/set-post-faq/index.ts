/**
 * set-post-faq — write FAQ JSON to a blog POST (or any FAQ-eligible post type)
 * via the minuto-product-faq plugin's authenticated REST route.
 *
 * Why a separate function from set-product-faq:
 *  - set-product-faq writes via the WooCommerce products API (/wc/v3/products
 *    /{id} meta_data), which only exists for products.
 *  - `_minuto_faq_published` is a PROTECTED meta key (leading underscore) that
 *    the vanilla /wp/v2/posts REST API refuses to set.
 *  - The plugin (v0.4.0+) exposes POST /wp-json/minuto-faq/v1/set/{id} which
 *    writes the meta after a capability check. We call THAT here, so this one
 *    function works for posts (and products too, but products keep using
 *    set-product-faq for back-compat).
 *
 * POST body (one of post_id / post_url required):
 *   { "post_id": 80740, "faq": [{ "q": "...", "a": "..." }, ...] }
 *   { "post_url": "https://www.minuto.co.il/blog/.../", "faq": [...] }
 *
 * Optional "change": { change_id?, requested_by?, reason?, approved_by?, undo_of? }
 *   (see _shared/site_change_log.ts). Every write saves the FAQ it replaces
 *   in public.site_change_log first; if that backup can't be saved, nothing
 *   is written.
 *
 * Response on success:
 *   { "success": true, "post_id": 80740, "post_type": "post",
 *     "post_title": "...", "faq_count": 5, "change_id": "<uuid>" }
 *
 * Auth: WP Application Password via HTTP Basic (same WP_BLOG_POST_USER_NAME +
 * WP_BLOG_POST_PASS secrets blog-publish uses). The user the App Password
 * belongs to must have edit_posts + edit_post on the target.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { isServiceCaller, unauthorized } from '../_shared/service_caller.ts'
import { beginChange, finishChange, parseChangeContext } from '../_shared/site_change_log.ts'
import { readPostFaq, siteEnv } from '../_shared/site_io.ts'

const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

interface FaqItem { q: string; a: string }

function validateFaq(input: unknown): FaqItem[] {
  if (!Array.isArray(input)) return []
  const out: FaqItem[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const q = typeof rec.q === 'string' ? rec.q.trim() : ''
    const a = typeof rec.a === 'string' ? rec.a.trim() : ''
    if (!q || !a) continue
    out.push({ q, a })
  }
  return out
}

// Resolve a post URL → numeric id by its slug via the public WP REST API.
// Tries the standard posts endpoint (this function targets blog posts).
async function resolvePostIdFromUrl(url: string): Promise<number | null> {
  let slug = ''
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '')
    slug = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '')
  } catch {
    return null
  }
  if (!slug) return null
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=id`)
  if (!res.ok) return null
  const arr = await res.json().catch(() => [])
  if (Array.isArray(arr) && arr[0] && typeof arr[0].id === 'number') return arr[0].id
  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  // It writes FAQ blocks onto the live site, so only another function may call it
  // (the admin chat sends the service key).
  if (!(await isServiceCaller(req))) return unauthorized(cors)
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    return json(500, { error: 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS secrets not set in Supabase' })
  }

  let body: { post_id?: unknown; post_url?: unknown; faq?: unknown; change?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  // Resolve target post id (explicit id wins; else resolve from url).
  let postId = Number(body.post_id)
  if (!Number.isInteger(postId) || postId <= 0) {
    if (typeof body.post_url === 'string' && body.post_url.trim()) {
      const resolved = await resolvePostIdFromUrl(body.post_url.trim())
      if (!resolved) {
        return json(400, { error: `Could not resolve post_url to a post id (slug not found): ${body.post_url}` })
      }
      postId = resolved
    } else {
      return json(400, { error: 'post_id (positive integer) or post_url is required' })
    }
  }

  const faq = validateFaq(body.faq)
  // Note: empty faq is allowed — the plugin treats it as an explicit clear.

  // Back up the FAQ this write replaces. No backup → no write.
  const ctx = parseChangeContext(body.change)
  const env = siteEnv({ wpUrl: WP_URL, wpUser: WP_USERNAME, wpPass: WP_APP_PASSWORD })
  let changeId: string
  try {
    const current = await readPostFaq(env, postId)
    changeId = await beginChange({
      target_type:   'post_faq',
      target_id:     postId,
      target_url:    typeof body.post_url === 'string' ? body.post_url.trim() : null,
      before:        current.faq,
      before_source: current.source,
      after:         faq,
      source_fn:     'set-post-faq',
      ctx,
    })
  } catch (e) {
    return json(502, { error: `Not written: could not back up the current FAQ first (${(e as Error).message})` })
  }
  const fail = async (status: number, error: string) => {
    await finishChange(changeId, { ok: false, error })
    return json(status, { error, change_id: changeId })
  }

  const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
  const routeUrl = `${WP_URL}/wp-json/minuto-faq/v1/set/${postId}`

  const wpRes = await fetch(routeUrl, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    redirect: 'manual',
    body:    JSON.stringify({ faq }),
  })

  // A redirect means WOO_URL isn't canonical (www) — body would be stripped.
  if (wpRes.status >= 300 && wpRes.status < 400) {
    const loc = wpRes.headers.get('location') || '(none)'
    return await fail(502, `WP returned redirect ${wpRes.status} → ${loc}. WOO_URL must be canonical (https://www.minuto.co.il, with www).`)
  }

  let wpBody: Record<string, unknown>
  try {
    wpBody = await wpRes.json()
  } catch {
    const text = await wpRes.text().catch(() => '')
    return await fail(502, `WP returned non-JSON (status ${wpRes.status}): ${text.slice(0, 300)}`)
  }

  if (!wpRes.ok || wpBody.success !== true) {
    // Plugin route not found (404) usually means the plugin isn't v0.4.0+.
    const hint = wpRes.status === 404
      ? ' (route not found — is minuto-product-faq v0.4.0+ active?)'
      : ''
    return await fail(502, `WP FAQ write failed (status ${wpRes.status})${hint}: ${JSON.stringify(wpBody).slice(0, 400)}`)
  }

  // Record the FAQ as WordPress stored it (the plugin sanitizes text), so a
  // later undo compares like with like. Only the plugin route returns the
  // stored value; a cached live page would not, so it is not used here.
  let stored: unknown = undefined
  try {
    const now = await readPostFaq(env, postId)
    if (now.source === 'wp_plugin') stored = now.faq
  } catch { /* keep `after` as sent */ }
  const logged = await finishChange(changeId, { ok: true, after: stored })

  return json(200, {
    success:    true,
    change_id:  changeId,
    ...(logged.logged ? {} : { change_log_warning: logged.error }),
    post_id:    wpBody.post_id ?? postId,
    post_type:  wpBody.post_type ?? null,
    post_title: wpBody.post_title ?? null,
    faq_count:  wpBody.faq_count ?? faq.length,
    cleared:    wpBody.cleared === true,
  })
})
