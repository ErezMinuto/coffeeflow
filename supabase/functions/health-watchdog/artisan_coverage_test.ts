// Threshold tests for artisan_coverage.ts.
//
//   deno run supabase/functions/health-watchdog/artisan_coverage_test.ts
//
// The Artisan file is uploaded by hand, so this is a reminder, not an alarm —
// it must never report ERROR. These pin both directions: that a run of roasts
// with no file is noticed, and that an ordinary quiet week says nothing.
import { artisanCoverageFindings } from './artisan_coverage.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}

const roasts = (total: number, covered: number) =>
  Array.from({ length: total }, (_, i) => ({ artisan_uuid: i < covered ? `uuid-${i}` : null }));

const run = (total: number, covered: number) =>
  artisanCoverageFindings({ recentRoasts: roasts(total, covered), windowHours: 96 });

const has = (f: ReturnType<typeof run>, needle: string) =>
  f.some(x => x.severity === 'WARN' && x.message.includes(needle));

// ── silence when there is nothing to say ────────────────────────────────────
{
  check('a week with no roasts is silent', run(0, 0).length === 0);
  check('everything covered is silent', run(8, 8).length === 0);

  // The failure mode that matters most: the watchdog must not fire just
  // because the roastery had a quiet stretch.
  check('1 uncovered roast is not enough signal', run(1, 0).length === 0);
  check('2 uncovered roasts are not enough signal', run(2, 0).length === 0);
}

// ── a run of roasts with no file uploaded ───────────────────────────────────
{
  const f = run(3, 0);
  check('3 roasts, none with a file → reminder', has(f, 'No Artisan file has been uploaded'), JSON.stringify(f));
  check('it says what to do', has(f, 'upload each roast'));
  check('it reports the real count', f[0].context.roasts === 3 && f[0].context.with_artisan === 0);
  check('it fires once, not per roast', run(20, 0).length === 1);

  // This is a habit, not an outage. ERROR would be wrong and would get muted.
  check('it is never an ERROR', ![run(3, 0), run(20, 0), run(10, 2)].flat().some(x => x.severity !== 'WARN'));
}

// ── partial coverage — some uploaded, some forgotten ────────────────────────
{
  const f = run(10, 2);
  check('2 of 10 covered → reminder', has(f, 'Only 2 of the last 10 roasts'), JSON.stringify(f));
  check('it names what is missing', has(f, 'charge and drop temperatures'));

  check('exactly half covered is not flagged', run(10, 5).length === 0);
  check('above half is not flagged', run(10, 6).length === 0);

  // Below the ratio floor we stay quiet — 1 of 4 is too thin to conclude from.
  check('4 roasts with 1 covered is below the ratio floor', run(4, 1).length === 0);
  check('5 roasts with 1 covered does remind', has(run(5, 1), 'Only 1 of the last 5 roasts'));
}



// ── every finding is shaped for the alert email ─────────────────────────────
{
  const f = run(4, 0);
  check('categorised for the email', f.every(x => x.category === 'artisan_coverage'));
  check('carries context for the log', f[0].context.window_hours === 96);
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
if (failures > 0) Deno.exit(1);
