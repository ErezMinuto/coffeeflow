// One-shot diagnostic: does the existing GEMINI_API_KEY have access to Veo
// image-to-video? Lists every model the key can see, filters for "veo".
// This function exists only to gate the Phase 2 (Reels generation) build —
// once we know Veo access is in place, this can be deleted.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async (_req) => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })

  // List all models the key can see via the Generative Language API. Veo
  // models show up if the key has Vertex/Veo access.
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return new Response(JSON.stringify({ error: `${res.status}: ${text.slice(0, 400)}` }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  const data = await res.json()
  const all  = (data.models ?? []) as Array<{ name?: string; supportedGenerationMethods?: string[]; description?: string }>
  const veo  = all.filter(m => /veo/i.test(m.name ?? ''))
  const ig   = all.filter(m => /imagen/i.test(m.name ?? ''))
  return new Response(JSON.stringify({
    total_models: all.length,
    veo_models: veo.map(m => ({ name: m.name, methods: m.supportedGenerationMethods })),
    imagen_models: ig.map(m => ({ name: m.name, methods: m.supportedGenerationMethods })),
    veo_access: veo.length > 0,
  }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
})
