// ============================================================================
// The negative-directive tail for a no_bag render's last QA attempt.
// ============================================================================
//
// Gemini has a strong "coffee scene → bag of beans in frame" prior, so a no_bag
// render ends with explicit DO-NOT directives (the tail of a prompt weighs most).
//
// THE BUG THIS REPLACES (2026-10, caught by health-watchdog's visual QA
// sentinel): the tail was a fixed string that ALSO said
//   "No human hands or arms in frame", "No loose coffee beans",
//   "The image must show ONLY the espresso machine and the pull, nothing else."
// for every no_bag brief. A pour-over, AeroPress or latte-pour brief was told to
// show an espresso machine it never asked for, and a "barista's hands pouring"
// brief was told no hands. QA then failed the render against its own prompt —
// all three attempts, every time. Real critiques:
//   "The brief states 'pour-over dripper (not visible, implied by the stream)'…
//    'must show ONLY the espresso machine'…"
//   "The brief explicitly forbids human hands… but the image shows a glass mug,
//    not a barista's hands pouring"
//
// The rule now: only the bag ban is what no_bag MEANS, so only it is
// unconditional. Hands and beans are forbidden only when the brief doesn't ask
// for them, and the subject line restates the brief instead of naming one.
//
// Pure, so it is tested without booting the worker: no_bag_tail_test.ts.

// "pouring" alone is not here: a kettle pour needs no hands.
const WANTS_HANDS = /\b(hands?|fingers?|arms?|barista'?s?|holding|held|tamping|tamps?|stirring)\b/i
const WANTS_BEANS = /\b(beans?|grounds?|roasted coffee|whole coffee)\b/i

export function noBagTail(brief: string): string {
  const directives = [
    'No coffee bag, no packaging, no pouch, no sachet, no bean container of any kind',
    'No coffee-product branding text anywhere',
  ]
  if (!WANTS_BEANS.test(brief)) directives.splice(1, 0, 'No loose coffee beans scattered on the surface')
  if (!WANTS_HANDS.test(brief)) directives.push('No human hands or arms in frame')

  return `DO NOT INCLUDE ANY OF THESE — they are forbidden in this render:
${directives.map(d => `- ${d}`).join('\n')}
Show only the subjects the brief above describes — add nothing it does not ask for.`
}
