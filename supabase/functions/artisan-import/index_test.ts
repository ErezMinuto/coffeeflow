// Integration tests for artisan-import, run against a fake PostgREST that
// records what would have been written.
//
//   deno run --allow-net --allow-env supabase/functions/artisan-import/index_test.ts
//
// The parser has its own unit tests (_shared/artisan_test.ts). What is covered
// here is the part that decides what happens to real inventory rows: whether a
// profile attaches to a roast, stages, or is refused — and that it never
// attaches to the wrong one.

const PORT_DB = 8791;
const PORT_FN = 8000;   // std@0.168.0 serve() default

Deno.env.set('SUPABASE_URL', `http://localhost:${PORT_DB}`);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');
Deno.env.set('ARTISAN_INGEST_KEY', 'test-ingest-key');
Deno.env.set('LOG_TO_DB', 'false');

// ── the fake database ───────────────────────────────────────────────────────

interface Roast {
  id: number; date: string; origin_id: number | null; roast_profile_id: number | null;
  artisan_uuid: string | null; batch_number: string;
  charge_et?: number | null; drop_bt?: number | null;
}

let roasts: Roast[] = [];
let origins: { id: number; name: string; artisan_name: string | null }[] = [];
let roastProfiles: { id: number; name: string; artisan_name: string | null }[] = [];
let profiles: Record<string, any> = {};   // artisan_uuid -> row
let nextProfileId = 1;
const patches: { table: string; query: string; body: any }[] = [];

function reset() {
  roasts = [];
  origins = [{ id: 7, name: 'Yirgacheffe', artisan_name: null }];
  roastProfiles = [{ id: 3, name: 'House Blend', artisan_name: null }];
  profiles = {};
  nextProfileId = 1;
  patches.length = 0;
}

/** Just enough PostgREST: eq./is./gte./lte. filters on the columns this function uses. */
function applyFilters<T extends Record<string, any>>(rows: T[], params: URLSearchParams): T[] {
  return rows.filter(row =>
    [...params.entries()].every(([col, expr]) => {
      if (col === 'select' || col === 'on_conflict' || col === 'order') return true;
      const [op, ...rest] = expr.split('.');
      const val = rest.join('.');
      switch (op) {
        case 'eq':  return String(row[col]) === val;
        case 'is':  return val === 'null' ? row[col] === null || row[col] === undefined : true;
        case 'gte': return new Date(row[col]).getTime() >= new Date(val).getTime();
        case 'lte': return new Date(row[col]).getTime() <= new Date(val).getTime();
        default:    return true;
      }
    })
  );
}

const db = Deno.serve({ port: PORT_DB, onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  const table = url.pathname.replace('/rest/v1/', '');
  const params = url.searchParams;
  // PostgREST returns a bare object, not an array, when the client asks for one
  // via .single() — which sends Accept: application/vnd.pgrst.object+json.
  const wantsObject = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object+json');
  const json = (b: unknown, status = 200) => {
    const payload = wantsObject && Array.isArray(b) ? (b[0] ?? null) : b;
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };

  if (req.method === 'GET') {
    if (table === 'origins')        return json(origins);
    if (table === 'roast_profiles') return json(roastProfiles);
    if (table === 'roasts')         return json(applyFilters(roasts, params));
    return json([]);
  }

  if (req.method === 'POST' && table === 'artisan_profiles') {
    // upsert on artisan_uuid
    const rows = await req.json();
    const incoming = Array.isArray(rows) ? rows[0] : rows;
    const existing = profiles[incoming.artisan_uuid];
    const row = existing
      ? { ...existing, ...incoming }
      : { ...incoming, id: nextProfileId++, roast_id: null };
    profiles[incoming.artisan_uuid] = row;
    return json([row], 201);
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    patches.push({ table, query: params.toString(), body });

    if (table === 'roasts') {
      const hit = applyFilters(roasts, params);
      for (const r of hit) Object.assign(r, body);
      return json(hit.map(r => ({ id: r.id })));
    }
    if (table === 'artisan_profiles') {
      const id = Number(params.get('id')?.split('.')[1]);
      const row = Object.values(profiles).find((p: any) => p.id === id);
      if (row) Object.assign(row, body);
      return json(row ? [row] : []);
    }
    return json([]);
  }

  return json([]);
});

// Import the function under test — this starts its own server.
await import('./index.ts');
await new Promise(r => setTimeout(r, 300));

// ── helpers ─────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}

const CHARGE_LOCAL = '2026-09-27T14:32:07+03:00';
const EPOCH = Math.floor(new Date(CHARGE_LOCAL).getTime() / 1000);

function profileBody(over: Record<string, unknown> = {}) {
  return {
    roastUUID: 'uuid-yirga-1042',
    roastisodate: '2026-09-27',
    roasttime: '14:32:07',
    roastepoch: EPOCH,
    roasttzoffset: 10800,
    roastbatchprefix: 'MIN', roastbatchnr: 1042,
    title: 'Yirgacheffe', beans: 'Yirgacheffe', operator: 'Erez',
    mode: 'C', weight: [15, 12.6, 'Kg'],
    timex: [0, 1, 2], temp1: [200, 201, 202], temp2: [150, 151, 152],
    computed: { CHARGE_ET: 195.0, CHARGE_BT: 92.4, DROP_ET: 210.5, DROP_BT: 208.3, totaltime: 1020 },
    ...over,
  };
}

async function post(body: unknown, headers: Record<string, string> = { 'x-artisan-key': 'test-ingest-key' }) {
  const res = await fetch(`http://localhost:${PORT_FN}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const FILE = 'CF_2026-09-27_1432_Yirgacheffe.json';

// ── auth ────────────────────────────────────────────────────────────────────
{
  reset();
  const anon = await post({ filename: FILE, profile: profileBody() }, { apikey: 'test-anon-key' });
  check('the app\'s anon key is accepted', anon.status === 200, `${anon.status}`);

  reset();
  const none = await post({ filename: FILE, profile: profileBody() }, {});
  check('an unauthenticated call is refused', none.status === 401, `${none.status}`);

  reset();
  const wrong = await post({ filename: FILE, profile: profileBody() }, { 'x-artisan-key': 'nope' });
  check('a wrong ingest key is refused', wrong.status === 401, `${wrong.status}`);
}

// ── the normal path: file arrives before the roast is logged ─────────────────
{
  reset();
  const r = await post({ filename: FILE, profile: profileBody() });
  check('with no roast logged yet, the profile stages',
    r.body.status === 'staged' && r.body.reason === 'no_roast_logged_yet', JSON.stringify(r.body));
  check('staging touches no roast', patches.filter(p => p.table === 'roasts').length === 0);
  check('the profile was stored', Object.keys(profiles).length === 1);
}

// ── attach to the roast the roaster then logs ───────────────────────────────
{
  reset();
  roasts = [{ id: 501, date: '2026-09-27T15:10:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: null, batch_number: 'BATCH-20260927-001' }];
  const r = await post({ filename: FILE, profile: profileBody() });

  check('attaches to the one matching roast', r.body.status === 'attached' && r.body.roast_id === 501, JSON.stringify(r.body));
  check('charge ET landed on the roast', roasts[0].charge_et === 195, `${roasts[0].charge_et}`);
  check('drop BT landed on the roast', roasts[0].drop_bt === 208.3, `${roasts[0].drop_bt}`);
  check('the roast is marked as taken', roasts[0].artisan_uuid === 'uuid-yirga-1042');
  check('the profile was linked back', (Object.values(profiles)[0] as any).roast_id === 501);

  // Neither weight nor stock may be rewritten by an import.
  const roastPatch = patches.find(p => p.table === 'roasts')!;
  for (const forbidden of ['green_weight', 'roasted_weight', 'operator', 'origin_id', 'date']) {
    check(`an import never rewrites ${forbidden}`, !(forbidden in roastPatch.body));
  }
}

// ── a blend attaches via roast_profile_id ──────────────────────────────────
{
  reset();
  roastProfiles = [{ id: 3, name: 'House Blend', artisan_name: null }];
  roasts = [{ id: 601, date: '2026-09-27T16:00:00+03:00', origin_id: null, roast_profile_id: 3, artisan_uuid: null, batch_number: 'BATCH-20260927-002' }];
  const r = await post({ filename: 'CF_2026-09-27_1432_House Blend.json', profile: profileBody({ beans: 'House Blend' }) });
  check('a blend attaches by roast_profile_id', r.body.status === 'attached' && r.body.roast_id === 601, JSON.stringify(r.body));
}

// ── the taught alias wins over the display name ─────────────────────────────
{
  reset();
  origins = [{ id: 7, name: "אתיופיה יירגצ'ף", artisan_name: 'Yirga' }];
  roasts = [{ id: 701, date: '2026-09-27T15:10:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: null, batch_number: 'b' }];
  const r = await post({ filename: 'CF_2026-09-27_1432_Yirga.json', profile: profileBody({ beans: 'Yirga' }) });
  check('the remembered Artisan spelling matches', r.body.status === 'attached' && r.body.roast_id === 701, JSON.stringify(r.body));
}

// ── never guess ─────────────────────────────────────────────────────────────
{
  reset();
  roasts = [
    { id: 801, date: '2026-09-27T15:10:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: null, batch_number: 'a' },
    { id: 802, date: '2026-09-27T17:40:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: null, batch_number: 'b' },
  ];
  const r = await post({ filename: FILE, profile: profileBody() });
  check('two candidates stage rather than guess',
    r.body.status === 'staged' && r.body.reason === 'ambiguous', JSON.stringify(r.body));
  check('an ambiguous import writes to no roast', patches.filter(p => p.table === 'roasts').length === 0);

  reset();
  origins = [{ id: 7, name: 'Yirgacheffe', artisan_name: null }];
  const unknown = await post({ filename: 'CF_2026-09-27_1432_Sumatra Mandheling.json', profile: profileBody({ beans: 'Sumatra Mandheling' }) });
  check('an unrecognised bean stages with a reason',
    unknown.body.status === 'staged' && unknown.body.reason === 'unknown_bean', JSON.stringify(unknown.body));
}

// ── a roast from another day is not a candidate ─────────────────────────────
{
  reset();
  // 03:30 local the next morning — inside the raw +30h window, wrong roasting day.
  roasts = [{ id: 901, date: '2026-09-28T03:30:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: null, batch_number: 'a' }];
  const r = await post({ filename: FILE, profile: profileBody() });
  check('a roast logged on the next day is not matched',
    r.body.status === 'staged' && r.body.reason === 'no_roast_logged_yet', JSON.stringify(r.body));
}

// ── a roast that already has Artisan data is not a candidate ────────────────
{
  reset();
  roasts = [{ id: 1001, date: '2026-09-27T15:10:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: 'someone-else', batch_number: 'a' }];
  const r = await post({ filename: FILE, profile: profileBody() });
  check('a roast already carrying a profile is skipped',
    r.body.status === 'staged', JSON.stringify(r.body));
  check('the existing profile was not overwritten', roasts[0].artisan_uuid === 'someone-else');
}

// ── idempotency ─────────────────────────────────────────────────────────────
{
  reset();
  roasts = [{ id: 1101, date: '2026-09-27T15:10:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: null, batch_number: 'a' }];
  const first  = await post({ filename: FILE, profile: profileBody() });
  const second = await post({ filename: FILE, profile: profileBody() });
  check('the first upload attaches', first.body.status === 'attached');
  check('re-uploading the same file is a no-op', second.body.status === 'already_attached', JSON.stringify(second.body));
  check('no duplicate profile row', Object.keys(profiles).length === 1);
  check('the same roast is reported', second.body.roast_id === 1101);
}

// ── refusals reach the caller ───────────────────────────────────────────────
{
  reset();
  const mismatch = await post({ filename: 'CF_2026-09-27_1432_Sidamo.json', profile: profileBody() });
  check('a filename naming another bean is rejected 400',
    mismatch.status === 400 && mismatch.body.code === 'filename_mismatch', JSON.stringify(mismatch.body));
  check('a rejected file is not stored', Object.keys(profiles).length === 0);

  reset();
  const notJson = await post({ filename: FILE, profile: 'this is an .alog, not JSON' });
  check('a non-profile body is rejected 400', notJson.status === 400, `${notJson.status}`);

  reset();
  const noUuid = await post({ filename: FILE, profile: profileBody({ roastUUID: '' }) });
  check('a body without roastUUID is rejected 400',
    noUuid.status === 400 && noUuid.body.code === 'missing_uuid', JSON.stringify(noUuid.body));
}

// ── °F roastery ─────────────────────────────────────────────────────────────
{
  reset();
  roasts = [{ id: 1201, date: '2026-09-27T15:10:00+03:00', origin_id: 7, roast_profile_id: null, artisan_uuid: null, batch_number: 'a' }];
  await post({
    filename: FILE,
    profile: profileBody({ mode: 'F', computed: { CHARGE_ET: 383, DROP_BT: 406.94, totaltime: 1020 } }),
  });
  check('°F is stored as °C on the roast', roasts[0].charge_et === 195 && roasts[0].drop_bt === 208.3,
    `${roasts[0].charge_et} / ${roasts[0].drop_bt}`);
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
await db.shutdown();
Deno.exit(failures === 0 ? 0 : 1);
