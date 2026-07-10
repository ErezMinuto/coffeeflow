import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ASPECT_TO_RATIO,
  Aspect,
  MINUTO_BEANS_REFERENCE_URL,
  MINUTO_ESPRESSO_MACHINE_REFERENCE_URL,
  MINUTO_ROASTER_REFERENCE_URL,
  MINUTO_VISUAL_IDENTITY,
  SCENE_PRESETS,
} from '../_shared/visual_identity.ts'
// pickFallbackBagUrl intentionally NOT imported — caller must specify
// which bag to use via reference_image_url / product_id / product_name.
// Random pool selection was removed 2026-05-16 so the rendered bag
// always matches the product being promoted in the post.
// Compositor kept in repo for selective re-enablement, but not imported
// in the default render path. The architecture pivoted to "Gemini renders
// from bag + style-ref references + bullet-structured prompt" because
// composited PNGs read as 2D-pasted in 3D scenes.

// Pick a random asset URL from a subfolder of upload_images/. The folder
// must already be populated with photos shot on white/uniform backgrounds
// (the flood-fill background-removal pass relies on that). Returns null
// if the folder is empty or unreachable — caller falls back to its
// default behaviour (typically: skip compositing for that object).
async function pickRandomAssetUrl(
  supabase: ReturnType<typeof createClient>,
  category: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('marketing')
    .list(`upload_images/${category}`, { limit: 100, sortBy: { column: 'name', order: 'asc' } })
  if (error || !data || data.length === 0) {
    console.warn(`[visual-test] asset pick "${category}" empty or errored: ${error?.message ?? 'no files'}`)
    return null
  }
  // Filter out folder placeholders (`.emptyFolderPlaceholder`) and any
  // non-image entries that might sneak in.
  const files = data.filter(f => f.name && !f.name.startsWith('.') && /\.(jpg|jpeg|png|webp)$/i.test(f.name))
  if (files.length === 0) return null
  const pick = files[Math.floor(Math.random() * files.length)]
  return `${SUPABASE_URL}/storage/v1/object/public/marketing/upload_images/${category}/${pick.name}`
}

// Test endpoint for the Minuto IG visual identity.
//
// Generates a single still image from a scene brief, anchored to the locked
// Minuto visual identity (style anchor + Minuto bag as reference image).
// Output is uploaded to Supabase Storage and the public URL is returned so
// the caller (or you, manually) can eyeball whether the style anchor is
// producing post-worthy visuals.
//
// The visual identity itself lives in ../_shared/visual_identity.ts so the
// marketing-advisor enrichment step writes scene briefs against the SAME
// anchor that this endpoint generates against — no drift.

// Surface rotation — varies the rendered scene's surface so the feed
// doesn't look mono-textured. Gemini was defaulting to concrete on
// every render despite the visual identity listing multiple surfaces.
// This module picks one explicitly per-render and the prompt injects
// it as an authoritative override. Weights bias toward Minuto-authentic
// surfaces (concrete, dark walnut) but mix in oak and stainless steel
// for variety per the user's request.
const SURFACES: Array<{ name: string; description: string; weight: number }> = [
  { name: 'raw concrete',            description: 'raw imperfect concrete with subtle texture and minor stains, grey-tan tones, slightly worn',         weight: 22 },
  { name: 'weathered dark walnut',   description: 'weathered dark walnut wood with rich visible grain, deep brown chocolate tones, slightly rustic',    weight: 20 },
  { name: 'light grained oak',       description: 'premium light-grained oak wood, warm honey-amber tones, clear visible wood grain, slight matte sheen', weight: 20 },
  { name: 'brushed stainless steel', description: 'brushed stainless steel surface, cool silver-grey tones, subtle reflective sheen, cafe-bar feel',    weight: 14 },
  { name: 'raw lime plaster',        description: 'raw lime plaster surface with subtle texture, off-white to cream tones, soft matte finish',          weight: 12 },
  { name: 'hand-thrown earthenware', description: 'large hand-thrown earthenware platter as surface, deep brown-grey with visible kiln marks',           weight:  7 },
  { name: 'aged copper',             description: 'aged patina copper surface, warm orange-brown with subtle greenish oxidation, vintage feel',         weight:  5 },
]

function pickSurface(): { name: string; description: string } {
  const total = SURFACES.reduce((s, x) => s + x.weight, 0)
  let r = Math.random() * total
  for (const s of SURFACES) {
    if (r < s.weight) return s
    r -= s.weight
  }
  return SURFACES[0]
}

const GEMINI_KEY    = Deno.env.get('GEMINI_API_KEY')
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

interface VisualTestRequest {
  scene_brief?: string                       // free-form scene description
  preset?: keyof typeof SCENE_PRESETS        // shortcut: pick a SCENE_PRESETS key
  aspect?: Aspect                            // default 'feed_square'
  use_reference?: boolean                    // default true; pass false to skip the bag entirely
  // When use_reference is true (the default), one of the following is
  // REQUIRED. Random pool fallback was removed 2026-05-16.
  reference_image_url?: string               // direct URL to a bag photo
  product_id?: number                        // woo_id (numeric WooCommerce product ID); resolved against woo_products.image_url
  product_name?: string                      // text — fuzzy-matched via ILIKE against woo_products.name (same pattern as marketing-advisor enrichment)
  composite_bag?: boolean                    // no-op (kept for backward compat) — compositing was abandoned in favour of bag-as-Gemini-reference rendering
  composite_cup?: boolean                    // no-op (kept for backward compat)
}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405, corsHeaders)
  if (!GEMINI_KEY) return jsonResponse({ error: 'GEMINI_API_KEY not configured' }, 500, corsHeaders)

  try {
    const body = await req.json() as VisualTestRequest
    const sceneBrief = body.scene_brief ?? (body.preset ? SCENE_PRESETS[body.preset] : null)
    if (!sceneBrief) {
      throw new Error(`provide either 'scene_brief' or 'preset' (one of: ${Object.keys(SCENE_PRESETS).join(', ')})`)
    }
    const aspect    = body.aspect ?? 'feed_square'
    const ratio     = ASPECT_TO_RATIO[aspect]
    const useReference = body.use_reference !== false

    // ── Minimal-scene gate ────────────────────────────────────────────────
    // Some briefs explicitly demand a clean single-subject / studio / no-prop
    // shot ("zero beans", "nothing else", "only the glass", "pure product on
    // white"). The default bag_hero scaffolding FIGHTS those: it force-attaches
    // a beans color-anchor + a cups/brewing style-anchor, lists "supporting
    // props", and overrides the brief's surface with a rotated rustic one. That
    // self-contradiction is exactly what made these briefs fail QA 3x and then
    // brief-regen to a HITL cap (real examples: tasks 8421991d, ff7e8c3f,
    // ac72e06d). no_bag briefs already render clean because they skip these
    // refs — this makes a prop-forbidding bag_hero behave the same way: keep
    // the bag, drop the contradicting scaffolding, respect the brief.
    const forbidsProps = /\b(no props|zero props|no secondary|no other objects?|without (?:any )?props|no clutter|no decorative|nothing else|no beans|zero beans|no roasted beans|no cups?|zero cups?|no glassware|zero glassware|no ceramic|sole (?:subject|object|hero)|only the (?:bag|glass|mug|cup|jar)|pure product|seamless (?:white|ivory|cream|backdrop)|studio (?:backdrop|sweep|shot)|product[- ]on[- ]white)\b/.test(sceneBrief.toLowerCase())
    if (forbidsProps) console.log('[visual-test] minimal-scene gate ON — brief forbids props: skipping beans + style refs, deferring surface/composition to the brief')
    // Compositing DISABLED — pivoted to a "Gemini renders bag from reference
    // image + style reference images + bullet-structured prompt" architecture
    // (Erez's test proved Gemini renders the bag faithfully when given a
    // clear single-subject directive, style refs, and structured scene
    // elements; compositing produced a "pasted-on" 2D look the user rejected).
    // Body flags kept for backward compatibility but are no-ops.
    const compositeBag = false

    // Pick a surface for this render. Authoritative override over anything
    // in the brief — keeps feed visually varied across posts.
    const surface = pickSurface()
    console.log(`[visual-test] surface pick: ${surface.name}`)

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)

    // 1. Load reference images. We pass TWO images to Gemini:
    //    a) BAG reference — explicit per-post (e.g. Antigua bag) or
    //       random pick from MINUTO_BAG_REFERENCE_POOL. Anchors how the
    //       Minuto bag should be rendered.
    //    b) BEANS reference — the canonical Minuto bean photo
    //       (MINUTO_BEANS_REFERENCE_URL). Anchors the actual medium-
    //       chestnut roast color so Gemini doesn't drift to too-light
    //       or too-dark on text descriptions alone.
    //    The brandClause (built below) labels both clearly so Gemini
    //    knows which reference is for which subject — preventing the
    //    "composite them awkwardly" failure mode.
    async function fetchAsB64(url: string): Promise<{ data: string; mime: string } | null> {
      try {
        const res = await fetch(url)
        if (!res.ok) {
          console.warn(`[visual-test] reference fetch ${res.status}: ${url}`)
          return null
        }
        const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
        const buf  = new Uint8Array(await res.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        return { data: btoa(bin), mime }
      } catch (e: any) {
        console.warn(`[visual-test] reference fetch error: ${e?.message}`)
        return null
      }
    }

    // Detect whether the scene calls for an espresso machine (espresso
    // brewing / milk steaming). The Strada X reference is ONLY for
    // commercial/cafe content — for "espresso at home" / kitchen-counter
    // scenes, we render a home machine instead (Delonghi/Breville/Gaggia)
    // and we want Gemini to do that WITHOUT a Strada X anchor competing
    // for attention. So we fetch the Strada X ref only when the scene is
    // explicitly cafe/bar/roastery context.
    const sceneLowerForMachine = sceneBrief.toLowerCase()
    const espressoSceneRegex = /\b(espresso machine|steam wand|portafilter|group head|grouphead|naked portafilter|bottomless portafilter|la marzocco|strada|milk steaming|steaming milk|microfoam|milk frothing|frothing milk|latte art|cappuccino|flat white|latte\b|espresso shot|pulling (?:a |the |an )?shot|brew group)\b/.test(sceneLowerForMachine)
    const homeContextRegex = /\b(at home|home espresso|home setup|home barista|home brewing|home machine|kitchen counter|kitchen|on the counter|בבית|במטבח|בדירה|בית|מטבח)\b/.test(sceneLowerForMachine)
    const cafeContextRegex = /\b(cafe|bar|roastery|behind the bar|on the bar|in the shop|at the cafe|barista at work|במינוטו|בבית הקפה|במאפיה|בקפה)\b/.test(sceneLowerForMachine)
    // Use Strada X only for commercial scenes. For home or ambiguous
    // espresso scenes we let Gemini render a generic home machine guided
    // by the EQUIPMENT-BY-BREWING-METHOD rule in visual_identity.
    const useStradaXReference = espressoSceneRegex && cafeContextRegex && !homeContextRegex
    // Roaster reference — attach Minuto's actual Coffee-Tech machine photo
    // when the brief mentions the roaster, the roastery, the cooling tray,
    // roast-day moments, or fresh beans coming off the cooler. Without
    // this, Gemini hallucinates generic vintage Probat-style copper
    // roasters with "COFFEE-TECH" text rendered as visible labels.
    const roasterSceneRegex = /\b(roaster|roastery|drum roaster|coffee-tech|cooling tray|cooler tray|roast day|roasting|מקלה|בית קלייה|בית הקלייה|מכונת קלייה|תוף קלייה|פולים יוצאים|קירור|מקרר פולים)\b/.test(sceneLowerForMachine)

    let bagRef:     { data: string; mime: string } | null = null
    let beansRef:   { data: string; mime: string } | null = null
    let machineRef: { data: string; mime: string } | null = null
    let roasterRef: { data: string; mime: string } | null = null
    let bagUrl:     string | null = null
    let bagSource:  'reference_image_url' | 'product_id' | 'product_name' | null = null
    if (useReference) {
      // Resolve which specific bag image to use. Random pool fallback was
      // removed 2026-05-16 — caller MUST pass one of reference_image_url,
      // product_id, or product_name so the rendered bag matches the
      // product being promoted in the post.
      if (body.reference_image_url) {
        bagUrl = body.reference_image_url
        bagSource = 'reference_image_url'
      } else if (typeof body.product_id === 'number' && Number.isFinite(body.product_id)) {
        const { data, error } = await supabase
          .from('woo_products')
          .select('name, image_url')
          .eq('woo_id', body.product_id)
          .not('image_url', 'is', null)
          .limit(1)
          .maybeSingle()
        if (error) {
          return jsonResponse({ error: `woo_products lookup failed for product_id=${body.product_id}: ${error.message}` }, 500, corsHeaders)
        }
        if (!data?.image_url) {
          return jsonResponse({ error: `no woo_products row with woo_id=${body.product_id}, or that row has no image_url` }, 400, corsHeaders)
        }
        bagUrl = data.image_url as string
        bagSource = 'product_id'
        console.log(`[visual-test] resolved product_id=${body.product_id} → "${data.name}" → ${bagUrl}`)
      } else if (body.product_name && body.product_name.trim().length >= 2) {
        const needle = body.product_name.trim()
        const { data, error } = await supabase
          .from('woo_products')
          .select('name, image_url')
          .ilike('name', `%${needle}%`)
          .not('image_url', 'is', null)
          .limit(1)
          .maybeSingle()
        if (error) {
          return jsonResponse({ error: `woo_products lookup failed for product_name="${needle}": ${error.message}` }, 500, corsHeaders)
        }
        if (!data?.image_url) {
          return jsonResponse({ error: `no woo_products name match for "${needle}" with a non-null image_url` }, 400, corsHeaders)
        }
        bagUrl = data.image_url as string
        bagSource = 'product_name'
        console.log(`[visual-test] resolved product_name="${needle}" → "${data.name}" → ${bagUrl}`)
      } else {
        return jsonResponse({
          error: 'must provide one of: reference_image_url (direct URL), product_id (numeric WooCommerce woo_id), or product_name (text — fuzzy matched against woo_products.name). The function no longer falls back to a random bag. To skip the bag entirely, pass use_reference:false.',
        }, 400, corsHeaders)
      }
      // All references pass as Gemini inlineData. Bag is always-on
      // (primary subject), beans always-on (color anchor), machine
      // conditional on a commercial-context espresso scene.
      const [b1, b2, b3, b4] = await Promise.all([
        fetchAsB64(bagUrl),
        forbidsProps ? Promise.resolve(null) : fetchAsB64(MINUTO_BEANS_REFERENCE_URL),
        useStradaXReference  ? fetchAsB64(MINUTO_ESPRESSO_MACHINE_REFERENCE_URL) : Promise.resolve(null),
        roasterSceneRegex    ? fetchAsB64(MINUTO_ROASTER_REFERENCE_URL)          : Promise.resolve(null),
      ])
      bagRef     = b1
      beansRef   = b2
      machineRef = b3
      roasterRef = b4
      console.log(`[visual-test] refs loaded — bag: ${bagRef ? 'OK' : 'MISS'}, beans: ${beansRef ? 'OK' : 'MISS'}, machine: ${machineRef ? 'OK' : (useStradaXReference ? 'MISS' : 'N/A')}, roaster: ${roasterRef ? 'OK' : (roasterSceneRegex ? 'MISS' : 'N/A')}, espresso=${espressoSceneRegex}/home=${homeContextRegex}/cafe=${cafeContextRegex}/roaster=${roasterSceneRegex}`)
    }
    // Tracks whether the brandClause should describe the bag. True both
    // when Gemini will render the bag (legacy) AND when we're compositing
    // (so Gemini knows to LEAVE the region empty for the paste).
    const bagInScene = useReference && !!bagUrl

    // Cup compositing also DISABLED (see compositeBag note above). Cup is
    // now optionally passed as a STYLE REFERENCE for Gemini to use as an
    // aesthetic anchor, not as a pasted-on object.
    const compositeCup = false
    const cupInScene = false

    // Pick 1 style reference from the user's photo library based on the
    // scene content. The reference is passed to Gemini alongside the bag
    // so Gemini matches the actual surface, lighting, props, and atmosphere
    // of Minuto's real photos instead of inventing them. This is what
    // Erez did manually in his successful test (image_0.png, image_1.png).
    // Returns null if the relevant subfolder is empty; the function then
    // proceeds without a style reference (still works, slightly less
    // anchored).
    async function pickStyleReferenceUrl(brief: string): Promise<string | null> {
      const b = brief.toLowerCase()
      let category = 'cups'
      if (/\b(espresso shot|pulling.*shot|tamping|portafilter)\b/.test(b))    category = 'hands'
      else if (/\b(latte art|cappuccino|microfoam|frothing|steaming|milk pitcher)\b/.test(b)) category = 'hands'
      else if (/\b(pour.over|v60|chemex|drip|filter coffee|aeropress|french press)\b/.test(b)) category = 'brewing'
      else if (/\b(beans|roasted|cooling tray|green beans|cupping)\b/.test(b)) category = 'beans'
      else if (/\b(roaster|roastery|behind.the.scenes|drum roaster)\b/.test(b)) category = 'roaster'
      else if (/\b(barista|behind the bar|in the cafe|in the shop|at the cafe)\b/.test(b)) category = 'hands'
      else if (/\b(milk|pitcher)\b/.test(b)) category = 'pitchers'
      else if (/\b(espresso|cappuccino|latte|macchiato|flat white|cortado|americano|cup|demitasse)\b/.test(b)) category = 'cups'
      const url = await pickRandomAssetUrl(supabase, category)
      if (url) console.log(`[visual-test] style ref pick: ${category} → ${url}`)
      else     console.log(`[visual-test] style ref pick: ${category} → empty, no style ref used`)
      return url
    }

    const styleRefUrl = (useReference && !forbidsProps) ? await pickStyleReferenceUrl(sceneBrief) : null
    let styleRef: { data: string; mime: string } | null = null
    if (styleRefUrl) {
      styleRef = await fetchAsB64(styleRefUrl)
    }

    // 2. Build the prompt.
    // Detect briefs that explicitly downplay the bag — instructional /
    // measurement / equipment-focused slides where forcing a prominent bag
    // hijacks the frame and steals attention from the actual subject
    // (steam wand, scale, thermometer, portafilter, etc.).
    const sceneLower = sceneBrief.toLowerCase()
    const bagDownplayed = /\b(no bag|without (?:the |a )?bag|bag (?:is |should be )?(?:softly )?blurred|bag (?:in (?:the )?)?background|bag (?:is )?out of focus|bag barely cropped|bag minor|no minuto bag)\b/.test(sceneLower)

    // Build reference-image descriptions in the order they're passed to
    // Gemini. The bag is ALWAYS FIRST and gets the strongest retention
    // language — it's the brand-critical element. Style ref (from the
    // user's photo library) comes next when present so Gemini matches
    // the actual Minuto aesthetic. Beans and machine come after as
    // color/detail anchors when relevant.
    const refDescriptions: string[] = []
    if (bagRef) {
      refDescriptions.push(`reference image — the MINUTO BAG. The bag in this attached image IS the bag to render. Treat it as the source of truth: look at the image and copy it faithfully — do NOT redesign, recolor, restyle, or re-imagine it based on prompt text. The reference is the authority, the prompt is just context.
${bagDownplayed
  ? '\nThe SCENE brief downplays the bag — keep it minor or omit it entirely.'
  : '\nThe bag is the HERO subject of the photograph unless the brief specifies an equipment-led scene.'}
Hard constraints (just in case the model is tempted to deviate): no invented label artwork, no added date stamps or batch numbers on the bag, no color changes.`)
    }
    if (styleRef) {
      refDescriptions.push(`reference image — STYLE ANCHOR. Real photo from Minuto's library showing the actual surface, lighting, prop styling, and atmosphere we want to match. Use this image as a visual reference for:
   ✓ Surface texture and material (the wood/concrete/metal in this image is what the scene should sit on)
   ✓ Light direction, color temperature, and shadow quality
   ✓ Cup shape, prop styling, and arrangement language
   ✓ Overall photographic mood
DO NOT copy this image's composition — only the visual language. The bag from the FIRST reference image is still the main subject; this STYLE ANCHOR informs the supporting elements.`)
    }
    if (beansRef) {
      refDescriptions.push(`reference image — BEAN COLOR ANCHOR. Real photo of Minuto's roasted beans showing their true color. Use this AS A COLOR ANCHOR ONLY (do not copy the composition). When you render any roasted coffee beans in the output, MATCH THE COLOR: medium chestnut brown with subtle warm/auburn undertones, matte finish.`)
    }
    if (machineRef) {
      refDescriptions.push(`reference image — MINUTO ESPRESSO MACHINE. Real photo of Minuto's 2-group La Marzocco Strada X. Use it as a COLOR + DETAIL anchor, NOT a full-silhouette template. When any part of the machine appears, match: slate/gunmetal MATTE body, pale-blue TRANSLUCENT GLASS teardrop side panel (only on the side glass — never on the front panel), naked portafilters with BLACK handles and small RED accent rings, chrome cool-touch steam wands curving outward from the SIDES of the body, raised stainless wire-grate cup tray on top, "La Marzocco" wordmark on the drip-tray front plate. Render PARTIAL crops only (wand + sliver of side panel, portafilter + group head fragment, cup-tray close-up) — never the full chassis. Forbidden: generic chrome Linea silhouette.`)
    }
    if (roasterRef) {
      refDescriptions.push(`reference image — MINUTO COFFEE ROASTER. Real photo of Minuto's actual Coffee-Tech Engineering compact drum roaster. Use it as a SHAPE + FINISH anchor — the roaster you render MUST visually match this image, not a generic Probat-style copper unit. Key features to preserve: TWO-TONE finish (matte-black lower body and side panels, BRUSHED STAINLESS STEEL upper drum cover and stainless drum face), tall stainless conical hopper sitting on top, large stainless exhaust chimney rising straight up from the upper-left, vertical compact silhouette (taller than wide, NOT a wide horizontal industrial unit), SEPARATE round shallow stainless cooling tray attached at mid-height on the RIGHT side (much smaller diameter than the drum body) with a rotating stainless arm crossing it. ⛔ NO visible manufacturer text or badge — the "COFFEE-TECH ENGINEERING" lettering on the real machine MUST NOT be rendered as readable text in the output (no readable letters on the hopper, drum cover, cooling tray rim, or anywhere). ⛔ NEVER render a vintage Probat copper roaster, NEVER an antique brass roaster, NEVER a "fully matte black" all-black Diedrich/Loring box (Minuto's machine has the prominent brushed-stainless upper section — getting it all-black is wrong).`)
    }

    const ordinal = (i: number) => ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'][i] ?? `#${i + 1}`
    const referencesBlock = refDescriptions.length > 0
      ? `\n\nREFERENCE IMAGES (${refDescriptions.length} attached, read each carefully):\n\n${refDescriptions.map((d, i) => `${ordinal(i)} ${d}`).join('\n\n')}`
      : ''

    const fullPrompt = `${MINUTO_VISUAL_IDENTITY}

🎯 PRIMARY DIRECTIVE
Create a high-resolution, photorealistic lifestyle product photograph at ${ratio} aspect ratio, featuring the Minuto coffee bag from the FIRST attached reference image as the hero subject. Retain ALL text, branding, and design features of the bag exactly as shown in the reference image — the bag in the output must be identifiable as the same specific Minuto product (same color, same label artwork, same proportions, same wordmark placement).

SCENE BRIEF — interpret this as the structured elements below:
${sceneBrief}

INTERPRET THE BRIEF AS A STRUCTURED PHOTOGRAPH:

• MAIN SUBJECT — the Minuto bag (FIRST reference image), positioned ${forbidsProps ? 'exactly as the SCENE BRIEF specifies — centered and filling the frame if the brief asks for that' : 'per the brief or per the Minuto identity composition rules (lower-right or upper-right third, never centered)'}.
• SUPPORTING PROPS — ${forbidsProps ? 'NONE beyond what the SCENE BRIEF explicitly names. Do NOT add cups, beans, glassware, brewing gear, hands, or any decorative element the brief did not ask for. If the brief says the subject stands alone, render it alone on an empty surface.' : 'cups, beans, brewing equipment, hands, milk pitchers, etc. as the brief describes. Where a STYLE ANCHOR reference is included, match its visual language for prop styling.'}
• LIGHTING & SHADOWS — ONE warm directional light from upper-right of frame. Hard, contrasty side-shadows fall diagonally toward lower-left. Deep shadow occupies a meaningful part of the frame.
• SURFACE — ${forbidsProps ? 'use the surface described in the SCENE BRIEF exactly as written (e.g. a seamless white studio sweep). Do NOT substitute a different material.' : `**${surface.description}**. Uniform across the entire frame. THIS SURFACE IS AUTHORITATIVE — it overrides any surface mentioned in the SCENE BRIEF above. The bag, cups, beans, and all props rest on THIS specific surface, nothing else.`}
• ATMOSPHERE — tranquil, considered, photo-essay feel. Earth-tone palette only (deep brown, raw concrete grey, dusty olive, cream, tan, warm amber, charcoal). Slight Kodak Portra 400 film grain.
• FOCUS — the Minuto bag is dominant; supporting props secondary; background softly out of focus.
• COMPOSITION — ${forbidsProps ? 'follow the SCENE BRIEF. A centered, symmetric studio composition is correct when the brief asks for it. Keep generous negative space around the subject.' : 'asymmetric, anchored in lower-right or upper-right third, never centered hero. At least 30% intentional negative space.'}${referencesBlock}

FORMAT: ${ratio} aspect ratio, photorealistic, high resolution.

⛔ FINAL OVERRIDE — read this LAST and let it overrule the SCENE
description above wherever they conflict:

🔒 SUBJECT-LOCK: when the SCENE brief names specific equipment — steam
wand, portafilter, espresso machine group head, thermometer, milk
pitcher (with or without thermometer probe), digital scale, measuring
vessel/jug, V60, Chemex, AeroPress, French press, gooseneck kettle,
tamper, knock box — that piece of equipment IS THE SUBJECT of the
frame. Render it clearly, in focus, dominant. Do NOT substitute it
with generic Minuto bag-and-cup product photography. Do NOT swap one
piece of equipment for another (e.g. NEVER render a brass gooseneck
kettle when the brief calls for a steam wand — those are different
brewing contexts). If the brief says "steam wand frothing milk in a
pitcher", show exactly that. If the brief says "digital scale reading
150ml", show exactly that. The named subject MUST be the rendered
subject — every time.

🔧 EQUIPMENT ANATOMY — espresso parts must connect correctly.
Real-world physics, not arbitrary attachment:

  • A STEAM WAND is a thin chrome tube tipped with a small steam tip.
    It attaches to the SIDE of an espresso machine's body, angled
    downward into a milk pitcher. A steam wand NEVER comes out of a
    portafilter, NEVER comes out of a group head, NEVER floats in the
    air, NEVER grows from a milk pitcher's body. If a steam wand is
    in frame, the espresso machine's chrome body or side panel MUST
    also be in frame (at minimum: the side of the machine where the
    wand attaches, even if cropped). The wand enters the milk pitcher
    from above, not from below — its tip is submerged just below the
    milk surface to create microfoam.

  • ⛔⛔⛔ A STEAM WAND DOES NOT POUR LIQUID. A steam wand outputs
    INVISIBLE PRESSURIZED STEAM — not milk, not coffee, not water, not
    any visible falling stream. NO white stream falls from the wand
    tip. NO liquid arc connects the wand tip to a cup. NO milk drops
    from a wand. If you find yourself rendering a chrome wand with a
    white stream falling from its tip into a cup BELOW it — STOP, that
    is wrong, redraw. The wand tip in a steaming-milk scene is
    SUBMERGED INSIDE a stainless steel pitcher (you see the wand
    disappear into the pitcher from above); if the wand tip is exposed
    in frame it is IDLE, dry, with at most a faint wisp of pale vapor.
    This is the single most common AI-coffee failure mode and an
    automatic image reject — explicitly do not generate it.

  • ⛔⛔⛔ MILK SOURCE LOCK — if milk appears in a cup in the frame,
    or a stream of milk is mid-air entering a cup, the SOURCE of that
    milk MUST be a STAINLESS STEEL MILK PITCHER held by a HAND. The
    pitcher is a small metal jug with a pointed pour spout and a
    handle, gripped by fingers entering from a frame edge. The milk
    stream flows from the pitcher's pointed spout to the cup. The
    source is NEVER a steam wand, NEVER a milk carton, NEVER a bottle,
    NEVER a faucet, NEVER an unspecified void. If a cappuccino, latte,
    flat white, or macchiato is the finished drink in the cup, the
    milk is already integrated with latte art on top — there is no
    active pour at all. Active milk pours come from a hand-held
    stainless pitcher, period.

  • A PORTAFILTER is a metal basket holder with a horizontal handle
    (usually black or wood). The basket end either: (a) locks UPWARD
    into the underside of an espresso machine's group head — chrome
    cylindrical fixture protruding from the front of the machine — OR
    (b) sits on a counter/tamping mat with the handle extending
    horizontally and a hand gripping it, OR (c) is held mid-air by a
    hand entering from frame edge. A portafilter NEVER has a steam
    wand attached, NEVER floats, NEVER points downward without
    support. Espresso, when shown pouring, comes from TWO SPOUTS at
    the bottom of the portafilter basket as twin amber streams into a
    cup placed below.

  • A GROUP HEAD is the chrome cylindrical fixture protruding
    horizontally from the front of an espresso machine, at chest
    height. The portafilter locks into it from below. Steam wands do
    not come out of group heads — they come out of the machine's side.

  • If the brief implies espresso brewing or milk steaming, the
    espresso machine body should be visible in frame (or at least
    cropped at frame edge with enough chrome/panel showing to anchor
    the equipment). Detached floating espresso parts read as wrong.

  • ${machineRef ? `STRADA X PARTIAL-REVEAL RULE: a third reference image of
    Minuto's actual La Marzocco Strada X is included. Use it as a
    COLOR + DETAIL anchor, NOT as a full-silhouette template. Gemini
    cannot reliably reproduce the Strada X's full chassis shape from
    a single product photo, so the rendered scene MUST show only
    PARTIAL elements of the machine, never the full silhouette:

      ✓ Steam wand curving out from a sliver of slate side panel,
        with the pale-blue glass wing visible on that panel.
      ✓ Naked portafilter docked into one chrome group head, plus
        a fragment of the front panel and "La Marzocco" wordmark.
      ✓ Tight crop on the brushed-steel cup tray with one ceramic cup,
        a glimpse of group head behind.
      ✓ Side-on close-up of the pale-blue translucent glass teardrop
        wing alone, with the slate body fading into shadow.

    ✗ Forbidden: full front-on view of the entire 2-group chassis.
    ✗ Forbidden: pale blue painted across the WHOLE machine body —
      blue belongs ONLY on the translucent side glass, never on the
      front panel or the main chassis.
    ✗ Forbidden: generic Linea silhouette (chrome curved body, single
      group, narrow profile) — Strada X is angular and modern, but
      because we can't reliably render it whole, we crop instead.

    Use the reference image's COLORS (slate-grey matte body, pale-blue
    translucent glass, black portafilter handles, RED accent ring at
    the spout base, chrome group caps, "La Marzocco" wordmark on the
    drip-tray plate) — not its overall shape. The shape is hard;
    cropping is reliable.` : 'No machine reference image is included for this scene (the scene does not call for an espresso machine).'}

If the SCENE description mentions a scoop, brass scoop, wooden spoon,
espresso spoon, measuring scoop, or any other utensil, IGNORE that
portion of the description and omit the utensil entirely. Loose beans
go directly on the surface or in a small ceramic dish — never in a
scoop. EXCEPTION: a brass gooseneck kettle is allowed ONLY when the
SCENE brief is about pour-over / V60 / Chemex / drip / filter brewing.
For any other context — espresso, milk frothing, latte/cappuccino,
grinding, packaging, beans-only stills — do NOT introduce a brass
gooseneck kettle.

If the SCENE description mentions dark roasted, dark beans,
dark-roasted, glossy beans, oily beans, OR raw green beans / unroasted
beans / pale tan beans / cardboard-colored beans, IGNORE that portion.
Render beans as MEDIUM ROAST — pecan brown / roasted hazelnut shell /
medium walnut / lighter milk chocolate. Matte, dry, never glossy.
Goldilocks: NOT pale-tan/cardboard/wheat (too light, looks underroasted),
NOT dark chocolate/espresso/black (too dark, looks french-roast),
NOT green/sage (not roasted at all). The target is clearly medium-roasted
coffee — chestnut brown with subtle warm undertones.

If the SCENE description specifies a ceramic cup but the brewing method
implied is filter / V60 / Chemex / pour-over, render a thin clear-glass
cup instead. Espresso/cappuccino keeps the small unglazed ceramic cup.

These rules WIN over anything in the SCENE description. The prior
text is inspiration; these are mandatory.`

    // 3. Call Gemini 2.5 Flash Image. Pass references in the order the
    //    brandClause describes them — BAG, STYLE, BEANS, MACHINE — so
    //    Gemini matches the ordinal labels to the right images.
    const parts: any[] = []
    if (bagRef)     parts.push({ inlineData: { mimeType: bagRef.mime,     data: bagRef.data } })
    if (styleRef)   parts.push({ inlineData: { mimeType: styleRef.mime,   data: styleRef.data } })
    if (beansRef)   parts.push({ inlineData: { mimeType: beansRef.mime,   data: beansRef.data } })
    if (machineRef) parts.push({ inlineData: { mimeType: machineRef.mime, data: machineRef.data } })
    if (roasterRef) parts.push({ inlineData: { mimeType: roasterRef.mime, data: roasterRef.data } })
    parts.push({ text: `Generate an image: ${fullPrompt}` })

    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        }),
      },
    )
    if (!genRes.ok) {
      const errText = await genRes.text().catch(() => '')
      throw new Error(`Gemini ${genRes.status}: ${errText.slice(0, 300)}`)
    }
    const genJson = await genRes.json()

    let imageB64: string | null = null
    let imageMime = 'image/png'
    for (const part of genJson.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        imageB64 = part.inlineData.data
        imageMime = part.inlineData.mimeType
        break
      }
    }
    if (!imageB64) {
      throw new Error(`Gemini returned no image. Raw: ${JSON.stringify(genJson).slice(0, 400)}`)
    }

    // 3.5 Post-processing — compositing is DISABLED. The Gemini output is
    //     the final image; we trust the reference images + bullet-structured
    //     prompt to produce a properly-integrated scene. If quality issues
    //     resurface, the compositor module + flags remain in the codebase
    //     for selective re-enablement, but the default is "Gemini renders
    //     everything from references."
    const bagComposited = false
    const cupComposited = false
    const composited    = false

    // 4. Upload to Supabase Storage `marketing` bucket under a dated path so
    //    multiple test runs don't overwrite each other.
    const ext      = imageMime.includes('jpeg') ? 'jpg' : 'png'
    const filename = `ig-test/${aspect}_${Date.now()}.${ext}`
    const fileBytes = Uint8Array.from(atob(imageB64), c => c.charCodeAt(0))

    const { error: upErr } = await supabase.storage
      .from('marketing')
      .upload(filename, fileBytes, { contentType: imageMime, upsert: true })
    if (upErr) throw new Error(`storage upload: ${upErr.message}`)

    const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

    return jsonResponse({
      success: true,
      url: pub.publicUrl,
      aspect,
      ratio,
      bytes: fileBytes.length,
      used_reference: bagInScene,
      composited_bag: bagComposited,
      composited_cup: cupComposited,
      composited: composited,
      surface: surface.name,
      style_ref: styleRefUrl,
      scene_brief: sceneBrief,
      bag_url: bagUrl,
      bag_source: bagSource,
    }, 200, corsHeaders)

  } catch (err: any) {
    console.error('[visual-test] error:', err?.message)
    return jsonResponse({ error: err?.message ?? String(err) }, 500, corsHeaders)
  }
})

function jsonResponse(body: unknown, status: number, cors: Record<string,string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
