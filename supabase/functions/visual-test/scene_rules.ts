// Scene-aware rules for the visual-test image prompt.
//
// The prompt used to paste every rule Minuto has ever needed into every
// render: ~460 lines / ~30k characters, where an espresso close-up also got
// the roaster, Strada X, bean colour, milk, tea, AeroPress and pour-over
// rules. The few rules that mattered were buried, and several blocks
// contradicted each other or the brief (hard side light vs the brief's
// light, "one element among several objects" vs "only the props the brief
// names", a ceramic espresso cup vs the brief's glass cup). Traced on the
// 2026-10-16 espresso story, where the cup ended up on a table under a
// floating portafilter.
//
// detectScene() reads the brief once; identityFor() then assembles only the
// sections that scene needs. Rule wording is carried over from
// _shared/visual_identity.ts (MINUTO_VISUAL_IDENTITY), minus the
// contradictions, and the brief now wins on light, framing and the cup.

export interface Scene {
  espresso:    boolean   // a shot being made: portafilter, group head, pour from the machine
  milk:        boolean   // steaming, pitcher, latte / cappuccino / flat white
  pourOver:    boolean   // V60 / Chemex / Kalita / dripper / kettle / filter
  aeropress:   boolean
  frenchPress: boolean
  moka:        boolean
  grinder:     boolean
  beans:       boolean   // loose / roasted beans in frame
  roaster:     boolean
  bag:         boolean   // a Minuto bag is in the render
  drink:       boolean   // any drink in a cup
  cafe:        boolean   // brief names Minuto's bar / a café
  home:        boolean   // brief is explicitly at home → home machine; otherwise Minuto's Strada X
  machineRef:  boolean   // a photo of Minuto's machine is attached
}

export function detectScene(brief: string, flags: {
  bag: boolean; beansRef: boolean; roaster: boolean; machineRef: boolean
  espresso: boolean; cafe: boolean; home: boolean
}): Scene {
  // Ignore negated mentions — "no jars, no green beans, no kettle" must not
  // pull in the beans or pour-over rules. Drops each "no/without/never …"
  // clause up to the next punctuation mark.
  const b = brief.toLowerCase().replace(/\b(?:no|without|never|not|avoid|zero)\b[^.,;:!?]*/g, ' ')
  const has = (re: RegExp) => re.test(b)
  // An espresso being MADE (machine in frame). A finished cup of espresso on
  // a table is just a drink — it must not be forced onto a machine.
  const espresso = has(/\b(portafilter|group ?head|espresso machine|brew group|tamp(?:ing|er)?|extraction|pulling (?:a |the |an )?shot|(?:being|is|was) pulled)\b/)
    || has(/\bespresso\b[^.]*\b(?:pour(?:s|ing)?|pulled|stream(?:s|ing)?|extract(?:ed|ing|ion)?|dripping)\b/)
  const milk = has(/\b(milk|steam wand|steaming|latte|cappuccino|flat white|cortado|macchiato|microfoam|pitcher|froth(?:ing|ed)?)\b/)
  const pourOver = has(/\b(pour[- ]?over|v60|chemex|kalita|dripper|filter coffee|drip coffee|bloom(?:ing)?|gooseneck|kettle|hario)\b/)
  const aeropress = has(/\baero ?press\b/)
  const frenchPress = has(/\b(french press|plunger)\b/)
  const moka = has(/\b(moka|bialetti|stovetop|מוקה)\b/)
  const grinder = has(/\b(grinder|grinding|grind)\b/)
  const beans = flags.beansRef || has(/\b(beans?|roasted coffee|roast level|cooling tray|cooler)\b/)
  return {
    espresso, milk, pourOver, aeropress, frenchPress, moka, grinder, beans,
    roaster: flags.roaster,
    bag: flags.bag,
    drink: espresso || milk || pourOver || aeropress || frenchPress || moka || has(/\b(cup|mug|glass|drink|sip|coffee in)\b/),
    cafe: flags.cafe,
    home: flags.home,
    machineRef: flags.machineRef,
  }
}

/** Names of the sections a scene gets — written into the saved prompt doc. */
export function sectionNames(s: Scene): string[] {
  return [
    'style',
    s.roaster && 'roaster',
    s.espresso && (s.home ? 'espresso: home machine' : 'espresso: Minuto Strada X'),
    s.drink && 'cup',
    (s.espresso || s.pourOver || s.aeropress || s.frenchPress || s.moka) && 'brewing method',
    s.milk && 'milk',
    s.beans && 'roast level',
    'hands', 'forbidden',
  ].filter(Boolean) as string[]
}

const STYLE = `PHOTOGRAPHED, NOT RENDERED. Editorial-grade photography for a premium
specialty-coffee brand on Instagram. NOT a stock photo, NOT a 3D render,
NOT graphic design, NOT an AI illustration.

CAMERA & FILM: Leica M-series, 50mm Summicron, f/2.8, Kodak Portra 400.
Subtle film grain, slight imperfect focus fall-off — the quiet feeling of a
photo-essay frame, not a product shot.

LIGHT: if the brief describes the light, use exactly that. Otherwise ONE
warm directional light from the upper right (late-morning window light),
contrasty shadows falling to the lower left, real shadow in the frame.
Never flat, never a softbox or studio-commercial look.

COMPOSITION: if the brief sets the framing (close-up, top-down, centered,
eye-level…), follow it. Otherwise: subject in the lower-right or upper-right
third, at least 30% calm negative space, asymmetric balance.

PALETTE: earth tones — deep brown, concrete grey, dusty olive, cream, tan,
warm amber, charcoal. No saturated reds, blues, yellows or greens, except
what is printed on a Minuto bag's label.

SURFACES: textured natural materials — raw concrete, weathered walnut or
oak, unglazed ceramic, lime plaster, earthenware. Never glossy white,
marble, seamless paper or white walls.`

const ROASTER = `THE MINUTO COFFEE ROASTER: Minuto's Coffee-Tech Engineering production
drum roaster, as in the real photo of the roastery.
⛔ SCALE — a FULL-SIZE PRODUCTION MACHINE, never a model, tabletop unit or
miniature: 2.0 m tall (taller than an adult), 1.5 m long, 1.0 m wide,
chimney ducts at 2.8 m by the ceiling. It stands on the roastery FLOOR and
dominates the frame. ⛔ EXACTLY ONE roaster in the frame.
LOOK: dark charcoal / gunmetal matte body; a large BLACK
cylindrical-to-conical green-bean hopper on top; a brushed stainless front
drum face with a round sight glass full of beans, a round gauge, a handle
wheel and a sampling trier; large SILVER flexible exhaust ducts rising to
the ceiling; a tall dark cyclone/chaff column beside it. The COOLER is a
large, deep, cylindrical brushed-stainless bin with tall straight sides on
a dark base, at the front of the machine below the drum door; fresh beans
fall from the drum door into it and its internal arms stir them.
MANUFACTURER PLATE: "COFFEE-TECH ENGINEERING", white letters on a dark
plate on the hopper neck above the bean sight window. Spell it exactly; if
it would be too small to render sharply, let it fall out of focus rather
than inventing letters. No other brand or model names anywhere.
NEVER a vintage Probat copper roaster, an antique brass roaster, a
white/cream roaster or a wood-trim roaster.`

const ESPRESSO_STRADA = `THE ESPRESSO MACHINE — Minuto's bar machine, a LA MARZOCCO STRADA X,
two-group (not a generic Linea / Linea Mini):
  • BODY: slate / dark gunmetal grey, matte — not chrome, not white.
  • SIDE WINDOW: a curved teardrop-shaped CLEAR glass window forms each
    outer side wall at the far ends of the machine. Show it only when the
    machine's side end is in frame; in a group-head / portafilter close-up
    it is out of frame. Never a small glass, blue or mint panel or shield
    beside a group head.
  • GROUPS: two chrome group heads with grey top caps, side by side, each
    holding exactly ONE portafilter with a BLACK handle.
  • STEAM WANDS: thin chrome wands rising from the top-side of the body
    next to the groups — never out of a group head or a portafilter.
  • DRIP TRAY: stainless wire grate across the bottom front; keep its small
    wordmark plate soft or out of frame (a sharp misspelling reads as fake).
  • Every part connects to the body as on the real machine — no floating,
    merged or invented parts. When in doubt, crop tighter.`

const ESPRESSO_HOME = `THE ESPRESSO MACHINE — a HOME espresso machine (the brief is set at home):
chrome or matte-black body, a SINGLE group head with a chrome
portafilter, water tank at the back, on a kitchen counter, smaller than a
café machine (e.g. Gaggia Classic, Rancilio Silvia, Breville Bambino). Not a
moka pot, not a stovetop brewer.`

const ESPRESSO_ANATOMY = `ESPRESSO PHYSICS:
  • The portafilter locks UPWARD into the underside of the group head on the
    front of the machine. It never floats and never has a wand attached.
  • The shot comes from TWO SPOUTS under the portafilter — a matched,
    symmetric pair side by side — as twin amber streams falling close
    together into the cup.
  • The cup stands on the machine's stainless DRIP-TRAY GRATE directly
    under the spouts. Never a cup on a table, counter or wooden surface
    under a hovering portafilter.
  • Enough of the machine body is in frame to anchor the group head.`

const CUP = `THE CUP: if the brief names the cup (material, shape, glass vs ceramic),
use exactly that cup. Otherwise: espresso / cappuccino → small unglazed
ceramic cup with raw edges; filter / pour-over → thin clear glass cup or
carafe; latte / flat white → small clear glass tumbler. One cup unless the
brief asks for more.`

const MILK = `MILK: milk is steamed INSIDE a stainless steel pitcher with the steam wand
submerged from above. A steam wand only makes steam — no milk, coffee or any
liquid ever falls from its tip. Milk reaches a cup only by being poured from
a stainless pitcher held by a hand. A finished cappuccino / latte / flat
white already has its milk in it (latte art on top), with no active pour.
Espresso itself never pours from a steam wand.`

const METHOD: Record<string, string> = {
  pourOver: `POUR-OVER: glass or porcelain dripper (V60 / Chemex / Kalita) with a paper
filter and a visible bed of wet, blooming grounds. The dripper ALWAYS sits on
top of a glass server or a cup that catches the coffee — never directly on
the table or counter, even in a top-down or macro shot (show the server's
rim or glass under the dripper). Kettle water goes ONLY into the
dripper — a kettle never pours straight into a cup. A brass gooseneck kettle
may appear, partly cropped at a frame edge.`,
  aeropress: `AEROPRESS: the actual translucent plastic AeroPress chamber, pressed down by
hand, its base flange resting DIRECTLY on the cup rim — never hovering above
the cup with a gap.`,
  frenchPress: `FRENCH PRESS: a glass-and-chrome plunger pot.`,
  moka: `MOKA POT: an aluminium octagonal stovetop moka pot (only because the brief
asks for one).`,
  espressoNotMoka: `ESPRESSO means an ESPRESSO MACHINE with a portafilter — never a moka pot,
stovetop brewer, Bialetti or AeroPress.`,
}

const ROAST_LEVEL = `BEANS: Minuto roasts MEDIUM. Roasted beans are pecan-shell / roasted-hazelnut
/ lighter milk-chocolate brown with warm amber undertones, matte and dry,
the centre crease slightly paler. Never pale tan or cardboard (too light),
never dark-chocolate or black or oily (too dark), never green (unroasted)
unless the brief is explicitly about green coffee. Loose beans lie directly
on the surface or in a small ceramic dish.`

const HANDS = `HANDS: only when the brief asks for them or the action needs one (holding a
pitcher, pouring, tamping). Hands enter from a frame edge. No faces.`

function forbidden(s: Scene): string {
  const lines = [
    `- Tea of any kind — every drink in frame is coffee.`,
    `- Spoons, scoops or any utensil.`,
    `- Duplicate equipment (two machines, two roasters, two kettles, two grinders) unless the brief asks for two.`,
    s.milk || s.espresso ? `- Any liquid falling from a steam wand.` : '',
    s.espresso ? `- A moka pot or stovetop brewer for espresso.` : '',
    s.pourOver ? `- A kettle pouring straight into a cup or glass.` : `- A kettle (only pour-over scenes have one).`,
    `- Text, letters, numbers, logos or watermarks${s.bag ? ' (except the Minuto bag label: wordmark, stag emblem, origin/blend name — and never a date, batch or lot number on the bag)' : ''}${s.roaster ? ' (except the "COFFEE-TECH ENGINEERING" plate)' : ''}.`,
    `- Human faces, full bodies, portraits; stock-photo clichés (smiling barista, latte-art heart, cozy Sunday steam-over-magazine).`,
    `- A cartoony, illustrated, vector or 3D-rendered look; vehicles, sky, landscapes, animals, plants beyond a single sprig.`,
  ].filter(Boolean)
  return `ABSOLUTELY FORBIDDEN:\n${lines.join('\n')}`
}

/** The identity block for one scene: only the sections it needs. */
export function identityFor(s: Scene): string {
  const parts: string[] = [STYLE]
  if (s.roaster) parts.push(ROASTER)
  if (s.espresso) {
    // Minuto's own bar machine by default; a home machine only when the brief
    // is explicitly set at home.
    parts.push(s.home ? ESPRESSO_HOME : ESPRESSO_STRADA)
    parts.push(ESPRESSO_ANATOMY)
  }
  if (s.drink) parts.push(CUP)
  const methods: string[] = []
  if (s.espresso && !s.moka) methods.push(METHOD.espressoNotMoka)
  if (s.pourOver) methods.push(METHOD.pourOver)
  if (s.aeropress) methods.push(METHOD.aeropress)
  if (s.frenchPress) methods.push(METHOD.frenchPress)
  if (s.moka) methods.push(METHOD.moka)
  parts.push(...methods)
  if (s.milk) parts.push(MILK)
  if (s.beans) parts.push(ROAST_LEVEL)
  parts.push(HANDS, forbidden(s))
  return parts.join('\n\n')
}
