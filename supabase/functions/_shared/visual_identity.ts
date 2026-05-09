// The locked Minuto IG visual identity. Imported by visual-test (the
// generation endpoint) and by marketing-advisor's enrichment step (which
// writes scene briefs that obey this same anchor). Keep this file as the
// single source of truth — if we drift apart, the agent's brief and the
// generated image will drift apart with it.
//
// Synthesized from reference posts (La Cabra "Rituals" Reel + Blue Bottle
// Valentine still-life). See conversation context for the full derivation.

// Default fallback when no specific product is matched. Kept as the
// Yirgacheffe bag for backwards compat, but in practice visual-test now
// rotates through MINUTO_BAG_REFERENCE_POOL when no per-post reference is
// supplied — otherwise EVERY post that didn't match a product would render
// the Yirgacheffe bag and the feed would look monochromatic.
export const MINUTO_BAG_REFERENCE_URL =
  'https://www.minuto.co.il/content/uploads/2025/08/yirgachffe.png'

// Five real Minuto bags with distinct colored center labels. visual-test
// picks one at random when no per-post reference_image_url is set, so
// generic posts get visual variety across the feed instead of always
// the same bag. Order doesn't matter; rotation is uniform-random per
// generation call.
export const MINUTO_BAG_REFERENCE_POOL: ReadonlyArray<string> = [
  'https://www.minuto.co.il/content/uploads/2025/08/yirgachffe.png',
  'https://www.minuto.co.il/content/uploads/2025/03/Minuto_Antigua.png',
  'https://www.minuto.co.il/content/uploads/2025/03/STAR_VELVET.png',
  'https://www.minuto.co.il/content/uploads/2026/05/SWEET_LEONA_.png',
  'https://www.minuto.co.il/content/uploads/2025/03/Kenya_AA.png',
]

export function pickFallbackBagUrl(): string {
  return MINUTO_BAG_REFERENCE_POOL[Math.floor(Math.random() * MINUTO_BAG_REFERENCE_POOL.length)]
}

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

SUBJECT VOCABULARY: Coffee bags (sized as an element, not the hero),
small unglazed ceramic cups with raw edges (for espresso/cappuccino),
thin clear-glass cups or carafes (for filter/pour-over coffee), glass
coffee servers (Hario range server: tall straight-sided cylindrical glass
with a flat horizontal handle, NOT a milk pitcher), porcelain pour-over
drippers, LIGHT-TO-MEDIUM ROASTED BEANS (warm light-brown / cinnamon /
caramel — see ROAST LEVEL clause below; NEVER raw or green), steam,
amber liquid, dark wood serving boards, brown craft-paper boxes,
hand-thrown earthenware bowls and dishes.

NO SPOONS, NO SCOOPS, NO UTENSILS: brass scoops, wooden spoons, espresso
spoons, measuring scoops — all forbidden. Gemini renders them with
weirdly small bowls or distorted proportions, and they break the frame.
If beans need to be displayed loose, scatter them directly on the surface
or pile them in a small unglazed ceramic dish.

CUP-BY-BREWING-METHOD RULE: The vessel must match the drink it implies.
  - Espresso shot, cappuccino, macchiato → small unglazed ceramic
    demitasse (60-90ml), raw kiln edges, no handle or short handle.
  - Filter coffee (V60, Chemex, Aeropress, drip) → thin CLEAR GLASS
    cup or carafe, straight or slightly tapered. Lets the amber color
    show through. Never a ceramic cup for filter.
  - Latte / flat white → small clear glass tumbler or thin-walled
    ceramic latte cup.
  When the scene is ambiguous (just "coffee", no method named), default
  to the small unglazed ceramic cup.

ROAST LEVEL — STRICTLY ENFORCED: Minuto roasts LIGHT to MEDIUM-LIGHT.
Beans are ROASTED — NEVER green, NEVER unroasted, NEVER raw. They have
clearly been through fire and have developed a warm brown color, just a
LIGHT brown rather than a dark one.

CONCRETE COLOR ANCHORS — render roasted beans the color of:
  ✓ Light cinnamon brown (the spice itself)
  ✓ Cardboard / kraft brown paper
  ✓ Caramel just before it deepens
  ✓ Pancake/waffle that's golden but not yet dark
  ✓ Light maple syrup
  ✓ Camel-colored leather
  ✓ Buttery shortbread

NOT the color of:
  ✗ GREEN, sage, olive, khaki, pistachio — these are UNROASTED beans
    which Minuto does NOT sell as a finished product. Forbidden.
  ✗ Walnut wood, chestnut, mahogany — too dark
  ✗ Dark chocolate, milk chocolate — too dark
  ✗ Espresso shot, coffee liquid — way too dark
  ✗ Roasted almonds — too dark
  ✗ Anything glossy, oily, or wet-looking
  ✗ Anything you'd see on a typical commercial-coffee bag photo

BEAN SURFACE FINISH:
  - Matte, dry — never glossy, never oily, never wet-looking
  - Bean center crease is visible and slightly darker than the surface,
    but the bean itself reads as a warm light brown not a green grain
  - Looks unmistakably like ROASTED coffee, not raw green coffee

ANTI-PATTERN CHECK: if your beans look green/sage/olive — STOP, you've
gone too light. Roasted coffee is brown, just lightly brown. Imagine
brown shortbread or a kraft-paper bag, then make the beans that color.
If your beans look like dark chocolate or espresso liquid — STOP, you've
gone too dark. The right answer is a warm CARAMEL/CINNAMON brown.

ALLOWED HANDS: Hands appear ONLY when interacting with coffee — pouring
from a server, holding a cup mid-sip motion, weighing beans on a scale.
Hands enter from frame edge, never as a subject. Slight motion blur on a
pour or pour-stream is welcome. NO faces.

ABSOLUTELY FORBIDDEN — image fails if it contains any of these:
- Human faces, heads, full bodies, portraits
- ⛔ ANY SPOON, SCOOP, OR UTENSIL — brass scoops, wooden spoons, espresso
  spoons, measuring scoops, dosing scoops, latte-art etching tools, stir
  sticks. ZERO utensils anywhere in the frame. If the brief or preset
  mentions one, ignore that part of the brief and omit the utensil. This
  is a HARD rule. Loose beans live directly on the surface or in a small
  ceramic dish, never in a scoop. The ONLY exception is a brass gooseneck
  kettle when it appears partially cropped from a frame edge in a brewing
  scene — full kettles are still forbidden, only a corner-glimpse kettle
  is allowed.
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
    'of the composition, not an accident. In the lower-left third: a small ' +
    'pile of LIGHT-TO-MEDIUM-ROASTED beans (light cinnamon brown, matte) ' +
    'scattered directly on the raw plaster, with a few loose beans nearby. ' +
    'A small empty unglazed ceramic cup, half in shadow, sits between the ' +
    'beans and the bag, smaller than the bag, soft focus. NO SPOONS, NO ' +
    'SCOOPS. The bag occupies maybe 25% of the frame area, not 50%. ' +
    'Almost monochromatic earth palette. Kodak Portra grain.',

  brewing_setup:
    'A SCENE on a weathered dark walnut counter at morning. The pour-over ' +
    'rig sits in the LEFT half of the frame: a porcelain V60 dripper on top ' +
    'of a TALL CYLINDRICAL HARIO GLASS SERVER (straight walls, flat handle), ' +
    'fresh coffee blooming at the start of the bloom — visible bubbles. A ' +
    'brass gooseneck kettle is partially cropped out of the upper-left frame ' +
    'edge, only its spout and a glint of brass visible (the kettle is the ' +
    'ONE allowed brass element — not a spoon or scoop). In the lower-right ' +
    'third: a small pile of LIGHT-TO-MEDIUM-ROASTED beans (light cinnamon ' +
    'brown, matte) on a hand-thrown earthenware dish. NO SPOONS, NO SCOOPS. ' +
    'A thin clear-glass cup sits beside the dripper since this is filter ' +
    'brewing. The Minuto coffee bag is SMALL in the deep-shadowed background, ' +
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
