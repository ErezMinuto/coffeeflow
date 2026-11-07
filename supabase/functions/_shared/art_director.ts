// The Instagram art director (docs/image-pipeline/art-director-design.md).
//
// Owner, 2026-11-07: Instagram images are real moments at Minuto, invented
// fresh each time, not still lifes from a fixed menu. The art director (Claude
// Opus 5.5, which won the owner's blind test 3 of 3) reads the caption,
// proposes 3 story concepts, picks one, chooses the physical action from the
// owner-approved list below, picks 1-2 of Minuto's own photos as references and
// writes the prompt for Nano Banana Pro. Gemini 3.1 Pro checks the render
// (the owner's choice). Physics stays closed: every action carries a realism
// note the owner approved, and the critic checks it.
//
// Pure: prompts, validation and question lists. The network calls live in
// seo-worker-visual (art director + critic) and visual-test (render).

import { PHOTO_INDEX, type IndexedPhoto } from './photo_index.ts'
import { PHOTO_EXCLUDE } from './shot_library.ts'

export const AD_MODEL = 'claude-opus-5-5'
export const AD_CRITIC_MODEL = 'gemini-3.1-pro-preview'
export const AD_PROMPT_VERSION = 'art-director-v1'

// Owner-approved 2026-11-07 ("List is right"). How each action REALLY looks;
// the art director must follow it and the critic checks it.
export const ACTIONS: Record<string, string> = {
  steaming_milk: "The barista holds the milk pitcher in one or both hands, raised to the steam wand; the wand tip is just under the milk surface; steam rises; the pitcher is held, never parked on the drip tray while steaming; only one steam wand.",
  pulling_a_shot: "A portafilter is locked into the group head; espresso runs in one or two thin streams from its spouts into a cup or glass sitting on the drip tray directly under it.",
  dosing_grinding: "Freshly ground coffee falls from the grinder's chute into a portafilter held under it or resting in the grinder's fork.",
  tamping: "The portafilter rests on the counter edge or a tamping mat; the barista presses the tamper down level into the basket.",
  pouring_latte_art: "The barista holds a cup tilted in one hand and pours steamed milk from the pitcher's spout close to the surface with the other; the pattern forms on the crema.",
  serving_across_the_bar: "A finished drink on its saucer is set on the bar counter or handed across it; the customer is a hand or a soft background figure.",
  finished_drink_at_rest: "A finished drink stands on a table or counter with a natural lived-in setting; nothing is pouring.",
  brewing_pour_over: "A kettle's thin stream pours onto wet grounds in a paper filter sitting on a dripper on a server or cup; the bed of grounds is dark and wet.",
  moka_pot_on_stove: "The moka pot sits on a lit stove burner or just off it; coffee rises out of the central spout into the top chamber, the lid open or closed.",
  roasting_drop: "Roasted beans pour from the drum door into the round cooling bin while its stirring arms turn; a little smoke; the roaster operator's hand on a lever or out of frame.",
  roasting_check: "The operator pulls the small sample trier out of the drum to look at the bean colour; beans on the trier are roasted brown.",
  bags_on_the_shelf: "Sealed Minuto bags stand upright on a shelf or counter; labels face out exactly as the real bags.",
  cupping: "Rows of small cups of ground coffee on a table; someone breaks the crust with a spoon or sniffs the aroma.",
  cleaning_down: "End of day: the barista wipes the steam wand with a cloth or brushes the group head; cups stacked to dry.",
}

// Bags need their real packshot and the label check, which the bag-shot path
// (visual-test renderBagScene) does. The art director's scenes carry no bags:
// in the prototype, 5 of 6 bags drawn without a packshot had garbled labels.
const BAG_FOLDERS = new Set(['bag_scenes', 'coffee_bags'])
const HARD_FLAGS = new Set(['order_ticket', 'readable_customer_text', 'sharp_face', 'green_beans'])

/** Library photos the art director may use as references. */
export function referenceCandidates(index: IndexedPhoto[] = PHOTO_INDEX, exclude: ReadonlySet<string> = PHOTO_EXCLUDE): IndexedPhoto[] {
  return index.filter(p =>
    !BAG_FOLDERS.has(p.key.split('/')[0]) &&
    !exclude.has(p.key) &&
    !p.flags.some(f => HARD_FLAGS.has(f)) &&
    !p.shows.includes('green_beans'))
}

export const AD_SYSTEM = `You are Minuto's art director for Instagram. Minuto is a small specialty coffee roastery and espresso bar in Israel ("מינוטו קפה בית קלייה ספיישלטי"). For each post you invent the image and write the prompt an image model (Nano Banana Pro) will render, using 1 or 2 of Minuto's own photos as references.

What makes a great Minuto image: a real moment caught mid-work at Minuto's own bar or roastery. Candid, hand-held, a natural angle, warm natural light, soft background, film grain. A person in the middle of doing something real is better than a staged still life. The viewer should feel they are standing at Minuto's bar.

How you work:
1. Read the caption and goal. The image serves the caption.
2. Look at the recent posts and do something different from them in subject, action, angle and time of day.
3. Propose 3 genuinely different concepts in one line each. Creativity lives in the story: who, when, why (a regular's first order at 7am, roast day, a new origin arriving, end-of-day clean-down, rain on the window). Pick the strongest for this caption and say why in one sentence.
4. Choose the physical action from the action list. Follow its realism note exactly; it is how this action really looks. If no action fits, you may define a new one: set "new_action": true and write its realism note yourself.
5. Choose 1 or 2 reference photos by key from the photo index. Prefer photos without flags. Each reference gets one role sentence: what the model must copy from it (e.g. "the exact design of the espresso machine", "how the barista's hands hold the pitcher"), and nothing else.
6. Write the prompt (120-220 words) in this order: shot style; anchor (what each reference controls); action; props; setting; light; camera and texture; brand details. Describe only what should be in the picture, all positively. Do not use the words "no", "not", "never", "without" or "avoid" in the prompt.
7. Write 2-3 yes/no questions a checker can answer by looking at the image, each phrased so that "yes" means correct, about the PHYSICAL details most likely to go wrong in YOUR scene: what touches what, which hand holds what, whether liquid comes from the right place, whether equipment is whole. Leave composition, framing, angles, exact degrees and colours out of the questions; a photo that differs from your plan in those ways is still a good photo.

Brand facts (always true):
- The espresso machine is a 2-group La Marzocco Strada X: slate-grey body, curved side panels with pale-blue glass. It carries only its own maker's mark.
- Minuto's bar: stainless counter and wooden cabinets, colourful ceramic cups stacked on top of the machine, a big street window, pendant lamps, plants. Surfaces are warm wood or stainless steel. Baristas often have tattooed forearms and dark aprons.
- Roasting happens on a Coffee-Tech drum roaster with a round cooling bin. Minuto roasts weekly.
- Coffee beans shown are always roasted (light-cinnamon to medium brown). Green coffee and resold brands are never the subject, and beans are never hand-sorted.
- Minuto bags and jars are left out of these scenes; product shots are made separately from the real packaging.
- People appear as hands, forearms and torsos, or as soft out-of-focus figures in the background, faces turned away or blurred.

Reply with JSON only, exactly this shape:
{"concepts": ["...", "...", "..."], "choice": 0, "why": "...", "action": "<action key or new key>", "new_action": false, "new_action_note": "", "references": [{"key": "<photo key>", "role": "..."}], "prompt": "...", "qa": ["...", "..."]}`

export interface RecentPost { date: string; caption: string; concept?: string; action?: string }

export interface ArtDirection {
  concepts: string[]
  choice: number
  why: string
  action: string
  new_action: boolean
  new_action_note: string
  references: Array<{ key: string; role: string }>
  prompt: string
  qa: string[]
}

const ASPECT_WORDS: Record<string, string> = {
  story: '9:16 vertical story', feed_portrait: '4:5 vertical feed post', feed_square: '1:1 square feed post', reel_cover: '9:16 vertical reel cover',
}

export function adUserMessage(opts: {
  caption: string
  aspect: string
  goal?: string
  recent: RecentPost[]
  learnings: string[]
  plannerHint?: string
  photos?: IndexedPhoto[]
}): string {
  const photos = opts.photos ?? referenceCandidates()
  return [
    'ACTION LIST (key: realism note):', JSON.stringify(ACTIONS, null, 1),
    '', 'PHOTO INDEX:', JSON.stringify(photos),
    '', 'RECENT POSTS (newest first):', JSON.stringify(opts.recent.slice(0, 15)),
    '', 'OWNER LEARNINGS:', opts.learnings.length ? opts.learnings.map(l => `- ${l}`).join('\n') : '- (none yet)',
    '', 'THIS POST:',
    `format: ${ASPECT_WORDS[opts.aspect] ?? opts.aspect}`,
    `goal: ${opts.goal ?? 'Instagram post for Minuto'}`,
    ...(opts.plannerHint ? [`planner's idea (a hint only; you decide): ${opts.plannerHint}`] : []),
    `caption: ${opts.caption}`,
  ].join('\n')
}

/** The second call after the critic failed a render: keep the concept, fix the physics. */
export function adRevisionMessage(previous: ArtDirection, failed: Array<{ q: string; why: string }>, correction: string): string {
  return [
    'Your last image failed the check. Keep the same concept, action and references unless a reference caused the problem.',
    'Failed checks:', ...failed.map(f => `- ${f.q} → ${f.why}`),
    ...(correction ? [`Checker's correction: ${correction}`] : []),
    'Rewrite the prompt so the corrected scene is described positively, as it should look. Same JSON shape as before.',
    '', 'Your last answer:', JSON.stringify(previous),
  ].join('\n')
}

const NEGATION = /\b(no|not|never|without|avoid)\b/i

/** Parse and check the art director's JSON. Errors are fed back for one fix. */
export function parseArtDirection(text: string, allowedKeys: ReadonlySet<string>): { ok: true; value: ArtDirection; warnings: string[] } | { ok: false; errors: string[] } {
  let d: Record<string, unknown>
  try {
    const s = text.indexOf('{'), e = text.lastIndexOf('}')
    d = JSON.parse(text.slice(s, e + 1))
  } catch {
    return { ok: false, errors: ['the reply was not valid JSON'] }
  }
  const errors: string[] = []
  const warnings: string[] = []
  const concepts = Array.isArray(d.concepts) ? d.concepts.map(String) : []
  if (concepts.length !== 3) errors.push('concepts must hold exactly 3 one-line ideas')
  const choice = Number(d.choice)
  if (!Number.isInteger(choice) || choice < 0 || choice > 2) errors.push('choice must be 0, 1 or 2')
  const action = typeof d.action === 'string' ? d.action.trim() : ''
  const newAction = d.new_action === true
  if (!action) errors.push('action is missing')
  else if (!ACTIONS[action] && !newAction) errors.push(`action "${action}" is not in the action list; pick one or set new_action true with a realism note`)
  if (newAction && !String(d.new_action_note ?? '').trim()) errors.push('a new action needs new_action_note')
  const refs = Array.isArray(d.references) ? d.references as Array<Record<string, unknown>> : []
  if (refs.length < 1 || refs.length > 2) errors.push('references must hold 1 or 2 photos')
  const references = refs.map(r => ({ key: String(r?.key ?? ''), role: String(r?.role ?? '').trim() }))
  for (const r of references) {
    if (!allowedKeys.has(r.key)) errors.push(`reference "${r.key}" is not a key in the photo index`)
    if (!r.role) errors.push(`reference "${r.key}" needs a role sentence`)
  }
  if (new Set(references.map(r => r.key)).size !== references.length) errors.push('the two references must be different photos')
  const prompt = typeof d.prompt === 'string' ? d.prompt.trim() : ''
  const words = prompt.split(/\s+/).filter(Boolean).length
  if (words < 60) errors.push(`the prompt has ${words} words; write 120-220`)
  if (words > 320) errors.push(`the prompt has ${words} words; keep it under 220`)
  if (NEGATION.test(prompt)) warnings.push(`prompt uses a negation word ("${prompt.match(NEGATION)![0]}")`)
  const qa = Array.isArray(d.qa) ? d.qa.map(String).filter(q => q.trim()) : []
  if (qa.length < 1) errors.push('qa needs 2-3 yes/no questions')
  if (errors.length) return { ok: false, errors }
  return {
    ok: true, warnings,
    value: {
      concepts, choice, why: String(d.why ?? ''), action, new_action: newAction,
      new_action_note: String(d.new_action_note ?? ''), references, prompt, qa: qa.slice(0, 3),
    },
  }
}

// Critic v3, calibrated 2026-11-07 against the owner's verdicts on 18 test
// images: a full physics audit failed all 18 (the owner passed 13); these
// gross-defect questions caught all 5 the owner rejected. Only these block.
// The owner judges the overall photo at phone size, not zoomed-in details.
export const AD_BLOCKING_QUESTIONS = [
  'Is the image free of an obviously deformed hand (a clearly extra, missing or melted finger that a viewer would notice at phone size)?',
  'Is the image free of a sharp, recognisable face that is the main subject or in the foreground? (soft or background faces are fine)',
  'Is every object resting on a surface or held, with nothing visibly floating in the air?',
  "Does the espresso machine carry only its own maker's mark, with no painted café name or extra logo? (yes if no machine)",
  'Are all coffee beans roasted brown, none green? (yes if no beans)',
  'Does the scene look like a real photograph of a real coffee bar or roastery, with nothing physically absurd that jumps out at first glance?',
  'Is the image free of coffee bags and jars?',
]

export interface CriticQuestions { blocking: string[]; notes: string[] }

/** Blocking questions decide pass/fail; the action's realism note and the art
 *  director's own questions are recorded as notes for the owner. */
export function criticQuestions(ad: ArtDirection): CriticQuestions {
  const note = ACTIONS[ad.action] ?? ad.new_action_note
  return { blocking: AD_BLOCKING_QUESTIONS, notes: [`Does the scene match how this action really looks: ${note}`, ...ad.qa] }
}

export const AD_CRITIC_SYSTEM = `You are checking an Instagram story or feed image for Minuto, a specialty coffee roastery, the way its owner does: on a phone, at normal viewing size, before posting.
Answer every numbered question "yes" or "no". Answer "no" only for a defect a viewer would actually notice at phone size without zooming: an extra or missing finger that is plainly visible, liquid coming from the wrong place, an object floating, a clearly recognisable face in focus, prominent garbled text that draws the eye, a machine part that is obviously broken or duplicated. Small details that only show when zoomed in (a slightly soft knuckle, tiny unreadable print on a tray, a cup angle a few degrees off) count as "yes". When a question's subject is not in the image, answer "yes".
Reply with JSON only: {"description": "one sentence on what the image shows", "answers": [{"n": 1, "answer": "yes" | "no", "why": "short"}], "correction": "if anything failed, one sentence describing the corrected scene positively; else empty"}`

export function criticUserMessage(questions: string[]): string {
  return `Questions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
}

export interface CriticVerdict {
  passes: boolean
  description: string
  failed: Array<{ q: string; why: string }>      // blocking questions not answered "yes"
  notes: Array<{ q: string; why: string }>       // note questions not answered "yes"
  correction: string
}

/** Anything but an explicit "yes" to every BLOCKING question fails; the first
 *  blockingCount questions block, the rest are notes. */
export function parseCritic(text: string, questions: string[], blockingCount = questions.length): CriticVerdict {
  let d: Record<string, unknown> = {}
  try {
    const s = text.indexOf('{'), e = text.lastIndexOf('}')
    d = JSON.parse(text.slice(s, e + 1))
  } catch { /* falls through as unanswered */ }
  const answers = Array.isArray(d.answers) ? d.answers as Array<Record<string, unknown>> : []
  const misses = questions
    .map((q, i) => ({ q, i, a: answers.find(x => Number(x?.n) === i + 1) }))
    .filter(({ a }) => String(a?.answer ?? '').toLowerCase() !== 'yes')
    .map(({ q, i, a }) => ({ q, i, why: a ? String(a.why ?? '') : 'not answered' }))
  const failed = misses.filter(m => m.i < blockingCount).map(({ q, why }) => ({ q, why }))
  const notes = misses.filter(m => m.i >= blockingCount).map(({ q, why }) => ({ q, why }))
  return {
    passes: failed.length === 0,
    description: typeof d.description === 'string' ? d.description : '',
    failed,
    notes,
    correction: typeof d.correction === 'string' ? d.correction : '',
  }
}
