import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ASPECT_TO_RATIO,
  Aspect,
  MINUTO_BEANS_REFERENCE_URL,
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

    let bagRef:   { data: string; mime: string } | null = null
    let beansRef: { data: string; mime: string } | null = null
    if (useReference) {
      const bagUrl = body.reference_image_url || pickFallbackBagUrl()
      // Fetch both refs in parallel — independent network calls.
      const [b1, b2] = await Promise.all([
        fetchAsB64(bagUrl),
        fetchAsB64(MINUTO_BEANS_REFERENCE_URL),
      ])
      bagRef   = b1
      beansRef = b2
      console.log(`[visual-test] refs loaded — bag: ${bagRef ? 'OK' : 'MISS'}, beans: ${beansRef ? 'OK' : 'MISS'}`)
    }
    const referenceB64 = bagRef?.data ?? null  // kept for downstream brandClause check

    // 2. Build the prompt.
    const brandClause = referenceB64 ? `

REFERENCE IMAGES (TWO included with this prompt — read carefully which is which):

FIRST reference image (the BAG): the actual Minuto coffee bag.
THE MINUTO BAG MUST APPEAR PROMINENTLY in the final image — non-negotiable
when a reference image is provided. If the scene description doesn't
mention the bag, place it in the composition anyway: lower-right or
upper-right third of the frame, in focus, recognizable. Match the
reference exactly: stand-up pouch with zip top, white pouch color,
stag-head emblem, "MINUTO Café Roastery" wordmark, and the colored
center label with the origin/blend name. Do NOT invent a generic bag.
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
elsewhere in the prompt.` : ''

    const fullPrompt = `${MINUTO_VISUAL_IDENTITY}

SCENE: ${sceneBrief}${brandClause}

FORMAT: ${ratio} aspect ratio, photorealistic, high resolution.

⛔ FINAL OVERRIDE — read this LAST and let it overrule the SCENE
description above wherever they conflict:

If the SCENE description mentions a scoop, brass scoop, wooden spoon,
espresso spoon, measuring scoop, or any other utensil, IGNORE that
portion of the description and omit the utensil entirely. Loose beans
go directly on the surface or in a small ceramic dish — never in a
scoop. The only exception is a brass gooseneck kettle when partially
cropped from a frame edge.

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
    if (bagRef)   parts.push({ inlineData: { mimeType: bagRef.mime,   data: bagRef.data } })
    if (beansRef) parts.push({ inlineData: { mimeType: beansRef.mime, data: beansRef.data } })
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
