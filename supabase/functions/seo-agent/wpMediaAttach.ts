// Minuto Organic Marketing — shared WP featured-image attach helper.
//
// Lifted out of seo-worker-visual so the chat handler can call it too —
// when admin manually approves a QA-capped attempt via the
// approve_qa_attempt tool, the chat agent runs the same attach path the
// worker would have run if QA had passed. Same code path means same
// behavior (filename sanitization, error handling, return shape).
//
// Two REST calls:
//   1. POST /wp/v2/media — upload image bytes, get media_id
//   2. POST /wp/v2/posts/{id} — set featured_media = media_id
// Auth + filename-sanitization pattern lifted from blog-publish/uploadMedia.
//
// Caller is responsible for: fetching WP credentials from env, choosing
// the post_id, providing the image URL, and a sensible titleHint string.
//
// Step 2 replaces the post's featured image, so the previous media id is
// saved to public.site_change_log first (undo puts it back). If that backup
// can't be saved the post is left untouched and this throws; the uploaded
// file just stays unused in the media library.

import { beginChange, finishChange, type ChangeContext } from '../_shared/site_change_log.ts'
import { readPost, siteEnv } from '../_shared/site_io.ts'

export async function attachFeaturedImage(args: {
  wpUrl:        string
  username:     string
  appPassword:  string
  postId:       number
  imageUrl:     string
  titleHint:    string
  sourceFn:     string          // edge function making the change (for the change log)
  change?:      ChangeContext
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

  // 4. Back up the current featured image, then update the post with
  //    featured_media. WP REST uses POST (not PUT) on /posts/{id} for
  //    partial updates.
  const env = siteEnv({ wpUrl: args.wpUrl, wpUser: args.username, wpPass: args.appPassword })
  const current = await readPost(env, args.postId)
  const changeId = await beginChange({
    target_type:   'post_featured_image',
    target_id:     args.postId,
    target_url:    current.link || null,
    target_title:  current.title || null,
    before:        current.featured_media,
    before_source: 'wp_rest',
    after:         mediaId,
    source_fn:     args.sourceFn,
    ctx:           args.change ?? {},
  })
  const postRes = await fetch(`${args.wpUrl}/wp-json/wp/v2/posts/${encodeURIComponent(String(args.postId))}`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ featured_media: mediaId }),
  })
  if (!postRes.ok) {
    const errText = await postRes.text().catch(() => '')
    const error = `WP post update ${postRes.status}: ${errText.slice(0, 300)}`
    await finishChange(changeId, { ok: false, error })
    throw new Error(error)
  }
  await finishChange(changeId, { ok: true })
  return mediaId
}
