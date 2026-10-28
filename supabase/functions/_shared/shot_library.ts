// ============================================================================
// SHOT LIBRARY — the only scenes the Instagram image pipeline may render.
// ============================================================================
//
// docs/image-pipeline/plan.md (approved 2026-10-28). Free-form scene briefs
// asked the image model to invent pours, hands and contact it cannot draw
// (floating V60, two left hands, a portafilter pouring onto a table) and
// "concept" scenes that read as off brand (a leaf on a table, a bean dropped
// into water). Each shot here is a scene the pipeline can make reliably:
//
//   • real_photo — a photo from Minuto's own library (marketing/upload_images/
//     <folder>/), lightly EDITED: reframed, relit, at most a small action.
//     Hands, machines, pours and the roaster are real, so their physics are.
//   • generated  — a static still life (no hands, nothing pouring), rendered
//     from ONE real reference photo and a short positive prompt (owner rule:
//     ~50 words, no negative lists, no overrides).
//
// The bag is NEVER generated (owner decision: real bag photos only). Bag shots
// use real photos of the bag (upload_images/bag_scenes/, from the owner's
// shoot) or, until those exist, the product's studio packshot on its own
// plain background.
//
// Pure module: no I/O, so planners, the renderer (visual-test) and the critic
// (seo-worker-visual) share one definition. Tests: shot_library_test.ts.

export type ShotType =
  | 'bag_hero'
  | 'bar_moment'
  | 'roastery'
  | 'brew_ritual'
  | 'finished_drink'
  | 'beans_closeup'
  | 'bag_with_drink'

export interface ShotSlots {
  // Required for bag shots: the WooCommerce product (Hebrew or English name).
  product_name?: string
  // Which moment of the shot, from the shot's `moments` list.
  moment?: string
  // finished_drink only.
  drink?: string
}

export interface ShotDef {
  id:          ShotType
  label:       string
  // One line for the planner menu: what the shot shows and when to use it.
  use_for:     string
  source:      'real_photo' | 'generated'
  // Library folders under marketing/upload_images/ that feed the shot, in
  // preference order.
  folders:     string[]
  moments:     string[]
  needs_product: boolean
  // False until the owner's shoot fills the folder; planners never see it.
  enabled:     boolean
}

export const SHOTS: Record<ShotType, ShotDef> = {
  bag_hero: {
    id: 'bag_hero', label: 'Bag hero',
    use_for: 'a Minuto coffee bag as the hero, for a product, a launch or a roast-of-the-week post',
    source: 'real_photo', folders: ['bag_scenes', 'coffee_bags'],
    moments: ['the bag on the counter', 'the bag in daylight', 'the bag in warm lamp light'],
    needs_product: true, enabled: true,
  },
  bar_moment: {
    id: 'bar_moment', label: 'Bar moment',
    use_for: "a real moment at Minuto's espresso bar: steaming milk, pouring latte art, pulling a shot, serving a cup",
    source: 'real_photo', folders: ['hands', 'machine', 'pitchers'],
    moments: ['steaming milk', 'pouring latte art', 'pulling an espresso shot', 'serving a cappuccino', 'the espresso bar'],
    needs_product: false, enabled: true,
  },
  roastery: {
    id: 'roastery', label: 'Roastery',
    use_for: "Minuto's own drum roaster: roast day, fresh beans dropping into the cooler, behind the scenes",
    source: 'real_photo', folders: ['roaster'],
    moments: ['the roaster at work', 'fresh beans dropping into the cooling bin', 'a close-up of the roaster'],
    needs_product: false, enabled: true,
  },
  brew_ritual: {
    id: 'brew_ritual', label: 'Brew ritual',
    use_for: 'home brewing equipment Minuto uses and sells: Chemex, dripper, AeroPress, moka pot, server',
    // Generated AROUND a real photo of Minuto's own equipment (owner,
    // 2026-10-28): the photo anchors what the Chemex/dripper looks like, the
    // prompt sets a clean, still scene. Still on purpose — pours and hands
    // come from real photos only (that is where floating drippers came from).
    source: 'generated', folders: ['brewing'],
    moments: ['a Chemex', 'a pour-over dripper', 'an AeroPress', 'a moka pot', 'a glass server'],
    needs_product: false, enabled: true,
  },
  finished_drink: {
    id: 'finished_drink', label: 'Finished drink',
    use_for: 'a finished coffee drink in a Minuto cup, still life, no hands: espresso, cappuccino, latte, filter coffee',
    source: 'generated', folders: ['cups'],
    moments: ['eye level', 'top down'],
    needs_product: false, enabled: true,
  },
  beans_closeup: {
    id: 'beans_closeup', label: 'Beans close-up',
    use_for: 'freshly roasted Minuto beans up close: a roast, an origin, freshness',
    source: 'generated', folders: ['beans'],
    moments: ['beans in a cupping tray', 'beans in a small ceramic dish', 'a handful of beans on wood'],
    needs_product: false, enabled: true,
  },
  bag_with_drink: {
    id: 'bag_with_drink', label: 'Bag and drink',
    use_for: 'a Minuto bag next to a finished cup, pairing a product with how it tastes',
    source: 'real_photo', folders: ['bag_scenes'],
    moments: ['the bag beside a cup'],
    needs_product: true, enabled: true,    // owner's bag shoot 2026-10-28 (every photo has an espresso)
  },
}

export const ENABLED_SHOTS = (Object.values(SHOTS) as ShotDef[]).filter(s => s.enabled)

export function isShotType(v: unknown): v is ShotType {
  return typeof v === 'string' && v in SHOTS
}

// The moment to use: the requested one when it is on the shot's list
// (case-insensitive), else the shot's first moment.
export function resolveMoment(shot: ShotDef, moment?: string): string {
  const m = (moment ?? '').trim().toLowerCase()
  return shot.moments.find(x => x.toLowerCase() === m) ?? shot.moments[0]
}

// ── Packshots ────────────────────────────────────────────────────────────────
// Studio packshots in upload_images/coffee_bags/, keyed by file. Aliases match
// woo_products names, which are often Hebrew-only for house blends.
// `slug` names the product's real bag photos in upload_images/bag_scenes/
// (<slug>_window.jpg, <slug>_counter.jpg, …), so a bag shot always shows
// the right bag without asking a model which bag is in the photo.
export const PACKSHOTS: Array<{ file: string; slug: string; aliases: string[] }> = [
  { file: 'ARISTO.png',            slug: 'aristo',            aliases: ['aristo', 'אריסטו'] },
  { file: 'BRAZIL.png',            slug: 'brazil',            aliases: ['brazil', 'sertão', 'sertao', 'ברזיל'] },
  { file: 'Dark_CHOCO.png',        slug: 'dark_chocolate',    aliases: ['dark chocolate'] },
  { file: 'Daye_BENSA.png',        slug: 'daye_bensa',        aliases: ['daye bensa', 'דיי בנסה'] },
  { file: 'DECAFF.png',            slug: 'decaf',             aliases: ['decaf', 'נטול קפאין'] },
  { file: 'GUATEMALA_antigua.png', slug: 'guatemala_antigua', aliases: ['guatemala', 'antigua', 'אנטיגואה'] },
  { file: 'GUJI.png',              slug: 'guji',              aliases: ['guji', "גוג'י"] },
  { file: 'INTENSO.png',           slug: 'intenso',           aliases: ['intenso', 'אינטנסו'] },
  { file: 'JUNGLE_JAVA.png',       slug: 'jungle_java',       aliases: ['jungle java'] },
  { file: 'Kenya_AA+.png',         slug: 'kenya',             aliases: ['kenya', 'קניה'] },
  { file: 'PRESTIGE.png',          slug: 'prestige',          aliases: ['prestige', "פרסטיז'", 'פרסטיז'] },
  { file: 'STAR_VELVET.png',       slug: 'velvet_star',       aliases: ['velvet star', 'star velvet'] },
  { file: 'TRIESTe.png',           slug: 'triest',            aliases: ['triest', 'trieste', 'טריאסט'] },
  { file: 'yirgachffe.png',        slug: 'yirgacheffe',       aliases: ['yirgacheffe', 'yirgacheffee', 'יירגשף'] },
]

function productEntry(productName: string | undefined) {
  const n = (productName ?? '').toLowerCase()
  return n ? PACKSHOTS.find(p => p.aliases.some(a => n.includes(a))) ?? null : null
}

export function packshotFor(productName: string | undefined): string | null {
  const hit = productEntry(productName)
  return hit ? `coffee_bags/${hit.file}` : null
}

// True when a bag_scenes file name is a photo of this product's bag.
export function isBagSceneOf(fileName: string, productName: string | undefined): boolean {
  const hit = productEntry(productName)
  return !!hit && fileName.toLowerCase().startsWith(`${hit.slug}_`)
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const RATIO_WORDS: Record<string, string> = {
  '9:16': 'vertical 9:16', '4:5': 'vertical 4:5', '1:1': 'square', '16:9': 'wide 16:9',
}

// What a real-photo edit should show. The edit prompt in visual-test supplies
// the preservation rules; this is the short "scene" part it is given.
export function shotEditBrief(shot: ShotDef, slots: ShotSlots): string {
  const moment = resolveMoment(shot, slots.moment)
  switch (shot.id) {
    case 'bag_hero':
    case 'bag_with_drink':
      return `The Minuto coffee bag, ${moment}. The bag and its printed label stay exactly as photographed. Warm, calm, natural light.`
    case 'bar_moment':
      return `Minuto's espresso bar: ${moment}. Keep the real barista hands, machine and cups exactly as photographed. Warm morning light.`
    case 'roastery':
      return `Minuto's roastery: ${moment}. Keep the real roaster exactly as photographed. Warm, moody light.`
    case 'brew_ritual':
      return `${moment[0].toUpperCase()}${moment.slice(1)} on Minuto's counter. Keep the equipment exactly as photographed. Soft daylight.`
    default:
      return moment
  }
}

// Generated still lifes: one positive scene, about 50 words, written for the
// image model with ONE reference photo attached (a real Minuto cup or beans).
export function shotGeneratePrompt(shot: ShotDef, slots: ShotSlots, ratio: string): string {
  const frame = RATIO_WORDS[ratio] ?? ratio
  const moment = resolveMoment(shot, slots.moment)
  if (shot.id === 'finished_drink') {
    const drink = (slots.drink ?? 'cappuccino').trim()
    const view = moment === 'top down' ? 'seen from directly above' : 'seen at eye level'
    return `A ${frame} editorial photograph of a freshly made ${drink} in the cup from the reference photo, ${view}. ` +
      `The cup stands alone on its saucer on a clean, warm wooden counter in soft morning window light, with gentle shadows and shallow depth of field. ` +
      `Natural film grain, calm and minimal.`
  }
  if (shot.id === 'brew_ritual') {
    const scene: Record<string, string> = {
      'a Chemex': 'freshly brewed coffee in the glass carafe and a damp paper filter of coffee grounds in its top',
      'a pour-over dripper': 'the dripper sitting on a glass server of freshly brewed coffee, a damp paper filter of grounds inside it',
      'an AeroPress': 'the AeroPress standing on a cup of freshly brewed coffee',
      'a moka pot': 'a thin wisp of steam rising from its spout, a small cup of coffee beside it',
      'a glass server': 'the server filled with freshly brewed amber coffee',
    }
    return `A ${frame} editorial photograph of ${moment}, exactly the one in the reference photo, standing on a clean, warm wooden counter, ` +
      `${scene[moment] ?? 'freshly brewed coffee inside'}. The counter is otherwise bare. Soft morning window light, gentle shadows, shallow depth of field, ` +
      `calm and minimal, natural film grain.`
  }
  // beans_closeup
  return `A ${frame} close-up editorial photograph of freshly roasted, medium-brown coffee beans, ${moment}, like the beans in the reference photo. ` +
    `Matte, dry beans with visible centre creases, warm side light, soft shadows, shallow depth of field. ` +
    `Natural film grain, calm and minimal.`
}

// ── QA checklist ─────────────────────────────────────────────────────────────
// Atomic yes/no questions the critic answers. Each must be answered YES for
// the image to pass. Only questions the shot can actually fail on.
export function shotChecklist(shot: ShotDef, slots: ShotSlots): string[] {
  // Every question is phrased so that "yes" is good; "n/a" is allowed when a
  // conditional question does not apply (the critic counts it as a pass).
  const photo  = 'Does the image look like a real photograph (not a render or illustration)?'
  const ground = 'Is every object resting on a surface or held by a hand, with nothing floating?'
  const text   = 'Is all sharp, readable text in the image correctly spelled? (n/a if there is none)'
  const hands  = 'If hands appear, are there at most two, belonging to one person (one left, one right), each with five normal fingers? (n/a if no hands)'
  switch (shot.id) {
    case 'bag_hero':
    case 'bag_with_drink':
      // Packshots are studio images by design, so no "real photograph" question.
      return [ground, text,
        'Is exactly one Minuto coffee bag the main subject?',
        `Does the bag's printed label read clearly and match the real ${slots.product_name ?? 'product'} bag?`,
        ...(shot.id === 'bag_with_drink' ? ['Is there a finished coffee drink next to the bag?'] : [])]
    case 'bar_moment':
      return [photo, ground, text, hands,
        'Is the espresso machine shown with every part attached (no floating or duplicated portafilters or steam wands)? (n/a if no machine is visible)',
        'If coffee or milk is flowing, does it come from a portafilter spout or a hand-held pitcher into a cup or pitcher? (n/a if nothing is flowing)',
        'Is the image free of readable customer names or order tickets?']
    case 'roastery':
      return [photo, ground, text,
        'Is the roaster a full-size floor-standing drum roaster (not a small or tabletop machine)? (n/a if only a close-up of a part is shown)',
        'Are any beans shown roasted (brown), not green?']
    case 'brew_ritual':
      return [photo, ground, text,
        `Is ${resolveMoment(shot, slots.moment)} the main subject, shown whole?`,
        'Is the scene still: no hands, and nothing being poured from a kettle?',
        'Is the counter clean (no cables, plugs or clutter)?',
        // Real makers' marks are fine (AEROPRESS, Bialetti); the failure is a
        // logo copied onto a different product (Bialetti on a dripper).
        'If a brand name appears, is it the real maker\'s mark on that same product (e.g. AEROPRESS on an AeroPress, Bialetti on a moka pot), not a logo copied onto a different item? (n/a if none)']
    case 'finished_drink':
      return [photo, ground, text,
        `Does the drink look like a ${slots.drink ?? 'coffee drink'} in a single cup (close variants, e.g. a latte for a cappuccino, are fine)?`,
        'Is the image free of hands and coffee bags?']
    case 'beans_closeup':
      return [photo, ground, text,
        'Are the beans roasted medium brown (not green, not black and oily)?',
        'Is the image free of hands and coffee bags?']
  }
}

// ── Planner menu and router ──────────────────────────────────────────────────

// The shot menu for planner prompts. Planners write the caption FIRST, then
// pick the shot that shows what the caption talks about.
export function plannerShotMenu(): string {
  return ENABLED_SHOTS.map(s =>
    `- ${s.id}: ${s.use_for}. moments: ${s.moments.map(m => `"${m}"`).join(', ')}` +
    (s.needs_product ? '. needs product_name' : '') +
    (s.id === 'finished_drink' ? '. needs drink' : '')
  ).join('\n')
}

// Prompt for mapping a legacy free-form brief (and, when known, the post's
// caption) onto the menu. The answer is always a shot from the menu.
export function shotRouterPrompt(sceneBrief: string, caption?: string, productName?: string): string {
  return `You choose the photo for a Minuto specialty-coffee Instagram post. Pick the ONE shot from this menu that best shows what the post is about. Never invent a scene outside the menu.

MENU:
${plannerShotMenu()}

${caption ? `POST CAPTION (Hebrew, the post's real subject):\n${caption}\n\n` : ''}OLD SCENE IDEA (may be unrealistic; use only its subject):
${sceneBrief}
${productName ? `\nPRODUCT: ${productName}` : ''}

Rules: a bag shot only when a product is named. Hands, pours or machines → bar_moment. Roasting → roastery. Brewing equipment → brew_ritual. A drink with no action → finished_drink. Beans, origin, freshness, plants or farms → beans_closeup.
Reply as JSON {"shot_type": "<id>", "moment": "<one of that shot's moments>", "drink": "<only for finished_drink>", "why": "<short>"}.`
}

// Validate a router or planner answer into a usable shot + slots. Unknown or
// disabled shots fall back to the safest generic shot.
export function normalizeShotChoice(
  raw: Record<string, unknown> | null | undefined,
  productName?: string,
): { shot: ShotDef; slots: ShotSlots } {
  let id = raw?.shot_type
  if (!isShotType(id) || !SHOTS[id].enabled) id = productName ? 'bag_hero' : 'finished_drink'
  let shot = SHOTS[id as ShotType]
  if (shot.needs_product && !productName) shot = SHOTS.finished_drink
  return {
    shot,
    slots: {
      product_name: shot.needs_product ? productName : undefined,
      moment: resolveMoment(shot, typeof raw?.moment === 'string' ? raw.moment : undefined),
      drink: shot.id === 'finished_drink'
        ? (typeof raw?.drink === 'string' && raw.drink.trim() ? raw.drink.trim() : 'cappuccino')
        : undefined,
    },
  }
}
