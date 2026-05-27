// Minuto Organic Marketing — WP draft → published transition detector.
//
// Writer worker always creates posts as status='draft'. The admin must
// manually click Publish in WP admin to make them live. The orchestrator
// has no way to know which drafts went live unless we ask WP.
//
// This module queries the WP REST API for each task's wp_post_id, reads
// the current `status` field, and writes wp_published=true|false back
// into the task's result_data so the per-post follow-back report
// (postPerformanceFollowback.ts) can distinguish "drafted + published"
// from "drafted + still sitting unpublished".
//
// Called by the orchestrator at the start of each cron tick, alongside
// experiment evaluation. Cheap: only polls tasks where wp_published is
// currently null and wp_post_id is set — settles each task once.
//
// Uses the same WP Application Password env vars as blog-publish and
// the visual worker's featured-image attach: WP_BLOG_POST_USER_NAME +
// WP_BLOG_POST_PASS. WOO_URL for the base URL.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

// Resolve the publish state for tasks created in the last N days whose
// wp_published is currently unknown. Returns counts so the orchestrator
// can log + the strategist can see in result.
export async function detectWpPublishTransitions(
  supabase: SupabaseClient,
  lookbackDays = 60,
): Promise<{
  checked:     number
  newly_live:  number
  still_draft: number
  errors:      Array<{ task_id: string; error: string }>
}> {
  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    console.warn('[wp-publish-detector] WP credentials missing; skipping')
    return { checked: 0, newly_live: 0, still_draft: 0, errors: [] }
  }
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('seo_tasks')
    .select('id, result_data, completed_at')
    .eq('task_type', 'text_generation')
    .eq('status', 'completed')
    .gte('completed_at', since)
    .limit(100)
  if (error) {
    console.error(`[wp-publish-detector] task query failed: ${error.message}`)
    return { checked: 0, newly_live: 0, still_draft: 0, errors: [{ task_id: '-', error: error.message }] }
  }

  const candidates = (data ?? []).filter((t: any) => {
    const r = (t.result_data ?? {}) as any
    return typeof r.wp_post_id === 'number' && r.wp_published == null  // only check tasks not yet settled
  })

  const auth   = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
  let newlyLive = 0
  let stillDraft = 0
  const errors: Array<{ task_id: string; error: string }> = []

  for (const t of candidates) {
    const r       = (t.result_data ?? {}) as any
    const postId  = r.wp_post_id as number
    try {
      // GET /wp-json/wp/v2/posts/{id} returns the post regardless of
      // status if authenticated as an Author/Admin user (which our app
      // password is). For ?status=publish-only filtering use the
      // 'status' field on the returned JSON.
      const res = await fetch(`${WP_URL}/wp-json/wp/v2/posts/${postId}?context=edit`, {
        method: 'GET',
        headers: { Authorization: auth },
      })
      if (!res.ok) {
        errors.push({ task_id: t.id, error: `WP REST ${res.status}` })
        continue
      }
      const json   = await res.json() as { status?: string }
      const isLive = json.status === 'publish'
      const patch  = { ...(t.result_data ?? {}) as any, wp_published: isLive, wp_status_checked_at: new Date().toISOString() }
      await supabase.from('seo_tasks').update({ result_data: patch }).eq('id', t.id)
      if (isLive) newlyLive++; else stillDraft++
    } catch (e: any) {
      errors.push({ task_id: t.id, error: e?.message ?? String(e) })
    }
  }

  return { checked: candidates.length, newly_live: newlyLive, still_draft: stillDraft, errors }
}
