import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Image } from 'https://deno.land/x/imagescript@1.2.17/mod.ts'
import {
  ASPECT_TO_RATIO,
  Aspect,
  SCENE_PRESETS,
  MINUTO_ROASTER_REFERENCE_URL,
  MINUTO_ESPRESSO_MACHINE_REFERENCE_URL,
} from '../_shared/visual_identity.ts'
import {
  BAG_REGION,
  BAG_REGION_PROMPT,
  compositeProductIntoScene,
} from '../_shared/compositor.ts'
import { getVertexAccessToken, getVertexConfig } from '../_shared/vertex_auth.ts'

// Vertex AI Imagen edit pipeline using a MULTI-STAGE COMPOSITE workflow.
//
// Architecture (decided 2026-05-16 after exhausting SUBJECT customization
// and BGSWAP attempts):
//
//   Stage 0 — Visual Director (Gemini Flash) reads the bag image and
//             invents a per-bag editorial environment prompt.
//
//   Stage 1 — Vertex Imagen text-to-image (imagen-4.0-generate-001)
//             generates the EMPTY scene background only. The prompt
//             explicitly tells Imagen to leave a clean area at
//             BAG_REGION (lower-right third) for product placement.
//             NO bag is rendered; no SUBJECT reference is passed.
//
//   Stage 2 — Programmatic composite via _shared/compositor.ts:
//             fetch the catalog bag PNG, color-key the white background
//             via 4-corner flood-fill, apply a directional light gradient
//             matching the scene, add a soft drop shadow, paste onto the
//             generated background at BAG_REGION.
//             Bag pixels are byte-perfect — Minuto branding/text/artwork
//             cannot be hallucinated because the bag is never regenerated.
//
//   Stage 3 — Vertex Imagen inpaint shadow-bake
//             (imagen-3.0-capability-001 with EDIT_MODE_INPAINT_INSERTION):
//             a programmatic mask covers the area below the bag (the
//             contact-shadow zone) and a thin halo around it (the ambient
//             occlusion zone). Imagen repaints only that masked area to
//             integrate the composited bag into the scene's lighting.
//
// The bag itself is NEVER in the mask, so its pixels survive Stage 3
// untouched. The result is a byte-perfect bag with photorealistic
// shadows in an editorial scene.
//
// Fallback: any stage can fail. If Stage 3 errors, we return the Stage 2
// composite directly (still has the compositor's built-in drop shadow,
// just no inpaint polish). If Stage 1 errors, we 500 — no point continuing.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VERTEX_IMAGEN_MODEL = Deno.env.get('VERTEX_IMAGEN_MODEL')
const VERTEX_IMAGEN_GENERATE_MODEL = Deno.env.get('VERTEX_IMAGEN_GENERATE_MODEL') ?? 'imagen-4.0-generate-001'
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const VISUAL_DIRECTOR_MODEL = Deno.env.get('VISUAL_DIRECTOR_MODEL') ?? 'gemini-3.1-flash'

interface VertexImagenEditRequest {
  mode?: 'edit' | 'list_models'
  scene_brief?: string
  preset?: keyof typeof SCENE_PRESETS
  aspect?: Aspect
  use_reference?: boolean
  reference_image_url?: string
  product_id?: number
  product_name?: string
  model?: string                            // overrides VERTEX_IMAGEN_MODEL (used by inpaint stage)
  skip_director?: boolean
  shadow_bake?: boolean                     // default FALSE. Stage 3 inpaint is opt-in: imagen-3.0-capability caps output ~1024px, which would downsample the 2K composite and re-blur the bag text. Default path keeps the sharp 2K composite + the compositor's own drop shadow. Pass true to A/B the inpaint shadow.
  render_mode?: 'bag_hero' | 'no_bag'       // default 'bag_hero' (unchanged composite pipeline). 'no_bag' = text-only Scene Director + single Vertex text-to-image with a non-bag coffee hero (cup/pour/beans/brewing/roastery). No bag reference, no Stage 2/3 composite.
}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405, corsHeaders)

  try {
    const body = await req.json().catch(() => ({})) as VertexImagenEditRequest
    const mode = body.mode ?? 'edit'
    if (mode === 'list_models') return await handleListModels(corsHeaders)
    if (body.render_mode === 'no_bag') return await handleNoBag(body, corsHeaders)
    return await handleHybridComposite(body, corsHeaders)
  } catch (err: any) {
    console.error('[vertex-imagen-edit] error:', err?.message ?? err)
    return jsonResponse({ error: err?.message ?? String(err) }, 500, corsHeaders)
  }
})

async function handleListModels(corsHeaders: Record<string, string>): Promise<Response> {
  const { projectId, location } = getVertexConfig()
  const token = await getVertexAccessToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/publishers/google/models?view=PUBLISHER_MODEL_VIEW_BASIC&pageSize=200`
  const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    return jsonResponse({ error: `model list ${res.status}: ${errText.slice(0, 400)}` }, 500, corsHeaders)
  }
  const json = await res.json() as { publisherModels?: Array<{ name?: string; versionId?: string }> }
  const models = (json.publisherModels ?? []).map(m => ({ name: m.name, version: m.versionId }))
  const imagen = models.filter(m => (m.name ?? '').toLowerCase().includes('imagen'))
  return jsonResponse({ projectId, location, total: models.length, imagen, all: models }, 200, corsHeaders)
}

// ─────────────────────────────────────────────────────────────────────────
// Visual Director: same Gemini Flash multimodal call as before. Now writes
// environment prompts knowing the pipeline will COMPOSITE the bag in,
// rather than render it via SUBJECT — so it must leave space at BAG_REGION
// and describe the environment without any product in it.
// ─────────────────────────────────────────────────────────────────────────
async function runVisualDirector(
  bagB64:           string,
  bagMime:          string,
  thematicContext?: string,
): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY env var not set — required for Visual Director step (pass skip_director:true to bypass)')
  }

  const systemPrompt = `You are an elite still-life photographer. You are photographing an EMPTY styled surface — a beautiful, minimal, premium tabletop scene with dramatic light. Think of a high-end interiors / product-photography set BEFORE the product is placed: just a gorgeous surface, a simple backdrop, and bold directional light carving deep shadows.

You will be shown a reference image only so you can pick a surface colour and light temperature that would COMPLEMENT it. You are NOT photographing that object. Describe ONLY the empty styled surface.

HARD RULES — your description must obey ALL of these:
- NEVER mention coffee, a coffee bag, a pouch, packaging, a product, beans, a cup, a mug, brewing, a kettle, or anything coffee-related. This is a pure empty-surface photograph. There is NO coffee anywhere.
- NEVER mention "placement", "composite", "leave room", "space for", percentages, layout, mockup, template, or any production/design language. You are describing a finished real photograph of an empty surface, nothing more.
- NEVER name a real brand.
- The ${BAG_REGION_PROMPT} stays clean and empty — just bare surface and the backdrop behind it. Do not put any object there.
- At most ONE small simple sculptural prop (a smooth stone, a ceramic vessel, a folded linen) far to one side or in the deep background. Prefer none. Generous negative space.

ABSOLUTELY FORBIDDEN materials/elements:
- Surfaces: marble (any colour), white walls, white seamless paper, glossy reflective slabs, polished modern surfaces, mirror finishes, poster board, paper sheets, design boards.
- Lighting: softbox, studio commercial light, bounced fill, flat shadowless lighting.
- Backgrounds: lush plants, dense foliage, gardens, vehicles, sky, landscapes, animals.
- People: faces, heads, bodies, portraits.
- Style: cartoon, illustration, vector, flat-design, 3D render, stock-photo cliché, any visible text/numbers/labels.
- Palette: saturated environment colours.

Allowed surfaces: raw concrete, dark slate, weathered walnut, light grained oak, raw lime plaster, hand-thrown earthenware, aged copper, brushed stainless steel, woven tatami mat.

Output rules:
- Single paragraph, 70–120 words. Concise.
- Eye-level or very slight high angle. A horizontal surface plane and a simple soft-focus backdrop are visible.
- Bold directional light from one clear side, carving a strong clean diagonal shadow across the empty surface. Deep shadow occupies real space — this is the premium signature.
- Photorealistic, premium editorial still-life mood, Kodak Portra 400 grain.

Return ONLY the empty-surface photograph description — no preamble, no commentary.`

  const userParts: any[] = [
    { inlineData: { mimeType: bagMime, data: bagB64 } },
  ]
  if (thematicContext && thematicContext.trim().length > 0) {
    userParts.push({
      text: `Thematic context for tone (do not echo): ${thematicContext.trim().slice(0, 600)}`,
    })
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      role:  'user',
      parts: userParts,
    }],
    generationConfig: {
      maxOutputTokens: 500,
      temperature:     1.0,
    },
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${VISUAL_DIRECTOR_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Visual Director (${VISUAL_DIRECTOR_MODEL}) ${res.status}: ${errText.slice(0, 400)}`)
  }
  const json = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = json.candidates?.[0]?.content?.parts
    ?.map(p => p.text ?? '')
    .join('')
    .trim()
  if (!text) {
    throw new Error(`Visual Director returned empty text. Raw: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return text
}

// ─────────────────────────────────────────────────────────────────────────
// Scene Director (no_bag mode): text-only Gemini call. No image input.
// Takes the scene_brief / preset and creatively invents a rich premium
// editorial photograph whose HERO is a coffee element itself (a cup, a
// pour, beans in a dish, brewing gear, the roastery) — the opposite of
// the bag_hero Director, which forbids all coffee words because it is
// describing an empty surface for a composited bag.
//
// Still forbids any coffee BAG / pouch / packaging (nothing is composited
// in this mode, so a hallucinated generic bag would just be noise) plus
// the full brand-forbidden surface/lighting/style list.
// ─────────────────────────────────────────────────────────────────────────
async function runSceneDirector(
  sceneBrief: string,
  referenceImages: Array<{ b64: string; mime: string; label: string }> = [],
): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY env var not set — required for Scene Director step (pass skip_director:true to bypass)')
  }

  const systemPrompt = `You are an elite editorial photographer and creative director shooting a premium specialty-coffee campaign. Your job is to take the upstream scene brief and translate it into a single rich Imagen-friendly photograph description, 70–120 words.

🔒 PRIMARY RULE — FAITHFUL TRANSLATION, NOT REINVENTION:
The upstream brief was written by Minuto's photography art director and already identifies the HERO subject, the SETTING, the COMPOSITION, and the LIGHT. Your job is to expand it with sensory detail, NOT to substitute a different hero. If the brief names a specific object — a matte-black Coffee-Tech drum roaster, a La Marzocco Strada X espresso machine, a stainless cooling tray, a V60 dripper, a Hario server, a roastery interior, a cafe bar — that object IS the hero of your final description. Keep it. Do not swap it for "a cup of espresso" or "a scatter of beans" because those are easier to imagine. The brief has been crafted for a reason.

🎬 BTS / WORKPLACE HERO PRESERVATION:
When the brief describes documentary roastery or cafe content — drum roaster, cooling tray, espresso machine, barista hands at the bar, fresh beans coming off the cooler, "the smell of roasting", "behind the bar", "6am in the roastery" — the HERO is the equipment + workplace, not a styled coffee element. Preserve the documentary feel. Do NOT recast a working-roastery scene as a styled cup-with-crema still life.

HERO TAXONOMY (whichever the brief names, you keep):
- A working roaster + cooling tray with fresh beans and rising steam (BTS roastery)
- A La Marzocco Strada X bar with an espresso pull and barista hands (BTS cafe)
- A single cup with rich crema (cup ritual)
- A slow pour from a gooseneck kettle over a V60 (pour ritual)
- A small dish or scatter of beans, matte light-cinnamon (origin/freshness)
- Hand-brewing gear caught mid-ritual (brewing education)

If the brief names one of these settings explicitly, that is the hero. Period.

HARD RULES — your description must obey ALL of these:
- NEVER include or mention a coffee bag, pouch, sack, kraft bag, paper bag, packaging, label, sticker, or any product packaging of ANY kind. There is NO bag anywhere in this photograph.
- NEVER name a real brand and NEVER show any text, numbers, logos, or written labels (machine model names like "La Marzocco Strada X" or "Coffee-Tech" describe the equipment shape for your reference — DO NOT write the model name as visible text in the photo, just render the matching shape/color).
- ⛔ BEAN COLOR — Minuto roasts MEDIUM only, never dark. Beans must be MATTE light-cinnamon brown / pecan-shell brown — NEVER glossy, NEVER oily, NEVER dark-chocolate, NEVER black-roast. A glossy or dark bean breaks the brand.
- ⛔ ROASTER STYLE — if the brief mentions a roaster, it is a MODERN MATTE-BLACK DRUM ROASTER (Coffee-Tech Engineering): black panels, black hopper, black drum face, small round glass viewport glowing warm amber from the flame. NEVER a vintage Probat copper roaster, NEVER an antique brass roaster, NEVER a white/cream roaster, NEVER wood-trim — modern industrial matte-black only.
- ⛔ ESPRESSO MACHINE STYLE — if the brief mentions a Strada / Strada X / cafe bar machine, it is a 2-group LA MARZOCCO STRADA X: slate-gray body, distinctive pale-blue glass side wing. NEVER a generic chrome Linea, NEVER a vintage lever machine.

ABSOLUTELY FORBIDDEN materials/elements:
- Surfaces: marble (any colour), white walls, white seamless paper, glossy reflective slabs, polished modern surfaces, mirror finishes, poster board, paper sheets, design boards.
- Lighting: softbox, studio commercial light, bounced fill, flat shadowless lighting.
- Backgrounds: lush plants, dense foliage, gardens, vehicles, sky, landscapes, animals.
- People: faces, heads, full bodies, portraits. A single hand mid-pour, holding a cup, or working the espresso portafilter is acceptable; never a face.
- Props: measuring scoops.
- Style: cartoon, illustration, vector, flat-design, 3D render, stock-photo cliché, any visible text/numbers/labels/logos.
- Palette: saturated environment colours, neon.

Allowed surfaces: raw concrete, dark slate, weathered walnut, light grained oak, raw lime plaster, hand-thrown earthenware, aged copper, brushed stainless steel, woven tatami mat.

Output rules:
- Single paragraph, 70–120 words. Concise, concrete, sensory.
- Preserve the brief's named hero and setting. Add sensory texture (steam wisps, the matte sheen of beans, light catching the viewport, hand grip on a portafilter handle) — do NOT add or substitute heroes.
- Eye-level or very slight high angle. Bold directional light from one clear side, carving a strong clean diagonal shadow. Deep shadow occupies real space — this is the premium signature.
- Photorealistic, premium editorial documentary mood, shallow depth of field, Kodak Portra 400 grain.

Return ONLY the photograph description — no preamble, no commentary.`

  // Build user-message parts: any reference images first (the model sees
  // them as visual anchors), then the brief text. Imagen text-to-image
  // downstream doesn't accept images, so we pass them HERE so the Director's
  // text output describes the actual Minuto equipment faithfully.
  const userParts: Array<Record<string, unknown>> = []
  for (const ref of referenceImages) {
    userParts.push({ inlineData: { mimeType: ref.mime, data: ref.b64 } })
    userParts.push({ text: `↑ Reference image — ${ref.label}. The hardware you describe in your output MUST match what you see in this image (silhouette, two-tone finish, hopper shape, cooling-tray placement, etc.), not a generic version pulled from training data.` })
  }
  userParts.push({
    text: `Photographer's brief to faithfully translate into a single 70-120 word Imagen description. Preserve the named hero, the setting, the composition, and the light direction VERBATIM — your job is to add sensory richness around them, NOT to substitute a different hero or setting. If the brief mentions a drum roaster, cooling tray, La Marzocco Strada X, V60, hand-brewing gear, or a specific scene element, that element IS the hero of your output. When reference images are attached above, the hardware in your output description MUST visually match them — describe what is actually shown, not a generic version. Ignore any mention of a coffee bag (no bag is rendered in this pipeline).\n\nBrief:\n${sceneBrief.trim().slice(0, 1200)}`,
  })

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      role:  'user',
      parts: userParts,
    }],
    generationConfig: {
      maxOutputTokens: 800,
      temperature:     1.0,
      // gemini-2.5-flash defaults to dynamic "thinking", which silently
      // eats the output-token budget and truncates the visible answer
      // mid-sentence (~90 chars). This is a one-shot creative description,
      // not a reasoning task — disable thinking so the full 70-120 word
      // scene is returned.
      thinkingConfig:  { thinkingBudget: 0 },
    },
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${VISUAL_DIRECTOR_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Scene Director (${VISUAL_DIRECTOR_MODEL}) ${res.status}: ${errText.slice(0, 400)}`)
  }
  const json = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = json.candidates?.[0]?.content?.parts
    ?.map(p => p.text ?? '')
    .join('')
    .trim()
  if (!text) {
    throw new Error(`Scene Director returned empty text. Raw: ${JSON.stringify(json).slice(0, 300)}`)
  }
  return text
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 1 — Vertex Imagen text-to-image.
//   mode='bag_hero': generate the EMPTY scene only (bag composited later).
//   mode='no_bag':   generate the FULL finished scene (coffee hero is
//                     rendered by Imagen; nothing is composited).
// ─────────────────────────────────────────────────────────────────────────
async function generateImagenScene(
  envPrompt: string,
  ratio:     string,
  model:     string,
  renderMode: 'bag_hero' | 'no_bag',
): Promise<{ b64: string; mime: string }> {
  const { projectId, location } = getVertexConfig()
  const token = await getVertexAccessToken()
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`

  // bag_hero Stage 1 prompt: a clean photograph of an EMPTY premium
  // surface. ZERO meta-language (no "placement", "composite",
  // percentages, "product will be added") — that makes Imagen draw a
  // design mockup with spec annotations. ZERO coffee words — "coffee
  // scene" makes Imagen add a coffee bag. The bag is composited silently
  // in Stage 2; Imagen never needs to know.
  //
  // no_bag Stage 1 prompt: a FULL finished editorial photo with a coffee
  // hero (the Scene Director already described it). Coffee words are
  // WANTED here, so the negative prompt must NOT forbid coffee/cup/beans/
  // brewing — only the bag/pouch/packaging + the brand-forbidden list.
  const fullPrompt = renderMode === 'no_bag'
    ? `A photorealistic, high-end editorial photograph. ${envPrompt}

Bold directional light from one clear side carving a strong clean diagonal shadow. Deep shadow occupies real space. Shallow depth of field, Kodak Portra 400 grain, premium editorial mood.

NEGATIVE PROMPT: coffee bag, coffee pouch, coffee sack, kraft paper bag, paper bag, pouch, packaging, product packaging, bag of beans, label, sticker, poster board, paper sheet, design board, mockup, spec annotation, percentage labels, numbers, text, watermark, logo, brand name, marble, white wall, white seamless paper, glossy reflective surface, polished modern slab, mirror finish, softbox lighting, studio commercial lighting, flat shadowless lighting, lush plants, dense foliage, bamboo, palm fronds, garden, vehicles, sky, landscape, animals, human faces, full bodies, portraits, measuring scoop, cartoon, illustration, vector, flat-design, 3D-rendered look, stock photo cliche, saturated colors, neon background.`
    : `A photorealistic, high-end editorial still-life photograph of an EMPTY styled surface. ${envPrompt}

The surface and the backdrop behind it are completely bare and empty — a beautiful minimal set with bold directional light carving a strong clean diagonal shadow across the surface. Deep shadow occupies real space. Generous negative space. No objects in ${BAG_REGION_PROMPT}; the surface there is clean and unbroken. Kodak Portra 400 grain, premium editorial mood.

NEGATIVE PROMPT: coffee, coffee bag, coffee pouch, coffee sack, kraft paper bag, paper bag, pouch, packaging, product, bag of beans, beans, coffee cup, mug, kettle, brewing equipment, poster board, paper sheet, design board, mockup, spec annotation, percentage labels, numbers, text, watermark, marble, white wall, white seamless paper, glossy reflective surface, polished modern slab, mirror finish, softbox lighting, studio commercial lighting, flat shadowless lighting, lush plants, dense foliage, bamboo, palm fronds, garden, vehicles, sky, landscape, animals, human faces, full bodies, portraits, scoops, spoons, utensils, cartoon, illustration, vector, flat-design, 3D-rendered look, stock photo cliche, saturated colors, neon background.`

  // imagen-4.0-generate-001 only accepts 1:1, 3:4, 4:3, 9:16, 16:9. Our
  // ASPECT_TO_RATIO maps feed_portrait → '4:5', which the generate model
  // rejects with a 400 (ASPECT_TO_RATIO stays as-is — it's shared with
  // the Gemini pipeline and other callers; we only remap at this call).
  const VERTEX_RATIO: Record<string, string> = { '4:5': '3:4' }
  const vertexRatio = VERTEX_RATIO[ratio] ?? ratio

  const predictBody = {
    instances: [{
      prompt: fullPrompt,
    }],
    parameters: {
      sampleCount:     1,
      aspectRatio:     vertexRatio,
      // 2K output so the compositor barely downscales the catalog bag —
      // a hero-sized bag at ~52% of 2048px ≈ 1065px ≈ catalog native,
      // keeping the bag's printed text byte-perfect sharp. If the API
      // rejects sampleImageSize for this model, the error surfaces in
      // Stage 1 and we drop the param.
      sampleImageSize: '2K',
    },
  }

  console.log(`[vertex-imagen-edit] Stage 1 (text-to-image, ${model}, render_mode=${renderMode}) POST`)
  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(predictBody),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Stage 1 text-to-image ${res.status}: ${errText.slice(0, 600)}`)
  }
  const json = await res.json() as {
    predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>
  }
  const pred = json.predictions?.[0]
  if (!pred?.bytesBase64Encoded) {
    throw new Error(`Stage 1 returned no image. Raw: ${JSON.stringify(json).slice(0, 400)}`)
  }
  return { b64: pred.bytesBase64Encoded, mime: pred.mimeType ?? 'image/png' }
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 3 — build a programmatic shadow-zone mask.
//
// The mask is a PNG at the same dimensions as the composite, where:
//   - WHITE pixels = inpaint this area (the shadow zone)
//   - BLACK pixels = preserve as-is (everything else, including the bag itself)
//
// Shadow zone = a soft rectangle BELOW the bag (the contact shadow on the
// surface) plus a thin halo around the bag's bottom half (ambient occlusion
// where the bag meets the floor). The TOP of the bag and the bag itself
// are NOT in the mask — those pixels survive Stage 3 untouched.
// ─────────────────────────────────────────────────────────────────────────
async function buildShadowMask(
  width:  number,
  height: number,
): Promise<Uint8Array> {
  // Bag bounding box in the scene (matches compositor's geometry).
  const bagWidth     = Math.round(width  * BAG_REGION.widthPct)
  // Assume bag aspect ~1.45 (height/width) — typical for stand-up coffee
  // pouches. Compositor derives this from the actual bag's aspect, but for
  // the mask we just need an approximate region, slightly larger than the
  // bag is fine (inpaint will only repaint where it makes sense anyway).
  const bagHeight    = Math.round(bagWidth * 1.45)
  const bagCenterX   = Math.round(width  * BAG_REGION.centerXPct)
  const bagCenterY   = Math.round(height * BAG_REGION.centerYPct)
  const bagLeft      = bagCenterX - Math.round(bagWidth  / 2)
  const bagRight     = bagCenterX + Math.round(bagWidth  / 2)
  const bagTop       = bagCenterY - Math.round(bagHeight / 2)
  const bagBottom    = bagCenterY + Math.round(bagHeight / 2)

  // Shadow zone bounds — slightly wider than the bag horizontally
  // (shadow spreads sideways) and extends down to roughly the bottom
  // edge of the frame (long cast shadow at 3/4 angle). Also includes a
  // thin band ABOVE the bag bottom to catch the contact-shadow region.
  const shadowLeft   = Math.max(0,           bagLeft   - Math.round(bagWidth * 0.10))
  const shadowRight  = Math.min(width - 1,   bagRight  + Math.round(bagWidth * 0.30)) // extra room to the right because the light is from upper-right, shadow falls lower-LEFT — but we mask both sides since Imagen decides direction from the existing composite's lighting
  const shadowTop    = Math.max(0,           bagBottom - Math.round(bagHeight * 0.08)) // top of shadow zone = 8% above bag bottom (catches contact area)
  const shadowBottom = Math.min(height - 1,  bagBottom + Math.round(bagHeight * 0.45)) // shadow extends 45% of bag height below the bag

  const mask = new Image(width, height)
  // imagescript Image starts with transparent black pixels. We want OPAQUE
  // black where preserve, OPAQUE white where edit. Initialize to opaque
  // black first.
  for (let py = 1; py <= height; py++) {
    for (let px = 1; px <= width; px++) {
      mask.setPixelAt(px, py, 0x000000ff) // opaque black
    }
  }
  // White rectangle in the shadow zone.
  for (let py = shadowTop + 1; py <= shadowBottom + 1; py++) {
    for (let px = shadowLeft + 1; px <= shadowRight + 1; px++) {
      mask.setPixelAt(px, py, 0xffffffff) // opaque white
    }
  }

  return await mask.encode() // PNG
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 3 — Vertex Imagen inpaint to paint shadows into the masked zone.
// Uses imagen-3.0-capability-001 with EDIT_MODE_INPAINT_INSERTION.
// ─────────────────────────────────────────────────────────────────────────
async function shadowBakeInpaint(
  compositeB64: string,
  maskB64:      string,
  model:        string,
): Promise<{ b64: string; mime: string }> {
  const { projectId, location } = getVertexConfig()
  const token = await getVertexAccessToken()
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`

  const inpaintPrompt = `Paint photorealistic contact shadows and ambient occlusion in the masked area, matching the warm directional lighting of the scene. The shadows should ground a coffee bag into its surface, with darker contact shadow directly under the bag and softer falloff outward. Keep the existing image content outside the masked area unchanged.`

  const predictBody = {
    instances: [{
      prompt: inpaintPrompt,
      referenceImages: [
        {
          referenceType:  'REFERENCE_TYPE_RAW',
          referenceId:    1,
          referenceImage: { bytesBase64Encoded: compositeB64 },
        },
        {
          referenceType:  'REFERENCE_TYPE_MASK',
          referenceId:    2,
          referenceImage: { bytesBase64Encoded: maskB64 },
          maskImageConfig: {
            maskMode: 'MASK_MODE_USER_PROVIDED',
            dilation: 0.0,
          },
        },
      ],
    }],
    parameters: {
      editMode:    'EDIT_MODE_INPAINT_INSERTION',
      sampleCount: 1,
      editConfig:  { baseSteps: 35 },
    },
  }

  console.log(`[vertex-imagen-edit] Stage 3 (inpaint shadow-bake, ${model}) POST`)
  const res = await fetch(endpoint, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(predictBody),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Stage 3 inpaint ${res.status}: ${errText.slice(0, 600)}`)
  }
  const json = await res.json() as {
    predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>
  }
  const pred = json.predictions?.[0]
  if (!pred?.bytesBase64Encoded) {
    throw new Error(`Stage 3 returned no image. Raw: ${JSON.stringify(json).slice(0, 400)}`)
  }
  return { b64: pred.bytesBase64Encoded, mime: pred.mimeType ?? 'image/png' }
}

// ─────────────────────────────────────────────────────────────────────────
// no_bag handler — text-only Scene Director → single Vertex text-to-image
// with a coffee hero. No bag reference, no Stage 2 composite, no Stage 3.
// ─────────────────────────────────────────────────────────────────────────
async function handleNoBag(
  body: VertexImagenEditRequest,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const sceneBrief = body.scene_brief ?? (body.preset ? SCENE_PRESETS[body.preset] : null)
  if (!sceneBrief) {
    return jsonResponse({
      error: `provide either 'scene_brief' or 'preset' (one of: ${Object.keys(SCENE_PRESETS).join(', ')})`,
    }, 400, corsHeaders)
  }

  const aspect = body.aspect ?? 'feed_square'
  const ratio  = ASPECT_TO_RATIO[aspect]

  console.log(`[vertex-imagen-edit] NO_BAG aspect=${aspect} skip_director=${!!body.skip_director}`)

  // ── Equipment-reference detection ────────────────────────────────────
  // Imagen 4 text-to-image doesn't accept reference images; we attach the
  // equipment reference photos to the Scene Director (Gemini, multimodal)
  // so its text output describes Minuto's ACTUAL hardware faithfully,
  // then Imagen renders from that better text. Without this, Imagen pulls
  // generic Probat-style roasters / Linea-style espresso machines from
  // its training data.
  const sceneLower = sceneBrief.toLowerCase()
  const roasterSceneRegex = /\b(roaster|roastery|drum roaster|coffee-tech|cooling tray|cooler tray|roast day|roasting|מקלה|בית קלייה|בית הקלייה|מכונת קלייה|תוף קלייה|פולים יוצאים|קירור|מקרר פולים)\b/.test(sceneLower)
  const cafeMachineSceneRegex = /\b(espresso machine|portafilter|group head|grouphead|steam wand|la marzocco|strada|barista|behind the bar|on the bar|cafe bar|מאחורי הבר|ה-?strada|הברמן|הברמנית|מכונת אספרסו)\b/.test(sceneLower)
  console.log(`[vertex-imagen-edit] no_bag refs — roaster=${roasterSceneRegex} cafeMachine=${cafeMachineSceneRegex}`)

  async function fetchRefAsB64(url: string): Promise<{ b64: string; mime: string } | null> {
    try {
      const r = await fetch(url)
      if (!r.ok) {
        console.warn(`[vertex-imagen-edit] reference fetch ${r.status}: ${url}`)
        return null
      }
      const mime = r.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
      const buf = new Uint8Array(await r.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return { b64: btoa(bin), mime }
    } catch (e: any) {
      console.warn(`[vertex-imagen-edit] reference fetch error: ${e?.message}`)
      return null
    }
  }

  const directorRefs: Array<{ b64: string; mime: string; label: string }> = []
  if (roasterSceneRegex || cafeMachineSceneRegex) {
    const [roasterRef, machineRef] = await Promise.all([
      roasterSceneRegex     ? fetchRefAsB64(MINUTO_ROASTER_REFERENCE_URL)          : Promise.resolve(null),
      cafeMachineSceneRegex ? fetchRefAsB64(MINUTO_ESPRESSO_MACHINE_REFERENCE_URL) : Promise.resolve(null),
    ])
    if (roasterRef) directorRefs.push({ ...roasterRef, label: 'Minuto\'s actual Coffee-Tech compact drum roaster — two-tone matte-black lower body + brushed-stainless upper drum cover, tall stainless conical hopper, large stainless exhaust chimney rising from the upper-left, separate round shallow stainless cooling tray attached at mid-height on the right (NOT the same diameter as the drum), vertical compact silhouette. NO visible manufacturer text or badge in any output description.' })
    if (machineRef) directorRefs.push({ ...machineRef, label: 'Minuto\'s actual 2-group La Marzocco Strada X — slate-gray body with the distinctive pale-blue glass side wing. NOT a generic chrome Linea.' })
  }

  // ── Scene Director (text-only, optionally vision-grounded) ───────────
  let directorOutput: string | null = null
  let directorError: string | null = null
  let envPrompt: string

  if (body.skip_director) {
    envPrompt = sceneBrief
  } else {
    try {
      directorOutput = await runSceneDirector(sceneBrief, directorRefs)
      envPrompt = directorOutput
    } catch (e: any) {
      directorError = e?.message ?? String(e)
      envPrompt = sceneBrief
      console.warn(`[vertex-imagen-edit] Scene Director failed, using brief text: ${directorError}`)
    }
  }

  // ── Single Vertex text-to-image (coffee hero, no compositing) ────────
  const scene = await generateImagenScene(envPrompt, ratio, VERTEX_IMAGEN_GENERATE_MODEL, 'no_bag')
  console.log(`[vertex-imagen-edit] no_bag done — scene generated (${scene.mime})`)

  // ── Upload + return ──────────────────────────────────────────────────
  const supabase  = createClient(SUPABASE_URL, SERVICE_ROLE)
  const ext       = scene.mime.includes('jpeg') ? 'jpg' : 'png'
  const filename  = `vertex-test/nobag_${aspect}_${Date.now()}.${ext}`
  const fileBytes = Uint8Array.from(atob(scene.b64), c => c.charCodeAt(0))

  const { error: upErr } = await supabase.storage
    .from('marketing')
    .upload(filename, fileBytes, { contentType: scene.mime, upsert: true })
  if (upErr) throw new Error(`storage upload: ${upErr.message}`)

  const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

  return jsonResponse({
    success:               true,
    url:                   pub.publicUrl,
    aspect,
    ratio,
    bytes:                 fileBytes.length,
    pipeline:              'no_bag',
    render_mode:           'no_bag',
    used_reference:        false,
    scene_brief:           sceneBrief,
    visual_director_text:  directorOutput,
    visual_director_error: directorError,
    visual_director_model: body.skip_director ? null : VISUAL_DIRECTOR_MODEL,
    generate_model:        VERTEX_IMAGEN_GENERATE_MODEL,
  }, 200, corsHeaders)
}

// ─────────────────────────────────────────────────────────────────────────
// Main handler — orchestrates Stages 0-3 + Supabase upload.
// ─────────────────────────────────────────────────────────────────────────
async function handleHybridComposite(
  body: VertexImagenEditRequest,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const inpaintModel = body.model || VERTEX_IMAGEN_MODEL || 'imagen-3.0-capability-001'
  const sceneBrief = body.scene_brief ?? (body.preset ? SCENE_PRESETS[body.preset] : null)
  if (!sceneBrief) {
    return jsonResponse({
      error: `provide either 'scene_brief' or 'preset' (one of: ${Object.keys(SCENE_PRESETS).join(', ')})`,
    }, 400, corsHeaders)
  }

  const aspect = body.aspect ?? 'feed_square'
  const ratio  = ASPECT_TO_RATIO[aspect]

  // ── Resolve bag URL (mandatory, no random fallback) ──────────────────
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
  let bagUrl: string | null = null
  let bagSource: 'reference_image_url' | 'product_id' | 'product_name' | null = null
  let matchedProductName: string | null = null

  if (body.reference_image_url) {
    bagUrl = body.reference_image_url
    bagSource = 'reference_image_url'
  } else if (typeof body.product_id === 'number' && Number.isFinite(body.product_id)) {
    const { data, error } = await supabase
      .from('woo_products').select('name, image_url')
      .eq('woo_id', body.product_id).not('image_url', 'is', null)
      .limit(1).maybeSingle()
    if (error)          return jsonResponse({ error: `woo_products lookup failed for product_id=${body.product_id}: ${error.message}` }, 500, corsHeaders)
    if (!data?.image_url) return jsonResponse({ error: `no woo_products row with woo_id=${body.product_id}, or that row has no image_url` }, 400, corsHeaders)
    bagUrl = data.image_url as string
    bagSource = 'product_id'
    matchedProductName = data.name as string
  } else if (body.product_name && body.product_name.trim().length >= 2) {
    const needle = body.product_name.trim()
    const { data, error } = await supabase
      .from('woo_products').select('name, image_url')
      .ilike('name', `%${needle}%`).not('image_url', 'is', null)
      .limit(1).maybeSingle()
    if (error)          return jsonResponse({ error: `woo_products lookup failed for product_name="${needle}": ${error.message}` }, 500, corsHeaders)
    if (!data?.image_url) return jsonResponse({ error: `no woo_products name match for "${needle}" with a non-null image_url` }, 400, corsHeaders)
    bagUrl = data.image_url as string
    bagSource = 'product_name'
    matchedProductName = data.name as string
  } else {
    return jsonResponse({
      error: 'must provide one of: reference_image_url (direct URL), product_id (numeric WooCommerce woo_id), or product_name (text — fuzzy matched against woo_products.name). The function no longer falls back to a random bag.',
    }, 400, corsHeaders)
  }

  console.log(`[vertex-imagen-edit] HYBRID aspect=${aspect} bag=${bagUrl} (via ${bagSource}) matchedName="${matchedProductName ?? '(none)'}"`)

  // ── Fetch bag image for Director (it needs the bytes to analyze) ─────
  const bagRes = await fetch(bagUrl)
  if (!bagRes.ok) throw new Error(`bag image fetch ${bagRes.status}: ${bagUrl}`)
  const bagMime = bagRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
  const bagBuf = new Uint8Array(await bagRes.arrayBuffer())
  let bagBin = ''
  for (let i = 0; i < bagBuf.length; i += 0x8000) bagBin += String.fromCharCode(...bagBuf.subarray(i, i + 0x8000))
  const bagB64 = btoa(bagBin)

  // ── Stage 0 — Visual Director (env prompt) ───────────────────────────
  let directorOutput: string | null = null
  let directorError: string | null = null
  let envPrompt: string

  if (body.skip_director) {
    envPrompt = sceneBrief
  } else {
    try {
      directorOutput = await runVisualDirector(bagB64, bagMime, sceneBrief)
      envPrompt = directorOutput
    } catch (e: any) {
      directorError = e?.message ?? String(e)
      envPrompt = sceneBrief
      console.warn(`[vertex-imagen-edit] Director failed, using preset text: ${directorError}`)
    }
  }

  // ── Stage 1 — Generate empty background ──────────────────────────────
  const bg = await generateImagenScene(envPrompt, ratio, VERTEX_IMAGEN_GENERATE_MODEL, 'bag_hero')
  console.log(`[vertex-imagen-edit] Stage 1 done — empty scene generated (${bg.mime})`)

  // ── Stage 2 — Composite bag onto background ──────────────────────────
  const composite = await compositeProductIntoScene(bg.b64, bagUrl, BAG_REGION)
  console.log(`[vertex-imagen-edit] Stage 2 done — bag composited at BAG_REGION (${composite.mime})`)

  // ── Stage 3 — Shadow-bake inpaint (OPT-IN, default OFF) ──────────────
  // Default skips Stage 3: the inpaint model caps output ~1024px which
  // would downsample the sharp 2K composite and re-blur the bag's text.
  // The compositor's own drop shadow already grounds the hero bag. Pass
  // shadow_bake:true to A/B the inpaint shadow (accepting the text
  // softening that comes with it).
  let finalImage: { b64: string; mime: string } = composite
  let shadowBakeError: string | null = null
  let stage3Skipped = true

  if (!body.shadow_bake) {
    console.log(`[vertex-imagen-edit] Stage 3 skipped (default — preserves 2K sharp text)`)
  } else {
    stage3Skipped = false
    try {
      // Decode the composite to know its dimensions for the mask.
      const compositeBytes = Uint8Array.from(atob(composite.b64), c => c.charCodeAt(0))
      const compositeImg = await Image.decode(compositeBytes)
      const maskBytes = await buildShadowMask(compositeImg.width, compositeImg.height)
      let maskBin = ''
      for (let i = 0; i < maskBytes.length; i += 0x8000) maskBin += String.fromCharCode(...maskBytes.subarray(i, i + 0x8000))
      const maskB64 = btoa(maskBin)

      finalImage = await shadowBakeInpaint(composite.b64, maskB64, inpaintModel)
      console.log(`[vertex-imagen-edit] Stage 3 done — shadow-bake applied`)
    } catch (e: any) {
      // Fall back to the Stage 2 composite — still usable, just less polished.
      shadowBakeError = e?.message ?? String(e)
      console.warn(`[vertex-imagen-edit] Stage 3 failed, returning Stage 2 composite: ${shadowBakeError}`)
    }
  }

  // ── Upload + return ──────────────────────────────────────────────────
  const ext       = finalImage.mime.includes('jpeg') ? 'jpg' : 'png'
  const filename  = `vertex-test/${aspect}_${Date.now()}.${ext}`
  const fileBytes = Uint8Array.from(atob(finalImage.b64), c => c.charCodeAt(0))

  const { error: upErr } = await supabase.storage
    .from('marketing')
    .upload(filename, fileBytes, { contentType: finalImage.mime, upsert: true })
  if (upErr) throw new Error(`storage upload: ${upErr.message}`)

  const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

  return jsonResponse({
    success:               true,
    url:                   pub.publicUrl,
    aspect,
    ratio,
    bytes:                 fileBytes.length,
    pipeline:              'hybrid_composite',
    used_reference:        true,
    scene_brief:           sceneBrief,
    visual_director_text:  directorOutput,
    visual_director_error: directorError,
    visual_director_model: body.skip_director ? null : VISUAL_DIRECTOR_MODEL,
    bag_url:               bagUrl,
    bag_source:            bagSource,
    matched_product_name:  matchedProductName,
    generate_model:        VERTEX_IMAGEN_GENERATE_MODEL,
    inpaint_model:         inpaintModel,
    stage3_skipped:        stage3Skipped,
    shadow_bake_error:     shadowBakeError,
  }, 200, corsHeaders)
}

function jsonResponse(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}
