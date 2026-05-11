import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

// Phase 2 — Reel video generation, step 1.
//
// Kicks off a Veo image-to-video job: takes the still cover frame produced by
// visual-test (or any public image URL) and an English motion prompt, returns
// the long-running operation ID immediately. The dashboard polls
// meta-reel-status with that ID until the MP4 is ready and uploaded to
// Storage.
//
// We use Veo 2.0 because it's silent (we want to layer curated music later,
// not Veo 3's AI-generated audio which can miss the brand vibe), stable
// (non-preview), and cheaper (~$0.50 / 5-sec clip vs Veo 3's $2.50).
//
// Veo's predictLongRunning API doesn't block — it returns an operation ID in
// ~1 second and the actual generation runs in the background for 1-5 minutes.
// Hence the split into generate + status. Total elapsed exceeds Supabase's
// 150s gateway timeout, which is why we can't do this in one call.

const VEO_MODEL = 'veo-2.0-generate-001'

interface ReelGenerateRequest {
  image_url:     string                                // public URL of the still cover frame
  motion_prompt: string                                // English description of motion (e.g. "slow zoom into bag, gentle steam rising")
  aspect?:       'reel_9_16' | 'square_1_1'           // default reel_9_16
  duration_sec?: 5 | 8                                 // Veo 2 supports 5 or 8 sec; default 5
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
    const aspect       = body.aspect ?? 'reel_9_16'
    const durationSec  = body.duration_sec ?? 5
    const aspectRatio  = aspect === 'square_1_1' ? '1:1' : '9:16'

    // Veo's image-to-video API expects the still as base64 inline. Fetch the
    // public URL, encode chunked to dodge the call-stack overflow that bites
    // when you spread big Uint8Array into String.fromCharCode in one go (same
    // pattern the blog-banner uses).
    const imgRes = await fetch(body.image_url)
    if (!imgRes.ok) throw new Error(`image_url fetch ${imgRes.status}`)
    const mime = (imgRes.headers.get('content-type') ?? 'image/png').split(';')[0].trim()
    const buf  = new Uint8Array(await imgRes.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    const imageB64 = btoa(bin)

    // predictLongRunning is the Vertex/Veo pattern — kick off, return op id.
    const veoRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning?key=${key}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{
            prompt: body.motion_prompt,
            image: { bytesBase64Encoded: imageB64, mimeType: mime },
          }],
          parameters: {
            aspectRatio,
            durationSeconds: durationSec,
            sampleCount: 1,
            personGeneration: 'dont_allow',  // we never want generated faces in Reels
          },
        }),
      },
    )
    if (!veoRes.ok) {
      const errText = await veoRes.text().catch(() => '')
      throw new Error(`Veo ${veoRes.status}: ${errText.slice(0, 400)}`)
    }
    const veoJson = await veoRes.json()
    const opName: string | undefined = veoJson.name
    if (!opName) throw new Error(`Veo returned no operation name: ${JSON.stringify(veoJson).slice(0, 300)}`)

    return json({
      operation:    opName,
      model:        VEO_MODEL,
      aspect_ratio: aspectRatio,
      duration_sec: durationSec,
      // Hint for the caller: poll meta-reel-status?operation=<this> every 5s.
      // Typical end-to-end for Veo 2 is 60-180 seconds.
    }, 200, cors)
  } catch (err: any) {
    console.error('[meta-reel-generate] error:', err?.message)
    return json({ error: err?.message ?? String(err) }, 400, cors)
  }
})

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
