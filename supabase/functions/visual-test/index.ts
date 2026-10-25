import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { detectScene, identityFor, sectionNames } from './scene_rules.ts'
import { bagReferenceFor, isJarProduct, storagePublicUrl, type BagReference } from '../_shared/bag_references.ts'
import { decode as decodeBase64 } from 'https://deno.land/std@0.168.0/encoding/base64.ts'
import {
  ASPECT_TO_RATIO,
  Aspect,
  MINUTO_BEANS_REFERENCE_URL,
  MINUTO_ESPRESSO_MACHINE_REFERENCE_URL,
  MINUTO_ROASTER_REFERENCE_URL,
  SCENE_PRESETS,
} from '../_shared/visual_identity.ts'
// pickFallbackBagUrl intentionally NOT imported — caller must specify
// which bag to use via reference_image_url / product_id / product_name.
// Random pool selection was removed 2026-05-16 so the rendered bag
// always matches the product being promoted in the post.
// Compositor kept in repo for selective re-enablement, but not imported
// in the default render path. The architecture pivoted to "Gemini renders
// from bag + style-ref references + bullet-structured prompt" because
// composited PNGs read as 2D-pasted in 3D scenes.

// Pick a random asset URL from a subfolder of upload_images/. The folder
// must already be populated with photos shot on white/uniform backgrounds
// (the flood-fill background-removal pass relies on that). Returns null
// if the folder is empty or unreachable — caller falls back to its
// default behaviour (typically: skip compositing for that object).
async function pickRandomAssetUrl(
  supabase: ReturnType<typeof createClient>,
  category: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('marketing')
    .list(`upload_images/${category}`, { limit: 100, sortBy: { column: 'name', order: 'asc' } })
  if (error || !data || data.length === 0) {
    console.warn(`[visual-test] asset pick "${category}" empty or errored: ${error?.message ?? 'no files'}`)
    return null
  }
  // Filter out folder placeholders (`.emptyFolderPlaceholder`) and any
  // non-image entries that might sneak in.
  const files = data.filter(f => f.name && !f.name.startsWith('.') && /\.(jpg|jpeg|png|webp)$/i.test(f.name))
  if (files.length === 0) return null
  const pick = files[Math.floor(Math.random() * files.length)]
  return `${SUPABASE_URL}/storage/v1/object/public/marketing/upload_images/${category}/${pick.name}`
}

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

// Surface rotation — varies the rendered scene's surface so the feed
// doesn't look mono-textured. Gemini was defaulting to concrete on
// every render despite the visual identity listing multiple surfaces.
// This module picks one explicitly per-render and the prompt injects
// it as an authoritative override. Weights bias toward Minuto-authentic
// surfaces (concrete, dark walnut) but mix in oak and stainless steel
// for variety per the user's request.
const SURFACES: Array<{ name: string; description: string; weight: number }> = [
  { name: 'raw concrete',            description: 'smooth poured concrete with a fine even grain, grey-tan tones, clean and unblemished',         weight: 22 },
  { name: 'weathered dark walnut',   description: 'fine-sanded dark walnut with smooth even grain, deep brown chocolate tones, softly polished',    weight: 20 },
  { name: 'light grained oak',       description: 'premium light-grained oak wood, warm honey-amber tones, clear visible wood grain, slight matte sheen', weight: 20 },
  { name: 'brushed stainless steel', description: 'brushed stainless steel surface, cool silver-grey tones, subtle reflective sheen, cafe-bar feel',    weight: 14 },
  { name: 'raw lime plaster',        description: 'smooth lime plaster with a fine even matte finish, off-white to cream tones, unblemished',          weight: 12 },
  { name: 'hand-thrown earthenware', description: 'large hand-thrown earthenware platter as surface, deep brown-grey with a smooth unglazed matte finish',           weight:  7 },
  { name: 'aged copper',             description: 'brushed copper surface, warm orange-brown tones, even soft matte finish',         weight:  5 },
]

function pickSurface(): { name: string; description: string } {
  const total = SURFACES.reduce((s, x) => s + x.weight, 0)
  let r = Math.random() * total
  for (const s of SURFACES) {
    if (r < s.weight) return s
    r -= s.weight
  }
  return SURFACES[0]
}

// Read the pixel dimensions straight out of a PNG/JPEG header. Used to
// VERIFY that the image Gemini returned actually has the aspect ratio we
// asked for — the model accepts the request either way and silently
// returns its own shape when it ignores us, which is invisible unless we
// measure. Returns null for formats we don't parse (never throws).
function readImageSize(bytes: Uint8Array): { w: number; h: number } | null {
  // PNG: 8-byte signature, then IHDR with width/height as big-endian u32.
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { w: dv.getUint32(16), h: dv.getUint32(20) }
  }
  // JPEG: walk the segment chain to the first SOFn frame header.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue }
      const marker = bytes[i + 1]
      // SOF0-SOF15 carry the dimensions; C4/C8/CC are DHT/JPG/DAC, not SOF.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] }
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3])
    }
  }
  return null
}

// True when the rendered image matches the requested "W:H" within 5%.
// Unknown dimensions (unparsed format) count as OK — never block a render
// on our own inability to measure it.
function matchesRatio(dims: { w: number; h: number } | null, ratio: string): boolean {
  if (!dims || !dims.h) return true
  const [rw, rh] = ratio.split(':').map(Number)
  if (!rw || !rh) return true
  const want = rw / rh
  return Math.abs(dims.w / dims.h - want) <= want * 0.05
}

// ── Real-photo library matching ─────────────────────────────────────────
// A folder like upload_images/roaster/ mixes very different shots (the main
// roaster, a sample roaster, green-coffee sacks). A RANDOM pick forced the
// editor to turn e.g. a sack photo into "roast day", and it invented content
// to get there. Instead each photo gets a one-line caption and the brief is
// matched against
// the captions. No fitting photo → [] → caller falls back to generation.
// Captions live in memory for the life of the worker (the marketing bucket
// only accepts images/video, so there is nowhere to persist them without a
// new table); a cold start re-captions the few folders a brief needs.
const CAPTION_MODEL  = 'gemini-2.5-flash'
const CAPTION_BATCH  = 6
// Library photos are 3-6 MB phone shots. Loading + base64-ing a dozen of
// them blew the edge worker's memory (WORKER_RESOURCE_LIMIT), so Gemini
// reads them straight from their public URLs via fileData instead.
const mimeOf = (path: string) => /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg'
const captionCache   = new Map<string, string>()

async function geminiJson(parts: any[]): Promise<any> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CAPTION_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY ?? '' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    },
  )
  if (!res.ok) throw new Error(`Gemini ${CAPTION_MODEL} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const j = await res.json()
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
  return JSON.parse(text)
}


// ── Brief rewrite ──────────────────────────────────────────────────────────
// The image model draws what the SCENE BRIEF describes and treats the
// "never do X" overrides at the end of the prompt as weaker. A live story
// test (2026-10-10) proved it: with the override rules deployed, a brief
// that said "a kettle pours hot water into a glass cup" still produced
// exactly that. So we fix the brief itself before anything is drawn: one
// cheap text call rewrites it into a scene that already obeys the rules.
// Fails OPEN — on any error the original brief is used unchanged.
const BRIEF_REWRITE_RULES = `You rewrite photo briefs for Minuto, a specialty COFFEE roastery and café, so an image model can draw them literally without breaking these rules. Keep everything in the brief that does not break a rule: subject, mood, light, setting, composition, aspect, and any product or bag it names.

RULES:
1. COFFEE ONLY. No tea, tea bags, teapots, tea leaves or infusions. Any drink is coffee: amber-brown filter coffee, espresso with crema, or a milk drink.
2. POUR-OVER PHYSICS. A kettle never pours into a cup, glass or mug. Kettle water pours into a V60 / Chemex dripper holding a paper filter and a bed of wet coffee grounds; coffee drips into a glass server or cup BELOW the dripper. Rewrite any kettle-into-cup scene this way.
3. ONE OF EACH MACHINE. Name each machine once, with "a single". Never two roasters, two espresso machines, two kettles or two grinders unless the brief explicitly asks for two. Collapse different words for the same machine ("the roaster", "the roasting machine", "the drum") into one.
4. THE ROASTER is Minuto's single, FULL-SIZE production drum roaster standing on the roastery floor, 2.0 m tall (taller than an adult), 1.5 m long and 1.0 m wide, with silver chimney ducts at 2.8 m by the ceiling — never a small model, miniature or tabletop unit, never on a counter, table or bench, and never small or distant in the frame; describe it as large and dominant. Its cooler is a large, deep, cylindrical brushed-stainless COOLING BIN with tall straight sides (about as wide as the drum body) standing on the FLOOR at the front-right of the roaster, directly below the drum door; fresh beans fall from the drum door into it and its internal stirring arms turn them. Never a shallow tray on a stand or on a table; nobody stirs the beans by hand. (The small tabletop SAMPLE roaster is only for briefs about sample roasting / cupping, and never alongside the main roaster.)
5. AEROPRESS ON THE CUP. An AeroPress is supported only by the cup it brews into: its base flange RESTS DIRECTLY ON THE CUP RIM, physically touching it — never floating above the cup with a gap or a stream falling through open air.
6. HANDS ONLY FOR AN ACTION. No people, faces or bodies. Keep or add ONE natural hand (or a pair) only when the brief asks for a person, hand or barista, or when the scene shows a tool being actively used: a kettle pouring, a pitcher pouring milk, tamping, cranking a hand grinder, pressing an AeroPress. The hand belongs to a person standing just out of frame and holds the tool properly (a pouring kettle by its handle; a hand grinder's body gripped in one hand while the other turns the crank). If the brief shows the action but no hand, either add that hand or rewrite the scene as the moment just after the action with the tool set down, never a tool floating or pouring on its own. Otherwise no hands. No spoons, scoops, paddles or stirring tools anywhere.
7. ESPRESSO ON THE MACHINE. Espresso pouring from a portafilter is only ever under the espresso machine: the portafilter locked into the group head, the cup on the machine's stainless drip-tray grate. If the brief puts a shot being pulled onto a table, counter or wooden surface, move the cup onto the drip tray and keep the brief's surface only as the counter around the machine. A finished espresso with no pour may stand anywhere.
8. SEALED BAG. A Minuto coffee bag is always CLOSED and SEALED: standing upright or lying flat, top folded or zipped shut. Never an open bag, a bag with its mouth open, a torn bag, or beans spilling or pouring out of a bag. Beans may sit loose BESIDE or IN FRONT OF the closed bag. Rewrite any open or spilling bag this way.
9. Describe only what the camera sees, in concrete nouns. Write it as 3-6 sentences of plain English.

Reply as JSON {"brief": "<the rewritten brief>", "changes": ["<each rule you applied, short>"]}. If the brief already follows every rule, return it unchanged with "changes": [].`

async function rewriteBrief(brief: string): Promise<{ brief: string; changes: string[]; error?: string }> {
  try {
    const out = await geminiJson([{ text: `${BRIEF_REWRITE_RULES}\n\nBRIEF:\n${brief}` }])
    const rewritten = typeof out?.brief === 'string' ? out.brief.trim() : ''
    if (rewritten.length < 20) return { brief, changes: [], error: 'empty rewrite' }
    return { brief: rewritten, changes: Array.isArray(out?.changes) ? out.changes.map(String) : [] }
  } catch (e: any) {
    return { brief, changes: [], error: String(e?.message ?? e) }
  }
}

async function pickMatchingRealPhoto(
  supabase: ReturnType<typeof createClient>,
  folders: string[],
  brief: string,
): Promise<string[]> {
  try {
    // 1. Candidate files across the allowed folders.
    const paths: string[] = []
    for (const folder of folders) {
      const { data } = await supabase.storage.from('marketing')
        .list(`upload_images/${folder}`, { limit: 200, sortBy: { column: 'name', order: 'asc' } })
      for (const f of data ?? []) {
        if (!f.name || f.name.startsWith('.') || !/\.(jpe?g|png|webp)$/i.test(f.name)) continue
        paths.push(`upload_images/${folder}/${f.name}`)
      }
    }
    if (paths.length === 0) return []
    const urlOf = (path: string) => `${SUPABASE_URL}/storage/v1/object/public/marketing/${path}`

    // 2. Caption photos not seen by this worker yet, a few at a time.
    const missing = paths.filter(p => !captionCache.has(p))
    for (let i = 0; i < missing.length; i += CAPTION_BATCH) {
      await Promise.all(missing.slice(i, i + CAPTION_BATCH).map(async path => {
        try {
          const out = await geminiJson([
            { fileData: { mimeType: mimeOf(path), fileUri: urlOf(path) } },
            { text: 'Caption this photo from a specialty-coffee roastery/cafe photo library, for matching against scene briefs. One factual sentence: the main subject; which equipment exactly (e.g. 2-group espresso machine front / side, main drum roaster with round cooling tray, small tabletop sample roaster, grinder, jute sacks of GREEN unroasted coffee); whether beans are green or roasted; whether hands or people are visible and doing what; notable problems (clutter, faces). Reply as JSON {"caption": "..."}.' },
          ])
          if (typeof out?.caption === 'string') captionCache.set(path, out.caption)
        } catch (e: any) {
          console.warn(`[visual-test] caption failed for ${path}: ${e?.message}`)
        }
      }))
    }
    if (missing.length > 0) console.log(`[visual-test] captioned ${missing.filter(p => captionCache.has(p)).length}/${missing.length} library photo(s)`)

    // 3. Match the brief against captioned candidates.
    const candidates = paths.filter(p => captionCache.has(p))
    if (candidates.length === 0) return []
    const list = candidates.map((p, i) => `[${i}] ${captionCache.get(p)}`).join('\n')
    const out = await geminiJson([{ text: `A real photo will be lightly EDITED (reframed, relit, and at most a small action added such as an espresso stream, steam, or beans pouring onto a tray) to illustrate this scene brief:

${brief}

Library photos:
${list}

Which photos ALREADY show the brief's main subject and action from a usable viewpoint, so that only a crop, light and that small action need changing? IGNORE the brief's surface, table or counter material, cup material/colour, light and background — the real photo's own versions are correct and win (e.g. at Minuto an espresso cup stands on the machine's drip tray, not on a wooden table). A close-up brief is met by cropping in on a photo where the subject is clearly visible. The camera angle cannot change: a brief about the group head / portafilter / espresso pour needs a photo where the group heads and portafilters are clearly visible (front or three-quarter view, not the machine's side end); a brief about steaming milk needs the steam wand and a pitcher in frame; a close-up brief needs the subject already large in the photo. Be strict: a different machine, a different kind of roaster, sacks instead of a roaster, or green beans where roasted are needed = NOT a match. At Minuto, "the roaster", "the roastery", "roast day" and "cooling tray" mean the MAIN DRUM ROASTER with its round cooling tray — the small tabletop sample roaster matches only briefs that explicitly say sample roast / sample roaster / cupping. Reply as JSON {"matches": [indices]} — empty if none fit.` }])
    const idx: number[] = Array.isArray(out?.matches)
      ? out.matches.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < candidates.length)
      : []
    console.log(`[visual-test] real-photo match: ${idx.length}/${candidates.length} fit → ${idx.map(i => candidates[i]).join(', ') || 'none'}`)
    if (idx.length === 0) return []
    // Up to two fitting photos in random order — the caller verifies each
    // edit against its source and moves on to the next if it drifted.
    return idx.map(i => urlOf(candidates[i])).sort(() => Math.random() - 0.5).slice(0, 2)
  } catch (e: any) {
    console.warn(`[visual-test] real-photo matching failed, falling back to generation: ${e?.message}`)
    return []
  }
}

const GEMINI_KEY    = Deno.env.get('GEMINI_API_KEY')
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

interface VisualTestRequest {
  scene_brief?: string                       // free-form scene description
  preset?: keyof typeof SCENE_PRESETS        // shortcut: pick a SCENE_PRESETS key
  aspect?: Aspect                            // default 'feed_square'
  use_reference?: boolean                    // default true; pass false to skip the bag entirely
  // When use_reference is true (the default), one of the following is
  // REQUIRED. Random pool fallback was removed 2026-05-16.
  reference_image_url?: string               // direct URL to a bag photo
  product_id?: number                        // woo_id (numeric WooCommerce product ID); resolved against woo_products.image_url
  product_name?: string                      // text — fuzzy-matched via ILIKE against woo_products.name (same pattern as marketing-advisor enrichment)
  // Extra photos of the SAME bag from other angles (e.g. a three-quarter view
  // showing the gusset). Shape/depth reference only; the primary bag image
  // stays the authority for the label. Max 2.
  bag_view_urls?: string[]
  composite_bag?: boolean                    // no-op (kept for backward compat) — compositing was abandoned in favour of bag-as-Gemini-reference rendering
  composite_cup?: boolean                    // no-op (kept for backward compat)
  // Real-photo mode: start from an actual photo of Minuto's bar / machine /
  // roaster (upload_images/) and only reframe + relight it, instead of
  // generating the equipment from scratch. Default: automatic for bagless
  // bar/machine/barista/roaster scenes. Pass false to force generation.
  real_photo?: boolean
  // Skip the pre-generation brief rewrite (rewriteBrief). Default: rewrite.
  skip_rewrite?: boolean
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
    const originalBrief = body.scene_brief ?? (body.preset ? SCENE_PRESETS[body.preset] : null)
    if (!originalBrief) {
      throw new Error(`provide either 'scene_brief' or 'preset' (one of: ${Object.keys(SCENE_PRESETS).join(', ')})`)
    }
    // Rewrite BEFORE any routing regex reads the brief, so reference picks
    // (roaster / machine / style) see the corrected scene too.
    const rewrite = body.skip_rewrite ? { brief: originalBrief, changes: [] as string[] } : await rewriteBrief(originalBrief)
    let sceneBrief = rewrite.brief
    console.log(`[visual-test] brief rewrite: ${rewrite.error ? `FAILED (${rewrite.error}) — using original` : rewrite.changes.length ? `changed — ${rewrite.changes.join('; ')}` : 'no changes'}`)
    const aspect    = body.aspect ?? 'feed_square'
    // Resolve the ratio LOUDLY. Callers pass `aspect` as a plain string at
    // runtime (seo-worker-visual forwards whatever the strategist wrote),
    // so an unmapped key used to yield `undefined` — which interpolated
    // into the prompt as the literal "at undefined aspect ratio" and sent
    // no aspect to Gemini at all. That is how IG stories shipped
    // horizontal. Never render on an unknown aspect silently.
    const ratio: string = ASPECT_TO_RATIO[aspect] ?? '1:1'
    if (!ASPECT_TO_RATIO[aspect]) {
      console.warn(`[visual-test] unknown aspect "${aspect}" — falling back to 1:1 (known: ${Object.keys(ASPECT_TO_RATIO).join(', ')})`)
    }
    const useReference = body.use_reference !== false

    // ── Minimal-scene gate ────────────────────────────────────────────────
    // Some briefs explicitly demand a clean single-subject / studio / no-prop
    // shot ("zero beans", "nothing else", "only the glass", "pure product on
    // white"). The default bag_hero scaffolding FIGHTS those: it force-attaches
    // a beans color-anchor + a cups/brewing style-anchor, lists "supporting
    // props", and overrides the brief's surface with a rotated rustic one. That
    // self-contradiction is exactly what made these briefs fail QA 3x and then
    // brief-regen to a HITL cap (real examples: tasks 8421991d, ff7e8c3f,
    // ac72e06d). no_bag briefs already render clean because they skip these
    // refs — this makes a prop-forbidding bag_hero behave the same way: keep
    // the bag, drop the contradicting scaffolding, respect the brief.
    const forbidsProps = /\b(no props|zero props|no secondary|no other objects?|without (?:any )?props|no clutter|no decorative|nothing else|no beans|zero beans|no roasted beans|no cups?|zero cups?|no glassware|zero glassware|no ceramic|sole (?:subject|object|hero)|only the (?:bag|glass|mug|cup|jar)|pure product|seamless (?:white|ivory|cream|backdrop)|studio (?:backdrop|sweep|shot)|product[- ]on[- ]white)\b/.test(sceneBrief.toLowerCase())
    if (forbidsProps) console.log('[visual-test] minimal-scene gate ON — brief forbids props: skipping beans + style refs, deferring surface/composition to the brief')
    // Compositing DISABLED — pivoted to a "Gemini renders bag from reference
    // image + style reference images + bullet-structured prompt" architecture
    // (Erez's test proved Gemini renders the bag faithfully when given a
    // clear single-subject directive, style refs, and structured scene
    // elements; compositing produced a "pasted-on" 2D look the user rejected).
    // Body flags kept for backward compatibility but are no-ops.
    const compositeBag = false

    // Pick a surface for this render. Authoritative override over anything
    // in the brief — keeps feed visually varied across posts.
    const surface = pickSurface()
    console.log(`[visual-test] surface pick: ${surface.name}`)

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

    // Detect whether the scene calls for an espresso machine (espresso
    // brewing / milk steaming). The Strada X reference is ONLY for
    // commercial/cafe content — for "espresso at home" / kitchen-counter
    // scenes, we render a home machine instead (Delonghi/Breville/Gaggia)
    // and we want Gemini to do that WITHOUT a Strada X anchor competing
    // for attention. So we fetch the Strada X ref only when the scene is
    // explicitly cafe/bar/roastery context.
    const sceneLowerForMachine = sceneBrief.toLowerCase()
    const espressoSceneRegex = /\b(espresso machine|steam wand|portafilter|group head|grouphead|naked portafilter|bottomless portafilter|la marzocco|strada|milk steaming|steaming milk|microfoam|milk frothing|frothing milk|latte art|cappuccino|flat white|latte\b|espresso shot|pulling (?:a |the |an )?shot|brew group)\b/.test(sceneLowerForMachine)
    // No bare "on the counter" (Minuto's bar has one) and no bare בית, which
    // also matches בבית הקפה ("at the café").
    const homeContextRegex = /\b(at home|home espresso|home setup|home barista|home brewing|home machine|kitchen counter|kitchen|במטבח|בדירה|מטבח)\b/.test(sceneLowerForMachine)
    const cafeContextRegex = /\b(cafe|café|coffee shop|coffeeshop|bar|roastery|behind the bar|on the bar|in the shop|at the cafe|barista at work|professional espresso machine|commercial espresso machine|professional machine|commercial machine|במינוטו|בבית הקפה|במאפיה|בקפה)\b/.test(sceneLowerForMachine)
    // Espresso scenes are at Minuto's bar with Minuto's own Strada X by
    // default (owner's call, 2026-10-16) — real photos of it in real-photo
    // mode, its photo as the reference otherwise. Only a brief explicitly
    // set at home gets a home machine.
    const useStradaXReference = espressoSceneRegex && !homeContextRegex
    // Roaster reference — attach Minuto's actual Coffee-Tech machine photo
    // when the brief mentions the roaster, the roastery, the cooling tray,
    // roast-day moments, or fresh beans coming off the cooler. Without
    // this, Gemini hallucinates generic vintage Probat-style copper
    // roasters with "COFFEE-TECH" text rendered as visible labels.
    const roasterSceneRegex = /\b(roaster|roastery|drum roaster|coffee-tech|cooling tray|cooler tray|roast day|roasting|מקלה|בית קלייה|בית הקלייה|מכונת קלייה|תוף קלייה|פולים יוצאים|קירור|מקרר פולים)\b/.test(sceneLowerForMachine)

    // ── Real-photo mode ──────────────────────────────────────────────────
    // Generating Minuto's machine / roaster from a reference only ever gives
    // a LOOKALIKE — the model redraws the equipment and gets parts, colours
    // and anatomy wrong (the owner's verdict on the best such render: "this
    // is not our machine"). For bagless scenes set at Minuto's bar or
    // roastery we instead EDIT a real photo from upload_images/: reframe to
    // the target aspect, relight / colour-grade, and add at most the small
    // action the brief asks for. The equipment pixels stay real.
    // Bag scenes keep the generation path (the bag reference already
    // renders faithfully there); home-kitchen scenes are not our bar.
    const handsSceneRegex = /\b(barista|hands?|tamp(?:ing|er)?|steam(?:ing)? milk|milk steaming|frothing|microfoam|latte art|pouring milk|milk pitcher|pitcher)\b/.test(sceneLowerForMachine)
    const realPhotoCategory: string | null =
      (body.real_photo === false || body.use_reference !== false || homeContextRegex) ? null
      : roasterSceneRegex                                                              ? 'roaster'
      : (handsSceneRegex && (cafeContextRegex || espressoSceneRegex || /\bbarista\b/.test(sceneLowerForMachine))) ? 'hands'
      : useStradaXReference                                                            ? 'machine'
      : null

    let bagRef:     { data: string; mime: string } | null = null
    let bagViews:   Array<{ data: string; mime: string }> = []
    let realBag:    BagReference | null = null
    let beansRef:   { data: string; mime: string } | null = null
    let machineRef: { uri: string; mime: string } | null = null
    let machineRefUrl: string | null = null
    let roasterRef: { uri: string; mime: string } | null = null
    let bagUrl:     string | null = null
    let bagSource:  'reference_image_url' | 'product_id' | 'product_name' | null = null
    let bagWooId:   number | null = null
    // Special editions come in an amber glass jar, not the white bag
    // (_shared/bag_references.ts JAR_PRODUCTS). The reference image is then a
    // jar photo, and every "bag" in this prompt means that jar.
    let isJar = false
    if (useReference) {
      // Resolve which specific bag image to use. Random pool fallback was
      // removed 2026-05-16 — caller MUST pass one of reference_image_url,
      // product_id, or product_name so the rendered bag matches the
      // product being promoted in the post.
      if (body.reference_image_url) {
        bagUrl = body.reference_image_url
        bagSource = 'reference_image_url'
      } else if (typeof body.product_id === 'number' && Number.isFinite(body.product_id)) {
        const { data, error } = await supabase
          .from('woo_products')
          .select('woo_id, name, image_url')
          .eq('woo_id', body.product_id)
          .not('image_url', 'is', null)
          .limit(1)
          .maybeSingle()
        if (error) {
          return jsonResponse({ error: `woo_products lookup failed for product_id=${body.product_id}: ${error.message}` }, 500, corsHeaders)
        }
        if (!data?.image_url) {
          return jsonResponse({ error: `no woo_products row with woo_id=${body.product_id}, or that row has no image_url` }, 400, corsHeaders)
        }
        bagUrl = data.image_url as string
        bagWooId = data.woo_id as number
        bagSource = 'product_id'
        console.log(`[visual-test] resolved product_id=${body.product_id} → "${data.name}" → ${bagUrl}`)
      } else if (body.product_name && body.product_name.trim().length >= 2) {
        const needle = body.product_name.trim()
        const { data, error } = await supabase
          .from('woo_products')
          .select('woo_id, name, image_url')
          .ilike('name', `%${needle}%`)
          .not('image_url', 'is', null)
          .limit(1)
          .maybeSingle()
        if (error) {
          return jsonResponse({ error: `woo_products lookup failed for product_name="${needle}": ${error.message}` }, 500, corsHeaders)
        }
        if (!data?.image_url) {
          return jsonResponse({ error: `no woo_products name match for "${needle}" with a non-null image_url` }, 400, corsHeaders)
        }
        bagUrl = data.image_url as string
        bagWooId = data.woo_id as number
        bagSource = 'product_name'
        console.log(`[visual-test] resolved product_name="${needle}" → "${data.name}" → ${bagUrl}`)
      } else {
        return jsonResponse({
          error: 'must provide one of: reference_image_url (direct URL), product_id (numeric WooCommerce woo_id), or product_name (text — fuzzy matched against woo_products.name). The function no longer falls back to a random bag. To skip the bag entirely, pass use_reference:false.',
        }, 400, corsHeaders)
      }
      // Real photos of this bag, when it has them (_shared/bag_references.ts),
      // replace the store image; every other bag renders exactly as before.
      // A direct reference_image_url is the caller's explicit choice and wins.
      realBag = bagSource === 'reference_image_url' ? null : bagReferenceFor(bagWooId)
      isJar = isJarProduct(bagWooId)
      if (isJar) {
        realBag = null
        // The brief usually says "bag" (the strategist assumes one). Left in,
        // the model draws a bag and pastes the jar label on it, as it did for
        // Roastery Brisas on 2026-10-21.
        sceneBrief = sceneBrief
          .replace(/\b(?:coffee |minuto |branded |retail )*(?:bag|pouch|packet|package)(s?)\b/gi, (_m, plural) => `Minuto glass jar${plural}`)
        console.log(`[visual-test] woo_id=${bagWooId} is a special edition — rendering its JAR, brief now: ${sceneBrief.slice(0, 160)}`)
      }
      if (realBag) {
        console.log(`[visual-test] real bag photos for woo_id=${bagWooId} replace the store image ${bagUrl}`)
        bagUrl = storagePublicUrl(SUPABASE_URL, realBag.front)
      }
      // Bag is always-on (primary subject), beans always-on (color anchor).
      // Machine / roaster refs are loaded below, OUTSIDE this block.
      const [b1, b2] = await Promise.all([
        fetchAsB64(bagUrl),
        forbidsProps ? Promise.resolve(null) : fetchAsB64(MINUTO_BEANS_REFERENCE_URL),
      ])
      bagRef     = b1
      beansRef   = b2
      const viewUrls = (Array.isArray(body.bag_view_urls) ? body.bag_view_urls : realBag ? realBag.views.map(v => storagePublicUrl(SUPABASE_URL, v)) : [])
        .filter(u => typeof u === 'string' && u).slice(0, 2)
      bagViews = (await Promise.all(viewUrls.map(fetchAsB64))).filter((v): v is { data: string; mime: string } => !!v)
      if (viewUrls.length) console.log(`[visual-test] extra bag views: ${bagViews.length}/${viewUrls.length} loaded`)

      // FAIL-FAST when the bag was requested but its reference image could not
      // be fetched (404 / network / bad URL → fetchAsB64 returned null).
      // Continuing here is the documented hallucination vector: the prompt
      // still tells Gemini to render "the Minuto bag" but attaches NO bag
      // reference, so it invents label artwork and gibberish text and pads the
      // frame with hallucinated props (the Velvet Star failure mode). Better to
      // fail loudly with the exact bad URL so the task retries / surfaces and
      // the broken woo_products.image_url gets fixed — never ship a fabricated
      // bag. (A null bag ref is ONLY a problem when a bag was actually
      // requested; no_bag scenes never set bagUrl.)
      if (bagUrl && !bagRef) {
        return jsonResponse({
          error: `bag reference image could not be fetched (source=${bagSource}, url=${bagUrl}). Refusing to render a bag_hero without its reference — that produces a hallucinated label. Fix the product's image_url (or pass a reachable reference_image_url).`,
        }, 502, corsHeaders)
      }
    }
    // Equipment references — loaded for EVERY render, bag or no bag.
    // They used to live inside the use_reference block, so no_bag renders
    // (the equipment-only shots, i.e. exactly the ones that show the
    // machine) got NO machine reference and Gemini invented one.
    // Prefer a real photo of Minuto's own bar from upload_images/machine/;
    // the catalog Strada X shot is only the fallback.
    // Which folders may hold a fitting photo for each category — a barista
    // shot can live in machine/, a machine shot in hands/.
    const REAL_PHOTO_FOLDERS: Record<string, string[]> = {
      roaster: ['roaster'],
      hands:   ['hands', 'machine', 'pitchers'],
      machine: ['machine', 'hands'],
    }
    const realPhotoUrls: string[] = realPhotoCategory
      ? await pickMatchingRealPhoto(supabase, REAL_PHOTO_FOLDERS[realPhotoCategory] ?? [realPhotoCategory], sceneBrief)
      : []
    if (realPhotoCategory) console.log(`[visual-test] real-photo mode: ${realPhotoCategory} → ${realPhotoUrls.join(', ') || 'no fitting photo, will generate'}`)
    // Equipment refs are passed to Gemini BY URL (fileData) — no download,
    // so they cost nothing to prepare even when a real-photo edit wins.
    if (useStradaXReference) {
      machineRefUrl = (await pickRandomAssetUrl(supabase, 'machine')) ?? MINUTO_ESPRESSO_MACHINE_REFERENCE_URL
      machineRef = { uri: machineRefUrl, mime: mimeOf(machineRefUrl) }
    }
    if (roasterSceneRegex) roasterRef = { uri: MINUTO_ROASTER_REFERENCE_URL, mime: mimeOf(MINUTO_ROASTER_REFERENCE_URL) }
    console.log(`[visual-test] refs loaded — bag: ${bagRef ? 'OK' : (bagUrl ? 'MISS' : 'N/A')}, beans: ${beansRef ? 'OK' : 'N/A'}, machine: ${machineRef ? `OK (${machineRefUrl})` : (useStradaXReference ? 'MISS' : 'N/A')}, roaster: ${roasterRef ? 'OK' : (roasterSceneRegex ? 'MISS' : 'N/A')}, espresso=${espressoSceneRegex}/home=${homeContextRegex}/cafe=${cafeContextRegex}/roaster=${roasterSceneRegex}`)

    // Tracks whether the brandClause should describe the bag. True both
    // when Gemini will render the bag (legacy) AND when we're compositing
    // (so Gemini knows to LEAVE the region empty for the paste).
    const bagInScene = useReference && !!bagUrl

    // Cup compositing also DISABLED (see compositeBag note above). Cup is
    // now optionally passed as a STYLE REFERENCE for Gemini to use as an
    // aesthetic anchor, not as a pasted-on object.
    const compositeCup = false
    const cupInScene = false

    // Pick 1 style reference from the user's photo library based on the
    // scene content. The reference is passed to Gemini alongside the bag
    // so Gemini matches the actual surface, lighting, props, and atmosphere
    // of Minuto's real photos instead of inventing them. This is what
    // Erez did manually in his successful test (image_0.png, image_1.png).
    // Returns null if the relevant subfolder is empty; the function then
    // proceeds without a style reference (still works, slightly less
    // anchored).
    async function pickStyleReferenceUrl(brief: string): Promise<string | null> {
      const b = brief.toLowerCase()
      let category = 'cups'
      if (/\b(espresso shot|pulling.*shot|tamping|portafilter)\b/.test(b))    category = 'hands'
      else if (/\b(latte art|cappuccino|microfoam|frothing|steaming|milk pitcher)\b/.test(b)) category = 'hands'
      else if (/\b(pour.over|v60|chemex|drip|filter coffee|aeropress|french press)\b/.test(b)) category = 'brewing'
      else if (/\b(beans|roasted|cooling tray|green beans|cupping)\b/.test(b)) category = 'beans'
      else if (/\b(roaster|roastery|behind.the.scenes|drum roaster)\b/.test(b)) category = 'roaster'
      else if (/\b(barista|behind the bar|in the cafe|in the shop|at the cafe)\b/.test(b)) category = 'hands'
      else if (/\b(milk|pitcher)\b/.test(b)) category = 'pitchers'
      else if (/\b(espresso|cappuccino|latte|macchiato|flat white|cortado|americano|cup|demitasse)\b/.test(b)) category = 'cups'
      const url = await pickRandomAssetUrl(supabase, category)
      if (url) console.log(`[visual-test] style ref pick: ${category} → ${url}`)
      else     console.log(`[visual-test] style ref pick: ${category} → empty, no style ref used`)
      return url
    }

    const styleRefUrl = (useReference && !forbidsProps) ? await pickStyleReferenceUrl(sceneBrief) : null
    let styleRef: { data: string; mime: string } | null = null
    if (styleRefUrl) {
      styleRef = await fetchAsB64(styleRefUrl)
    }

    // 2. Build the prompt.
    // Detect briefs that explicitly downplay the bag — instructional /
    // measurement / equipment-focused slides where forcing a prominent bag
    // hijacks the frame and steals attention from the actual subject
    // (steam wand, scale, thermometer, portafilter, etc.).
    const sceneLower = sceneBrief.toLowerCase()
    const bagDownplayed = /\b(no bag|without (?:the |a )?bag|bag (?:is |should be )?(?:softly )?blurred|bag (?:in (?:the )?)?background|bag (?:is )?out of focus|bag barely cropped|bag minor|no minuto bag)\b/.test(sceneLower)

    // Build reference-image descriptions in the order they're passed to
    // Gemini. The bag is ALWAYS FIRST and gets the strongest retention
    // language — it's the brand-critical element. Style ref (from the
    // user's photo library) comes next when present so Gemini matches
    // the actual Minuto aesthetic. Beans and machine come after as
    // color/detail anchors when relevant.
    const refDescriptions: string[] = []
    if (bagRef && isJar) {
      refDescriptions.push(`reference image — the MINUTO SPECIAL-EDITION JAR. This product ships in an amber glass JAR with a black screw lid and a white wrap-around label, exactly as in this attached image. It IS the jar to render: copy its glass colour, lid, proportions and label faithfully. It is NOT a bag: never render a bag, pouch, packet or box for it, and never move its label onto a bag.
${bagDownplayed
  ? '\nThe SCENE brief downplays the product — keep the jar minor or omit it entirely.'
  : '\nThe jar is the HERO subject of the photograph unless the brief specifies an equipment-led scene.'}
Hard constraints: the jar is CLOSED with its black lid on; beans may sit beside it. No invented label artwork, no added date stamps or batch numbers, no colour changes.`)
    } else if (bagRef) {
      refDescriptions.push(`reference image — the MINUTO BAG. The bag in this attached image IS the bag to render. Treat it as the source of truth: look at the image and copy it faithfully — do NOT redesign, recolor, restyle, or re-imagine it based on prompt text. The reference is the authority, the prompt is just context.
${bagDownplayed
  ? '\nThe SCENE brief downplays the bag — keep it minor or omit it entirely.'
  : '\nThe bag is the HERO subject of the photograph unless the brief specifies an equipment-led scene.'}
Hard constraints (just in case the model is tempted to deviate): the bag is CLOSED and SEALED, never open or spilling beans; no invented label artwork, no added date stamps or batch numbers on the bag, no color changes.`)
    }
    for (const _ of bagViews) {
      refDescriptions.push(`reference image — the SAME MINUTO BAG from another angle. Use it for the bag's 3D shape only: its flat box bottom, side gussets, depth and how the front label sits on the bag. It is the same physical bag as the FIRST image; render ONE bag, never a second one. The FIRST image stays the authority for the label artwork and text.`)
    }
    if (styleRef) {
      refDescriptions.push(`reference image — STYLE ANCHOR. Real photo from Minuto's library showing the actual surface, lighting, prop styling, and atmosphere we want to match. Use this image as a visual reference for:
   ✓ Surface texture and material (the wood/concrete/metal in this image is what the scene should sit on)
   ✓ Light direction, color temperature, and shadow quality
   ✓ Cup shape, prop styling, and arrangement language
   ✓ Overall photographic mood
DO NOT copy this image's composition — only the visual language. The ${isJar ? 'jar' : 'bag'} from the FIRST reference image is still the main subject; this STYLE ANCHOR informs the supporting elements.`)
    }
    if (beansRef) {
      refDescriptions.push(`reference image — BEAN COLOR ANCHOR. Real photo of Minuto's roasted beans showing their true color. Use this AS A COLOR ANCHOR ONLY (do not copy the composition). When you render any roasted coffee beans in the output, MATCH THE COLOR: medium chestnut brown with subtle warm/auburn undertones, matte finish.`)
    }
    if (machineRef) {
      refDescriptions.push(`reference image — MINUTO ESPRESSO MACHINE. Real photo of Minuto's own 2-group La Marzocco Strada X on its bar. THIS is the machine — every machine part you render must look like the matching part in this photo and attach to the body exactly where it does here. Match: slate/gunmetal MATTE body; the CLEAR (near-colourless, see-through) glass is the machine's large OUTER SIDE WALL at the far end — it never appears as a small panel or shield beside a group head, and is simply out of frame in group-head close-ups; grey group-head caps over chrome groups, each holding ONE portafilter with a BLACK handle; chrome steam wands rising from the TOP-SIDE of the body next to the groups (never out of a group or portafilter); stainless drip tray. Copy the machine's anatomy faithfully; the scene's framing, light and mood come from the brief. Forbidden: generic chrome Linea silhouette, invented parts, readable brand text.`)
    }
    if (roasterRef) {
      refDescriptions.push(`reference image — MINUTO COFFEE ROASTER. A REAL PHOTO of Minuto's own Coffee-Tech production drum roaster in its roastery. Render THIS machine: dark charcoal matte body, black hopper on top, brushed-stainless drum face with the round sight glass, gauge and handle wheel, silver ducts rising to the ceiling, the deep cylindrical stainless cooling bin below the drum door. ⛔ SCALE: it is a FULL-SIZE production machine standing on the roastery FLOOR, 2.0 m tall at its highest point (taller than an adult), 1.5 m long, 1.0 m wide, with chimney ducts at 2.8 m by the ceiling — it must look as big in the output as it does in this photo. NEVER a small model, a miniature, a tabletop or countertop roaster, or a distant toy-sized machine; if the frame shows a counter or table, the roaster stands BEHIND or BESIDE it on the floor, far larger than anything on the counter. EXACTLY ONE roaster. Show the "COFFEE-TECH ENGINEERING" plate on the front of the hopper neck, above the bean sight window — Minuto's real machine shows it and it SHOULD appear when that part of the machine is in frame. Spell it exactly "COFFEE-TECH ENGINEERING", white letters on a dark plate, the size it is in the reference photo; if it would be too small to render sharply, let it fall softly out of focus rather than inventing letters. No other brand names, model names or invented text anywhere. Copy the machine, not the photo's exact framing — the brief sets the composition.`)
    }

    const ordinal = (i: number) => ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'][i] ?? `#${i + 1}`
    const referencesBlock = refDescriptions.length > 0
      ? `\n\nREFERENCE IMAGES (${refDescriptions.length} attached, read each carefully):\n\n${refDescriptions.map((d, i) => `${ordinal(i)} ${d}`).join('\n\n')}`
      : ''

    // Only the rule sections this scene needs (see scene_rules.ts).
    const scene = detectScene(sceneBrief, {
      bag: !!bagRef, beansRef: !!beansRef, roaster: !!roasterRef, machineRef: !!machineRef,
      espresso: espressoSceneRegex, cafe: cafeContextRegex, home: homeContextRegex,
    })
    const fullPrompt = `${identityFor(scene)}

🎯 PRIMARY DIRECTIVE
${bagRef && isJar ? `Create a high-resolution, photorealistic lifestyle product photograph at ${ratio} aspect ratio, featuring the Minuto special-edition coffee JAR from the FIRST attached reference image as the hero subject: an amber glass jar with a black lid and a white label, closed. There is NO coffee bag in this image: wherever this prompt or the brief says "bag", it means this jar.` : bagRef ? `Create a high-resolution, photorealistic lifestyle product photograph at ${ratio} aspect ratio, featuring the Minuto coffee bag from the FIRST attached reference image as the hero subject. The bag in the output must be identifiable as the same specific Minuto product (same color, same label artwork, same proportions, same wordmark placement).` : `Create a high-resolution, photorealistic editorial photograph at ${ratio} aspect ratio of exactly what the SCENE BRIEF describes. There is NO coffee bag in this image — do not add one. Any attached reference images are equipment references, not a bag.`}
${bagRef ? `
🔤 LABEL TEXT — render the LARGE elements sharp and faithful: ${isJar ? 'the product name on the jar label' : 'the "Minuto" brand wordmark, the stag-head emblem, and the product name'} exactly as in the reference. The SMALL fine-print / descriptor lines below the product name are TOO SMALL to reproduce legibly — render them as a soft, naturally out-of-focus suggestion of text (shallow depth of field falling off across the lower label), NEVER as sharp characters. Do NOT invent, scramble, or hallucinate sharp lettering there: soft indistinct fine print reads as real photography; sharp gibberish glyphs (especially Hebrew) do not. When in doubt, let the fine print dissolve into focus blur rather than spelling out fake words.
` : ''}
SCENE BRIEF — interpret this as the structured elements below:
${sceneBrief}

INTERPRET THE BRIEF AS A STRUCTURED PHOTOGRAPH:

• MAIN SUBJECT — ${bagRef ? (isJar ? 'the Minuto special-edition glass jar, lid on (FIRST reference image)' : 'the Minuto bag, closed and sealed (FIRST reference image)') : 'the subject the SCENE BRIEF names'}, positioned ${!bagRef && !forbidsProps ? 'as the SCENE BRIEF frames it; otherwise in the lower-right or upper-right third' : forbidsProps ? 'exactly as the SCENE BRIEF specifies — centered and filling the frame if the brief asks for that' : 'per the brief or per the Minuto identity composition rules (lower-right or upper-right third, never centered)'}.
• SUPPORTING PROPS — ${forbidsProps ? 'NONE beyond what the SCENE BRIEF explicitly names. Do NOT add cups, beans, glassware, brewing gear, hands, or any decorative element the brief did not ask for. If the brief says the subject stands alone, render it alone on an empty surface.' : 'cups, beans, brewing equipment, hands, milk pitchers, etc. as the brief describes. Where a STYLE ANCHOR reference is included, match its visual language for prop styling.'}
• LIGHTING & SHADOWS — as the SCENE BRIEF describes it, if it does. Otherwise ONE warm directional light from upper-right of frame. Hard, contrasty side-shadows fall diagonally toward lower-left. Deep shadow occupies a meaningful part of the frame.
• SURFACE — ${forbidsProps ? 'use the surface described in the SCENE BRIEF exactly as written (e.g. a seamless white studio sweep). Do NOT substitute a different material.' : `**${surface.description}**. Uniform across the entire frame. THIS SURFACE IS AUTHORITATIVE — it overrides any surface mentioned in the SCENE BRIEF above. The bag, cups, beans, and all props rest on THIS specific surface, nothing else.${espressoSceneRegex ? ' EXCEPTION — ESPRESSO: a cup being filled from a portafilter stands on the espresso machine\'s stainless DRIP-TRAY GRATE directly under the spouts, never on this surface or any table (an espresso machine cannot pour onto a table). This surface is only the counter around the machine.' : ''}${roasterRef ? ' EXCEPTION — THE ROASTER: this surface is only for small tabletop props (bag, cups, beans). The roaster is NOT a prop: it stands on the roastery FLOOR, never on this surface. If both appear, the surface is a counter or workbench in front of / beside the floor-standing roaster.' : ''}`}
• ATMOSPHERE — tranquil, considered, photo-essay feel. Earth-tone palette only (deep brown, raw concrete grey, dusty olive, cream, tan, warm amber, charcoal). Slight Kodak Portra 400 film grain.
• FOCUS — ${bagRef && isJar ? "the Minuto jar is dominant; the product name on its label is the SHARP focal point while the small fine print falls into gentle shallow-DoF softness" : bagRef ? "the Minuto bag is dominant; its wordmark, emblem, and product name are the SHARP focal point while the small fine-print descriptor lines fall into gentle shallow-DoF softness" : 'the brief\'s subject is the sharp focal point'}; supporting props secondary; background softly out of focus.
• COMPOSITION — ${forbidsProps ? 'follow the SCENE BRIEF. A centered, symmetric studio composition is correct when the brief asks for it. Keep generous negative space around the subject.' : 'the framing the SCENE BRIEF asks for (close-up, top-down, eye-level…); otherwise asymmetric, anchored in the lower-right or upper-right third, at least 30% intentional negative space.'}${referencesBlock}

FORMAT: ${ratio} aspect ratio, photorealistic, high resolution.

⛔ FINAL OVERRIDE — read this LAST and let it overrule the SCENE
description above wherever they conflict:

🚫 PROP DISCIPLINE: render ONLY the props the SCENE brief explicitly
names. Do NOT invent or add cups, mugs, bowls, dishes, saucers, trays,
loose coffee beans, spoons, books, plants, or windows that the brief
did not ask for. A HUMAN HAND — or any body part — must NEVER appear
unless the brief explicitly calls for a hand holding something. If the
brief says "no props", "no other props", or "nothing else on the
surface", then render ONLY the bag on the named surface: empty surface,
nothing else in frame. Extra invented props are an automatic reject.
${bagRef ? (isJar ? `
🫙 JAR, NOT BAG: this product is a special edition sold ONLY in the
amber glass jar from the FIRST reference image. Render that jar, lid
closed. Never a bag, pouch or packet, whatever the brief calls it.
` : `
🔒 SEALED BAG: the Minuto bag is CLOSED and SEALED, top shut, standing
or lying intact. Never open, torn, tipped over, or with beans spilling
or pouring out of it. Loose beans may only sit beside or in front of it.
`) : ''}
🔒 SUBJECT-LOCK: when the SCENE brief names specific equipment — steam
wand, portafilter, espresso machine group head, thermometer, milk
pitcher (with or without thermometer probe), digital scale, measuring
vessel/jug, V60, Chemex, AeroPress, French press, gooseneck kettle,
tamper, knock box — that piece of equipment IS THE SUBJECT of the
frame. Render it clearly, in focus, dominant. Do NOT substitute it
with generic Minuto bag-and-cup product photography. Do NOT swap one
piece of equipment for another (e.g. NEVER render a brass gooseneck
kettle when the brief calls for a steam wand — those are different
brewing contexts). If the brief says "steam wand frothing milk in a
pitcher", show exactly that. If the brief says "digital scale reading
150ml", show exactly that. The named subject MUST be the rendered
subject — every time.
${machineRef ? `
🔧 STRADA X PARTIAL-REVEAL RULE: a reference image of
    Minuto's actual La Marzocco Strada X is included. Use it as a
    COLOR + DETAIL anchor, NOT as a full-silhouette template. Gemini
    cannot reliably reproduce the Strada X's full chassis shape from
    a single product photo, so the rendered scene MUST show only
    PARTIAL elements of the machine, never the full silhouette:

      ✓ Portafilter docked into one group head, cup below on the
        drip tray — NO side glass in this crop (it's at the far end
        of the machine, out of frame).
      ✓ Steam wand rising from the top-side of the body into a milk
        pitcher, a group head beside it.
      ✓ The machine's side end: the large clear glass side window
        framed by the slate body, with the slate body fading into
        shadow.
      ✓ Tight crop on the drip tray with one ceramic cup, a glimpse
        of group head above.

    ✗ Forbidden: full front-on view of the entire 2-group chassis.
    ✗ Forbidden: a blue / mint tint on the machine body or glass —
      the body is dark slate grey and the side glass is clear.
    ✗ Forbidden: generic Linea silhouette (chrome curved body, single
      group, narrow profile) — Strada X is angular and modern, but
      because we can't reliably render it whole, we crop instead.

    Use the reference image's COLORS (slate-grey matte body, clear
    see-through glass as the side wall, black portafilter handles, grey
    group caps) and its part-to-part anatomy. The shape is hard;
    cropping is reliable.` : ''}${roasterRef ? `

🏭 ROASTER SCALE + PLACEMENT — the roaster is a FULL-SIZE production
machine on the roastery FLOOR: 2.0 m tall (taller than an adult),
1.5 m long, 1.0 m wide, chimney ducts at 2.8 m by the ceiling. It is never a small model, a miniature or a
tabletop unit, and never looks small next to cups, bags or a counter. It is NEVER on a counter, table,
bar or workbench, and there is only ONE roaster in the frame.

🌀 COOLER — Minuto's cooler is a large, deep, cylindrical
brushed-stainless bin with tall straight sides, about as wide as the
drum body, standing on the FLOOR at the front-right of the roaster,
directly below the drum door — exactly as in the reference image.
Fresh beans fall from the drum door into it; its own internal arms
stir them. Never a shallow tray on a stand or table, never a second
cooler.

✋ NO HANDS, NO TOOLS in roaster scenes — unless the brief explicitly
asks for a person or a hand, no hand, arm or person appears. No
paddle, spoon, scoop, stick or rake in the beans. The machine works
on its own.` : ''}

These rules WIN over anything in the SCENE description. The prior
text is inspiration; these are mandatory.`

    // 3. Call Gemini 2.5 Flash Image. Pass references in the order the
    //    brandClause describes them — BAG, STYLE, BEANS, MACHINE — so
    //    Gemini matches the ordinal labels to the right images.
    // Real-photo mode replaces the whole generation prompt with an EDIT
    // instruction on the one real photo.
    const realPhotoPrompt = `Edit the attached REAL photograph of Minuto's own coffee bar / roastery into a ${ratio} photograph for Instagram.

THE EQUIPMENT IS REAL AND MUST STAY EXACTLY AS PHOTOGRAPHED. The espresso machine, group heads, portafilters, steam wands, grinders, roaster, cups, counter, and people keep the same shapes, parts, positions and colours. Do NOT redraw, restyle, replace, add or remove any equipment. Do not change the machine's colours. Existing real signage, menu boards, badges and logos stay as they are — do not add new text or logos, and never re-letter, sharpen or "clean up" existing small text (badges, labels, gauges): keep it exactly as in the photo, or let it fall softly out of focus. Misspelled text is the #1 tell of an edited photo. If you cannot keep a piece of existing text letter-perfect, blur it instead. Never add a badge, label or printed text that is not in the photo.

Never change what an object IS: green (unroasted) coffee stays green, sacks stay sacks, an empty cup stays empty unless the brief's action fills it. If the photo does not show what the brief describes, keep the photo's real content and take only the mood and light from the brief.

WHAT YOU MAY DO:
• Reframe to ${ratio} by CROPPING (and, only where unavoidable, extending the edges). SAME CAMERA, SAME ANGLE, SAME VIEWPOINT: the result must look like a crop of this exact photo, not a new photo of the same place. Do not rotate the scene, move the camera, zoom in past what the photo shows, or re-stage anything. If the brief asks for a closer or different view than this photo has, IGNORE that part of the brief. Extend ONLY plain wall, plain counter, floor, or soft out-of-focus background — never invent products, bags, cups, shelves of goods, people or equipment.
• Relight and colour-grade: warm, editorial, natural light, gentle film grain, slightly softer background. Keep it believable — a well-shot phone/film photo, not a render.
• Add ONLY the small in-the-moment action the brief describes, and only where the photo already shows the part it comes from (no espresso stream unless a portafilter is visible, no beans on a tray that is out of frame), physically correct: e.g. an espresso stream from the existing portafilter spouts into a cup on the drip tray, a wisp of steam, milk being poured from a hand-held pitcher. Nothing else.
• Push clutter (trash, cables, boxes, cleaning cloths) into shadow or crop it out.
• ORDER TICKETS / RECEIPTS (the paper slips hanging under the drip tray) show customers' names: crop them out of the frame, or if that is impossible, blur them until no text is readable. Never leave them sharp.
• THE "LA MARZOCCO" WORDMARK (the drip tray's front plate, and the red logo on the white cups): leave it EXACTLY as photographed only if that part of the photo is left untouched. If your edit would redraw, relight or extend that area, crop it out of the frame or blur it until no letters can be read — never re-letter it, and never add it where the photo does not show it.

SCENE BRIEF (use it for framing, mood and the small action — ignore any equipment description in it that contradicts the photo; the photo wins):
${sceneBrief}`
    const parts: any[] = []
    if (bagRef)     parts.push({ inlineData: { mimeType: bagRef.mime,     data: bagRef.data } })
    for (const v of bagViews) parts.push({ inlineData: { mimeType: v.mime, data: v.data } })
    if (styleRef)   parts.push({ inlineData: { mimeType: styleRef.mime,   data: styleRef.data } })
    if (beansRef)   parts.push({ inlineData: { mimeType: beansRef.mime,   data: beansRef.data } })
    if (machineRef) parts.push({ fileData: { mimeType: machineRef.mime, fileUri: machineRef.uri } })
    if (roasterRef) parts.push({ fileData: { mimeType: roasterRef.mime, fileUri: roasterRef.uri } })
    parts.push({ text: `Generate an image: ${fullPrompt}` })

    async function callGemini(useParts: any[] = parts): Promise<{ b64: string; mime: string }> {
      const genRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: useParts }],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT'],
              // HARD aspect-ratio control. The FORMAT line in the prompt is
              // only a suggestion — Gemini routinely ignores prose framing
              // instructions and returns its own default shape. imageConfig
              // is the contract, and it is what keeps a 'story' render at
              // 9:16 instead of whatever the model felt like.
              imageConfig: { aspectRatio: ratio },
            },
          }),
        },
      )
      if (!genRes.ok) {
        const errText = await genRes.text().catch(() => '')
        throw new Error(`Gemini ${genRes.status}: ${errText.slice(0, 300)}`)
      }
      const genJson = await genRes.json()
      for (const part of genJson.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          return { b64: part.inlineData.data as string, mime: part.inlineData.mimeType as string }
        }
      }
      throw new Error(`Gemini returned no image. Raw: ${JSON.stringify(genJson).slice(0, 400)}`)
    }

    // std decoder — the old Uint8Array.from(atob(...), cb) ran a JS callback
    // per byte, which adds up to real CPU time once real-photo mode makes
    // several images per request (edge workers have a small CPU budget).
    const b64ToBytes = (b64: string) => decodeBase64(b64)
    // Enough of the file to read PNG/JPEG dimensions without decoding it all.
    const headerDims = (b64: string) => readImageSize(decodeBase64(b64.slice(0, 87380)))

    // REAL-PHOTO EDIT, VERIFIED. The edit model sometimes "re-shoots" the
    // scene instead of editing it — a different machine, a new angle, an
    // invented cup — and the result still looks like a real photo, so the
    // downstream QA cannot tell. Compare every edit against its source; a
    // drifted edit moves on to the next fitting photo, then to generation.
    let realPhotoUsed: string | null = null
    const realPhotoChecks: Array<{ photo: string; same: boolean; why: string }> = []
    let gen: { b64: string; mime: string } | null = null
    for (const url of realPhotoUrls) {
      try {
        const edit = await callGemini([
          { fileData: { mimeType: mimeOf(url), fileUri: url } },
          { text: realPhotoPrompt },
        ])
        if (!matchesRatio(headerDims(edit.b64), ratio)) {
          realPhotoChecks.push({ photo: url, same: false, why: 'wrong aspect ratio' })
          continue
        }
        const verdict = await geminiJson([
          { fileData: { mimeType: mimeOf(url), fileUri: url } },
          { inlineData: { mimeType: edit.mime, data: edit.b64 } },
          { text: `Image 1 is a real photo. Image 2 is supposed to be a LIGHT EDIT of it: cropped / reframed, relit, and at most a small added action (espresso stream from an existing portafilter, steam, beans pouring onto an existing tray, milk in an existing pitcher).
Is image 2 still clearly the SAME scene? Answer false if ANY of: the equipment is a different model or has different parts/layout (e.g. a different espresso machine, extra or missing group heads, a relocated steam wand, a different roaster); the camera angle / viewpoint changed or the scene was re-staged; new objects were invented (cups, bags, products, people, signage); readable text differs from image 1 or is misspelled. Cropping away parts of image 1 is fine.
Reply as JSON {"same": true|false, "why": "one short sentence"}.` },
        ])
        const same = verdict?.same === true
        realPhotoChecks.push({ photo: url, same, why: String(verdict?.why ?? '') })
        console.log(`[visual-test] real-photo check ${same ? 'PASS' : 'FAIL'} (${url}): ${verdict?.why ?? ''}`)
        if (same) { gen = edit; realPhotoUsed = url; break }
      } catch (e: any) {
        realPhotoChecks.push({ photo: url, same: false, why: `error: ${e?.message ?? e}` })
        console.warn(`[visual-test] real-photo edit failed for ${url}: ${e?.message ?? e}`)
      }
    }
    if (realPhotoUrls.length > 0 && !gen) console.warn('[visual-test] no real-photo edit passed the fidelity check — falling back to generation')

    if (!gen) gen = await callGemini()
    let imageBytes = b64ToBytes(gen.b64)
    let dims       = readImageSize(imageBytes)
    // ASPECT GUARD — measure what actually came back and retry once if the
    // shape is wrong. A story published at the wrong ratio gets cropped or
    // pillarboxed by Instagram, and nothing downstream (not even the
    // Claude-vision QA pass) looks at dimensions, so this is the only place
    // the mistake can be caught.
    if (!realPhotoUsed && !matchesRatio(dims, ratio)) {
      console.warn(`[visual-test] aspect mismatch — asked ${ratio} (${aspect}), got ${dims?.w}x${dims?.h}. Retrying once.`)
      const retry      = await callGemini()
      const retryBytes = b64ToBytes(retry.b64)
      const retryDims  = readImageSize(retryBytes)
      if (matchesRatio(retryDims, ratio)) {
        gen = retry; imageBytes = retryBytes; dims = retryDims
      } else {
        console.error(`[visual-test] aspect STILL wrong after retry — asked ${ratio}, got ${retryDims?.w}x${retryDims?.h}. Returning aspect_ok:false.`)
      }
    }
    const aspectOk  = matchesRatio(dims, ratio)
    const imageMime = gen.mime
    console.log(`[visual-test] render ${aspect} (${ratio}) → ${dims?.w}x${dims?.h} aspect_ok=${aspectOk}`)

    // 3.5 Post-processing — compositing is DISABLED. The Gemini output is
    //     the final image; we trust the reference images + bullet-structured
    //     prompt to produce a properly-integrated scene. If quality issues
    //     resurface, the compositor module + flags remain in the codebase
    //     for selective re-enablement, but the default is "Gemini renders
    //     everything from references."
    const bagComposited = false
    const cupComposited = false
    const composited    = false

    // 4. Upload to Supabase Storage `marketing` bucket under a dated path so
    //    multiple test runs don't overwrite each other.
    const ext      = imageMime.includes('jpeg') ? 'jpg' : 'png'
    const filename = `ig-test/${aspect}_${Date.now()}.${ext}`
    const fileBytes = imageBytes

    const { error: upErr } = await supabase.storage
      .from('marketing')
      .upload(filename, fileBytes, { contentType: imageMime, upsert: true })
    if (upErr) throw new Error(`storage upload: ${upErr.message}`)

    const { data: pub } = supabase.storage.from('marketing').getPublicUrl(filename)

    // The EXACT prompt sent to the image model goes back in the response;
    // seo-worker-visual stores it per QA attempt in seo_tasks.result_data and
    // the IG review email shows it. (It used to be uploaded as
    // <image>.prompt.txt, but the marketing bucket only accepts images and
    // video, so every upload was rejected and no prompt was ever saved.)
    const sentPrompt = realPhotoUsed ? realPhotoPrompt : `Generate an image: ${fullPrompt}`
    const promptDoc = [
      `IMAGE: ${pub.publicUrl}`,
      `MODEL: gemini-3.1-flash-image-preview (${realPhotoUsed ? `real-photo edit of ${realPhotoUsed}` : 'generation'})`,
      `REFERENCE IMAGES: ${[bagRef && `bag (${bagUrl})`, bagViews.length && `${bagViews.length} extra bag view(s)`, styleRef && `style (${styleRefUrl})`, beansRef && 'beans', machineRef && `machine (${machineRefUrl})`, roasterRef && 'roaster'].filter(Boolean).join(', ') || 'none'}`,
      `SURFACE: ${surface.name}`,
      `RULE SECTIONS: ${sectionNames(scene).join(', ')}`,
      ``, `── ORIGINAL BRIEF (from the agent) ──`, originalBrief,
      ``, `── REWRITTEN BRIEF ── changes: ${rewrite.error ? `rewrite failed: ${rewrite.error}` : rewrite.changes.join('; ') || 'none'}`, sceneBrief,
      ``, `── FULL PROMPT SENT TO THE IMAGE MODEL ──`, sentPrompt,
    ].join('\n')
    return jsonResponse({
      prompt_doc: promptDoc,
      success: true,
      url: pub.publicUrl,
      aspect,
      ratio,
      width:     dims?.w ?? null,
      height:    dims?.h ?? null,
      aspect_ok: aspectOk,
      bytes: fileBytes.length,
      used_reference: bagInScene,
      composited_bag: bagComposited,
      composited_cup: cupComposited,
      composited: composited,
      surface: surface.name,
      // false when the brief forbids props and its own surface is used verbatim;
      // seo-worker-visual's critic only discounts the brief's surface when true.
      surface_overrides_brief: !forbidsProps,
      style_ref: styleRefUrl,
      machine_ref: machineRef ? machineRefUrl : null,
      real_photo: realPhotoUsed,
      real_photo_checks: realPhotoChecks,
      roaster_ref: roasterRef ? MINUTO_ROASTER_REFERENCE_URL : null,
      scene_brief: sceneBrief,
      original_scene_brief: originalBrief,
      brief_rewrite_changes: rewrite.changes,
      brief_rewrite_error: rewrite.error ?? null,
      bag_url: bagUrl,
      bag_source: bagSource,
      // Real-bag photo set in use (null = store image) and what its label
      // prints; seo-worker-visual spell-checks the rendered label against it.
      bag_reference: realBag ? { woo_id: bagWooId, views: bagViews.length } : null,
      bag_label_text: realBag?.label_text ?? null,
      // 'jar' for special editions (JAR_PRODUCTS); seo-worker-visual's critic
      // then fails any bag and skips the bag-lockup spell check.
      product_container: bagInScene ? (isJar ? 'jar' : 'bag') : null,
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
