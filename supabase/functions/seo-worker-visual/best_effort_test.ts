// Tests for best_effort.ts — which failed attempt gets attached to the draft.
//
//   deno run supabase/functions/seo-worker-visual/best_effort_test.ts
import { BEST_EFFORT_POST_STATUSES, pickBestEffortAttempt } from './best_effort.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}

const att = (n: number, missing: number, issues: number, url = `https://x/${n}.png`) => ({
  attempt: n,
  image_url: url,
  critique: { missing: Array(missing).fill('m'), issues: Array(issues).fill('i') },
});

check('empty list → null', pickBestEffortAttempt([]) === null);

check('fewest issues wins',
  pickBestEffortAttempt([att(1, 0, 4), att(2, 0, 1), att(3, 0, 2)])?.attempt === 2);

check('a missing subject outranks many issues',
  pickBestEffortAttempt([att(1, 1, 0), att(2, 0, 5)])?.attempt === 2);

check('tie goes to the later attempt',
  pickBestEffortAttempt([att(1, 0, 2), att(2, 0, 2), att(3, 0, 3)])?.attempt === 2);

check('attempt without an image is skipped',
  pickBestEffortAttempt([att(1, 0, 0, ''), att(2, 0, 3)])?.attempt === 2);

// Post 82937, 2026-10-25, with the stored critiques' counts: four attempts tie
// at two issues, and the latest of them, 07fcf2e1 a3 (fine print only), wins.
// The attempts that lost the delivery box never come close.
const chain = pickBestEffortAttempt([
  { ...att(1, 3, 3), task: '5cb788e9' }, { ...att(2, 0, 2), task: '5cb788e9' }, { ...att(3, 2, 0), task: '5cb788e9' },
  { ...att(1, 0, 2), task: 'd68a3554' }, { ...att(2, 0, 7), task: 'd68a3554' }, { ...att(3, 0, 4), task: 'd68a3554' },
  { ...att(1, 0, 2), task: '07fcf2e1' }, { ...att(2, 0, 4), task: '07fcf2e1' }, { ...att(3, 0, 2), task: '07fcf2e1' },
]);
check('82937 chain picks 07fcf2e1 a3', chain?.task === '07fcf2e1' && chain?.attempt === 3, JSON.stringify(chain));

check('a packaging violation is never picked, even with the fewest issues',
  pickBestEffortAttempt([
    { ...att(1, 0, 0), critique: { missing: [], issues: [], packaging_violation: true } },
    att(2, 0, 4),
  ])?.attempt === 2);

check('only packaging violations → null',
  pickBestEffortAttempt([{ ...att(1, 0, 1), critique: { missing: [], issues: ['open bag'], packaging_violation: true } }]) === null);

check('draft and pending are attachable', BEST_EFFORT_POST_STATUSES.has('draft') && BEST_EFFORT_POST_STATUSES.has('pending'));
check('publish / future / private are not',
  !['publish', 'future', 'private'].some(s => BEST_EFFORT_POST_STATUSES.has(s)));

if (failures) { console.error(`${failures} failure(s)`); Deno.exit(1); }
console.log('all passed');
