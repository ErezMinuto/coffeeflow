// Publishing a staged Instagram post from the review UI.
//
// Meta expires a prepared container ~24h after it is staged. A post that sat
// in the review queue longer than that cannot be published by its old
// creation_id: meta-publish answers 400 "Media has been expired". The admin
// already confirmed "publish now", so we re-stage the SAME content (same image,
// same caption, same type, the way organic-worker-instagram stages it) and
// publish the fresh container in the same click.
import { supabase } from './supabase'

// supabase-js turns any non-2xx into a generic "Edge Function returned a
// non-2xx status code"; the real reason is in the response body.
export async function invokeMetaPublish(body: Record<string, unknown>): Promise<Record<string, any>> {
  const { data, error } = await supabase.functions.invoke('meta-publish', { body })
  if (error) {
    let msg = error.message
    const res = (error as any).context
    if (res && typeof res.json === 'function') {
      try { const j = await res.clone().json(); if (j?.error) msg = String(j.error) } catch { /* keep generic */ }
    }
    throw new Error(msg)
  }
  if (data && data.success === false) throw new Error(data.error ?? 'meta-publish returned success:false')
  return (data ?? {}) as Record<string, any>
}

function isExpiredContainer(msg: string): boolean {
  return /expired/i.test(msg) && /container|media/i.test(msg)
}

// Rebuild the 'prepare' body from what the task stored. Mirrors
// organic-worker-instagram: story drops the trailing hashtag line; carousel
// sends children; feed/story send image_url.
function prepareBodyFrom(rd: Record<string, any>): Record<string, unknown> {
  const mediaType = rd.media_type as string | undefined
  const type = mediaType === 'story' ? 'story' : mediaType === 'feed_carousel' ? 'carousel' : mediaType === 'feed_image' ? 'feed' : null
  if (!type) throw new Error(`הפוסט המוכן פג תוקף, ואי אפשר להכין מחדש פוסט מסוג ${mediaType ?? 'לא ידוע'}.`)
  const caption = String(rd.caption ?? '')
  const body: Record<string, unknown> = {
    action: 'prepare',
    type,
    caption: type === 'story' ? caption.replace(/\n#[^\n]+$/, '').trim() : caption,
  }
  const children = Array.isArray(rd.carousel_children) ? rd.carousel_children.filter((u: unknown) => typeof u === 'string' && u) : []
  if (type === 'carousel') {
    if (children.length < 2) throw new Error('הפוסט המוכן פג תוקף, ואין לו תמונות קרוסלה שמורות כדי להכין אותו מחדש.')
    body.children = children.map((u: string) => ({ image_url: u }))
  } else {
    if (!rd.image_url) throw new Error('הפוסט המוכן פג תוקף, ואין לו תמונה שמורה כדי להכין אותו מחדש.')
    body.image_url = rd.image_url
  }
  return body
}

// Publishes rd.ig_creation_id; if Meta says it expired, re-stages and
// publishes the new container. Returns the publish response plus the
// result_data fields that changed (to merge into seo_tasks.result_data).
export async function publishIgWithRestage(rd: Record<string, any>): Promise<{ data: Record<string, any>; patch: Record<string, any> }> {
  try {
    return { data: await invokeMetaPublish({ action: 'publish', creation_id: rd.ig_creation_id }), patch: {} }
  } catch (e: any) {
    if (!isExpiredContainer(String(e?.message ?? ''))) throw e
  }
  const prepared = await invokeMetaPublish(prepareBodyFrom(rd))
  const creationId = prepared.creation_id as string | undefined
  if (!creationId) throw new Error(prepared.error ?? 'meta-publish returned no creation_id')
  const patch = { ig_creation_id: creationId, prepared_at: new Date().toISOString(), restaged_from_creation_id: rd.ig_creation_id }
  try {
    return { data: await invokeMetaPublish({ action: 'publish', creation_id: creationId }), patch }
  } catch (e: any) {
    // Keep the fresh container on the task so a retry doesn't re-stage again.
    ;(e as any).patch = patch
    throw e
  }
}
