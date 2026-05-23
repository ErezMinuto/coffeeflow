import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { marked } from 'https://esm.sh/marked@12.0.0'

// Push an AI-drafted blog post to WordPress as a DRAFT (status='draft').
// Manual publish stays the approval gate — owner reviews in WP admin,
// hits Publish. Same pattern as IG.
//
// Auth: WP Application Password via HTTP Basic. WP_BLOG_POST_USER_NAME +
// WP_BLOG_POST_PASS must be set as Supabase secrets. The user the App
// Password is tied to needs an Author/Editor role (Subscriber/Customer
// hits 401 'rest_cannot_create').
//
// Body:
//   {
//     title:               string            // H1 / post title
//     content_markdown:    string            // Markdown body (we convert → HTML)
//     slug?:               string            // URL slug; WP derives one if omitted
//     excerpt?:            string            // Short blurb (meta description)
//     featured_image_url?: string            // Optional hero image; we fetch + upload to /media first
//     status?:             'draft' | 'pending' | 'publish'  // Default 'draft' (we never auto-publish from here)
//   }
//
// Response: { ok, id, link, edit_url, status, featured_media?, warnings? }
// Errors return 4xx/5xx with { error, ... } so the caller can log + continue.

const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

interface BlogPublishRequest {
  title:               string
  content_markdown:    string
  slug?:               string
  excerpt?:            string
  featured_image_url?: string
  status?:             'draft' | 'pending' | 'publish'
}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405, corsHeaders)

  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    return jsonResponse({ error: 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS secrets not set in Supabase' }, 500, corsHeaders)
  }

  let body: BlogPublishRequest & { mode?: string }
  try {
    body = await req.json() as BlogPublishRequest & { mode?: string }
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400, corsHeaders)
  }

  // Diagnostic: GET /wp/v2/posts/{id} with auth — drafts are private so
  // anon can't see them; this lets the agent confirm a post exists +
  // has the expected featured_media. Pass {mode:'get_post', id: 12345}.
  if (body.mode === 'get_post' && (body as any).id) {
    const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
    const r = await fetch(`${WP_URL}/wp-json/wp/v2/posts/${encodeURIComponent(String((body as any).id))}?context=edit&status=any`, {
      headers: { Authorization: auth },
    })
    const j = await r.json().catch(async () => await r.text())
    return jsonResponse({
      http_status: r.status,
      id:          (j as any)?.id,
      status:      (j as any)?.status,
      featured_media: (j as any)?.featured_media,
      title:       (j as any)?.title?.rendered ?? (j as any)?.title?.raw,
    }, 200, corsHeaders)
  }

  // Diagnostic: GET /wp/v2/users/me — returns which WP user the Basic
  // Auth resolves to + that user's roles. Lets us confirm the App
  // Password is tied to the right (post-creating) account without
  // attempting a real draft. Safe to call any time.
  if (body.mode === 'whoami') {
    const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
    const r = await fetch(`${WP_URL}/wp-json/wp/v2/users/me?context=edit`, {
      headers: { Authorization: auth },
    })
    const text = await r.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = text.slice(0, 500) }
    // Safe shape of the password — length + first/last 2 chars + whether
    // it has trailing/leading whitespace. Catches paste errors without
    // exposing the value. Spaces *inside* the string are fine (WP App
    // Passwords are shown with spaces every 4 chars; WP strips them
    // server-side either way).
    const pwLen = WP_APP_PASSWORD.length
    const pwShape = pwLen === 0
      ? '(empty)'
      : `${pwLen}c ${JSON.stringify(WP_APP_PASSWORD.slice(0, 2))}…${JSON.stringify(WP_APP_PASSWORD.slice(-2))}`
            + (WP_APP_PASSWORD !== WP_APP_PASSWORD.trim() ? ' ⚠ leading/trailing whitespace!' : '')
    return jsonResponse({
      http_status:  r.status,
      wp_username_secret_was_set_to: WP_USERNAME,
      wp_username_shape: `${WP_USERNAME.length}c` + (WP_USERNAME !== WP_USERNAME.trim() ? ' ⚠ leading/trailing whitespace!' : ''),
      wp_password_shape: pwShape,
      response: parsed,
    }, 200, corsHeaders)
  }

  if (!body.title?.trim() || !body.content_markdown?.trim()) {
    return jsonResponse({ error: 'title and content_markdown are required (non-empty)' }, 400, corsHeaders)
  }

  const status   = body.status ?? 'draft'
  const auth     = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
  const warnings: string[] = []

  // ── Optional: upload featured image to /wp/v2/media ───────────────────
  // WP REST requires the image be uploaded as a media object FIRST and
  // referenced by its numeric ID on the post. We fetch the URL the
  // caller supplied (typically a marketing-bucket banner), then stream
  // it into WP. If anything fails, we just skip the featured image —
  // the draft still goes through, owner can attach manually.
  let featuredMedia: number | undefined
  if (body.featured_image_url) {
    try {
      featuredMedia = await uploadMedia(body.featured_image_url, body.title, auth)
    } catch (e: any) {
      warnings.push(`featured image upload failed: ${e?.message ?? e}`)
      console.warn(`[blog-publish] featured image upload failed: ${e?.message ?? e}`)
    }
  }

  // ── Convert markdown → HTML for WP `content` field ────────────────────
  // WP doesn't render markdown natively (without a plugin). marked is
  // small, well-tested, GFM-friendly, handles Hebrew RTL correctly
  // because it's just plain HTML conversion — direction is set by the
  // theme's existing RTL CSS.
  const contentHtml = marked.parse(body.content_markdown, { async: false }) as string

  // ── Create the post ───────────────────────────────────────────────────
  const postBody: Record<string, unknown> = {
    title:   body.title.trim(),
    content: contentHtml,
    status,
  }
  if (body.slug?.trim())    postBody.slug    = body.slug.trim()
  if (body.excerpt?.trim()) postBody.excerpt = body.excerpt.trim()
  if (featuredMedia)        postBody.featured_media = featuredMedia

  const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(postBody),
  })
  const text = await res.text()
  if (!res.ok) {
    return jsonResponse({
      error:       `WP ${res.status}: ${text.slice(0, 500)}`,
      featured_media: featuredMedia,
      warnings,
    }, res.status, corsHeaders)
  }

  let post: any
  try { post = JSON.parse(text) } catch {
    return jsonResponse({ error: `WP returned non-JSON body: ${text.slice(0, 300)}` }, 500, corsHeaders)
  }

  return jsonResponse({
    ok:       true,
    id:       post.id,
    link:     post.link,                                  // public permalink (works only when published)
    edit_url: `${WP_URL}/wp-admin/post.php?post=${post.id}&action=edit`,
    status:   post.status,
    featured_media: featuredMedia,
    warnings: warnings.length > 0 ? warnings : undefined,
  }, 200, corsHeaders)
})

// ─────────────────────────────────────────────────────────────────────────
// /wp-json/wp/v2/media uploader. WP expects the raw image bytes in the
// body with a Content-Disposition filename. We let the caller pass a
// URL (typical: a Supabase storage public URL from generateBlogBanner)
// and re-stream the bytes into WP.
// ─────────────────────────────────────────────────────────────────────────
async function uploadMedia(imageUrl: string, postTitle: string, auth: string): Promise<number> {
  const imgRes = await fetch(imageUrl)
  if (!imgRes.ok) throw new Error(`source image fetch ${imgRes.status}`)
  const mime  = imgRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
  const bytes = new Uint8Array(await imgRes.arrayBuffer())

  // Filename derived from title — must be PURE ASCII because the value
  // ends up in a Content-Disposition HTTP header and fetch() rejects
  // non-ByteString headers. We strip everything non-ASCII (Hebrew titles
  // were producing 'Argument 2 is not a valid ByteString' on every push).
  // WP shows the post's real (Hebrew) title in the media library anyway,
  // independent of the uploaded filename.
  const ext      = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
  const safeName = postTitle.toLowerCase()
    .replace(/[^\x20-\x7e]+/g, '')  // drop all non-printable-ASCII (incl Hebrew)
    .replace(/[^a-z0-9]+/g, '-')    // squash everything else to dashes
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'blog-banner'

  const res = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
    method:  'POST',
    headers: {
      Authorization:        auth,
      'Content-Type':       mime,
      'Content-Disposition': `attachment; filename="${safeName}.${ext}"`,
    },
    body: bytes,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`WP media ${res.status}: ${errText.slice(0, 300)}`)
  }
  const json = await res.json() as { id?: number }
  if (typeof json.id !== 'number') throw new Error(`WP media returned no id: ${JSON.stringify(json).slice(0, 200)}`)
  return json.id
}

function jsonResponse(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
