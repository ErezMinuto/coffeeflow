// Minuto Organic Marketing — Per-post follow-back reporter.
//
// On every orchestrator tick, walk the tasks emitted in the prior 2
// cycles and report each one's current performance back to the strategist
// as a dedicated context block. Different from the existing
// "fetchTopOrganicLandingPages" (which shows AGGREGATE top performers
// across the whole site) — this is the agent's per-post self-retrospection.
//
// What gets reported per task:
//   - text_generation: WP publish status (draft vs live), if live then
//     GA4 sessions + conversions since publish
//   - instagram_post: queue_for_review vs published, if published then
//     Meta engagement, if not published why (admin hasn't approved yet,
//     or task failed before preparing)
//   - visual_generation: skipped (handled implicitly via parent text/IG row)
//   - dynamic_experiment: status + admin notes if any
//
// Lives in seo-agent/ so the chat handler could reuse it as a tool too.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { SeoTaskRow } from './types.ts'

export interface PostFollowback {
  task_id:           string
  task_type:         string
  created_at:        string
  variation_label:   string | null
  experiment_id:     string | null
  brief_summary:     string
  // Per-channel performance fields. Only the ones relevant to task_type
  // get populated; others left undefined.
  wp_post_id?:       number | null
  wp_link?:          string | null
  wp_published?:     boolean | null    // null = unknown (haven't checked)
  ga4_sessions?:     number
  ga4_conversions?:  number
  ig_creation_id?:   string | null
  ig_media_id?:      string | null
  ig_permalink?:     string | null
  ig_published?:     boolean | null
  meta_impressions?: number
  meta_engagement?:  number
  // Catch-all for QA / approval / failure context the agent should see.
  status_note?:      string
}

// Pull all non-trivial tasks (text/IG/experiment) from the last 14 days.
// Visual_generation is excluded — its performance is folded into the
// parent text/IG row's performance.
export async function collectPostFollowback(
  supabase: SupabaseClient,
  lookbackDays = 14,
): Promise<PostFollowback[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString()
  const { data: tasks, error } = await supabase
    .from('seo_tasks')
    .select('*')
    .gte('created_at', since)
    .in('task_type', ['text_generation', 'instagram_post', 'dynamic_experiment'])
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw new Error(`collectPostFollowback failed: ${error.message}`)

  const out: PostFollowback[] = []
  for (const t of (tasks ?? []) as SeoTaskRow[]) {
    const result = (t.result_data ?? {}) as any
    const brief  = (t.brief_data ?? {})  as any
    const fb: PostFollowback = {
      task_id:         t.id,
      task_type:       t.task_type,
      created_at:      t.created_at,
      variation_label: t.variation_label,
      experiment_id:   t.experiment_id,
      brief_summary:   summarizeBrief(t.task_type, brief),
    }

    if (t.task_type === 'text_generation') {
      fb.wp_post_id = typeof result.wp_post_id === 'number' ? result.wp_post_id : null
      fb.wp_link    = typeof result.link === 'string' ? result.link : null
      // wp_published is set by the WP draft→published detector (a future
      // step or a separate sync). Until it runs, fall back to unknown.
      fb.wp_published = typeof result.wp_published === 'boolean' ? result.wp_published : null
      // GA4 per-page metrics: only meaningful if the post is live.
      if (fb.wp_link && fb.wp_published) {
        const path  = safePath(fb.wp_link)
        const since = (t.completed_at ?? t.created_at).split('T')[0]
        const { data: g } = await supabase
          .from('ga4_pages_daily')
          .select('sessions, conversions')
          .eq('page_path', path)
          .eq('channel_group', 'Organic Search')
          .gte('date', since)
        fb.ga4_sessions    = (g ?? []).reduce((s: number, r: any) => s + (r.sessions ?? 0), 0)
        fb.ga4_conversions = (g ?? []).reduce((s: number, r: any) => s + Number(r.conversions ?? 0), 0)
      }
      if (t.status === 'failed')               fb.status_note = `worker failed: ${(t.error_msg ?? '').slice(0, 200)}`
      else if (t.status === 'pending')         fb.status_note = 'task still pending — worker has not claimed yet'
      else if (t.status === 'processing')      fb.status_note = 'worker actively running'
      else if (!fb.wp_post_id)                 fb.status_note = 'completed but no wp_post_id — writer failed silently'
      else if (fb.wp_published === false)      fb.status_note = 'WP draft created, NOT yet published live by admin'
      else if (fb.wp_published === null)       fb.status_note = 'WP draft created — publish status not yet detected'

    } else if (t.task_type === 'instagram_post') {
      fb.ig_creation_id = typeof result.ig_creation_id === 'string' ? result.ig_creation_id : null
      fb.ig_media_id    = typeof result.ig_media_id    === 'string' ? result.ig_media_id    : null
      fb.ig_permalink   = typeof result.ig_permalink   === 'string' ? result.ig_permalink   : null
      fb.ig_published   = !!fb.ig_media_id
      if (fb.ig_published && fb.ig_media_id) {
        const { data: meta } = await supabase
          .from('meta_organic_posts')
          .select('impressions, likes, comments, shares, saves, reach')
          .eq('post_id', fb.ig_media_id)
          .maybeSingle()
        if (meta) {
          fb.meta_impressions = Number(meta.impressions ?? 0)
          fb.meta_engagement  = Number(meta.likes ?? 0) + Number(meta.comments ?? 0) + Number(meta.shares ?? 0) + Number(meta.saves ?? 0)
        }
      }
      if (t.status === 'failed')               fb.status_note = `worker failed: ${(t.error_msg ?? '').slice(0, 200)}`
      else if (!fb.ig_creation_id)             fb.status_note = 'no IG creation_id — worker did not prepare; check parent visual or worker logs'
      else if (!fb.ig_published)               fb.status_note = 'PREPARED on Meta, awaiting admin approval to publish (publish_ig_post tool)'
      else if (fb.meta_impressions == null)    fb.status_note = 'published live, but meta-sync has not yet ingested engagement metrics for this post_id'

    } else if (t.task_type === 'dynamic_experiment') {
      fb.status_note = t.status === 'completed'
        ? (result.approved_via_ui_at || result.approved_via_chat_at ? 'admin approved' : 'completed without explicit approval audit trail')
        : `status=${t.status}${t.error_msg ? ' | error: ' + t.error_msg.slice(0, 100) : ''}`
    }

    out.push(fb)
  }
  return out
}

function summarizeBrief(taskType: string, brief: any): string {
  if (taskType === 'text_generation') {
    return `"${(brief.title ?? brief.keyword ?? '?').slice(0, 80)}"`
  }
  if (taskType === 'instagram_post') {
    return `caption: "${(brief.caption_he ?? '').slice(0, 80)}…"`
  }
  if (taskType === 'dynamic_experiment') {
    return (brief.description ?? '').slice(0, 100)
  }
  return ''
}

function safePath(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}
