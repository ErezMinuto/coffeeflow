// Composites a Hebrew (RTL) text overlay onto an existing image and uploads
// the result to Supabase Storage. Runs entirely in the Deno edge runtime —
// no Fly.io worker needed for static images. Uses resvg-wasm to render an
// SVG that wraps the source image as a base64-encoded <image> + a Hebrew
// <text> block at the bottom-third of the frame, on top of a translucent
// dark band for legibility.
//
// Used by the dashboard CarouselControls AFTER visual-test produces the
// raw photographic image: when an enriched slide has overlay_text set,
// the chain becomes visual-test → visual-overlay → final URL.
//
// SVG/resvg approach is used (instead of Sharp or canvas) because:
//   - resvg-wasm has zero native deps and runs cleanly in Deno edge.
//   - SVG <text direction="rtl"> handles Hebrew shaping/bidirection natively.
//   - One render pass — fetch image, build SVG, render PNG, upload.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resvg, initWasm } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2'

// Heebo (Google Fonts repo, variable font axis [wght]) — open license,
// supports Hebrew + Latin. Fetched once at first call and cached in
// module state for the lifetime of the function instance (cold start
// hit only). Variable font (122KB) so we get all weights from one file.
const HEEBO_BOLD_URL = 'https://github.com/google/fonts/raw/main/ofl/heebo/Heebo%5Bwght%5D.ttf'
const RESVG_WASM_URL = 'https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm'

const SUPA_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

let wasmInit: Promise<void> | null = null
async function ensureWasm() {
  if (!wasmInit) {
    wasmInit = initWasm(fetch(RESVG_WASM_URL))
  }
  return wasmInit
}

let cachedFont: Uint8Array | null = null
async function loadFont(): Promise<Uint8Array> {
  if (cachedFont) return cachedFont
  const res = await fetch(HEEBO_BOLD_URL)
  if (!res.ok) throw new Error(`heebo font fetch ${res.status}`)
  cachedFont = new Uint8Array(await res.arrayBuffer())
  return cachedFont
}

interface OverlayRequest {
  image_url:   string
  // Headline text — rendered large + bold, wraps to as many lines as needed.
  overlay_text: string
  // Optional supporting copy under the headline — rendered smaller, also
  // wrapped. Used by carousel slides that carry heading + body.
  body_text?:  string
  // Position of the text band. Default 'bottom' (most carousel slides).
  position?:   'bottom' | 'top' | 'center'
  // Direction. Default 'rtl' for Hebrew. Pass 'ltr' for English overlays.
  direction?:  'rtl' | 'ltr'
  // Optional aspect hint so we render the correct PNG dimensions. Default
  // 'feed_square'. 'feed_portrait' (4:5, 1080×1350) is the IG carousel
  // standard; 'reel_cover' is 9:16.
  aspect?:     'feed_square' | 'feed_portrait' | 'reel_cover'
}

const DIM_FOR_ASPECT: Record<NonNullable<OverlayRequest['aspect']>, { w: number; h: number }> = {
  feed_square:   { w: 1080, h: 1080 },
  feed_portrait: { w: 1080, h: 1350 },
  reel_cover:    { w: 1080, h: 1920 },
}

// Greedy word-wrap. resvg gives no text-metrics API, so we estimate each
// line's width from an average Hebrew/Latin glyph advance (~0.54×fontSize
// for the Heebo bold weight we render with) and break on spaces. Short
// marketing copy only, so estimate-based wrapping is accurate enough; the
// dark band is sized from the resulting line count so text never clips.
function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (!clean) return []
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.54)))
  const words = clean.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word
    if (candidate.length <= maxChars) {
      cur = candidate
    } else {
      if (cur) lines.push(cur)
      // A single word longer than the line: hard-break it so it can't clip.
      if (word.length > maxChars) {
        let rest = word
        while (rest.length > maxChars) {
          lines.push(rest.slice(0, maxChars))
          rest = rest.slice(maxChars)
        }
        cur = rest
      } else {
        cur = word
      }
    }
  }
  if (cur) lines.push(cur)
  return lines
}

serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405, cors)

  try {
    const body = await req.json() as OverlayRequest
    if (!body.image_url)    throw new Error("'image_url' is required")
    if (!body.overlay_text || !body.overlay_text.trim()) {
      throw new Error("'overlay_text' is required (non-empty string)")
    }
    const position  = body.position ?? 'bottom'
    const direction = body.direction ?? 'rtl'
    const aspect    = body.aspect ?? 'feed_square'
    const { w, h }  = DIM_FOR_ASPECT[aspect] ?? DIM_FOR_ASPECT.feed_square

    // 1. Fetch source image as base64 so it can sit inside the SVG <image>
    const imgRes = await fetch(body.image_url)
    if (!imgRes.ok) throw new Error(`source image_url ${imgRes.status}`)
    const imgBuf  = new Uint8Array(await imgRes.arrayBuffer())
    const imgMime = imgRes.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
    let bin = ''
    for (let i = 0; i < imgBuf.length; i += 0x8000) bin += String.fromCharCode(...imgBuf.subarray(i, i + 0x8000))
    const imgB64  = btoa(bin)

    // 2. Build the SVG. Heading (large/bold) + optional body (smaller) sit
    //    on a dark translucent band for legibility. Both are word-wrapped to
    //    the frame width, so the band grows to fit however many lines result.
    //    Text is right-anchored for RTL (Hebrew flows right→left from the
    //    anchor), left-anchored for LTR.
    const padX        = 64
    const padY        = 40
    const headFont    = aspect === 'reel_cover' ? 68 : aspect === 'feed_portrait' ? 60 : 56
    const bodyFont    = Math.max(30, Math.round(headFont * 0.6))
    const headLH      = Math.round(headFont * 1.28)
    const bodyLH      = Math.round(bodyFont * 1.34)
    const gap         = Math.round(headFont * 0.5)  // space between heading + body blocks
    const maxTextW    = w - padX * 2

    const headLines = wrapText(body.overlay_text, headFont, maxTextW)
    const bodyLines = body.body_text ? wrapText(body.body_text, bodyFont, maxTextW) : []

    const headBlockH = headLines.length * headLH
    const bodyBlockH = bodyLines.length * bodyLH
    const bandH = padY * 2 + headBlockH + (bodyLines.length ? gap + bodyBlockH : 0)
    const bandY = position === 'top'
                    ? 0
                    : position === 'center'
                      ? (h - bandH) / 2
                      : h - bandH

    const textAnchor = direction === 'rtl' ? 'end' : 'start'
    const textX      = direction === 'rtl' ? w - padX : padX
    const xmlLang    = direction === 'rtl' ? 'he' : 'en'

    // Baseline of line `i` within a block whose top starts at `top`.
    const lineY = (top: number, i: number, lh: number, font: number) =>
      top + i * lh + font * 0.82

    const headTop = bandY + padY
    const bodyTop = headTop + headBlockH + (bodyLines.length ? gap : 0)

    const headEls = headLines.map((ln, i) =>
      `<text x="${textX}" y="${lineY(headTop, i, headLH, headFont)}" font-family="Heebo" font-size="${headFont}" font-weight="700" fill="white" text-anchor="${textAnchor}" direction="${direction}" xml:lang="${xmlLang}">${escapeXml(ln)}</text>`,
    ).join('\n  ')

    const bodyEls = bodyLines.map((ln, i) =>
      `<text x="${textX}" y="${lineY(bodyTop, i, bodyLH, bodyFont)}" font-family="Heebo" font-size="${bodyFont}" font-weight="400" fill="rgba(255,255,255,0.92)" text-anchor="${textAnchor}" direction="${direction}" xml:lang="${xmlLang}">${escapeXml(ln)}</text>`,
    ).join('\n  ')

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image href="data:${imgMime};base64,${imgB64}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>
  <rect x="0" y="${bandY}" width="${w}" height="${bandH}" fill="rgba(0,0,0,0.55)"/>
  ${headEls}
  ${bodyEls}
</svg>`

    // 3. Render to PNG via resvg
    await ensureWasm()
    const fontBytes = await loadFont()
    const resvg = new Resvg(svg, {
      font: { fontBuffers: [fontBytes], loadSystemFonts: false, defaultFontFamily: 'Heebo' },
      fitTo: { mode: 'width', value: w },
    })
    const png = resvg.render().asPng()

    // 4. Upload to Storage and return public URL
    const supabase = createClient(SUPA_URL, SERVICE)
    const filename = `ig-overlay/${aspect}_${Date.now()}.png`
    const { error: upErr } = await supabase.storage
      .from('marketing')
      .upload(filename, png, { contentType: 'image/png', upsert: true })
    if (upErr) throw new Error(`storage upload: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

    return json({
      success:    true,
      url:        pub.publicUrl,
      bytes:      png.length,
      aspect,
      position,
      direction,
    }, 200, cors)
  } catch (err: any) {
    console.error('[visual-overlay] error:', err?.message)
    return json({ error: err?.message ?? String(err) }, 400, cors)
  }
})

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]!))
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
