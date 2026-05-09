import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Phase 2 — Reel video generation, step 2.
//
// Polls a Veo predictLongRunning operation. Three terminal states the
// dashboard cares about:
//   - PENDING: not done yet → caller polls again in 5s.
//   - DONE:    Veo finished. We download the MP4 from Veo's signed URL,
//              upload it to Supabase Storage's `marketing` bucket, and
//              return the public URL the caller can hand to meta-publish.
//   - ERROR:   Veo failed. Surface the message.
//
// We do the download+upload here (server-side) instead of giving the caller
// the Veo signed URL directly because:
//   1. Veo's URL expires after ~1 hour, so we'd lose the asset.
//   2. Public Storage URLs are what meta-publish (Instagram Graph API) needs
//      — IG fetches the video itself from the URL we provide.

const SUPA_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) return json({ error: 'GEMINI_API_KEY not set' }, 500, cors)

  try {
    // Accept both POST {operation} and GET ?operation=
    let opName: string | null = null
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      opName = body?.operation ?? null
    } else {
      opName = new URL(req.url).searchParams.get('operation')
    }
    if (!opName) throw new Error("'operation' is required (the name returned by meta-reel-generate)")

    // Poll Veo. The operation name returned by predictLongRunning IS the
    // path you GET to check status — e.g. "models/veo-2.0-generate-001/operations/abc123".
    const opRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${opName}?key=${key}`)
    if (!opRes.ok) {
      const txt = await opRes.text().catch(() => '')
      throw new Error(`operation poll ${opRes.status}: ${txt.slice(0, 300)}`)
    }
    const op = await opRes.json()

    if (!op.done) {
      return json({ status: 'pending', operation: opName }, 200, cors)
    }
    if (op.error) {
      return json({ status: 'error', error: op.error?.message ?? JSON.stringify(op.error).slice(0, 300) }, 200, cors)
    }

    // Veo wraps the result a few different ways depending on model version.
    // Look in all the obvious places for a video URL OR base64-encoded MP4.
    const response = op.response ?? {}
    let videoBytes: Uint8Array | null = null
    let veoSignedUrl: string | null = null

    // Most-common shape (Veo 2/3 longRunning): response.generateVideoResponse.generatedSamples[].video.uri
    const samples = response.generateVideoResponse?.generatedSamples
                 ?? response.generatedSamples
                 ?? response.predictions
                 ?? []
    for (const s of samples) {
      const v = s.video ?? s.videoFile ?? s
      if (v?.uri) { veoSignedUrl = v.uri; break }
      if (v?.bytesBase64Encoded) {
        videoBytes = base64ToBytes(v.bytesBase64Encoded)
        break
      }
    }

    if (!videoBytes && !veoSignedUrl) {
      return json({
        status: 'error',
        error:  'operation done but no video found in response',
        debug:  JSON.stringify(response).slice(0, 800),
      }, 200, cors)
    }

    // If Veo gave us a signed URL, fetch the bytes ourselves so we can re-host
    // them. The signed URL needs the same API key as a query param.
    if (!videoBytes && veoSignedUrl) {
      const sep = veoSignedUrl.includes('?') ? '&' : '?'
      const dl = await fetch(`${veoSignedUrl}${sep}key=${key}`)
      if (!dl.ok) throw new Error(`download from Veo ${dl.status}`)
      videoBytes = new Uint8Array(await dl.arrayBuffer())
    }

    // Upload to Supabase Storage.
    const supabase = createClient(SUPA_URL, SERVICE)
    const filename = `ig-reels/reel_${Date.now()}.mp4`
    const { error: upErr } = await supabase.storage
      .from('marketing')
      .upload(filename, videoBytes!, { contentType: 'video/mp4', upsert: true })
    if (upErr) throw new Error(`storage upload: ${upErr.message}`)
    const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

    return json({
      status:    'done',
      video_url: pub.publicUrl,
      bytes:     videoBytes!.length,
    }, 200, cors)
  } catch (err: any) {
    console.error('[meta-reel-status] error:', err?.message)
    return json({ status: 'error', error: err?.message ?? String(err) }, 400, cors)
  }
})

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
