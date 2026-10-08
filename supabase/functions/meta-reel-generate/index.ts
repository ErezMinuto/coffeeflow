import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateReel, reelStoragePath } from './omni.ts'

// Phase 2 — Reel video generation, step 1.
//
// Image-to-video: takes the still cover frame produced by visual-test (or any
// public image URL) and an English motion prompt, generates the clip with
// Gemini Omni, re-hosts the MP4 in Storage and returns its public URL.
//
// 2026-10-08: migrated from Veo 2.0 (veo-2.0-generate-001 now 404s — Google
// removed it) to gemini-omni-1.1-flash. Differences that matter here:
//   - Omni ALWAYS generates audio; there is no off switch. We keep it quiet
//     by appending SOUND_GUARD to every prompt (Veo 2 was chosen for being
//     silent so curated music can be layered later).
//   - No duration parameter. Omni picks the length (~10s in testing);
//     duration_sec is accepted for backward compatibility and ignored.
//   - No personGeneration setting. "No people" goes in the prompt instead.
//   - It's synchronous (~35s at 720p in testing, inside the 150s gateway
//     limit), so this call already has the video. It still returns an
//     `operation` (the interaction id) so the old generate → poll
//     meta-reel-status flow keeps working; status answers 'done' at once.

const SUPA_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const SOUND_GUARD = 'Audio: soft ambient room tone only. No dialogue, no voices, no music, no extra sound effects. No people.'

interface ReelGenerateRequest {
  image_url:     string                                // public URL of the still cover frame
  motion_prompt: string                                // English description of motion (e.g. "slow zoom into bag, gentle steam rising")
  aspect?:       'reel_9_16' | 'square_1_1'           // default reel_9_16
  duration_sec?: number                                // ignored — Omni has no duration control
  resolution?:   '720p' | '1080p'                     // default 720p; 1080p is an upscale and slower
}

serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405, cors)

  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) return json({ error: 'GEMINI_API_KEY not set' }, 500, cors)

  try {
    const body = await req.json() as ReelGenerateRequest
    if (!body.image_url)     throw new Error("'image_url' is required")
    if (!body.motion_prompt) throw new Error("'motion_prompt' is required")
    // Omni only renders 16:9 and 9:16. Square requests get 9:16; Meta crops
    // a vertical clip for square placements.
    const aspectRatio = '9:16'
    const resolution  = body.resolution === '1080p' ? '1080p' : '720p'

    // Omni takes the still as base64 inline. Fetch the public URL, encode
    // chunked to dodge the call-stack overflow that bites when you spread big
    // Uint8Array into String.fromCharCode in one go (same pattern the
    // blog-banner uses).
    const imgRes = await fetch(body.image_url)
    if (!imgRes.ok) throw new Error(`image_url fetch ${imgRes.status}`)
    const mime = (imgRes.headers.get('content-type') ?? 'image/png').split(';')[0].trim()
    const buf  = new Uint8Array(await imgRes.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    const imageB64 = btoa(bin)

    const { id, video } = await generateReel(key, {
      imageB64, mime,
      prompt: `${body.motion_prompt.trim()}\n\n${SOUND_GUARD}`,
      aspectRatio, resolution,
    })

    const supabase = createClient(SUPA_URL, SERVICE)
    const filename = reelStoragePath(id)
    const { error: upErr } = await supabase.storage
      .from('marketing')
      .upload(filename, video, { contentType: 'video/mp4', upsert: true })
    if (upErr) throw new Error(`storage upload: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

    return json({
      status:       'done',
      operation:    id,
      video_url:    pub.publicUrl,
      bytes:        video.length,
      model:        'gemini-omni-1.1-flash',
      aspect_ratio: aspectRatio,
      resolution,
    }, 200, cors)
  } catch (err: any) {
    console.error('[meta-reel-generate] error:', err?.message)
    return json({ error: err?.message ?? String(err) }, 400, cors)
  }
})

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
