import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ASPECT_TO_RATIO,
  Aspect,
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

    // 1. Optionally load the Minuto bag reference image. Priority:
    //    a) explicit per-post reference_image_url (e.g. the actual Antigua
    //       bag when the post is about Antigua) — passed by enrichment.
    //    b) random pick from MINUTO_BAG_REFERENCE_POOL — so generic posts
    //       that didn't match a specific product get visual variety across
    //       the feed instead of always rendering Yirgacheffe.
    let referenceB64: string | null = null
    let referenceMime = 'image/png'
    const referenceUrl = body.reference_image_url || pickFallbackBagUrl()
    if (useReference) {
      const refRes = await fetch(referenceUrl)
      if (refRes.ok) {
        referenceMime = refRes.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/png'
        const buf = new Uint8Array(await refRes.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        }
        referenceB64 = btoa(bin)
        console.log(`[visual-test] reference loaded: ${buf.length} bytes`)
      } else {
        console.warn(`[visual-test] reference fetch failed: ${refRes.status}`)
      }
    }

    // 2. Build the prompt.
    const brandClause = referenceB64 ? `

BRAND BAG REFERENCE: A reference image of the actual Minuto coffee bag is
included with this prompt. THE MINUTO BAG MUST APPEAR PROMINENTLY in the
final image — this is non-negotiable when a reference image is provided.
If the scene description doesn't explicitly mention the bag, place it in
the composition anyway: lower-right or upper-right third of the frame, in
focus, recognizable. The bag's whole purpose in this image is to identify
which Minuto product the post is about; an image without the bag wastes
the per-post product matching the upstream agent already did.

Match the reference exactly: stand-up pouch with zip top, white pouch
color, stag-head emblem, "MINUTO Café Roastery" wordmark at the top, and
the colored center label with the origin/blend name. Do NOT invent a
generic-looking coffee bag.

CRITICAL: Do NOT add any printed dates, roast-date stamps, batch numbers,
expiry stickers, or numerical labels to the bag. The reference image may or
may not have such markings — IGNORE them and render a clean bag without any
dates or numbers. Only the brand wordmark, stag emblem, and origin/blend
name on the center label are allowed.` : ''

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
dark-roasted, glossy beans, oily beans, or rich-brown beans, IGNORE
that portion. Render beans the color of dry rolled oats or blanched
almonds — pale tan, matte, dry. Specialty light roast.

If the SCENE description specifies a ceramic cup but the brewing method
implied is filter / V60 / Chemex / pour-over, render a thin clear-glass
cup instead. Espresso/cappuccino keeps the small unglazed ceramic cup.

These rules WIN over anything in the SCENE description. The prior
text is inspiration; these are mandatory.`

    // 3. Call Gemini 2.5 Flash Image (proven model for reference-conditioned
    //    image edits in this project — same one the blog banner uses).
    const parts = referenceB64
      ? [
          { inlineData: { mimeType: referenceMime, data: referenceB64 } },
          { text: `Generate an image: ${fullPrompt}` },
        ]
      : [{ text: `Generate an image: ${fullPrompt}` }]

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
