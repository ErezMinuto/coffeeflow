// Threshold tests for artisan_coverage.ts.
//
//   deno run supabase/functions/health-watchdog/artisan_coverage_test.ts
//
// A watchdog that cries wolf gets muted, and a muted watchdog is the same as
// no watchdog. These pin both directions: that a real blackout is caught, and
// that an ordinary quiet week says nothing at all.
import { artisanCoverageFindings } from './artisan_coverage.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}

const roasts = (total: number, covered: number) =>
  Array.from({ length: total }, (_, i) => ({ artisan_uuid: i < covered ? `uuid-${i}` : null }));

const run = (total: number, covered: number, orphans: Array<{ beans?: string | null }> = []) =>
  artisanCoverageFindings({
    recentRoasts: roasts(total, covered),
    orphans,
    windowHours: 96,
    staleAfterDays: 7,
  });

const has = (f: ReturnType<typeof run>, sev: 'WARN' | 'ERROR', needle: string) =>
  f.some(x => x.severity === sev && x.message.includes(needle));

// ── silence when there is nothing to say ────────────────────────────────────
{
  check('a week with no roasts is silent', run(0, 0).length === 0);
  check('everything covered is silent', run(8, 8).length === 0);

  // The failure mode that matters most: the watchdog must not fire just
  // because the roastery had a quiet stretch.
  check('1 uncovered roast is not enough signal', run(1, 0).length === 0);
  check('2 uncovered roasts are not enough signal', run(2, 0).length === 0);
}

// ── total blackout — the watcher is down ────────────────────────────────────
{
  const f = run(3, 0);
  check('3 roasts, none covered → ERROR', has(f, 'ERROR', 'NOT ONE'), JSON.stringify(f));
  check('the blackout alert names the watcher', has(f, 'ERROR', 'watcher on the roastery computer'));
  check('the blackout alert points at the guide', has(f, 'ERROR', 'docs/artisan.md'));
  check('it reports the real count', f[0].context.roasts === 3 && f[0].context.with_artisan === 0);

  check('a large blackout still fires once', run(20, 0).filter(x => x.severity === 'ERROR').length === 1);
}

// ── partial coverage — arriving but not matching ────────────────────────────
{
  // One match proves the watcher is alive, so this must NOT be the ERROR.
  const f = run(10, 2);
  check('2 of 10 covered → WARN, not ERROR',
    has(f, 'WARN', 'covered only 2/10') && !f.some(x => x.severity === 'ERROR'), JSON.stringify(f));
  check('the partial alert blames the bean name', has(f, 'WARN', 'bean name'));
  check('the partial alert gives the fix', has(f, 'WARN', 'זכור את השם הזה'));

  check('exactly half covered is not flagged', run(10, 5).length === 0);
  check('above half is not flagged', run(10, 6).length === 0);

  // Below the ratio floor we stay quiet — 1 of 4 is too thin to conclude from.
  check('4 roasts with 1 covered is below the ratio floor', run(4, 1).length === 0);
  check('5 roasts with 1 covered does warn', has(run(5, 1), 'WARN', 'covered only 1/5'));
}

// ── orphaned profiles ───────────────────────────────────────────────────────
{
  const f = run(8, 8, [{ beans: 'Yirgacheffe' }, { beans: 'Yirgacheffe' }, { beans: 'Sidamo' }]);
  check('unattached profiles warn even when coverage is fine',
    has(f, 'WARN', '3 Artisan profile(s) older than 7 days'), JSON.stringify(f));
  check('bean names are de-duplicated in the message', has(f, 'WARN', 'Yirgacheffe, Sidamo'));
  check('the count is reported', f[0].context.unattached === 3);

  const many = run(8, 8, Array.from({ length: 12 }, (_, i) => ({ beans: `bean-${i}` })));
  check('at most 5 bean names are listed', (many[0].context.beans as string[]).length === 5);

  const nameless = run(8, 8, [{ beans: null }, { beans: '' }]);
  check('nameless orphans still warn', has(nameless, 'WARN', '2 Artisan profile(s)'));
  check('nameless orphans omit the bean list', !nameless[0].message.includes('(beans:'));
}

// ── the two checks are independent ──────────────────────────────────────────
{
  const f = run(4, 0, [{ beans: 'Sidamo' }]);
  check('a blackout and orphans both report', f.length === 2, JSON.stringify(f.map(x => x.severity)));
  check('every finding is categorised for the email',
    f.every(x => x.category === 'artisan_coverage'));
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
if (failures > 0) Deno.exit(1);
