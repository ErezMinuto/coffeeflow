// The locked Minuto IG visual identity. Imported by visual-test (the
// generation endpoint) and by marketing-advisor's enrichment step (which
// writes scene briefs that obey this same anchor). Keep this file as the
// single source of truth — if we drift apart, the agent's brief and the
// generated image will drift apart with it.
//
// Synthesized from reference posts (La Cabra "Rituals" Reel + Blue Bottle
// Valentine still-life). See conversation context for the full derivation.

export const MINUTO_BAG_REFERENCE_URL =
  'https://www.minuto.co.il/content/uploads/2025/08/yirgachffe.png'

export const MINUTO_VISUAL_IDENTITY = `
PHOTOGRAPHED, NOT RENDERED. This is editorial-grade lifestyle/product
photography for a premium specialty-coffee brand on Instagram. NOT a stock
photo. NOT a 3D render. NOT graphic design. NOT an AI illustration.

CAMERA & FILM: Shot on Leica M-series with a 50mm Summicron prime, f/2.8,
on Kodak Portra 400 film. Subtle visible film grain. Slight imperfect
focus-falloff. The photograph has the quiet, considered feeling of a
photo-essay frame — not a product shot.

LIGHTING: ONE warm directional light source from upper-right of frame
(simulating late-morning window light). Hard, contrasty side-shadows that
fall toward the lower-left. Deep shadow occupies a meaningful part of the
frame. Never flat. Never shadowless. Never a softbox or studio commercial
look. Never bounced or fill-lit.

COMPOSITION RULES — STRICTLY ENFORCED:
- The primary subject MUST sit in the lower-right third OR upper-right third
  of the frame, NEVER dead-center.
- At least 30% of the frame is intentional negative space (empty surface,
  shadow, blurred wall, etc.).
- Asymmetric balance — heavy element on one side, breathing space on the
  other. Like a Wabi-sabi still-life painting.
- Subject occupies a SCENE — it is one element among several considered
  objects. Never an isolated hero shot. Never a centered floating product.

PALETTE: Earth tones ONLY. Deep brown, raw concrete grey, dusty olive,
cream, tan, warm amber, charcoal black. No saturated reds, blues, yellows,
or greens. The only allowed splash of saturated color is whatever appears
on the Minuto bag's center label, kept small in the frame.

SURFACE: Textured natural materials only. Raw concrete with visible
imperfections, weathered dark walnut or oak, unglazed ceramic with kiln
marks, raw lime plaster, hand-thrown earthenware. NEVER glossy white
modern, NEVER marble, NEVER seamless paper backdrops, NEVER white walls.

SUBJECT VOCABULARY: Coffee bags (sized as an element, not the hero), small
unglazed ceramic cups with raw edges, glass coffee servers (Hario range
server: tall straight-sided cylindrical glass with a flat handle, NOT a
milk pitcher), porcelain pour-over drippers, brass coffee scoops, raw
green beans, dark roasted beans, steam, amber liquid, dark wood serving
boards, brown craft-paper boxes, hand-thrown earthenware bowls.

ALLOWED HANDS: Hands appear ONLY when interacting with coffee — pouring
from a server, holding a cup mid-sip motion, weighing beans on a scale.
Hands enter from frame edge, never as a subject. Slight motion blur on a
pour or pour-stream is welcome. NO faces.

ABSOLUTELY FORBIDDEN — image fails if it contains any of these:
- Human faces, heads, full bodies, portraits
- Centered hero-shot composition (subject in middle of frame)
- Saturated colors outside the bag's small label
- Softbox lighting, glossy reflections, studio lighting
- White walls, white seamless paper, marble, glossy surfaces
- Text, letters, words, numbers, watermarks (EXCEPT the Minuto wordmark, the
  stag-head emblem, and the origin/blend name printed on the bag's center
  label — those are the ONLY allowed text elements)
- ANY printed dates, batch numbers, lot numbers, "best before" stamps,
  expiry dates, "roasted on" labels, or numerical strings on the coffee
  bag. The bag must not display any date or number anywhere. If the model
  is tempted to render a date sticker, omit it entirely.
- Multiple competing products (more than one bag-sized hero element)
- Stock-photo lifestyle clichés: smiling barista, latte-art heart, cozy
  Sunday morning steam-rising-over-magazine, branded coffee cups in hands
- Cartoony / illustrated / vector / flat-design / 3D-rendered look
- Vehicles, sky, landscapes, animals, plants beyond a single sprig
`.trim()

export const SCENE_PRESETS: Record<string, string> = {
  still_life_gift:
    'A SCENE arranged as a quiet gift moment. Frame composed in landscape ' +
    'orientation. The arrangement sits in the lower-right third of the frame: ' +
    'two Minuto coffee bags resting at slight angles on a hand-thrown unglazed ' +
    'ceramic plate with raw kiln-marked edges. A small brown craft-paper box, ' +
    'partially shadowed, sits to the upper-left of the plate, its Minuto stag ' +
    'emblem just catching the light. Surface: raw imperfect concrete with ' +
    'visible texture and a single dark stain. Hard diagonal sunlight enters ' +
    'from upper-right, casting long sharp shadows toward the lower-left. The ' +
    'upper-left third of the frame is mostly empty shadowed concrete — ' +
    'breathing space. Kodak Portra 400 grain. NEVER place the plate in the ' +
    'center of the frame.',

  pour_shot:
    'A SCENE of the pour ritual, frame oriented with the action diagonal. The ' +
    'main pour happens in the LEFT half of the frame: a hand emerges from the ' +
    'upper-left edge holding a TALL CYLINDRICAL HARIO RANGE SERVER (straight ' +
    'glass walls, flat horizontal handle, much larger than a milk pitcher), ' +
    'tilted forward, pouring a thin amber stream into a small unglazed ceramic ' +
    'cup with raw edges sitting on a dark weathered walnut table. Visible ' +
    'soft steam curls upward. The right half of the frame is mostly negative ' +
    'space — deep shadow, with a Minuto coffee bag SMALL in the lower-right ' +
    'corner, soft and slightly out of focus, NOT a hero element. Single hard ' +
    'warm light from upper-right. Slight motion blur on the pour stream. No ' +
    'face visible.',

  origin_still:
    'A SCENE around a single Minuto coffee bag positioned in the upper-right ' +
    'third of the frame, standing upright on a raw lime plaster surface. The ' +
    'bag is side-lit hard from the right, casting a long sharp shadow that ' +
    'extends fully across to the left edge of the frame — the shadow is part ' +
    'of the composition, not an accident. In the lower-left third: a brass ' +
    'antique coffee scoop holding a careful small pile of green coffee beans, ' +
    'with a few loose beans scattered on the plaster around it. A small empty ' +
    'unglazed ceramic cup, half in shadow, sits between them, smaller than the ' +
    'bag, soft focus. The bag occupies maybe 25% of the frame area, not 50%. ' +
    'Almost monochromatic earth palette. Kodak Portra grain.',

  brewing_setup:
    'A SCENE on a weathered dark walnut counter at morning. The pour-over ' +
    'rig sits in the LEFT half of the frame: a porcelain V60 dripper on top ' +
    'of a TALL CYLINDRICAL HARIO GLASS SERVER (straight walls, flat handle), ' +
    'fresh coffee blooming at the start of the bloom — visible bubbles. A ' +
    'brass gooseneck kettle is partially cropped out of the upper-left frame ' +
    'edge, only its spout and a glint of brass visible. In the lower-right ' +
    'third: a small pile of medium-roasted beans on a hand-thrown earthenware ' +
    'dish. The Minuto coffee bag is SMALL in the deep-shadowed background, ' +
    'occupying less than 15% of the frame area. Single warm window light from ' +
    'upper-right. Generous shadow across the right side of the frame.',
}

export const ASPECT_TO_RATIO = {
  feed_square:    '1:1',
  feed_portrait:  '4:5',
  reel_cover:     '9:16',
} as const
export type Aspect = keyof typeof ASPECT_TO_RATIO

// Compact summary fed into the agent's enrichment prompt — Claude picks one
// of these keys as `post_type` and uses it as the seed for the scene_brief.
export const SCENE_PRESET_SUMMARIES = {
  still_life_gift: 'two bags + craft box on ceramic plate; gift / batch announcement / seasonal release',
  pour_shot:       'hand pouring from Hario server into ceramic cup; ritual / brewing / freshness',
  origin_still:    'single bag with brass scoop of green beans; origin story / single-origin focus',
  brewing_setup:   'pour-over rig blooming with brass kettle suggested; method / equipment / education',
} as const
