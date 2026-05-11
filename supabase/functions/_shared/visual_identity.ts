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

// Color anchor for actual Minuto roasted beans — uploaded by the user
// 2026-05-09 after multiple iterations of text-only color prompts kept
// missing the target. Passed to Gemini as a SECOND reference image
// (alongside the bag) so the model has a visual anchor for the medium-
// chestnut color rather than guessing from text descriptions alone.
export const MINUTO_BEANS_REFERENCE_URL =
  'https://ytydgldyeygpzmlxvpvb.supabase.co/storage/v1/object/public/marketing/IMG_5117.jpg'

// Shape + colour anchor for Minuto's actual bar machine — a 2-group
// La Marzocco Strada X. Uploaded by the user 2026-05-10 after text-only
// description rendered a generic chrome Linea silhouette instead of the
// distinctive slate body + pale-blue glass side wing. Passed to Gemini
// as a THIRD reference image, but ONLY when the scene brief involves
// espresso brewing or milk steaming (detected by visual-test). For
// pour-over / beans-only / lifestyle shots we don't include it — the
// machine has no business in those scenes.
export const MINUTO_ESPRESSO_MACHINE_REFERENCE_URL =
  'https://ytydgldyeygpzmlxvpvb.supabase.co/storage/v1/object/public/marketing/FullSizeRender_6cabba01-90d6-4413-9e50-1f5a16e64acb.jpg.jpeg'

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
drippers, MEDIUM ROASTED BEANS (pecan / chestnut / lighter milk
chocolate — see ROAST LEVEL clause below; NEVER raw/green, NEVER
dark/oily), steam, amber liquid, dark wood serving boards, brown
craft-paper boxes, hand-thrown earthenware bowls and dishes.

THE MINUTO COFFEE ROASTER (when a scene calls for the roastery /
roasting machine / "the roaster"): a Coffee-Tech Engineering drum
roaster with a FULLY MATTE BLACK BODY — black panels, black hopper,
black chimney, black afterburner column. The only non-black elements
are the round stainless steel cooling tray with rotating arms (silver),
small chrome details on the front (a round pressure gauge, the bean
sight glass with a chrome rim), and a small red emergency-stop button.
NEVER render a vintage Probat copper roaster, NEVER an antique brass
roaster, NEVER a white/cream-colored roaster, NEVER a yellow or wood-
trim roaster. Modern, all-black, industrial. If the scene mentions a
brass kettle that's allowed (separate object); the roaster itself is
black.

THE MINUTO ESPRESSO MACHINE (when a scene calls for an espresso
machine, group head, portafilter docked, steam wand, or any espresso
brewing / milk steaming): a LA MARZOCCO STRADA X, two-group, with
these specific distinguishing features (do NOT render a generic Linea
or Linea Mini silhouette — that's wrong machine):
  • BODY COLOR: slate / dark gunmetal grey, matte (not glossy, not
    chrome, not white). The main body panels are a flat charcoal-grey.
  • SIGNATURE SIDE PANEL: a curved, teardrop-shaped translucent
    PALE-BLUE GLASS side wing on each side of the machine, set into
    the grey body — this is the Strada X's most recognizable element
    and must appear if the side of the machine is in frame. It's
    sky-blue / powder-blue translucent glass, not opaque, not dark.
  • TWO SATURATED BREW GROUPS: cylindrical chrome group heads
    protruding forward from the front panel, with rounded chrome top
    caps. Two of them, side by side. Naked / bottomless portafilters
    locked into them, with BLACK handles and a small RED accent ring
    at the base where the spouts emerge.
  • TWO COOL-TOUCH STEAM WANDS: thin chrome articulated wands curving
    OUTWARD from the SIDES of the machine body (one per side),
    flanking the group heads — NOT coming out of the front, NOT out of
    the group heads. They have small chrome knob controls on top.
  • TOP CUP TRAY: a raised stainless-steel wire-grate cup warmer/tray
    sits on top of the body, supported by thin chrome rails — it's
    open mesh, you can see through it.
  • DRIP TRAY: stainless steel wire-mesh tray across the bottom front,
    with a "La Marzocco" wordmark plate on the front lip (chrome
    lettering on dark background).
  • FRONT PANEL: dark grey, with a small round chrome pressure gauge
    on the lower-left and a single small toggle switch nearby.
NEVER render a chrome / mirror-polished body, NEVER a white espresso
machine, NEVER a Linea Mini silhouette (that's a small home machine
with a curved chrome body — wrong). NEVER render the Strada X without
the pale-blue glass side panel if the side is in frame. The eagle wing
La Marzocco logo is small and lives on the drip-tray front plate, not
splashed across the body.

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

EQUIPMENT-BY-BREWING-METHOD RULE — STRICTLY ENFORCED:
The brewing EQUIPMENT must match the drink that's claimed. The single
most common mistake is rendering a moka pot when the brief says
"espresso". That is WRONG. Moka pot makes moka coffee (stovetop, ~2 bar
pressure, no crema, completely different drink). Espresso REQUIRES an
ESPRESSO MACHINE with a portafilter and 9 bar pressure.

  • Espresso (any brief mentioning "espresso", "espresso shot",
    "espresso at home", "real espresso", אספרסו) → an ESPRESSO MACHINE
    with a chrome portafilter docked into a group head. NEVER a moka
    pot. NEVER a stovetop espresso maker. NEVER a Bialetti. NEVER an
    AeroPress. NEVER a pour-over for espresso.
       ‣ HOME-FOCUSED espresso content ("at home", "home barista",
         "kitchen", בבית, במטבח, בדירה, "home espresso") →
         render a HOME ESPRESSO MACHINE: chrome or matte-black body,
         SINGLE group head with a chrome portafilter, water tank at the
         back, sits on a kitchen counter. Exemplars: Delonghi Dedica,
         Breville Bambino, Gaggia Classic Pro, Sage Barista, Rancilio
         Silvia, La Pavoni lever. Smaller scale than a commercial bar
         machine.
       ‣ CAFE / BAR / ROASTERY espresso content (Minuto's own brand
         storytelling, "in the cafe", "at the bar", "Minuto roastery")
         → the La Marzocco Strada X (see THE MINUTO ESPRESSO MACHINE
         block). NEVER use the Strada X for "at home" content — that
         machine is a 2-group commercial unit, would not exist on a
         customer's kitchen counter.
       ‣ When ambiguous (just "espresso" without home/cafe context) →
         default to a HOME espresso machine. Minuto's audience is
         customers brewing at home; that's the default.
  • Filter / V60 / Chemex / pour-over / drip → glass dripper + Hario
    server + brass gooseneck kettle. No espresso machine, no moka pot.
  • AeroPress → the actual AeroPress chamber, plastic translucent
    cylinder pressed down by hand.
  • French press → glass-and-chrome plunger pot.
  • Moka pot → ONLY when the brief explicitly says "moka", "מוקה",
    "stovetop", "Bialetti", or "stovetop espresso maker". Never for
    plain "espresso".

ROAST LEVEL — STRICTLY ENFORCED: Minuto roasts to MEDIUM, occasionally
medium-light. NEVER medium-dark, NEVER dark, NEVER green/unroasted.

CONCRETE COLOR ANCHORS — render roasted beans the color of:
  ✓ Pecan shells / roasted pecan brown
  ✓ Milk chocolate (the lighter end — Cadbury, not 70% dark)
  ✓ Roasted hazelnut shell
  ✓ Medium walnut wood (the freshly cut warm-brown walnut, not aged dark)
  ✓ Chestnut just out of the roaster
  ✓ Real-world appearance: medium chestnut brown with subtle red-amber
    undertones, the bean centre crease slightly paler than the surface

NOT the color of:
  ✗ GREEN, sage, olive, khaki — UNROASTED. Forbidden.
  ✗ Cardboard, kraft paper, oats, blanched almonds, camel leather, raw
    cashews — TOO LIGHT. These overshoot to underroasted; coffee is
    distinctly brown, not pale tan.
  ✗ Dark chocolate, espresso shot, coffee liquid, ebony, near-black —
    TOO DARK. Forbidden (medium-dark/french violation).
  ✗ Anything glossy, oily, or wet-looking — Minuto beans are matte
    even immediately after roasting.

BEAN SURFACE FINISH:
  - Matte, dry, slight visible chaff/silverskin texture is fine.
  - Bean center crease visible and slightly paler than the surface
    (the line where it cracked open during roast).
  - Subtle warm undertones — auburn / amber, not pure cool brown.
  - NEVER glossy or oily even though they're roasted.

ANTI-PATTERN CHECKS — both sides:
  • If your beans look pale tan / cardboard / wheat / oat → TOO LIGHT.
    Push toward the medium-chestnut/pecan range.
  • If your beans look dark chocolate / espresso / glossy black → TOO
    DARK. Pull back toward medium-chestnut/pecan.
  • If your beans look green/sage → not roasted at all. Wrong scene.
  • Goldilocks zone: clearly recognizable as ROASTED coffee at a
    medium roast level. Pecan-brown / hazelnut-shell / lighter
    milk-chocolate. That's the target.

ALLOWED HANDS: Hands appear ONLY when interacting with coffee — pouring
from a server, holding a cup mid-sip motion, weighing beans on a scale.
Hands enter from frame edge, never as a subject. Slight motion blur on a
pour or pour-stream is welcome. NO faces.

ABSOLUTELY FORBIDDEN — image fails if it contains any of these:
- ⛔ MOKA POT / Bialetti / stovetop espresso maker / any aluminum
  octagonal stovetop brewer when the brief mentions ESPRESSO — they
  make moka coffee, not espresso. Render an espresso machine instead
  (home or commercial per EQUIPMENT-BY-BREWING-METHOD rule). Moka pot
  is allowed ONLY when the brief explicitly says moka / מוקה /
  stovetop / Bialetti.
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
