import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ASPECT_TO_RATIO,
  Aspect,
  MINUTO_BEANS_REFERENCE_URL,
  MINUTO_ESPRESSO_MACHINE_REFERENCE_URL,
  MINUTO_VISUAL_IDENTITY,
  SCENE_PRESETS,
  pickFallbackBagUrl,
} from '../_shared/visual_identity.ts'

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

const GEMINI_KEY    = Deno.env.get('GEMINI_API_KEY')
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

interface VisualTestRequest {
  scene_brief?: string                       // free-form scene description
  preset?: keyof typeof SCENE_PRESETS        // shortcut: pick a SCENE_PRESETS key
  aspect?: Aspect                            // default 'feed_square'
  use_reference?: boolean                    // default true; pass false to skip the bag
  reference_image_url?: string               // override the default Yirgacheffe bag with a specific product image
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

    // Detect whether the scene calls for the Strada X (espresso brewing /
    // milk steaming). Only then do we fetch + pass the machine reference —
    // for pour-over, beans-only stills, lifestyle gift shots etc., the
    // machine has no business in the frame.
    const sceneLowerForMachine = sceneBrief.toLowerCase()
    const espressoSceneRegex = /\b(espresso machine|steam wand|portafilter|group head|grouphead|naked portafilter|bottomless portafilter|la marzocco|strada|milk steaming|steaming milk|microfoam|milk frothing|frothing milk|latte art|cappuccino|flat white|latte\b|espresso shot|pulling (?:a |the |an )?shot|brew group)\b/.test(sceneLowerForMachine)

    let bagRef:     { data: string; mime: string } | null = null
    let beansRef:   { data: string; mime: string } | null = null
    let machineRef: { data: string; mime: string } | null = null
    if (useReference) {
      const bagUrl = body.reference_image_url || pickFallbackBagUrl()
      // Fetch refs in parallel — independent network calls. Machine ref
      // is conditional on the espresso/milk-steam scene detection above.
      const [b1, b2, b3] = await Promise.all([
        fetchAsB64(bagUrl),
        fetchAsB64(MINUTO_BEANS_REFERENCE_URL),
        espressoSceneRegex ? fetchAsB64(MINUTO_ESPRESSO_MACHINE_REFERENCE_URL) : Promise.resolve(null),
      ])
      bagRef     = b1
      beansRef   = b2
      machineRef = b3
      console.log(`[visual-test] refs loaded — bag: ${bagRef ? 'OK' : 'MISS'}, beans: ${beansRef ? 'OK' : 'MISS'}, machine: ${machineRef ? 'OK' : (espressoSceneRegex ? 'MISS' : 'N/A')}`)
    }
    const referenceB64 = bagRef?.data ?? null  // kept for downstream brandClause check

    // 2. Build the prompt.
    // Detect briefs that explicitly downplay the bag — instructional /
    // measurement / equipment-focused slides where forcing a prominent bag
    // hijacks the frame and steals attention from the actual subject
    // (steam wand, scale, thermometer, portafilter, etc.).
    const sceneLower = sceneBrief.toLowerCase()
    const bagDownplayed = /\b(no bag|without (?:the |a )?bag|bag (?:is |should be )?(?:softly )?blurred|bag (?:in (?:the )?)?background|bag (?:is )?out of focus|bag barely cropped|bag minor|no minuto bag)\b/.test(sceneLower)
    const brandClause = referenceB64 ? `

REFERENCE IMAGES (TWO included with this prompt — read carefully which is which):

FIRST reference image (the BAG): the actual Minuto coffee bag.
${bagDownplayed
  ? `The SCENE brief above explicitly downplays the bag (e.g. "no bag",
"softly blurred", "in the background", "out of focus", "barely cropped").
RESPECT THAT. Keep the bag minor or omit it entirely if the brief asks.
The instructional/measurement subject of the scene MUST dominate the
frame — do NOT let the bag steal focus from steam wands, scales,
thermometers, portafilters, or other named equipment.`
  : `Feature the bag prominently when the SCENE brief calls for it or
when the scene is a generic product/lifestyle shot without a more
specific instructional subject. If the scene's primary subject is a
piece of equipment (steam wand, digital scale, thermometer, portafilter,
milk pitcher with probe, measuring vessel), keep the bag MINOR — soft
background presence, edge of frame, or omit. The bag should never
dominate an instructional carousel slide whose job is to show a measurement
or technique.`}
When the bag does appear, match the reference image EXACTLY. The bag
is a FAITHFUL COPY of the reference image — same WHITE pouch colour
(never black, never grey, never coloured), same zip-top stand-up pouch
shape, same stag-head emblem in the same position, same "MINUTO Café
Roastery" wordmark, same colored center-label artwork (the exact
illustration from the reference — green starry pattern for Velvet Star,
green mountain panel for Guatemala Antigua, etc.).

🚫 ABSOLUTELY DO NOT INVENT BAG ARTWORK. Specifically forbidden:
  • Tropical / animal illustrations (parrots, toucans, leaves, fruit)
  • Holographic, iridescent, gradient, or rainbow-foil label finishes
  • Replacement of the white bag colour with black, dark grey, or any
    other coloured pouch
  • Multi-panel labels split into different artwork sections
  • Generic "specialty coffee" badges, certifications, or trust marks
  • Decorative elements not visible in the reference image

If the reference image's label artwork is hard to read at small size,
keep it simple — just the stag + wordmark + a soft impression of the
colored panel. NEVER fill in invented detail.

Do NOT add any printed dates, roast-date stamps, batch numbers, expiry
stickers, or numerical labels to the bag. Only the brand wordmark, stag
emblem, and origin/blend name are allowed.

SECOND reference image (the BEANS): real photo of Minuto's actual
roasted beans showing their true color. Use this image AS A COLOR
ANCHOR ONLY — do NOT copy the composition (which is a top-down close-up
filling the frame). When you render any roasted coffee beans in the
output, MATCH THE COLOR of the beans in this second reference: medium
chestnut brown with subtle warm/auburn undertones, matte finish, visible
center crease. NOT the composition, ONLY the color. This second image
is "what color should the beans be" — it overrides any color description
elsewhere in the prompt.${machineRef ? `

THIRD reference image (the MACHINE): real photo of Minuto's actual bar
espresso machine — a 2-group La Marzocco Strada X. This image is
included ONLY for scenes involving espresso brewing or milk steaming.
Use it AS A SHAPE-AND-COLOR ANCHOR for the machine — match these
distinctive features exactly when any part of the machine appears:
  • Body color: SLATE / dark gunmetal grey, MATTE finish (NOT chrome,
    NOT mirror-polished, NOT white).
  • The signature PALE-BLUE TRANSLUCENT GLASS teardrop side panel set
    into the grey body — must appear if the side of the machine is in
    frame. Sky-blue / powder-blue, not opaque, not dark.
  • Two saturated brew groups protruding forward with rounded chrome
    top caps; naked / bottomless portafilters with BLACK handles and a
    small RED accent ring at the spout base.
  • Cool-touch articulated chrome steam wands curving outward from the
    SIDES of the machine body (one per side), NOT from the front.
  • Raised stainless wire-grate cup tray on top, supported by thin
    chrome rails.
  • "La Marzocco" wordmark on the drip-tray front plate.
Do NOT copy the reference image's white-background product-shot
composition — only the machine's appearance. Do NOT render a generic
chrome Linea silhouette; the Strada X is visually distinct.` : ''}` : ''

    const fullPrompt = `${MINUTO_VISUAL_IDENTITY}

SCENE: ${sceneBrief}${brandClause}

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

    // 3. Call Gemini 2.5 Flash Image (proven model for reference-conditioned
    //    image edits in this project — same one the blog banner uses).
    //    Pass references in the order the brandClause describes them:
    //    BAG first, BEANS second.
    const parts: any[] = []
    if (bagRef)     parts.push({ inlineData: { mimeType: bagRef.mime,     data: bagRef.data } })
    if (beansRef)   parts.push({ inlineData: { mimeType: beansRef.mime,   data: beansRef.data } })
    if (machineRef) parts.push({ inlineData: { mimeType: machineRef.mime, data: machineRef.data } })
    parts.push({ text: `Generate an image: ${fullPrompt}` })

    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
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
      used_reference: !!referenceB64,
      scene_brief: sceneBrief,
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
