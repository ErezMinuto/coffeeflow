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

// Shape + finish anchor for Minuto's actual roaster — a Coffee-Tech
// Engineering compact drum roaster with a two-tone matte-black lower
// body + brushed stainless upper drum cover, tall conical stainless
// hopper, and a separate small round stainless cooling tray on the
// right. Uploaded by the user 2026-05-26 after the text-only roaster
// description kept rendering generic "fully matte black Probat-style"
// silhouettes with hallucinated "COFFEE-TECH" text. Passed to Gemini /
// Imagen as a reference image whenever the scene brief mentions the
// roaster, the roastery, roast day, the cooling tray, fresh beans
// coming off the cooler, or BTS roastery moments. For cafe / pour-over
// / cup-ritual scenes we don't include it.
export const MINUTO_ROASTER_REFERENCE_URL =
  'https://ytydgldyeygpzmlxvpvb.supabase.co/storage/v1/object/public/marketing/minuto_roaster_reference.png'

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
roasting machine / "the roaster"): a Coffee-Tech Engineering compact
drum roaster (Minuto's actual machine) — TWO-TONE: matte-black lower
body and side panels, with a BRUSHED STAINLESS STEEL upper drum
cover, stainless drum face, and a tall stainless conical hopper on
top. The silhouette is VERTICAL and compact (taller than wide), not
the squat horizontal industrial style. A large stainless-steel
exhaust chimney rises straight up from the top-left. A round drum
face on the right side has a central handle wheel and a black trier
(sampling rod). To the right of the main body, attached at mid-
height, sits a SEPARATE round shallow stainless cooling tray (much
smaller diameter than a commercial cooler — about hopper width) with
a stainless rotating arm crossing it. The cooling tray rim is
brushed stainless; its inside is perforated steel floor. Small
yellow stencil safety labels appear on a few black panels (e.g.
"MANUAL CRANK") but they are SMALL stencils on hardware — NEVER
render them as large readable headline text. A small grey control
panel with a tiny LCD display sits on the front lower half.
⛔ MANUFACTURER BADGE PROHIBITION: there is a small "COFFEE-TECH
ENGINEERING" badge on the real machine, BUT it MUST NOT be rendered
as readable text in the photograph — neither on the hopper, the
drum cover, the cooling tray rim, nor anywhere else. NO model
names, NO manufacturer text, NO orange/yellow logo lettering. The
machine is identified by its silhouette and two-tone finish, not
by branding.
NEVER render a vintage Probat copper roaster, NEVER an antique
brass roaster, NEVER a white/cream-colored roaster, NEVER a
wood-trim roaster, NEVER a "fully matte black" Diedrich/Loring-
style box (Minuto's machine has the prominent brushed-stainless
upper section — getting it all-black is wrong). NEVER render the
roaster as a giant industrial unit — Minuto's machine is compact
enough to fit in a small roastery. If the scene mentions a brass
kettle that's allowed (separate object); the roaster itself is
two-tone matte-black + brushed stainless.

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
    A STEAM WAND PRODUCES STEAM ONLY. It is NEVER a pour spout. Milk,
    coffee, or any liquid stream emerging FROM the tip of a steam wand
    into a cup is physically wrong and forbidden — the wand tip either
    sits idle (no stream), emits faint white steam vapor, or is
    submerged inside a separate stainless steel milk pitcher being
    held under it. Liquid never falls from the wand into a cup.
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

MILK HANDLING RULE — STRICTLY ENFORCED: Milk and coffee live in
different vessels and move along different paths. Get this wrong and
the image instantly reads as fake to anyone who's ever been near an
espresso bar.
  • Milk is textured (steamed/frothed) INSIDE a stainless steel milk
    pitcher / jug with a pointed pour spout. The steam wand is
    submerged in that pitcher from above. Steam wands NEVER pour milk
    directly into a cup. Liquid does NOT fall from the tip of a steam
    wand. A steam wand only emits faint white steam vapor or sits
    idle.
  • Milk reaches the cup by being POURED FROM A STAINLESS STEEL
    PITCHER held by a hand. The pitcher tilts; a smooth white stream
    crosses from the pitcher spout into the cup. If milk is going into
    a cup in the frame, the source MUST be a pitcher, not a wand, not
    a carton, not a bottle, not thin air.
  • If a cappuccino / latte / flat white is the finished drink in the
    cup, the milk is already inside it (with latte art on top); any
    "active pour" must come from a stainless pitcher, not from the
    espresso machine.
  • The espresso shot reaches the cup ONLY through the portafilter
    spouts of the espresso machine (or, for moka briefs, from the moka
    pot's central spout). Espresso never pours from a steam wand
    either.

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
- ⛔ MILK (or any liquid) POURING FROM A STEAM WAND into a cup. Steam
  wands produce STEAM only. If milk is reaching a cup in the frame,
  the source must be a stainless steel milk pitcher held by a hand —
  never the wand. The wand tip, if visible, is either idle or
  submerged inside a separate pitcher. A white stream falling from a
  chrome wand tip directly into a cup is the single most telling
  "AI doesn't understand coffee" artifact and is an immediate fail.
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

// Editorial presets — written for the Vertex SUBJECT-customization path
// where the model generates the bag natively into a 3/4 perspective with
// creative freedom on tilt, lean, scale, and placement. "Single bag"
// constraint is kept (multi-bag is a separate fidelity issue), but
// otherwise the bag is free to rest at slight angles on plates, sit small
// in deep-shadowed backgrounds, etc. Same presets also used by the
// Gemini path (visual-test) where they read naturally too.
export const SCENE_PRESETS: Record<string, string> = {
  still_life_gift:
    'A SCENE arranged as a quiet gift moment. Frame composed in landscape ' +
    'orientation. The arrangement sits in the lower-right third of the frame: ' +
    'a single Minuto coffee bag resting at a slight angle on a hand-thrown ' +
    'unglazed ceramic plate with raw kiln-marked edges. A small brown ' +
    'craft-paper box, partially shadowed, sits to the upper-left of the ' +
    'plate, its Minuto stag emblem just catching the light. Surface: raw ' +
    'imperfect concrete with visible texture and a single dark stain. Hard ' +
    'diagonal sunlight enters from upper-right, casting long sharp shadows ' +
    'toward the lower-left. The upper-left third of the frame is mostly ' +
    'empty shadowed concrete — breathing space. Kodak Portra 400 grain. ' +
    'NEVER place the plate in the center of the frame.',

  pour_shot:
    'A SCENE of the pour ritual, frame oriented with the action diagonal. ' +
    'The main pour happens in the LEFT half of the frame: a hand emerges ' +
    'from the upper-left edge holding a TALL CYLINDRICAL HARIO RANGE SERVER ' +
    '(straight glass walls, flat horizontal handle, much larger than a milk ' +
    'pitcher), tilted forward, pouring a thin amber stream into a small ' +
    'unglazed ceramic cup with raw edges sitting on a dark weathered walnut ' +
    'table. Visible soft steam curls upward. The right half of the frame is ' +
    'mostly negative space — deep shadow, with a single Minuto coffee bag ' +
    'in the lower-right third, soft and slightly out of focus. Single hard ' +
    'warm light from upper-right. Slight motion blur on the pour stream. ' +
    'No face visible.',

  origin_still:
    'A SCENE around a single Minuto coffee bag positioned in the upper-right ' +
    'third of the frame, standing on a raw lime plaster surface. The bag is ' +
    'side-lit hard from the right, casting a long sharp shadow that extends ' +
    'fully across to the left edge of the frame — the shadow is part of the ' +
    'composition, not an accident. In the lower-left third: a small pile of ' +
    'light-to-medium-roasted beans (light cinnamon brown, matte) scattered ' +
    'directly on the raw plaster, with a few loose beans nearby. A small ' +
    'empty unglazed ceramic cup, half in shadow, sits between the beans and ' +
    'the bag, smaller than the bag, soft focus. NO SPOONS, NO SCOOPS. ' +
    'Almost monochromatic earth palette. Kodak Portra grain.',

  brewing_setup:
    'A SCENE on a weathered dark walnut counter at morning. The pour-over ' +
    'rig sits in the LEFT half of the frame: a porcelain V60 dripper on top ' +
    'of a TALL CYLINDRICAL HARIO GLASS SERVER (straight walls, flat handle), ' +
    'fresh coffee blooming at the start of the bloom — visible bubbles. A ' +
    'brass gooseneck kettle is partially cropped out of the upper-left frame ' +
    'edge, only its spout and a glint of brass visible (the kettle is the ' +
    'ONE allowed brass element — not a spoon or scoop). In the lower-right ' +
    'third: a small pile of light-to-medium-roasted beans (light cinnamon ' +
    'brown, matte) on a hand-thrown earthenware dish. NO SPOONS, NO SCOOPS. ' +
    'A thin clear-glass cup sits beside the dripper since this is filter ' +
    'brewing. A single Minuto coffee bag in the deep-shadowed background. ' +
    'Single warm window light from upper-right. Generous shadow across the ' +
    'right side of the frame.',

  roaster_bts:
    'A SCENE inside the Minuto roastery in the early morning, documentary ' +
    'style. Minuto\'s actual Coffee-Tech Engineering compact drum roaster ' +
    'occupies the LEFT half of the frame — TWO-TONE: matte-black lower ' +
    'body and side panels, BRUSHED STAINLESS STEEL upper drum cover and ' +
    'stainless drum face. A tall stainless conical hopper sits on top; a ' +
    'large stainless exhaust chimney rises straight up from the upper-left. ' +
    'The silhouette is vertical and compact (taller than wide), not a wide ' +
    'horizontal industrial unit. To the right of the main body, attached ' +
    'at mid-height, sits a SEPARATE round shallow stainless COOLING TRAY ' +
    'with a perforated steel floor and a rotating stainless arm crossing ' +
    'it — fresh light-to-medium-roasted beans (pecan-shell brown, matte, ' +
    'NEVER dark, NEVER glossy) spread across the tray. Soft warm steam ' +
    'rises off the bean pile — thin, low, not aggressive. The matte bean ' +
    'color is the hero. NO BAG anywhere in frame. NO visible manufacturer ' +
    'text or badge — the "COFFEE-TECH ENGINEERING" badge must NOT be ' +
    'rendered as readable text. Surface around the roaster: raw concrete ' +
    'floor with subtle stains. Single warm tungsten work-light from the ' +
    'upper-right roastery ceiling, creating long shadows toward the ' +
    'lower-left and leaving the background in deep shadow. No people, no ' +
    'faces. Kodak Portra 400 grain, editorial documentary feel. NEVER a ' +
    'vintage Probat copper, NEVER an antique brass, NEVER all-black ' +
    'Diedrich/Loring box — Minuto\'s machine is two-tone matte-black + ' +
    'brushed stainless.',

  cafe_bts:
    'A SCENE behind the bar at the Minuto cafe, documentary style. The ' +
    'LA MARZOCCO STRADA X 2-group espresso machine occupies the LEFT half ' +
    'of the frame in profile — slate-gray body, distinctive pale-blue ' +
    'glass side wing catching the light. A single portafilter is locked ' +
    'into the left group head, an espresso pour mid-stream into a small ' +
    'thick-walled ceramic cup below — the amber-mahogany stream is thin ' +
    'and steady, a small puddle of crema forming. Hands and barista body ' +
    'are partially cropped at the upper-left edge (no face visible, just ' +
    'the working hand on the portafilter handle). In the lower-right ' +
    'third: a clean bar surface (dark stained walnut or polished concrete) ' +
    'with a small pile of light-to-medium-roasted whole beans (light ' +
    'cinnamon brown, matte) scattered on a hand-thrown ceramic dish. NO ' +
    'BAG in frame. Single warm tungsten bar light from the upper-right, ' +
    'creating soft highlights on the machine and long shadows. Deep ' +
    'shadow in the background. Kodak Portra 400 grain, editorial ' +
    'documentary feel.',
}

export const ASPECT_TO_RATIO = {
  feed_square:    '1:1',
  feed_portrait:  '4:5',
  reel_cover:     '9:16',
  story:          '9:16',   // IG story — full-bleed vertical (1080×1920)
} as const
export type Aspect = keyof typeof ASPECT_TO_RATIO

// Compact summary fed into the agent's enrichment prompt — Claude picks one
// of these keys as `post_type` and uses it as the seed for the scene_brief.
export const SCENE_PRESET_SUMMARIES = {
  still_life_gift: 'single bag resting at a slight angle on a ceramic plate with a craft box beside; gift / batch announcement / seasonal release',
  pour_shot:       'hand pouring from a Hario server into a ceramic cup, with a single bag soft in the background; ritual / brewing / freshness',
  origin_still:    'single bag on a lime plaster surface with scattered medium-roast beans and a ceramic cup beside; origin story / single-origin focus',
  brewing_setup:   'pour-over rig blooming with a brass kettle cropped from the edge and the single bag soft in the background; method / equipment / education',
  roaster_bts:     'two-tone matte-black + brushed-stainless Coffee-Tech compact roaster left (vertical silhouette, stainless hopper, separate round cooling tray on the right), fresh-roasted beans on cooling tray with light steam; NO bag; NO manufacturer text; roastery BTS / roast-day / craft moments',
  cafe_bts:        'La Marzocco Strada X bar machine left, espresso pouring into ceramic cup with barista hands cropped, whole beans on bar right; NO bag; cafe BTS / espresso ritual / bar craft',
} as const
