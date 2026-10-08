import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchReel, reelStoragePath } from '../meta-reel-generate/omni.ts'

// Phase 2 — Reel video generation, step 2.
//
// Since the 2026-10-08 move from Veo 2.0 to Gemini Omni, meta-reel-generate
// is synchronous and already returns the finished video_url. This function
// is kept so the generate → poll flow keeps working: given the `operation`
// (Omni interaction id) it returns
//   - DONE:  the public Storage URL. If the upload is somehow missing, the
//            video is re-fetched from the interaction and re-hosted.
//   - ERROR: anything else, including old Veo operation names, which can no
//            longer be polled (Veo 2.0 was removed by Google).
//
// We re-host in Storage rather than hand out Google's data because public
// Storage URLs are what meta-publish (Instagram Graph API) needs — IG fetches
// the video itself from the URL we provide.

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
    if (!opName) throw new Error("'operation' is required (the id returned by meta-reel-generate)")

    if (opName.startsWith('models/')) {
      return json({ status: 'error', error: 'This is a Veo 2.0 operation; Veo 2.0 was removed by Google. Generate the reel again.' }, 200, cors)
    }

    const supabase = createClient(SUPA_URL, SERVICE)
    const filename = reelStoragePath(opName)
    const slash    = filename.lastIndexOf('/')
    const { data: existing } = await supabase.storage
      .from('marketing')
      .list(filename.slice(0, slash), { search: filename.slice(slash + 1), limit: 1 })

    let bytes: number | undefined
    if (!existing?.length) {
      const video = await fetchReel(key, opName)
      const { error: upErr } = await supabase.storage
        .from('marketing')
        .upload(filename, video, { contentType: 'video/mp4', upsert: true })
      if (upErr) throw new Error(`storage upload: ${upErr.message}`)
      bytes = video.length
    }
    const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

    return json({ status: 'done', video_url: pub.publicUrl, bytes }, 200, cors)
  } catch (err: any) {
    console.error('[meta-reel-status] error:', err?.message)
    return json({ status: 'error', error: err?.message ?? String(err) }, 400, cors)
  }
})

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
