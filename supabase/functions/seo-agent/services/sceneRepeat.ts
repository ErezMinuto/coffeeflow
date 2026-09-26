// Minuto SEO Agent — IG scene no-repeat guard.
//
// WHY: the daily story and feed visuals are queued by mission-worker, whose
// only no-repeat rule was on the FEATURED COFFEE (and stories are exempt from
// that). Nothing it saw told it what SCENE it rendered yesterday. With the
// 2026-09-23 story theme lock narrowing the subject to espresso / latte art,
// the prompt was effectively identical every morning, and so was the output:
// the same portafilter-and-crema scene three days running, for the story and
// the post alike.
//
// Two layers, same as the theme lock:
//   1. the planner is SHOWN the recent scenes (renderRecentScenesBlock), and
//   2. a new IG scene too close to one of them is REJECTED at queue time
//      (findRepeatedScene), with a note telling it what to change.
//
// Similarity is word-set overlap on content words. Scene briefs are free-form
// prose, so there is no structured field to compare; the words every Minuto
// brief shares (daylight, wood, shallow depth of field …) are stripped first so
// that the house style alone never reads as a repeat.
//
// Type-only import (erased at runtime), as in storyThemeLock.ts.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

/** How far back a scene counts as "recent". */
export const SCENE_REPEAT_DAYS = 7

/** Overlap (0..1) at or above which two scenes are the same shot. */
export const SCENE_REPEAT_THRESHOLD = 0.5

/** …and they must also share at least this many content words, so two short
 *  briefs that merely name the same subject ("espresso", "cup") never collide.
 *  Under a narrow theme lock a false positive would stall the day's story. */
export const SCENE_REPEAT_MIN_SHARED = 4

export interface RecentScene {
  id:          string
  created_at:  string
  aspect:      string
  scene_brief: string
}

// Grammar words plus the locked Minuto house style — present in nearly every
// brief, so they say nothing about whether the SHOT is the same.
const IGNORED = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'on', 'in', 'into', 'onto', 'at', 'to',
  'from', 'with', 'without', 'by', 'for', 'as', 'is', 'are', 'be', 'its', 'it',
  'this', 'that', 'over', 'under', 'beside', 'next', 'near', 'while', 'just',
  'no', 'not', 'any', 'kind', 'only', 'very', 'some', 'one', 'two', 'few',
  'minuto', 'coffee', 'specialty', 'scene', 'shot', 'image', 'photo', 'frame',
  'story', 'feed', 'post', 'instagram', 'vertical', 'square', 'portrait',
  'natural', 'soft', 'warm', 'daylight', 'light', 'lighting', 'window',
  'shallow', 'depth', 'field', 'focus', 'sharp', 'minimal', 'premium', 'calm',
  'uncluttered', 'negative', 'space', 'generous', 'editorial', 'magazine',
  'quality', 'inviting', 'surface', 'prop', 'wood', 'wooden', 'pale', 'stone',
  'text', 'logo', 'logos', 'bag', 'pouch', 'packaging', 'label',
  'identity', 'locked', 'style',
])

export function sceneWords(text: unknown): Set<string> {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/[\s-]+/)
    // Crude plural fold so "cups" and "cup" match (but not "generous", "glass").
    .map(w => (w.length > 3 && /[^su]s$/.test(w) ? w.slice(0, -1) : w))
    .filter(w => w.length > 2 && !IGNORED.has(w))
  return new Set(words)
}

/** Overlap of two scenes as |A∩B| / min(|A|,|B|) — a short rewording of a
 *  longer earlier brief still counts as the same shot. */
export function sceneSimilarity(a: unknown, b: unknown): number {
  return sceneOverlap(a, b).similarity
}

function sceneOverlap(a: unknown, b: unknown): { similarity: number; shared: number } {
  const A = sceneWords(a)
  const B = sceneWords(b)
  if (A.size === 0 || B.size === 0) return { similarity: 0, shared: 0 }
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return { similarity: shared / Math.min(A.size, B.size), shared }
}

export interface RepeatVerdict {
  scene:      RecentScene
  similarity: number
}

/** The most similar recent scene at or above the threshold, else null. */
export function findRepeatedScene(
  candidate: unknown,
  recent: RecentScene[],
  threshold = SCENE_REPEAT_THRESHOLD,
): RepeatVerdict | null {
  let best: RepeatVerdict | null = null
  for (const scene of recent) {
    const { similarity, shared } = sceneOverlap(candidate, scene.scene_brief)
    if (shared < SCENE_REPEAT_MIN_SHARED || similarity < threshold) continue
    if (!best || similarity > best.similarity) best = { scene, similarity }
  }
  return best
}

// IG-destined scenes queued since `sinceIso`, newest first, from EVERY queuer
// (mission-worker and organic-orchestrator write the same table). Failed
// renders are skipped — nothing shipped. Guarded: a failure returns [], which
// degrades to "no history", never blocks the step.
export async function fetchRecentIgScenes(
  supabase: SupabaseClient,
  sinceIso: string,
): Promise<RecentScene[]> {
  try {
    const { data, error } = await supabase
      .from('seo_tasks')
      .select('id, created_at, status, brief_data')
      .eq('task_type', 'visual_generation')
      .neq('status', 'failed')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    const out: RecentScene[] = []
    for (const row of (data ?? []) as Array<{ id: string; created_at: string; brief_data: Record<string, unknown> | null }>) {
      const b = row.brief_data ?? {}
      if (String(b.destination ?? '').toLowerCase() !== 'ig_post') continue
      const slides = Array.isArray(b.slides) ? (b.slides as Array<{ scene_brief?: unknown }>) : []
      const scene = String(b.scene_brief ?? '').trim() ||
        slides.map(s => String(s?.scene_brief ?? '').trim()).filter(Boolean).join(' / ')
      if (!scene) continue
      out.push({
        id:          row.id,
        created_at:  row.created_at,
        aspect:      String(b.aspect ?? (slides.length ? 'carousel' : '')).toLowerCase(),
        scene_brief: scene,
      })
    }
    return out
  } catch (e) {
    console.warn(`[sceneRepeat] recent IG scenes fetch failed: ${(e as Error)?.message ?? e}`)
    return []
  }
}

export function renderRecentScenesBlock(recent: RecentScene[], days = SCENE_REPEAT_DAYS): string {
  const header =
    `=== RECENT IG SCENES — last ${days}d, newest first (applies to STORIES AND FEEDS) ===\n` +
    `These are the scenes already rendered for Instagram. Every new visual must be a VISIBLY DIFFERENT shot from all of them — ` +
    `change the main subject or action, the camera angle (overhead / side / close macro / wide), the vessel and the setting. ` +
    `Staying on the same theme is fine; re-describing one of these shots is not. A scene too close to one below is REJECTED at queue time.\n`
  if (recent.length === 0) return `${header}  (none in the last ${days} days)\n\n`
  return header + recent.slice(0, 20).map(s =>
    `  - [${s.created_at.slice(0, 10)}] (${s.aspect || '?'}) ${s.scene_brief.replace(/\s+/g, ' ').slice(0, 220)}`,
  ).join('\n') + '\n\n'
}
