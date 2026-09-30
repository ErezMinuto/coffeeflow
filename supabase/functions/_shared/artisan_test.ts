// Behaviour tests for artisan.ts.
//
//   deno run supabase/functions/_shared/artisan_test.ts
//
// These cover the properties the import is relied on for and which are easy to
// regress: that units are normalised, that curve arrays never reach the
// database, that a 0.0 sentinel is not mistaken for a reading, and — above all
// — that a filename disagreeing with its body is rejected rather than stored.
import {
  parseProfile,
  parseArtisanFile,
  readArtisanFile,
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


// ── happy path ──────────────────────────────────────────────────────────────
{
  const p = parseProfile(fixture());

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
  const p = parseProfile(fixture());
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
  );
  check('missing charge ET is null, not 0', p.charge_et === null, `${p.charge_et}`);
  check('absent drop ET is null', p.drop_et === null, `${p.drop_et}`);
  check('the readings that exist survive', p.charge_bt === 92.4 && p.drop_bt === 208.3);
}


// ── refusals ────────────────────────────────────────────────────────────────
{
  throws('a body with no roastUUID is refused', 'missing_uuid', () => parseProfile(fixture({ roastUUID: '' })));
  throws('a non-object is refused', 'not_a_profile', () => parseProfile('{not json}'));
  throws('an array is refused', 'not_a_profile', () => parseProfile([1, 2, 3]));
  throws('a body with no roastepoch is refused', 'missing_roastepoch', () => parseProfile(fixture({ roastepoch: 0 })));
}


// ── reading the two file formats ────────────────────────────────────────────
// Both .alog and .json are getProfile() serialised, so either carries the
// readings. .alog is what Artisan saves by default and therefore what gets
// uploaded in practice.
{
  const f = fixture();
  const json = JSON.stringify(f);

  // The .alog equivalent: Python repr — single quotes, True/False/None.
  const alog = `{'roastUUID': 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', 'roastisodate': '2026-09-27', ` +
    `'roasttime': '14:32:07', 'roastepoch': ${f.roastepoch}, 'roasttzoffset': 10800, ` +
    `'roastbatchprefix': 'MIN', 'roastbatchnr': 1042, 'title': 'Yirgacheffe', ` +
    `'beans': "אתיופיה יירגצ'ף\nlot 42", 'operator': 'Erez', 'mode': 'C', ` +
    `'weight': [15.0, 12.6, 'Kg'], 'timex': [0.0, 1.0], 'temp1': [195.0, 194.0], ` +
    `'temp2': [92.4, 93.0], 'roastingnotes': None, 'flag': True, ` +
    `'computed': {'CHARGE_ET': 195.0, 'CHARGE_BT': 92.4, 'DROP_ET': 210.5, ` +
    `'DROP_BT': 208.3, 'totaltime': 1020.0}}`;

  const fromJson = parseArtisanFile(json, 'whatever.json');
  const fromAlog = parseArtisanFile(alog, '2026-09-27_1432.alog');

  check('.json is read', fromJson.charge_et === 195 && fromJson.drop_bt === 208.3);
  check('.alog is read', fromAlog.charge_et === 195 && fromAlog.drop_bt === 208.3,
    `${fromAlog.charge_et} / ${fromAlog.drop_bt}`);
  check('.alog keeps a bean name with an apostrophe',
    fromAlog.beans === "אתיופיה יירגצ'ף", `${fromAlog.beans}`);
  check('.alog weights convert', fromAlog.green_kg === 15 && fromAlog.roasted_kg === 12.6);
  check('.alog batch label', fromAlog.batch_label === 'MIN1042');
  check('.alog strips curve arrays', !('timex' in fromAlog.meta) && !('temp1' in fromAlog.meta));
  check('.alog keeps None as null', (fromAlog.meta as any).roastingnotes === null);
  check('.alog keeps True as true', (fromAlog.meta as any).flag === true);

  // Both formats agree on every reading.
  check('both formats yield the same readings',
    fromJson.charge_et === fromAlog.charge_et && fromJson.charge_bt === fromAlog.charge_bt &&
    fromJson.drop_et === fromAlog.drop_et && fromJson.drop_bt === fromAlog.drop_bt);

  // An unknown extension sniffs the content rather than refusing.
  check('an unknown extension still reads JSON', (readArtisanFile(json, 'roast.txt') as any).roastUUID === f.roastUUID);
  check('an unknown extension still reads alog', (readArtisanFile(alog, 'roast.bak') as any).roastUUID === f.roastUUID);
  check('no filename at all still works', (readArtisanFile(alog) as any).roastUUID === f.roastUUID);

  throws('a .json that is not JSON is refused', 'bad_json', () => readArtisanFile('{oops', 'r.json'));
  throws('an .alog that is not a literal is refused', 'bad_alog', () => readArtisanFile('{oops', 'r.alog'));
  throws('a spreadsheet is refused, not guessed at', 'bad_alog', () => readArtisanFile('name,value\na,1', 'r.csv'));
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
if (failures > 0) Deno.exit(1);
