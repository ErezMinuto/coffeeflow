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

// One additional slide in a multi-slide carousel post. Slide 1 (the cover)
// is always the EnrichedPost.scene_brief itself — additional_slides only
// covers slides 2..N. Phase 3.
export interface AdditionalSlide {
  scene_brief:  string             // English brief for this slide; same Minuto identity, different subject focus
  overlay_text: string | null      // optional Hebrew headline for THIS slide
  image_url:    string | null      // populated on-demand by the dashboard, like the cover
}

export interface EnrichedPost {
  post_index:      number                              // matches posts_to_publish[i]
  intent:          string                              // copy of the canonical intent
  post_type:       keyof typeof SCENE_PRESETS | string // SCENE_PRESETS key or fallback
  aspect:          EnrichedAspect                      // feed_square | reel_cover (drives visual-test)
  calendar_hook:   string                              // 1-phrase moment this post connects to
  scene_brief:     string                              // 4–6 sentence English brief for Gemini (slide 1 = cover for carousels)
  overlay_text:    string | null                       // optional Hebrew text for compositing (slide 1 for carousels)
  scheduled_for:   string                              // ISO datetime in IL time
  // Echo of upstream fields so consumers don't need both shapes:
  upstream_type:   string                              // raw 'post'|'reel'|'carousel'|'story' from the agent
  caption:         string
  hashtags:        string[]
  // Image generated from scene_brief via the visual-test endpoint. Public
  // URL into the `marketing` Storage bucket. Null on rejection or generation
  // failure (the dashboard then shows the brief without an image).
  image_url:       string | null
  // Carousel-only: slides 2..N. Empty/undefined for non-carousel posts.
  // Slide 1 (the cover) is always EnrichedPost.scene_brief above.
  // Total slides in the carousel = 1 + additional_slides.length.
  additional_slides?: AdditionalSlide[]
  // The specific Minuto product the post is about, if any. Haiku extracts the
  // name from caption/topic/hook (e.g. "Dark Chocolate", "Yirgacheffe").
  // Marketing-advisor's runner looks this up in woo_products and stamps the
  // matched image URL onto reference_image_url so visual-test renders the
  // right bag — not always the default Yirgacheffe.
  product_reference?:    string | null
  reference_image_url?:  string | null
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

  const isCarousel = String(post.type ?? '').toLowerCase() === 'carousel'
  const aspectGuidance = aspect === 'reel_cover'
    ? 'The upstream agent picked a Reel or Story (9:16 vertical). Write the brief for the COVER FRAME — the single still that opens the Reel and shows in the grid. The cover frame must obey the Minuto identity exactly the same as a feed post, just composed vertically. Phase 2 will animate this; for now we generate the still cover.'
    : isCarousel
      ? `The upstream agent picked a CAROUSEL (multi-slide post). Write briefs for ALL FIVE SLIDES — the cover (slide 1) goes in scene_brief; slides 2-5 go in additional_slides. Each slide is a separate still photograph, but together they form ONE coherent visual story with strict continuity: same surface material, same light direction, same earth palette, same time of day, same camera distance/style. The viewer scrolls through them as one composition spread across 5 frames. NEVER write text-overlay descriptions, NEVER write infographic/diagram/icon descriptions — every slide is a clean photographic still. The story progresses through the post's narrative: slide 1 sets the mood (hero), slides 2-4 are supporting moments, slide 5 lands the takeaway (often the bag in a final composed beauty shot). MANDATORY: at least one slide (usually the last) prominently shows the Minuto bag.`
      : 'The upstream agent picked a feed post. Write the brief for the hero frame in 1:1.'

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

CRITICAL — YOU ARE A TRANSLATOR, NOT A JUDGE.

The strategist agent upstream is the brand-voice gatekeeper. By the time a
post reaches you, it has already passed brand-voice checks. Your ONLY job
is to translate the post into scene briefs (cover + 4 follow-up slides
for carousels, single hero frame for everything else). You do NOT reject.

There is NO rejection path. NO "rejected: true" output. Every post gets
SUCCESS-shape JSON with scene_brief(s) filled in. If the format feels
challenging — 5-slide educational carousel, video sequence, comparison
spread, infographic, labeled diagram, before/after with measurements —
you ADAPT. The hero frame doesn't have to carry every educational point;
the caption and the additional_slides do.

Adaptation examples — these all return SUCCESS-shape JSON, never anything else:
  - Post = "5-slide carousel: 5 mistakes ruining your latte" → enrichment
    returns a cover + 4 additional_slides, each a clean photographic still
    of one mistake (thermometer at 80°C, milk pitcher with foam too dry,
    etc.). Educational points live in the briefs and overlay_text.
  - Post = "5-slide carousel: signs your beans are stale" → cover still of
    a single Minuto bag with freshness valve visible, plus 4 follow-up
    slides showing roast-date callouts and bean texture. The 5 educational
    points live in the briefs and the caption.
  - Post = "video: green beans → roasting → cooling → packing" → cover
    still of dark-roasted beans on a raw cooling tray with the matched
    Minuto bag in the upper-right third. The process narrative lives in
    the caption.
  - Post = "infographic: machine model → which beans" → cover still of one
    Minuto bag beside one espresso machine, hard side light, lower-right.
    The matching table lives in the caption.
  - Post = "before/after with date stamp" → cover still of a single bag
    next to a freshly cracked bean pile, NO date sticker rendered.

If you find yourself about to reject for ANY reason — "format doesn't fit",
"too many points to capture", "would need motion", "would need multiple
slides", "post compares X to Y", "mentions a competitor" — STOP. Write
the adaptation instead. The strategist already cleared the brand-voice
side of the equation. Trust that and translate.
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

OUTPUT — strict JSON, no other text, no markdown fences. Always the
SUCCESS shape — there is no rejection path:

SUCCESS:
{
  "post_type": "still_life_gift" | "pour_shot" | "origin_still" | "brewing_setup",
  "calendar_hook": "1 short phrase (Hebrew or English ok)",
  "scene_brief": "4–6 sentence ENGLISH photographer's brief, written in the locked Minuto identity. Specific objects, specific composition (lower-right third etc.), specific light direction. NO references to brand voice or copywriting — just the shot. NO competitor brands, NO side-by-side comparison framing. ⛔ NEVER include scoops, spoons, or utensils of any kind in the brief — Minuto's brand identity forbids them; loose beans go directly on the surface or in a small ceramic dish. ⛔ NEVER specify dark/oily/glossy roasted beans — Minuto only roasts light-to-medium, so beans must be light cinnamon brown / matte. MANDATORY: if product_reference is non-null, the brief MUST place the Minuto [product] bag prominently in the composition (e.g. 'a Minuto Guatemala Antigua bag stands in the upper-right third'). Don't write a scene without the bag when we know which product the post is about — that defeats the visual identification. The only exception is a pure pour/in-cup shot where the bag would feel forced; even then, mention 'a Minuto [product] bag visible in soft background'. For carousels: this is the COVER slide (slide 1) — and because the cover will carry a Hebrew title overlay band along the bottom, the brief MUST leave the BOTTOM 1/4 of the frame as low-detail negative space (deep shadow, unbroken raw concrete, or simple ceramic plate edge — no critical subject detail there). The main subject lives in the upper 3/4. Example phrasing to include: '...the lower quarter of the frame is shadowed concrete, kept intentionally empty as breathing space for a Hebrew title.'",
  "overlay_text": null | "Hebrew headline ≤ 40 chars. ⛔ MANDATORY for CAROUSEL COVERS — when additional_slides is non-null, this is the cover-slide title and you MUST set it. Use the post's Hebrew hook (passed in the user message) as the source — refine/shorten to ≤40 chars but keep the core promise intact. Examples: hook 'קפה חלבי לשבועות — איך לעשות קצף שלא נופל תוך 2 דקות' → 'קצף חלב שלא נופל — מדריך לשבועות' (35 chars). DO NOT leave null on a carousel cover — the cover is the hook slide. For NON-carousel posts: null is fine UNLESS the post REALLY needs text (announcing a new origin name, a price/promo, or a recipe ratio). NO disparaging text, NO 'competitor doesn't do X' framing. ⛔ HEBREW UNITS ONLY: when the overlay includes measurements, use Hebrew abbreviations — מ\"ל not 'ml', ס\"מ not 'cm', ג'/גרם not 'g', ק\"ג not 'kg', מעלות not '°C'. Latin/symbol units get bidi-reversed inside Hebrew RTL text and read backwards. Example correct: '60 מ\"ל אספרסו + 150 מ\"ל חלב'. Example wrong: '60ml espresso + 150ml milk' or '60ml אספרסו'.",
  "product_reference": null | "the SPECIFIC Minuto product name as it appears in the post (e.g. 'Dark Chocolate', 'Yirgacheffe', 'Guatemala Antigua', 'Fazenda Sertão'). Use null when the post is generic about coffee/roasting and not about one named product. The downstream pipeline uses this to look up the right bag image as a Gemini reference, so the rendered bag matches the post's product.",
  "additional_slides": null | [
    /* CAROUSELS ONLY: include ALL FOUR slides 2..5 here. NULL or omitted for non-carousel posts. */
    /* Same Minuto identity for every slide. STRICT continuity: same surface, same light direction, same earth palette, same camera style. */
    /* Each entry is for ONE slide. NO text/icon/infographic descriptions — clean photographic stills only. */
    /* SCENE_BRIEF RULES for every slide 2..N — MANDATORY:
       (a) MEASUREMENT-INSTRUMENT VISIBILITY — when the slide depicts a thermometer, digital scale, kitchen
           timer, pressure gauge, or any other measurement instrument, the brief MUST specify that the
           instrument's READING IS VISIBLE TO CAMERA, with the actual value in the brief itself. Examples:
           "a digital probe thermometer clipped to the rim of the milk pitcher displays '62°C' in clear
           white LCD digits, angled toward camera"; "the kitchen scale's display reads '150' in bold
           digital numerals"; "a stopwatch on the counter shows '0:28'". A measurement instrument WITHOUT
           a visible reading teaches nothing — Gemini will render a generic rod-shaped probe and the
           viewer can't tell what they're meant to learn. Always include the angle ("angled toward
           camera" / "tilted so the display faces the lens") so the reading isn't hidden by perspective.
       (b) CTA / CLOSER PAIRING FIDELITY — when the post's slide-5 / closer / CTA copy mentions a product
           in PAIRING with something (e.g. "Guatemala Antigua מתאים מושלם לחלב" → milk pairing,
           "this bean shines in a French press" → press pairing, "vibrant in pour-over" → V60 pairing,
           "perfect cold-brew" → ice/tall-glass pairing), the slide-5 scene_brief MUST visibly INCLUDE
           that pairing element. Milk pairing → a finished cappuccino or flat white WITH visible foam
           microfoam or latte art alongside the bag. Press pairing → a French press with brewed coffee
           visible. Cold-brew → ice cubes + tall clear glass. A bag-and-empty-cup CTA shot loses the
           ENTIRE point of the closer — the viewer needs to see the *result* the CTA is selling. */
    /* OVERLAY_TEXT RULE for every slide 2..N — same Hebrew-units rule as the cover, plus this MANDATORY trigger:
       if the slide's scene_brief contains explicit numerical measurements (e.g. "150 ml", "60-65°C", "18 g", "1:2 ratio", "30 seconds", "20 cm"),
       you MUST set overlay_text to a short Hebrew callout that surfaces those measurements with Hebrew units —
       מ"ל / ס"מ / ג' / גרם / ק"ג / מעלות / שניות / ש' — NOT Latin units (ml/cm/g/kg/°C/sec).
       Examples — correct: '60 מ"ל אספרסו + 150 מ"ל חלב', 'חלב 60-65 מעלות', 'מינון 18 ג׳ ב-30 שניות', 'יחס 1:2'.
       Examples — wrong (do NOT emit): '150ml milk', '60-65°C', '18g/30sec', or null on a measurement slide.
       Instructional / measurement / equipment-reading slides are exactly the case overlay_text exists for — DO NOT leave them null.
       For purely atmospheric or beauty-shot slides with no numbers in the brief, null is still the right default. */
    {
      "scene_brief": "4–6 sentence ENGLISH brief for SLIDE 2. Continuation of the cover's mood — same surface, same light. Different subject focus that progresses the post's narrative.",
      "overlay_text": null | "short Hebrew headline ≤ 40 chars — REQUIRED if this slide's brief contains explicit numerical measurements (see OVERLAY_TEXT RULE above); otherwise null"
    },
    { "scene_brief": "SLIDE 3 brief …", "overlay_text": "same rule — required when brief has measurements, else null" },
    { "scene_brief": "SLIDE 4 brief …", "overlay_text": "same rule — required when brief has measurements, else null" },
    { "scene_brief": "SLIDE 5 brief — the closing beauty shot featuring the Minuto bag prominently as the takeaway. If the post's CTA mentions a product PAIRING (see SCENE_BRIEF RULES above), this slide MUST visibly include that pairing element — finished latte/cappuccino for milk pairing, V60 for pour-over pairing, French press for press pairing, etc. A bag-and-empty-cup shot is INSUFFICIENT when the CTA promises a pairing.", "overlay_text": "same rule — usually null on the closing beauty shot, but required if it carries final numbers (e.g. ratio recap)" }
  ]
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
  { kind: 'success'; post_type: string; calendar_hook: string; scene_brief: string; overlay_text: string | null; product_reference: string | null; additional_slides: AdditionalSlide[] | null }

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
  // Defence-in-depth: if Haiku tries to slip a rejection through despite
  // the prompt forbidding it, we ignore the rejection field. Either Haiku
  // ALSO returned valid scene_brief / post_type alongside (use them) or
  // we return null and the caller will fall back / log.
  if (typeof obj.post_type !== 'string' || typeof obj.scene_brief !== 'string') return null
  // Parse the additional_slides array for carousels — be defensive: only
  // accept entries that have a non-empty scene_brief, drop the rest.
  let additional_slides: AdditionalSlide[] | null = null
  if (Array.isArray(obj.additional_slides) && obj.additional_slides.length > 0) {
    additional_slides = obj.additional_slides
      .filter((s: any) => s && typeof s.scene_brief === 'string' && s.scene_brief.trim().length > 0)
      .map((s: any): AdditionalSlide => ({
        scene_brief:  s.scene_brief.trim(),
        overlay_text: typeof s.overlay_text === 'string' && s.overlay_text.trim() ? s.overlay_text.trim() : null,
        image_url:    null,
      }))
    if (additional_slides.length === 0) additional_slides = null
  }
  return {
    kind: 'success',
    post_type:         obj.post_type,
    calendar_hook:     typeof obj.calendar_hook === 'string' ? obj.calendar_hook : '',
    scene_brief:       obj.scene_brief,
    overlay_text:      typeof obj.overlay_text === 'string' && obj.overlay_text.trim() ? obj.overlay_text.trim() : null,
    product_reference: typeof obj.product_reference === 'string' && obj.product_reference.trim() ? obj.product_reference.trim() : null,
    additional_slides,
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
      // Carousel-only: emit additional_slides 2..N. For non-carousel posts,
      // Haiku may return additional_slides anyway (the prompt asks for null
      // outside carousels) — defensively strip them based on upstream_type
      // so non-carousels never carry slide arrays.
      const carouselSlides =
        upstreamType === 'carousel' && parsed.additional_slides && parsed.additional_slides.length > 0
          ? parsed.additional_slides
          : undefined
      return {
        ...base,
        post_type:           parsed.post_type,
        calendar_hook:       parsed.calendar_hook,
        scene_brief:         parsed.scene_brief,
        overlay_text:        parsed.overlay_text,
        product_reference:   parsed.product_reference,
        reference_image_url: null,   // populated by the runner via woo_products lookup
        additional_slides:   carouselSlides,
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
