import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Publishes content to the Minuto Instagram Business account via the IG Graph API.
//
// IG's native publish flow is two API calls (create container → publish).  We
// expose those as two explicit actions so a human-in-the-loop preview can sit
// between them.  The dashboard's typical flow:
//
//   1. user/agent generates image + caption
//   2. dashboard POSTs {action:'prepare', type, image_url, caption}
//        → Meta validates the image and stages a container; returns creation_id
//   3. preview card renders for the user; they click Approve or Discard
//   4. on Approve, dashboard POSTs {action:'publish', creation_id}
//        → media goes live on @minuto_cafe; returns media_id + permalink
//   5. on Discard, dashboard does nothing — Meta auto-expires the container in 24h
//
// dry_run is also supported for pre-flight validation that doesn't even create
// a Meta container (e.g. catching a missing field before the round-trip).
//
// Quota: only step 4 (publish) counts against IG's 50 publishes / rolling 24h
// limit.  Container creation is free.

const GRAPH = 'https://graph.facebook.com/v23.0'
const REEL_POLL_INTERVAL_MS = 3000
const REEL_POLL_TIMEOUT_MS  = 90_000
const IG_QUOTA_LIMIT        = 50
const IG_CAPTION_MAX        = 2200

type PostType = 'feed' | 'reel' | 'carousel' | 'story'
// 'publish_now' = prepare+publish in a single invocation. Necessary because
// Meta's /me/accounts returns a fresh, container-scoped page token on each
// call, so splitting prepare and publish across two function invocations made
// the publish-side token unable to read the prepare-side container (Graph
// error code 100 / subcode 33 "Authorization Error"). Keeping the split
// actions for backwards compat and the documented preview-card flow, but no
// active caller should rely on them.
type Action   = 'prepare' | 'publish' | 'publish_now' | 'dry_run'

interface ContentFields {
  type: PostType
  caption?: string
  image_url?: string
  video_url?: string
  children?: Array<{ image_url: string }>
}

interface PublishRequest extends Partial<ContentFields> {
  action: Action
  creation_id?: string  // required for action='publish'
}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405, corsHeaders)

  try {
    const body = await req.json() as PublishRequest
    if (!body?.action) throw new Error("'action' is required (prepare|publish|dry_run)")

    const ig = await loadIgContext()

    if (body.action === 'dry_run') {
      validateContent(body as ContentFields)
      const quota = await getQuotaUsage(ig.igUserId, ig.pageToken)
      return jsonResponse({
        dry_run: true,
        page: { id: ig.pageId, name: ig.pageName },
        ig:   { id: ig.igUserId, username: ig.igUsername },
        quota,
        would_publish: { type: body.type, has_caption: !!body.caption,
                         caption_length: body.caption?.length ?? 0 },
      }, 200, corsHeaders)
    }

    if (body.action === 'prepare') {
      validateContent(body as ContentFields)
      console.log(`[meta-publish] prepare type=${body.type} image_url=${body.image_url ?? '-'} video_url=${body.video_url ?? '-'} caption_len=${body.caption?.length ?? 0}`)
      const creationId = await createContainer(ig.igUserId, ig.pageToken, body as ContentFields)
      console.log(`[meta-publish] prepare created container=${creationId}`)
      const quota = await getQuotaUsage(ig.igUserId, ig.pageToken)
      return jsonResponse({
        prepared: true,
        creation_id: creationId,
        type: body.type,
        page: { id: ig.pageId, name: ig.pageName },
        ig:   { id: ig.igUserId, username: ig.igUsername },
        // Echo the renderable preview fields so the caller can show the card
        // without keeping a parallel copy of what was sent.
        preview: {
          caption: body.caption ?? '',
          image_url: body.image_url,
          video_url: body.video_url,
          children: body.children,
        },
        quota,
      }, 200, corsHeaders)
    }

    if (body.action === 'publish') {
      if (!body.creation_id) throw new Error("'creation_id' is required for action='publish'")
      const quotaBefore = await getQuotaUsage(ig.igUserId, ig.pageToken)
      if (quotaBefore.used >= quotaBefore.limit) {
        throw new Error(`IG publish quota exhausted: ${quotaBefore.used}/${quotaBefore.limit} used in last 24h`)
      }
      // Reels can be PREPAREd while still encoding; only block on FINISHED at publish time.
      await waitForContainerReady(body.creation_id, ig.pageToken)
      const mediaId = await publishContainer(ig.igUserId, ig.pageToken, body.creation_id)
      const quotaAfter = await getQuotaUsage(ig.igUserId, ig.pageToken)
      const permalink = await fetchPermalink(mediaId, ig.pageToken)
      return jsonResponse({
        success: true,
        media_id: mediaId,
        permalink,
        ig: { id: ig.igUserId, username: ig.igUsername },
        quota_before: quotaBefore,
        quota_after:  quotaAfter,
      }, 200, corsHeaders)
    }

    if (body.action === 'publish_now') {
      validateContent(body as ContentFields)
      const quotaBefore = await getQuotaUsage(ig.igUserId, ig.pageToken)
      if (quotaBefore.used >= quotaBefore.limit) {
        throw new Error(`IG publish quota exhausted: ${quotaBefore.used}/${quotaBefore.limit} used in last 24h`)
      }
      const creationId = await createContainer(ig.igUserId, ig.pageToken, body as ContentFields)
      await waitForContainerReady(creationId, ig.pageToken)
      const mediaId = await publishContainer(ig.igUserId, ig.pageToken, creationId)
      const quotaAfter = await getQuotaUsage(ig.igUserId, ig.pageToken)
      const permalink = await fetchPermalink(mediaId, ig.pageToken)
      return jsonResponse({
        success: true,
        media_id: mediaId,
        permalink,
        creation_id: creationId,
        ig: { id: ig.igUserId, username: ig.igUsername },
        quota_before: quotaBefore,
        quota_after:  quotaAfter,
      }, 200, corsHeaders)
    }

    throw new Error(`unknown action: ${body.action}`)

  } catch (err: any) {
    console.error('[meta-publish] error:', err?.message)
    return jsonResponse({ error: err?.message ?? String(err) }, 400, corsHeaders)
  }
})

// ── helpers ──────────────────────────────────────────────────────

function jsonResponse(body: unknown, status: number, cors: Record<string,string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function validateContent(b: ContentFields) {
  if (!b.type) throw new Error('type is required (feed|reel|carousel|story)')
  if (b.type === 'feed'  && !b.image_url) throw new Error('feed requires image_url')
  if (b.type === 'reel'  && !b.video_url) throw new Error('reel requires video_url')
  if (b.type === 'story' && !b.image_url && !b.video_url) throw new Error('story requires image_url or video_url')
  if (b.type === 'carousel') {
    const n = b.children?.length ?? 0
    if (n < 2 || n > 10) throw new Error('carousel requires 2–10 children')
    for (const c of b.children!) {
      if (!c.image_url) throw new Error('every carousel child needs image_url')
    }
  }
  if ((b.caption?.length ?? 0) > IG_CAPTION_MAX) {
    throw new Error(`caption exceeds IG limit of ${IG_CAPTION_MAX} characters`)
  }
}

async function loadIgContext() {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const { data: tokenRow, error } = await supabase
    .from('oauth_tokens').select('access_token').eq('platform', 'meta').single()
  if (error || !tokenRow) throw new Error('Meta not connected — re-auth via Settings page')

  const accountsRes = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${tokenRow.access_token}`)
  const accounts = await accountsRes.json()
  if (accounts.error) throw new Error(`me/accounts: ${accounts.error.message}`)
  const pageCount = accounts.data?.length ?? 0
  const page = accounts.data?.[0]
  if (!page) throw new Error('user does not manage any FB pages')
  const igRef = page.instagram_business_account
  if (!igRef) throw new Error(`page "${page.name}" has no linked IG business account`)
  const tokenFp = (page.access_token as string).slice(-8)
  console.log(`[meta-publish] loadIgContext: ${pageCount} page(s); selected page="${page.name}" id=${page.id} ig=${igRef.id} page_token_fp=...${tokenFp}`)

  let igUsername = ''
  try {
    const r = await fetch(`${GRAPH}/${igRef.id}?fields=username&access_token=${page.access_token}`)
    igUsername = (await r.json()).username ?? ''
  } catch { /* non-fatal */ }

  return {
    pageToken:  page.access_token as string,
    pageId:     page.id as string,
    pageName:   page.name as string,
    igUserId:   igRef.id as string,
    igUsername,
  }
}

async function getQuotaUsage(igUserId: string, pageToken: string) {
  const res = await fetch(`${GRAPH}/${igUserId}/content_publishing_limit?access_token=${pageToken}`)
  const data = await res.json()
  if (data.error) throw new Error(`quota check: ${data.error.message}`)
  const used = data.data?.[0]?.quota_usage ?? 0
  return { used, limit: IG_QUOTA_LIMIT, remaining: Math.max(0, IG_QUOTA_LIMIT - used) }
}

async function createContainer(igUserId: string, pageToken: string, b: ContentFields) {
  if (b.type === 'feed')     return createFeedContainer(igUserId, pageToken, b)
  if (b.type === 'reel')     return createReelContainer(igUserId, pageToken, b)
  if (b.type === 'carousel') return createCarouselContainer(igUserId, pageToken, b)
  if (b.type === 'story')    return createStoryContainer(igUserId, pageToken, b)
  throw new Error(`unknown type: ${b.type}`)
}

// IG Stories — uses media_type=STORIES + either image_url or video_url.
// 9:16 aspect ratio recommended (~1080×1920). Caption is ignored by IG
// for stories (no text overlay rendered from caption), but we still
// echo it through so the prepared container metadata stays consistent
// with feed/reel records and the admin can see what was intended.
// Stories don't accept hashtags as visible text — caller should
// strip hashtags from caption before sending if they care about that.
async function createStoryContainer(igUserId: string, pageToken: string, b: ContentFields) {
  const params = new URLSearchParams({
    media_type:   'STORIES',
    access_token: pageToken,
  })
  if (b.image_url) params.set('image_url', b.image_url)
  if (b.video_url) params.set('video_url', b.video_url)
  // Story API ignores caption but include it in the request for parity;
  // Meta tolerates the field.
  if (b.caption) params.set('caption', b.caption)
  const res = await fetch(`${GRAPH}/${igUserId}/media`, { method: 'POST', body: params })
  const data = await res.json()
  console.log(`[meta-publish] createStoryContainer response: ${JSON.stringify(data)}`)
  if (data.error) throw new Error(`create story container: ${data.error.message}`)
  return data.id as string
}

async function createFeedContainer(igUserId: string, pageToken: string, b: ContentFields) {
  const params = new URLSearchParams({
    image_url: b.image_url!,
    caption:   b.caption ?? '',
    access_token: pageToken,
  })
  const res = await fetch(`${GRAPH}/${igUserId}/media`, { method: 'POST', body: params })
  const data = await res.json()
  console.log(`[meta-publish] createFeedContainer response: ${JSON.stringify(data)}`)
  if (data.error) throw new Error(`create feed container: ${data.error.message}`)
  return data.id as string
}

async function createReelContainer(igUserId: string, pageToken: string, b: ContentFields) {
  const params = new URLSearchParams({
    media_type: 'REELS',
    video_url:  b.video_url!,
    caption:    b.caption ?? '',
    access_token: pageToken,
  })
  const res = await fetch(`${GRAPH}/${igUserId}/media`, { method: 'POST', body: params })
  const data = await res.json()
  if (data.error) throw new Error(`create reel container: ${data.error.message}`)
  return data.id as string
}

async function createCarouselContainer(igUserId: string, pageToken: string, b: ContentFields) {
  const childIds: string[] = []
  for (const child of b.children!) {
    const params = new URLSearchParams({
      image_url: child.image_url,
      is_carousel_item: 'true',
      access_token: pageToken,
    })
    const res = await fetch(`${GRAPH}/${igUserId}/media`, { method: 'POST', body: params })
    const data = await res.json()
    if (data.error) throw new Error(`carousel child: ${data.error.message}`)
    childIds.push(data.id)
  }
  const parentParams = new URLSearchParams({
    media_type: 'CAROUSEL',
    children:   childIds.join(','),
    caption:    b.caption ?? '',
    access_token: pageToken,
  })
  const res = await fetch(`${GRAPH}/${igUserId}/media`, { method: 'POST', body: parentParams })
  const data = await res.json()
  if (data.error) throw new Error(`carousel parent: ${data.error.message}`)
  return data.id as string
}

// Reels need server-side video processing. Publishing before status_code='FINISHED'
// returns a misleading "Media ID is not available" error, so we poll.  For images
// (feed/carousel) Meta returns FINISHED immediately, so this poll is effectively
// a one-shot check — keeping it unconditional simplifies the publish path.
async function waitForContainerReady(containerId: string, pageToken: string) {
  const start = Date.now()
  while (Date.now() - start < REEL_POLL_TIMEOUT_MS) {
    const res = await fetch(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${pageToken}`)
    const data = await res.json()
    if (data.error) {
      console.log(`[meta-publish] status poll failed for container=${containerId}: ${JSON.stringify(data.error)}`)
      throw new Error(`status poll: ${data.error.message}`)
    }
    if (data.status_code === 'FINISHED') return
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new Error(`container ${containerId} failed processing: ${data.status ?? data.status_code}`)
    }
    await new Promise(r => setTimeout(r, REEL_POLL_INTERVAL_MS))
  }
  throw new Error(`container ${containerId} did not finish processing within ${REEL_POLL_TIMEOUT_MS / 1000}s`)
}

async function publishContainer(igUserId: string, pageToken: string, creationId: string) {
  const params = new URLSearchParams({ creation_id: creationId, access_token: pageToken })
  const res = await fetch(`${GRAPH}/${igUserId}/media_publish`, { method: 'POST', body: params })
  const data = await res.json()
  if (data.error) throw new Error(`media_publish: ${data.error.message}`)
  return data.id as string
}

// Meta's media id isn't a usable URL slug — fetch the real permalink so the
// dashboard can deep-link to the post for verification or sharing.
async function fetchPermalink(mediaId: string, pageToken: string): Promise<string> {
  try {
    const res = await fetch(`${GRAPH}/${mediaId}?fields=permalink&access_token=${pageToken}`)
    const data = await res.json()
    return data.permalink ?? ''
  } catch {
    return ''
  }
}
