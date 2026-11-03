// Threshold tests for runtime_sentinel.ts and the dedupe rule in bug_signals.ts.
//
//   deno run supabase/functions/health-watchdog/runtime_sentinel_test.ts
//
// The critique strings below are real (seo_tasks.result_data, Aug–Oct 2026),
// so the classifier is pinned to what the QA agent actually writes. Each check
// pins both directions: that a repeat is caught, and that one-offs and handled
// refusals stay out of the fixer's queue.
import {
  chatLoopFindings, classifyCritique, edgeCrashFindings, isCrash, stackLocation, visualQaFindings,
  type FailedVisualTask, type LogErrorLine, type LogRun,
} from './runtime_sentinel.ts';
import { shouldFile } from './bug_signals.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}

const NOW = Date.parse('2026-10-24T08:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();

// ── critique classifier, against real critique text ─────────────────────────
{
  const espresso = { issues: ["The brief explicitly states 'The image must show ONLY the espresso machine and the pull (cup + crema), nothing else.' The image shows only the cup with latte art, but no espresso machine."] };
  check('the hard-coded espresso override reads as a prompt contradiction', classifyCritique(espresso).includes('prompt-contradiction'), JSON.stringify(classifyCritique(espresso)));
  check('…and as missing equipment', classifyCritique(espresso).includes('missing-equipment'));

  const hands = { issues: ['The brief explicitly forbids human hands or arms in frame, but the image shows a hand stirring the coffee.'] };
  check('"explicitly forbids" → forbidden element', classifyCritique(hands).includes('forbidden-element'));

  check('"wordmark is gibberish" → garbled text', classifyCritique({ issues: ['bag wordmark/product name is gibberish'] }).includes('garbled-text'));
  check('"product name is X instead of Y" → garbled text',
    classifyCritique({ issues: ["bag product name is 'Aristo' instead of 'פולי קפה טרי ספשלטי קפה מינוטו אריסטו'"] }).includes('garbled-text'));

  const surface = { issues: ['surface is light concrete, not dark slate'] };
  check('a composition nitpick matches nothing (no pattern for taste)', classifyCritique(surface).length === 0, JSON.stringify(classifyCritique(surface)));
  check('an empty critique matches nothing', classifyCritique({ issues: [], missing: [] }).length === 0);
}

// ── visual QA spike ─────────────────────────────────────────────────────────
{
  const single = (id: string, h: number, issue: string): FailedVisualTask =>
    ({ id, updated_at: hoursAgo(h), qa_last_critique: { passes: false, missing: [], issues: [issue] } });
  const forbid = 'The brief explicitly forbids loose coffee beans, but they are present.';

  check('2 tasks on the same defect is not a spike', visualQaFindings([single('a', 1, forbid), single('b', 2, forbid)], NOW).length === 0);

  const three = visualQaFindings([single('a', 1, forbid), single('b', 2, forbid), single('c', 3, forbid)], NOW);
  check('3 tasks on the same defect in 24h → ERROR', three.length === 1 && three[0].severity === 'ERROR', JSON.stringify(three));
  check('it carries a bug signal with a stable key', three[0]?.signal?.key === 'visual-qa-forbidden-element');
  check('the signal detail has a reproduction query', !!three[0]?.signal?.detail.includes("result_data->>'review_required' = 'true'"));
  check('the signal names where to look', !!three[0]?.signal?.detail.includes('seo-worker-visual/index.ts'));

  check('tasks older than 24h do not count',
    visualQaFindings([single('a', 1, forbid), single('b', 2, forbid), single('c', 30, forbid)], NOW).length === 0);

  check('3 tasks on 3 different defects is not a spike', visualQaFindings([
    single('a', 1, forbid), single('b', 2, 'bag wordmark/product name is gibberish'), single('c', 3, 'surface is concrete, not slate'),
  ], NOW).length === 0);

  // A carousel that fails 4 slides on the same defect is ONE broken task, not four.
  const carousel: FailedVisualTask = {
    id: 'car', updated_at: hoursAgo(1),
    slide_qa: [1, 2, 3, 4].map(slide => ({ slide, passed: false, attempts: [{ critique: { issues: ['x'] } }, { critique: { issues: [forbid] } }] })),
  };
  check('one carousel with 4 failed slides is not a spike', visualQaFindings([carousel, single('b', 2, forbid)], NOW).length === 0);
  check('carousel slides count by their LAST attempt',
    visualQaFindings([carousel, single('b', 2, forbid), single('c', 3, forbid)], NOW)[0]?.context.pattern === 'forbidden-element');
  const passedSlides: FailedVisualTask = { id: 'p', updated_at: hoursAgo(1), slide_qa: [{ passed: true, attempts: [{ critique: { issues: [forbid] } }] }] };
  check('a slide that passed is ignored', visualQaFindings([passedSlides, single('b', 2, forbid), single('c', 3, forbid)], NOW).length === 0);
}

// ── chat runaway loops ──────────────────────────────────────────────────────
{
  const sys = (session: string, h: number) =>
    ({ session_id: session, role: 'system', content: '(stopped after 8 tool-use loops — please rephrase your request.)', created_at: hoursAgo(h) });
  const pnr = (session: string, h: number) =>
    ({ session_id: session, role: 'tool', content: '{"worker":"ig","result":{"ok":false,"retry":true,"reason":"parent_not_ready"}}', created_at: hoursAgo(h) });

  check('nothing → silent', chatLoopFindings([], NOW).length === 0);

  const one = chatLoopFindings([sys('s1', 2)], NOW);
  check('one runaway in 24h → WARN, no signal', one.length === 1 && one[0].severity === 'WARN' && !one[0].signal, JSON.stringify(one));

  const repeat = chatLoopFindings([sys('s1', 2), sys('s2', 100)], NOW);
  check('two runaways in 7d → ERROR + signal', repeat[0]?.severity === 'ERROR' && repeat[0]?.signal?.key === 'chat-runaway-tool-loops', JSON.stringify(repeat));
  check('…even when only one is in the last 24h', repeat[0]?.context.last_24h === 1);
  check('an old one-off (8 days) is silent', chatLoopFindings([sys('s1', 8 * 24)], NOW).length === 0);

  const timeout = chatLoopFindings([{ session_id: 's', role: 'system', content: '(I ran out of time for this turn after completing the steps above …)', created_at: hoursAgo(1) }], NOW);
  check('out-of-time → WARN only', timeout.length === 1 && timeout[0].severity === 'WARN' && !timeout[0].signal);

  check('2 parent_not_ready in a session is the dependency system working', chatLoopFindings([pnr('s', 1), pnr('s', 1)], NOW).length === 0);
  const loop = chatLoopFindings([pnr('s', 1), pnr('s', 1), pnr('s', 2)], NOW);
  check('3 in one session → ERROR + signal', loop[0]?.severity === 'ERROR' && loop[0]?.signal?.key === 'chat-parent-not-ready-loop', JSON.stringify(loop));
  check('3 spread over 3 sessions is not a loop', chatLoopFindings([pnr('a', 1), pnr('b', 1), pnr('c', 1)], NOW).length === 0);
  check('a USER message quoting parent_not_ready does not count',
    chatLoopFindings([1, 2, 3].map(h => ({ ...pnr('s', h), role: 'user' })), NOW).length === 0);
}

// ── edge crashes ────────────────────────────────────────────────────────────
{
  const run = (id: string, fn: string, status: string, h = 1, duration_ms: number | null = 500): LogRun =>
    ({ run_id: id, fn, started_at: hoursAgo(h), duration_ms, status });
  // What a real refusal looks like (supplier-invoices, 2026-10-23).
  const refusal = (id: string, code = 'duplicate_file'): LogErrorLine =>
    ({ run_id: id, event: 'run.finish', message: 'run error in 362ms', data: { code }, error_name: null, error_stack: null, run_status: 'error' });
  const thrown = (id: string): LogErrorLine[] => [
    { run_id: id, event: 'sync.fail', message: 'Cannot read properties of undefined', data: null, error_name: 'TypeError',
      error_stack: 'TypeError: x\n    at handler (file:///tmp/functions/meta-sync/index.ts:212:15)', run_status: null },
    { run_id: id, event: 'run.finish', message: 'run error in 9s', data: null, error_name: null, error_stack: null, run_status: 'error' },
  ];

  check('a handled refusal (code set) is not a crash', !isCrash([refusal('r')]));
  check('a thrown error is a crash', isCrash(thrown('r')));
  check('an error with no code is a crash', isCrash([{ ...refusal('r'), data: null }]));
  check('stack → repo path + line', stackLocation(thrown('r')[0].error_stack) === 'supabase/functions/meta-sync/index.ts:212');

  const refusals = edgeCrashFindings(
    [run('1', 'supplier-invoices', 'error'), run('2', 'supplier-invoices', 'error'), run('3', 'artisan-import', 'error')],
    [refusal('1'), refusal('2'), refusal('3', 'unauthorised')], NOW);
  check('9 handled refusals file nothing (they are the API working)', refusals.length === 0, JSON.stringify(refusals));

  const oneCrash = edgeCrashFindings([run('1', 'meta-sync', 'error')], thrown('1'), NOW);
  check('one crash → ERROR, no signal', oneCrash.length === 1 && oneCrash[0].severity === 'ERROR' && !oneCrash[0].signal);

  const twoCrashes = edgeCrashFindings([run('1', 'meta-sync', 'error'), run('2', 'meta-sync', 'error')], [...thrown('1'), ...thrown('2')], NOW);
  check('two crashes in one fn → signal', twoCrashes[0]?.signal?.key === 'edge-crash-meta-sync', JSON.stringify(twoCrashes));
  check('…pointing at the file:line from the stack', !!twoCrashes[0]?.signal?.detail.includes('meta-sync/index.ts:212'));
  check('…with a logs.sh reproduction', !!twoCrashes[0]?.signal?.detail.includes('./scripts/logs.sh run 1'));

  check('crashes in two different fns do not add up', edgeCrashFindings(
    [run('1', 'meta-sync', 'error'), run('2', 'google-sync', 'error')], [...thrown('1'), ...thrown('2')], NOW).every(f => !f.signal));

  check('an incomplete run still inside the grace window is in flight, not killed',
    edgeCrashFindings([run('1', 'google-sync', 'incomplete', 0.1)], [], NOW).length === 0);
  const killed = edgeCrashFindings([run('1', 'google-sync', 'incomplete', 2, null), run('2', 'google-sync', 'incomplete', 3, null)], [], NOW);
  check('two killed runs → ERROR + signal', killed[0]?.severity === 'ERROR' && !!killed[0]?.signal && killed[0].message.includes('killed mid-flight'), JSON.stringify(killed));

  check('a crash older than 24h is ignored', edgeCrashFindings([run('1', 'meta-sync', 'error', 30)], thrown('1'), NOW).length === 0);

  const slow = edgeCrashFindings([run('1', 'meta-sync', 'success', 1, 132_923)], [], NOW);
  check('a 133s success → timeout-risk WARN, no signal', slow.length === 1 && slow[0].category === 'edge_timeout_risk' && slow[0].severity === 'WARN' && !slow[0].signal, JSON.stringify(slow));
  check('a 120s success is fine', edgeCrashFindings([run('1', 'google-sync', 'success', 1, 120_277)], [], NOW).length === 0);
}

// ── signal dedupe ───────────────────────────────────────────────────────────
{
  const prior = (status: string, daysAgo: number) =>
    ({ id: 'x', status, created_at: new Date(NOW - daysAgo * 86_400_000).toISOString(), updated_at: new Date(NOW - daysAgo * 86_400_000).toISOString() });
  check('no prior → file', shouldFile(null, NOW).file);
  for (const s of ['open', 'approved', 'building', 'needs_human']) check(`prior ${s} → skip, even if old`, !shouldFile(prior(s, 60), NOW).file);
  check('shipped 2d ago → skip (manual deploy may not have landed)', !shouldFile(prior('shipped', 2), NOW).file);
  const regression = shouldFile(prior('shipped', 10), NOW);
  check('shipped 10d ago and back → file as a regression', regression.file && regression.reason.startsWith('regression'));
  check('declined 5d ago → skip (a decline is an answer)', !shouldFile(prior('declined', 5), NOW).file);
  check('declined 20d ago → may re-raise', shouldFile(prior('declined', 20), NOW).file);
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
if (failures > 0) Deno.exit(1);
