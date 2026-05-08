// Post-processes the organic_content agent's `posts_to_publish[3]` into
// `enriched_posts[3]` — the publish-ready shape the IG generation pipeline
// consumes. Runs as 3 parallel Haiku calls, ~$0.01 / agent run.
//
// Why this is a separate file (and a separate LLM step) rather than baked
// into the main organic prompt:
//   - The main prompt is already large and carefully tuned. Adding more
//     fields risks degrading the rest of the report.
//   - Iterating on the visual brief shouldn't require re-running the full
//     organic agent.
//   - The visual_identity anchor stays in one place and is shared with the
//     visual-test endpoint that actually generates images.
//
// What it does for each of the 3 posts:
//   1. Asks Haiku to pick a SCENE_PRESET key, write a 4–6 sentence
//      scene_brief in the locked Minuto identity, identify a calendar_hook,
//      and (rarely) set an overlay_text.
//   2. Computes scheduled_for in IL time from the agent's best_day +
//      best_time strings.

import {
  MINUTO_VISUAL_IDENTITY,
  SCENE_PRESET_SUMMARIES,
  SCENE_PRESETS,
} from '../_shared/visual_identity.ts'

type CallClaude = (
  model: string,
  system: string,
  userMessage: string,
  opts?: { maxTokens?: number; timeoutMs?: number },
) => Promise<{ text: string; inputTokens: number; outputTokens: number }>

// What the organic agent emits per post (only the fields we actually use).
export interface PostToPublish {
  type?: string
  intent?: 'save' | 'share' | 'behind_the_scenes' | string
  topic?: string
  best_day?: string
  best_time?: string
  caption?: string
  hashtags?: string[]
  hook?: string
  visual_direction?: string
  why_this_intent?: string
}

// Maps the upstream agent's `type` (which Reel / feed post / carousel / story
// it suggested) to the aspect ratio the v1 image-generation pipeline produces.
// Reels and Stories are 9:16; feed posts and carousel cover slides are 1:1.
// In v1 we only generate the COVER/HERO frame for Reels and carousels —
// Phase 2 adds the actual video composition.
export type EnrichedAspect = 'feed_square' | 'reel_cover'

const TYPE_TO_ASPECT: Record<string, EnrichedAspect> = {
  post:     'feed_square',
  carousel: 'feed_square',  // cover slide only in v1
  reel:     'reel_cover',
  story:    'reel_cover',
}

export interface EnrichedPost {
  post_index:      number                              // matches posts_to_publish[i]
  intent:          string                              // copy of the canonical intent
  post_type:       keyof typeof SCENE_PRESETS | string // SCENE_PRESETS key or fallback
  aspect:          EnrichedAspect                      // feed_square | reel_cover (drives visual-test)
  calendar_hook:   string                              // 1-phrase moment this post connects to
  scene_brief:     string                              // 4–6 sentence English brief for Gemini
  overlay_text:    string | null                       // optional Hebrew text for compositing
  scheduled_for:   string                              // ISO datetime in IL time
  // Echo of upstream fields so consumers don't need both shapes:
  upstream_type:   string                              // raw 'post'|'reel'|'carousel'|'story' from the agent
  caption:         string
  hashtags:        string[]
  // Image generated from scene_brief via the visual-test endpoint. Public
  // URL into the `marketing` Storage bucket. Null on rejection or generation
  // failure (the dashboard then shows the brief without an image).
  image_url:       string | null
  // The specific Minuto product the post is about, if any. Haiku extracts the
  // name from caption/topic/hook (e.g. "Dark Chocolate", "Yirgacheffe").
  // Marketing-advisor's runner looks this up in woo_products and stamps the
  // matched image URL onto reference_image_url so visual-test renders the
  // right bag — not always the default Yirgacheffe.
  product_reference?:    string | null
  reference_image_url?:  string | null
  // Brand-voice rejection: when the upstream post violates the anti-disparagement
  // rule, we surface it here instead of silently dropping it. The dashboard
  // shows these as "needs regeneration" rather than rendering a scene_brief.
  // Format mismatches (Reels in v1) are NOT rejections — those still get a
  // hero-frame scene_brief with the appropriate aspect.
  rejected?:       boolean
  rejection_reason?: string
}

const HEBREW_DAY_INDEX: Record<string, number> = {
  'ראשון':  0,
  'שני':    1,
  'שלישי':  2,
  'רביעי':  3,
  'חמישי':  4,
  'שישי':   5,
  'שבת':    6,
}

// Israel runs IDT (+03:00) from last Friday in March to last Sunday in October.
// For now we hardcode based on month — accurate enough through 2027 without
// pulling in a tz library. Revisit if we run into edge cases at the boundaries.
function isIsraelDST(d: Date): boolean {
  const m = d.getUTCMonth()
  if (m > 2 && m < 9) return true   // Apr–Sep always DST
  if (m < 2 || m > 9) return false  // Jan–Feb, Nov–Dec never
  // March / October — boundary months. Approximate cutoff at 27th.
  return d.getUTCDate() >= 27
}

function computeScheduledFor(bestDay?: string, bestTime?: string, today: Date = new Date()): string {
  const targetDow = HEBREW_DAY_INDEX[String(bestDay ?? '').trim()]
  const [hh, mm] = String(bestTime ?? '09:00').split(':').map(s => parseInt(s, 10))
  const hour = Number.isFinite(hh) ? Math.max(0, Math.min(23, hh)) : 9
  const minute = Number.isFinite(mm) ? Math.max(0, Math.min(59, mm)) : 0

  // Find next occurrence of targetDow (today counts if it's still in the future).
  const out = new Date(today)
  if (Number.isFinite(targetDow)) {
    const diff = (targetDow! - out.getDay() + 7) % 7
    out.setDate(out.getDate() + (diff === 0 ? 7 : diff))   // never schedule "today" — always next occurrence
  } else {
    out.setDate(out.getDate() + 1)                         // unknown day → tomorrow as a safe default
  }
  out.setHours(hour, minute, 0, 0)

  // Format as ISO with explicit Israel offset.
  const offset = isIsraelDST(out) ? '+03:00' : '+02:00'
  const yyyy = out.getFullYear()
  const mo   = String(out.getMonth() + 1).padStart(2, '0')
  const da   = String(out.getDate()).padStart(2, '0')
  const ho   = String(out.getHours()).padStart(2, '0')
  const mi   = String(out.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mo}-${da}T${ho}:${mi}:00${offset}`
}

const HAIKU_MODEL = 'claude-haiku-4-5'

function buildEnrichmentPrompt(post: PostToPublish, aspect: EnrichedAspect, calendarContext: string): { system: string; user: string } {
  const presetList = Object.entries(SCENE_PRESET_SUMMARIES)
    .map(([k, v]) => `  - "${k}": ${v}`).join('\n')

  const aspectGuidance = aspect === 'reel_cover'
    ? 'The upstream agent picked a Reel or Story (9:16 vertical). Write the brief for the COVER FRAME — the single still that opens the Reel and shows in the grid. The cover frame must obey the Minuto identity exactly the same as a feed post, just composed vertically. Phase 2 will animate this; for now we generate the still cover.'
    : 'The upstream agent picked a feed post or carousel. Write the brief for the hero frame in 1:1 (or the cover slide for carousels).'

  const system = `You are the photography art director for Minuto, an Israeli specialty
coffee roastery, writing scene briefs for AI-generated Instagram content.

Your job: take ONE post brief from a marketing agent and turn it into a
publish-ready package — pick a scene-preset class, write a 4–6 sentence
photographer's brief in English, identify the calendar moment it connects
to, and decide whether it needs a Hebrew text overlay (rare — most posts
let the visual carry).

📐 FORMAT (NOT a rejection reason):
${aspectGuidance}
You write the brief regardless of whether the upstream agent picked Reel,
Story, post, or carousel. NEVER reject a post because of its format. Format
mismatches are handled by the publish pipeline downstream — your job is the
visual brief for the cover/hero frame.

🎯 YOUR PRIMARY JOB: ADAPT.

The image you produce is ONE HERO COVER FRAME. It is NOT trying to convey
the full post. It is the still that:
  - For a feed post: anchors the in-feed grid tile.
  - For a Reel: opens the Reel (the cover thumbnail you see in the grid).
  - For a carousel: serves as slide #1 (the cover slide); the rest of the
    carousel's content lives in slides 2..N — which v1 does NOT generate.

The upstream agent's visual_direction is INSPIRATION, not gospel. It often
describes a video sequence, a multi-slide carousel, a chart, an
infographic, or a comparison spread. Your job is to translate the SPIRIT
of that direction into ONE evocative still-life photo brief that captures
the post's mood/subject — NOT to capture every educational point or every
slide of the carousel. The caption, not the image, carries the textual
information.

CRITICAL: Format mismatches are NEVER a rejection reason. EVER. If the
post wants a video, an infographic, a 5-slide carousel, a comparison
chart, a table, a labeled diagram, or anything else that isn't a
photograph — you ADAPT, not reject. The phrase "cannot be adapted into a
single still-life" is not a valid output from you; everything can be
adapted into a hero frame because the hero frame doesn't need to carry
all the post's information.

Adaptation examples — these MUST come back as scene_briefs, not rejections:
  - Post = "5-slide carousel: signs your beans are stale" → ONE still-life
    of a single Minuto bag with a freshness valve and zip-top visible,
    catching warm side-light, beside a small pile of glossy fresh beans on
    raw concrete. The 5 educational points live in the caption.
  - Post = "video: green beans → roasting → cooling → packing" → ONE
    still of dark-roasted beans on a raw cooling tray with the matched
    Minuto bag in the upper-right third. The process narrative lives in
    the caption.
  - Post = "infographic: machine model → which beans" → ONE still of one
    Minuto bag beside one espresso machine, hard side light, lower-right.
    The matching table lives in the caption or future carousel slides.
  - Post = "before/after with date stamp" → ONE still of a single bag
    next to a freshly cracked bean pile, NO date sticker rendered.

🚫 HARD REJECTIONS — ONLY these two patterns. Nothing else.

  1. Post names a COMPETITOR COFFEE BRAND (Lavazza, Illy, Hausbrandt,
     Nespresso, Starbucks, Costa, Mauro, Bristot, Kimbo, Segafredo, נחת,
     Jera, אגרו, Origem, Kilimanjaro, Nahat) AND the post topic is
     fundamentally built around comparing/disparaging that brand —
     can't be salvaged by dropping the name.
     Note 1: machine brands (Delonghi, Breville, Gaggia, Rancilio, Sage)
     are FINE — those are NOT coffee brands.
     Note 2: if the brand is mentioned only as setup but the post's
     positive message stands on its own, ADAPT (drop the brand mention
     in the brief).

  2. Post mocks the customer in a way no rewrite can fix ("you don't even
     know when your beans were roasted, do you?", "the cheap Delonghi you
     bought is the problem"). Note: "you have a Delonghi but the coffee
     isn't tasty? the problem isn't the machine" is empowerment, ACCEPT.

That's it. Two patterns. If you find yourself about to reject for any
other reason — including "format doesn't fit", "too many points to
capture", "would need text overlays", "would need motion", "would need
multiple slides" — stop and write the adaptation instead.

When you reject, return:
{
  "rejected": true,
  "rejection_reason": "1 short sentence explaining the HARD rule that triggered. Format/visual mismatches are NEVER a rejection reason — those get adapted."
}

Allowed positive framings (these are FINE, not rejections):
  - "Roast date" as a standalone Minuto value, no comparison ("roasted this
    morning, that's the Minuto standard").
  - Inviting the customer to look at their own current bag without judgment
    ("check your bag for a roast date").
  - Educational content about commercial vs specialty roasting as a category,
    without naming brands or implying the customer is foolish.
  - Mentioning the customer's espresso machine model (Delonghi, Breville,
    Gaggia, Rancilio, etc.) to recommend matching beans, NOT to mock the
    machine. Machine brand names are FINE in this context — the prohibition
    is on COFFEE/BEAN brand names (Lavazza, Nespresso, etc.).
  - "Your machine can do more / the problem isn't the machine, it's the
    beans" framing — this is EMPOWERMENT, not disparagement. The customer's
    hardware is being defended, beans are positioned as the upgrade.

CRITICAL DISTINCTION — read the WHOLE post before rejecting:
  Disparagement is about TONE and FRAME, not surface-level keywords. A post
  that mentions a machine brand + price + "isn't tasty" is NOT automatically
  disparaging — read what the NEXT sentence says. If the next sentence
  defends the machine ("the problem isn't the machine"), the post is
  empowerment. If the next sentence attacks the machine ("the cheap Delonghi
  is the problem"), it's disparagement.

  Example A — DISPARAGEMENT (REJECT):
    "Your cheap Delonghi will never make real espresso. Buy a real machine."

  Example B — EMPOWERMENT (ACCEPT):
    "You have a ₪2000 Delonghi but the coffee isn't tasty? The problem
    isn't the machine — it's the beans. Match the right beans to your
    machine and watch it transform."

  Both mention "Delonghi" + "₪2000" + "isn't tasty". Only A is a violation.

────────────────────────────────────────────────────────────────────────

If the post passes the guardrail, write the brief.

The locked Minuto IG visual identity (your scene_brief MUST obey every
rule below, no exceptions):

${MINUTO_VISUAL_IDENTITY}

Available scene-preset classes (pick exactly one for post_type):
${presetList}

Each preset is a starting template. You should adapt it to the specific
post topic — don't just echo the template. Keep the locked composition
rules (subject in lower-right or upper-right third, never centered, 30%+
negative space, asymmetric, hard side-light from upper-right).

Calendar context (use to pick a calendar_hook — what moment this post
connects to in real-world Israeli/coffee time):

${calendarContext}

If no upcoming event maps cleanly, use one of:
"weekend morning", "fresh batch", "rainy day", "midweek ritual",
"new origin arrival", "Friday slow brew", "deep work morning".

OUTPUT — strict JSON, no other text, no markdown fences. Either the
SUCCESS shape or the REJECTION shape, depending on the guardrail check:

SUCCESS:
{
  "post_type": "still_life_gift" | "pour_shot" | "origin_still" | "brewing_setup",
  "calendar_hook": "1 short phrase (Hebrew or English ok)",
  "scene_brief": "4–6 sentence ENGLISH photographer's brief, written in the locked Minuto identity. Specific objects, specific composition (lower-right third etc.), specific light direction. NO references to brand voice or copywriting — just the shot. NO competitor brands, NO side-by-side comparison framing. MANDATORY: if product_reference is non-null, the brief MUST place the Minuto [product] bag prominently in the composition (e.g. 'a Minuto Guatemala Antigua bag stands in the upper-right third'). Don't write a scene without the bag when we know which product the post is about — that defeats the visual identification. The only exception is a pure pour/in-cup shot where the bag would feel forced; even then, mention 'a Minuto [product] bag visible in soft background'.",
  "overlay_text": null | "short Hebrew headline ≤ 40 chars — use null UNLESS the post REALLY needs text (e.g. announcing a new origin name, a price/promo, or a recipe ratio). NO disparaging text, NO 'competitor doesn't do X' framing.",
  "product_reference": null | "the SPECIFIC Minuto product name as it appears in the post (e.g. 'Dark Chocolate', 'Yirgacheffe', 'Guatemala Antigua', 'Fazenda Sertão'). Use null when the post is generic about coffee/roasting and not about one named product. The downstream pipeline uses this to look up the right bag image as a Gemini reference, so the rendered bag matches the post's product."
}

REJECTION:
{
  "rejected": true,
  "rejection_reason": "1 short English sentence naming the pattern that triggered"
}`

  const user = `POST BRIEF:
- IG type: ${post.type ?? '(unknown)'}
- Intent: ${post.intent ?? '(unknown)'}
- Topic: ${post.topic ?? ''}
- Hook (opening line): ${post.hook ?? ''}
- Caption (final, Hebrew): ${post.caption ?? ''}
- Visual direction from main agent (use as inspiration, not gospel): ${post.visual_direction ?? '(none provided)'}
- Why this intent: ${post.why_this_intent ?? ''}

Now return the strict JSON enrichment.`

  return { system, user }
}

type ParsedEnrichment =
  | { kind: 'success'; post_type: string; calendar_hook: string; scene_brief: string; overlay_text: string | null; product_reference: string | null }
  | { kind: 'rejected'; rejection_reason: string }

function parseEnrichmentJson(text: string): ParsedEnrichment | null {
  // Tolerate ```json ... ``` fencing or stray prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw    = (fenced ? fenced[1] : text).trim()
  const start  = raw.indexOf('{')
  const end    = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: any
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (obj?.rejected === true) {
    return {
      kind: 'rejected',
      rejection_reason: typeof obj.rejection_reason === 'string' && obj.rejection_reason.trim()
        ? obj.rejection_reason.trim()
        : 'brand voice violation (no reason provided)',
    }
  }
  if (typeof obj.post_type !== 'string' || typeof obj.scene_brief !== 'string') return null
  return {
    kind: 'success',
    post_type:         obj.post_type,
    calendar_hook:     typeof obj.calendar_hook === 'string' ? obj.calendar_hook : '',
    scene_brief:       obj.scene_brief,
    overlay_text:      typeof obj.overlay_text === 'string' && obj.overlay_text.trim() ? obj.overlay_text.trim() : null,
    product_reference: typeof obj.product_reference === 'string' && obj.product_reference.trim() ? obj.product_reference.trim() : null,
  }
}

export async function enrichPostsForPublishing(
  posts: PostToPublish[],
  calendarContext: string,
  callClaude: CallClaude,
  today: Date = new Date(),
): Promise<EnrichedPost[]> {
  // Run all 3 in parallel — they're independent and Haiku is fast (~2-4s each).
  const settled = await Promise.allSettled(
    posts.map(async (post, i) => {
      const upstreamType = String(post.type ?? 'post').toLowerCase()
      const aspect: EnrichedAspect = TYPE_TO_ASPECT[upstreamType] ?? 'feed_square'
      const { system, user } = buildEnrichmentPrompt(post, aspect, calendarContext)
      const { text } = await callClaude(HAIKU_MODEL, system, user, { maxTokens: 1200, timeoutMs: 45_000 })
      const parsed = parseEnrichmentJson(text)
      if (!parsed) {
        throw new Error(`enrichment[${i}]: Haiku did not return parseable JSON. Raw: ${text.slice(0, 200)}`)
      }
      const base = {
        post_index:    i,
        intent:        String(post.intent ?? ''),
        upstream_type: upstreamType,
        aspect,
        scheduled_for: computeScheduledFor(post.best_day, post.best_time, today),
        caption:       String(post.caption ?? ''),
        hashtags:      Array.isArray(post.hashtags) ? post.hashtags : [],
        image_url:     null as string | null,   // populated on-demand via the dashboard's "Generate Visual" button
      }
      if (parsed.kind === 'rejected') {
        // Brand-voice violation. Surface the post in the output WITHOUT a
        // scene_brief so the dashboard can show "needs regeneration" rather
        // than silently dropping it.
        console.warn(`[enrichment] post ${i} REJECTED: ${parsed.rejection_reason}`)
        return {
          ...base,
          post_type:        '',
          calendar_hook:    '',
          scene_brief:      '',
          overlay_text:     null,
          rejected:         true,
          rejection_reason: parsed.rejection_reason,
        } as EnrichedPost
      }
      return {
        ...base,
        post_type:           parsed.post_type,
        calendar_hook:       parsed.calendar_hook,
        scene_brief:         parsed.scene_brief,
        overlay_text:        parsed.overlay_text,
        product_reference:   parsed.product_reference,
        reference_image_url: null,   // populated by the runner via woo_products lookup
      } as EnrichedPost
    }),
  )

  // Don't fail the whole agent run if one enrichment errors — log + skip.
  const out: EnrichedPost[] = []
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    if (r.status === 'fulfilled') {
      out.push(r.value)
    } else {
      console.error(`[enrichment] post ${i} failed:`, r.reason?.message ?? r.reason)
    }
  }
  return out
}
