// Gemini Omni image-to-video via the Interactions API. Shared by
// meta-reel-generate (creates the clip) and meta-reel-status (re-fetches it by
// interaction id) — editing this file means redeploying both.
//
// Response shape, confirmed against a real call on 2026-10-08:
//   { id, status: 'completed', steps: [
//       { type: 'thought', ... },
//       { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: <base64> }] } ] }

const INTERACTIONS = 'https://generativelanguage.googleapis.com/v1beta/interactions'
export const OMNI_MODEL = 'gemini-omni-1.1-flash'

export interface ReelInput {
  imageB64:    string
  mime:        string
  prompt:      string
  aspectRatio: '9:16' | '16:9'
  resolution:  '720p' | '1080p'
}

export async function generateReel(key: string, input: ReelInput): Promise<{ id: string; video: Uint8Array }> {
  const res = await fetch(INTERACTIONS, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      model: OMNI_MODEL,
      input: [
        { type: 'image', data: input.imageB64, mime_type: input.mime },
        { type: 'text',  text: input.prompt },
      ],
      response_format:   { type: 'video', aspect_ratio: input.aspectRatio, resolution: input.resolution },
      generation_config: { video_config: { task: 'image_to_video' } },
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Omni ${res.status}: ${errText.slice(0, 400)}`)
  }
  const interaction = await res.json()
  return { id: interaction.id, video: extractVideo(interaction) }
}

// GET returns the finished interaction with the video inline again.
export async function fetchReel(key: string, id: string): Promise<Uint8Array> {
  const res = await fetch(`${INTERACTIONS}/${encodeURIComponent(id)}`, { headers: { 'x-goog-api-key': key } })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Omni ${res.status}: ${errText.slice(0, 400)}`)
  }
  return extractVideo(await res.json())
}

export function extractVideo(interaction: any): Uint8Array {
  if (!interaction?.id) throw new Error(`Omni returned no interaction id: ${JSON.stringify(interaction).slice(0, 300)}`)
  if (interaction.status !== 'completed') {
    throw new Error(`Omni interaction ${interaction.status ?? 'unknown status'}: ${JSON.stringify(interaction.error ?? '').slice(0, 300)}`)
  }
  for (const step of interaction.steps ?? []) {
    for (const c of step.content ?? []) {
      if (c?.type === 'video' && c.data) return base64ToBytes(c.data)
    }
  }
  throw new Error('Omni completed but returned no video (likely blocked by its safety filter — try a different frame or prompt)')
}

export function reelStoragePath(id: string): string {
  return `ig-reels/reel_${id.replace(/[^A-Za-z0-9_-]/g, '')}.mp4`
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
