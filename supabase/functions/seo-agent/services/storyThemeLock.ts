// Minuto SEO Agent — daily IG story theme lock.
//
// WHY: on 2026-09-17 the admin asked for espresso and latte art stories only,
// for two weeks. It was recorded in seo_learnings and had no effect whatsoever
// — stories on 09-17 (French press), 09-18 (siphon), 09-20 (cezve), 09-22
// (cupping bowls) and 09-23 (French press) shipped anyway. The reason is
// structural, not behavioural: the daily story is queued by mission-worker,
// and mission-worker does not read seo_learnings at all. The instruction was
// filed somewhere the story planner cannot see, while mission-worker's own
// STORY POLICY was actively pushing the opposite ("a brewing method, ritual,
// brewing tip, or café-ambiance scene").
//
// So the lock lives in code, on the path that actually queues the story, and
// it is enforced on the emitted brief rather than merely described.
//
// SCOPE — this gates the DAILY STORY ROTATION ONLY. Feed posts and blog
// articles stay free to cover V60, Clever, cold brew, espresso, seasonal
// angles, anything. The learning rows recorded by the chat agent on 09-17 and
// 09-23 over-generalised the admin's request into "all visual content", which
// would have suppressed exactly the filter content they later confirmed they
// want. Do not widen this.
//
// EXPIRY is a date, not a vibe. "For the next two weeks" recorded as a
// learning never expired — it was still sitting there a week later, re-added
// verbatim, with an older 2026-07-23 rule beside it demanding the OPPOSITE
// (siphon/V60/French press variety in the story rotation). A lock with an
// `until` lapses on its own and stops contradicting the next instruction.

// Type-only import (erased at runtime) and a direct system_config read rather
// than db.ts's getSystemConfig. db.ts reads Deno.env at module load, so
// importing it here would drag env access into every consumer — including the
// unit tests, which have no business needing SUPABASE_URL to check a regex.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const STORY_THEME_LOCK_KEY = 'ig_story.theme_lock'

export interface StoryThemeLock {
  /** Human-readable themes, shown to the planner. */
  themes:   string[]
  /** Scene must match at least one of these (case-insensitive substrings). */
  allow:    string[]
  /** Scene must match none of these, even if it also matches `allow`. */
  deny:     string[]
  /** Inclusive last day the lock applies, YYYY-MM-DD Israel time. */
  until:    string
  reason?:  string
}

// Default lives in code so the lock works with no DB change, and lapses by
// itself on `until`. A system_config row under STORY_THEME_LOCK_KEY overrides
// it — that is how the admin extends, narrows or cancels it early without a
// redeploy. Setting the row to null (or an `until` in the past) lifts it.
export const DEFAULT_STORY_THEME_LOCK: StoryThemeLock = {
  themes: ['espresso', 'latte art'],
  allow: [
    'espresso', 'portafilter', 'crema', 'group head', 'tamper', 'tamping',
    'ristretto', 'cortado', 'macchiato', 'cappuccino', 'flat white', 'latte',
    'latte art', 'rosetta', 'microfoam', 'milk pitcher', 'steamed milk',
    'steaming milk', 'pouring milk', 'milk jug',
    'אספרסו', 'לאטה', 'קפוצ׳ינו', 'קפוצינו', 'מיקרופום',
  ],
  // Brew methods that are NOT espresso or latte art. Present so a scene can't
  // slip a French press in beside an espresso cup and pass on the espresso
  // keyword alone.
  deny: [
    'french press', 'siphon', 'syphon', 'vacuum pot', 'v60', 'pour over',
    'pour-over', 'chemex', 'kalita', 'aeropress', 'moka', 'cezve',
    'ibrik', 'turkish coffee', 'cold brew', 'toddy', 'batch brew',
    'cupping', 'gooseneck', 'percolator', 'immersion dripper', 'hario switch',
    // Multi-word on purpose. A bare "drip" would reject a perfectly good
    // "espresso dripping from the portafilter", and a bare "clever" would
    // reject "a clever composition" — both plausible in a scene brief.
    'drip coffee', 'drip brewer', 'drip machine', 'clever dripper',
    'פרנץ׳ פרס', 'סיפון', 'קולד ברו', 'פינג׳אן', 'קפה טורקי',
  ],
  until:  '2026-10-07',
  reason: 'Admin request 2026-09-23: espresso and latte art stories only for two weeks.',
}

export async function getActiveStoryThemeLock(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<StoryThemeLock | null> {
  let lock: StoryThemeLock | null = DEFAULT_STORY_THEME_LOCK
  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', STORY_THEME_LOCK_KEY)
      .maybeSingle()
    if (error) throw new Error(error.message)
    // A row present and explicitly null lifts the lock; no row at all leaves
    // the code default in force.
    if (data) lock = (data.value ?? null) as StoryThemeLock | null
  } catch (e) {
    // A config outage must not silently drop a guardrail, so we keep the
    // default rather than failing open to "no lock".
    console.warn(`[storyThemeLock] config read failed, using default: ${(e as Error)?.message ?? e}`)
  }
  if (!lock || !Array.isArray(lock.allow) || !lock.until) return null
  // Expired locks are simply absent — no cleanup step, no stale rule.
  if (todayIso > lock.until) return null
  return lock
}

export interface SceneVerdict {
  ok: boolean
  /** Populated when ok === false — what to tell the planner to fix. */
  why?: string
}

// Judge a proposed story scene against the lock. Substring matching on the
// scene text: briefs are written as free-form English prose (with occasional
// Hebrew), so there is no structured field to key off.
export function screenStoryScene(sceneText: unknown, lock: StoryThemeLock): SceneVerdict {
  const text = String(sceneText ?? '').toLowerCase()
  if (!text.trim()) return { ok: false, why: 'empty scene_brief' }

  const hitDeny = (lock.deny ?? []).find(d => text.includes(d.toLowerCase()))
  if (hitDeny) {
    return {
      ok: false,
      why: `scene mentions "${hitDeny}", which is outside the current story theme lock (${lock.themes.join(' / ')}, until ${lock.until})`,
    }
  }
  const hitAllow = (lock.allow ?? []).some(a => text.includes(a.toLowerCase()))
  if (!hitAllow) {
    return {
      ok: false,
      why: `scene does not depict ${lock.themes.join(' or ')} — the story theme lock is active until ${lock.until}`,
    }
  }
  return { ok: true }
}

// Replaces the default STORY POLICY sentence while the lock is active.
export function renderStoryLockPolicy(lock: StoryThemeLock): string {
  return `⛔ STORY THEME LOCK — ACTIVE UNTIL ${lock.until} (admin instruction${lock.reason ? `: ${lock.reason}` : ''}).
The daily story MUST depict ${lock.themes.join(' or ')} — nothing else. An espresso pull, crema in the cup, a portafilter, steaming or pouring milk, a rosetta being poured, a finished latte-art cup: all good, and there are unlimited variations, so vary the angle, light, cup and setting rather than the subject.
Do NOT queue a story showing ${(lock.deny ?? []).slice(0, 8).join(', ')} or any other brew method while this lock is active. A story visual whose scene_brief breaks this is REJECTED at queue time and you will be asked to redo it, so get it right the first time.
This lock applies to the DAILY STORY ONLY. Feed posts are unaffected and remain free to cover any brew method, product or seasonal angle.
`
}
