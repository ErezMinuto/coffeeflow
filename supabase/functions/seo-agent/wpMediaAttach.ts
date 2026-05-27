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

export async function attachFeaturedImage(args: {
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
