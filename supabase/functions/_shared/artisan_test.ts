// Behaviour tests for artisan.ts.
//
//   deno run supabase/functions/_shared/artisan_test.ts
//
// These cover the properties the import is relied on for and which are easy to
// regress: that units are normalised, that curve arrays never reach the
// database, that a 0.0 sentinel is not mistaken for a reading, and — above all
// — that a filename disagreeing with its body is rejected rather than stored.
import {
  parseFilename,
  parseProfile,
  normaliseBeanName,
  toKg,
  ArtisanParseError,
} from './artisan.ts';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}
function throws(name: string, code: string, fn: () => unknown) {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (e) {
    const got = e instanceof ArtisanParseError ? e.code : `${e}`;
    check(name, got === code, `expected code "${code}", got "${got}"`);
  }
}

// A profile in the shape Artisan's exportJSON() writes: getProfile() verbatim,
// including the `computed` block from computedProfileInformation().
function fixture(over: Record<string, unknown> = {}) {
  return {
    roastUUID: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    roastisodate: '2026-09-27',
    roastdate: 'Sun Sep 27 2026',
    roasttime: '14:32:07',
    roastepoch: 1790778727,
    roasttzoffset: 10800,
    roastbatchprefix: 'MIN',
    roastbatchnr: 1042,
    roastbatchpos: 3,
    title: 'Yirgacheffe',
    beans: 'Yirgacheffe\nlot 42, washed',
    operator: 'Erez',
    mode: 'C',
    weight: [15, 12.6, 'Kg'],
    timeindex: [120, 0, 0, 0, 780, 0, 1020, 0],
    timex: [0, 1, 2, 3, 4],
    temp1: [190, 191, 192, 193, 194],
    temp2: [90, 95, 100, 105, 110],
    extratimex: [[0, 1, 2]],
    computed: {
      CHARGE_ET: 195.0,
      CHARGE_BT: 92.4,
      DROP_ET: 210.5,
      DROP_BT: 208.3,
      FCs_time: 780,
      DROP_time: 1020,
      totaltime: 1020,
      weight_loss: 16.0,
    },
    ...over,
  };
}

// ── filename grammar ────────────────────────────────────────────────────────
{
  const p = parseFilename('CF_2026-09-27_1432_Yirgacheffe.json');
  check('filename parses', p?.date === '2026-09-27' && p?.hhmm === '1432' && p?.beans === 'Yirgacheffe',
    JSON.stringify(p));

  check('full path is reduced to its basename',
    parseFilename('/Users/roast/out/CF_2026-09-27_1432_Yirgacheffe.json')?.beans === 'Yirgacheffe');

  check('windows path is reduced to its basename',
    parseFilename('C:\\Artisan\\out\\CF_2026-09-27_1432_Yirgacheffe.json')?.beans === 'Yirgacheffe');

  check('bean name may contain spaces',
    parseFilename('CF_2026-09-27_1432_Ethiopia Guji natural.json')?.beans === 'Ethiopia Guji natural');

  check('bean name may be Hebrew',
    parseFilename("CF_2026-09-27_1432_אתיופיה יירגצ'ף.json")?.beans === "אתיופיה יירגצ'ף");

  check('forgotten bean name still parses',
    parseFilename('CF_2026-09-27_1432_.json')?.beans === '');

  check('a file without the CF_ sentinel is ignored',
    parseFilename('2026-09-27_1432_Yirgacheffe.json') === null);

  check('an .alog is not a JSON profile',
    parseFilename('CF_2026-09-27_1432_Yirgacheffe.alog') === null);
}

// ── happy path ──────────────────────────────────────────────────────────────
{
  const p = parseProfile(fixture(), 'CF_2026-09-27_1432_Yirgacheffe.json');

  check('uuid carried through', p.artisan_uuid === 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  check('roasted_at is the absolute charge instant',
    p.roasted_at === new Date(1790778727 * 1000).toISOString(), p.roasted_at);
  check('beans is the first line only', p.beans === 'Yirgacheffe', `${p.beans}`);
  check('batch label is prefix+nr', p.batch_label === 'MIN1042', `${p.batch_label}`);
  check('operator carried through', p.operator === 'Erez');
  check('green weight in kg', p.green_kg === 15, `${p.green_kg}`);
  check('roasted weight in kg', p.roasted_kg === 12.6, `${p.roasted_kg}`);

  check('charge ET — טמפ׳ הטענה', p.charge_et === 195.0, `${p.charge_et}`);
  check('charge BT', p.charge_bt === 92.4, `${p.charge_bt}`);
  check('drop ET', p.drop_et === 210.5, `${p.drop_et}`);
  check('drop BT — טמפ׳ סיום', p.drop_bt === 208.3, `${p.drop_bt}`);
  check('total time', p.total_time_sec === 1020, `${p.total_time_sec}`);

  check('computed block kept whole', (p.computed as any)?.weight_loss === 16.0);
}

// ── curve arrays must never reach the database ──────────────────────────────
{
  const p = parseProfile(fixture(), 'CF_2026-09-27_1432_Yirgacheffe.json');
  const stripped = ['timex', 'temp1', 'temp2', 'extratimex', 'computed'];
  for (const k of stripped) {
    check(`meta drops ${k}`, !(k in p.meta));
  }
  check('meta keeps timeindex', Array.isArray((p.meta as any).timeindex));
  check('meta keeps the roast identity', (p.meta as any).roastbatchprefix === 'MIN');
}

// ── unit normalisation ──────────────────────────────────────────────────────
{
  const f = parseProfile(
    fixture({
      mode: 'F',
      computed: { CHARGE_ET: 383, CHARGE_BT: 198.32, DROP_ET: 410.9, DROP_BT: 406.94, totaltime: 1020 },
    }),
    'CF_2026-09-27_1432_Yirgacheffe.json',
  );
  check('°F charge ET converted to °C', f.charge_et === 195, `${f.charge_et}`);
  check('°F drop BT converted to °C', f.drop_bt === 208.3, `${f.drop_bt}`);

  check('grams → kg', toKg(15000, 'g') === 15);
  check('kg → kg', toKg(15, 'Kg') === 15);
  check('lb → kg', Math.abs((toKg(33.069, 'lb') ?? 0) - 15) < 0.001, `${toKg(33.069, 'lb')}`);
  check('oz → kg', Math.abs((toKg(529.1, 'oz') ?? 0) - 15) < 0.001, `${toKg(529.1, 'oz')}`);
  throws('an unknown weight unit is refused, not guessed', 'bad_weight_unit', () => toKg(15, 'stone'));
}

// ── a 0.0 sentinel is not a reading ─────────────────────────────────────────
{
  const p = parseProfile(
    fixture({ computed: { CHARGE_ET: 0.0, CHARGE_BT: 92.4, DROP_BT: 208.3, totaltime: 1020 } }),
    'CF_2026-09-27_1432_Yirgacheffe.json',
  );
  check('missing charge ET is null, not 0', p.charge_et === null, `${p.charge_et}`);
  check('absent drop ET is null', p.drop_et === null, `${p.drop_et}`);
  check('the readings that exist survive', p.charge_bt === 92.4 && p.drop_bt === 208.3);
}

// ── the filename must agree with the body ───────────────────────────────────
{
  throws('a filename dated differently is rejected', 'filename_mismatch',
    () => parseProfile(fixture(), 'CF_2026-09-26_1432_Yirgacheffe.json'));

  throws('a filename timed differently is rejected', 'filename_mismatch',
    () => parseProfile(fixture(), 'CF_2026-09-27_0900_Yirgacheffe.json'));

  throws('a filename naming another bean is rejected', 'filename_mismatch',
    () => parseProfile(fixture(), 'CF_2026-09-27_1432_Sidamo.json'));

  // Artisan strips < > : " / \ | ? * from filenames, so the two legitimately
  // differ here and the check must compare like with like.
  const p = parseProfile(
    fixture({ beans: 'Ethiopia/Yirgacheffe' }),
    'CF_2026-09-27_1432_EthiopiaYirgacheffe.json',
  );
  check('a name the filesystem sanitised still matches', p.beans === 'Ethiopia/Yirgacheffe');

  // A hand-exported file that does not follow the protocol is still importable.
  const manual = parseProfile(fixture(), 'my-roast-export.json');
  check('a non-protocol filename skips the cross-check', manual.beans === 'Yirgacheffe');
}

// ── refusals ────────────────────────────────────────────────────────────────
{
  throws('a body with no roastUUID is refused', 'missing_uuid', () => parseProfile(fixture({ roastUUID: '' })));
  throws('a non-object is refused', 'not_a_profile', () => parseProfile('{not json}'));
  throws('an array is refused', 'not_a_profile', () => parseProfile([1, 2, 3]));
  throws('a body with no roastepoch is refused', 'missing_roastepoch', () => parseProfile(fixture({ roastepoch: 0 })));
}

// ── bean-name normalisation (both sides of every match) ─────────────────────
{
  check('case is ignored', normaliseBeanName('Yirgacheffe') === normaliseBeanName('YIRGACHEFFE'));
  check('surrounding space is ignored', normaliseBeanName('  Yirgacheffe ') === 'yirgacheffe');
  check('inner space is collapsed', normaliseBeanName('Ethiopia   Guji') === 'ethiopia guji');
  check('empty and null agree', normaliseBeanName(null) === '' && normaliseBeanName('') === '');
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
if (failures > 0) Deno.exit(1);
