// Tests for no_bag_tail.ts — the no_bag render's attempt-3 forbid list.
//
//   deno run supabase/functions/seo-worker-visual/no_bag_tail_test.ts
//
// Pins the bug it fixes: a fixed tail that forced an espresso machine into
// every brief and forbade the hands/beans a brief had asked for.
import { noBagTail } from './no_bag_tail.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}

const pourOver = 'A thin stream of water falls from a gooseneck kettle onto fresh grounds; pour-over dripper not visible, implied by the stream. Soft morning light on brushed steel.';
const aeropress = 'An AeroPress pressing into a clear glass mug on brushed steel in morning light.';
const latte = "A barista's hands pouring steamed milk into a flat white, latte art forming.";
const espresso = 'The espresso machine pulling a shot into a small white cup, crema thick and golden.';

// ── the bug: nothing outside the brief may be forced in ─────────────────────
for (const [name, brief] of [['pour-over', pourOver], ['AeroPress', aeropress], ['latte', latte], ['espresso', espresso]]) {
  const t = noBagTail(brief);
  check(`${name}: no espresso machine is forced in`, !/espresso machine/i.test(t), t);
  check(`${name}: no hard-coded ONLY <subject>`, !/\bonly the (?!subjects the brief)/i.test(t), t);
  check(`${name}: restates the brief as the subject`, t.includes('Show only the subjects the brief above describes'));
}

// ── the bag ban is what no_bag means: always there ──────────────────────────
for (const brief of [pourOver, aeropress, latte, espresso, '']) {
  const t = noBagTail(brief);
  check(`bag + branding always forbidden (${brief.slice(0, 20) || 'empty'})`, t.includes('No coffee bag') && t.includes('No coffee-product branding'));
}

// ── hands: forbidden unless the brief asks for them ─────────────────────────
check("a barista's-hands brief does not forbid hands", !noBagTail(latte).includes('No human hands'), noBagTail(latte));
check('a hands-free brief still forbids hands', noBagTail(aeropress).includes('No human hands'));
check('a kettle pour is not a request for hands', noBagTail(pourOver).includes('No human hands'));
check('"holding a cup" keeps hands', !noBagTail('Someone holding a ceramic cup by a window.').includes('No human hands'));

// ── beans: forbidden unless the brief asks for them ─────────────────────────
check('a grounds brief does not forbid beans', !noBagTail(pourOver).includes('No loose coffee beans'));
check('a beans brief does not forbid beans', !noBagTail('Freshly roasted beans in a ceramic bowl.').includes('No loose coffee beans'));
check('a beans-free brief still forbids beans', noBagTail(aeropress).includes('No loose coffee beans'));

// ── shape: still a tail the model weights ───────────────────────────────────
const t = noBagTail(aeropress);
check('opens with the DO NOT header', t.startsWith('DO NOT INCLUDE ANY OF THESE'));
check('one bullet per directive', t.split('\n').filter(l => l.startsWith('- ')).length === 4, t);

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
if (failures > 0) Deno.exit(1);
