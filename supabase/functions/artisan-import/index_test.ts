// Integration tests for artisan-import, run against a fake PostgREST that
// records what would have been written.
//
//   deno run --allow-net --allow-env supabase/functions/artisan-import/index_test.ts
//
// The readers have their own unit tests (_shared/artisan_test.ts,
// _shared/python_literal_test.ts). What is covered here is the part that
// touches real inventory rows: that the readings land on the roast the roaster
// chose, that nothing else on that row is ever rewritten, and that the obvious
// mis-clicks are refused rather than silently applied.

const PORT_DB = 8791;
const PORT_FN = 8000;   // std@0.168.0 serve() default

Deno.env.set('SUPABASE_URL', `http://localhost:${PORT_DB}`);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');
Deno.env.set('LOG_TO_DB', 'false');

// ── the fake database ───────────────────────────────────────────────────────

interface Roast {
  id: number; batch_number: string;
  green_weight?: number; roasted_weight?: number; operator?: string;
  origin_id?: number | null; date?: string;
  artisan_uuid?: string | null;
  charge_et?: number | null; charge_bt?: number | null;
  drop_et?: number | null;   drop_bt?: number | null;
}

let roasts: Roast[] = [];
let profiles: Array<Record<string, any>> = [];
let nextProfileId = 1;
const patches: { table: string; body: any }[] = [];

function reset() {
  roasts = [{
    id: 501, batch_number: 'BATCH-20260927-001',
    green_weight: 15, roasted_weight: 12.6, operator: 'Erez',
    origin_id: 7, date: '2026-09-27T15:10:00+03:00', artisan_uuid: null,
  }];
  profiles = [];
  nextProfileId = 1;
  patches.length = 0;
}

function applyFilters<T extends Record<string, any>>(rows: T[], params: URLSearchParams): T[] {
  return rows.filter(row =>
    [...params.entries()].every(([col, expr]) => {
      if (col === 'select' || col === 'on_conflict' || col === 'order') return true;
      const [op, ...rest] = expr.split('.');
      const val = rest.join('.');
      switch (op) {
        case 'eq':  return String(row[col]) === val;
        case 'neq': return String(row[col]) !== val;
        case 'is':  return val === 'null' ? row[col] === null || row[col] === undefined : true;
        default:    return true;
      }
    })
  );
}

const db = Deno.serve({ port: PORT_DB, onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  const table = url.pathname.replace('/rest/v1/', '');
  const params = url.searchParams;
  // PostgREST returns a bare object when .single()/.maybeSingle() asks for one.
  const wantsObject = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object+json');
  const json = (b: unknown, status = 200) => {
    const payload = wantsObject && Array.isArray(b) ? (b[0] ?? null) : b;
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };

  if (req.method === 'GET') {
    if (table === 'roasts')           return json(applyFilters(roasts, params));
    if (table === 'artisan_profiles') return json(applyFilters(profiles, params));
    return json([]);
  }

  if (req.method === 'POST' && table === 'artisan_profiles') {
    const rows = await req.json();
    const incoming = Array.isArray(rows) ? rows[0] : rows;
    const existing = profiles.find(p => p.roast_id === incoming.roast_id);   // onConflict: roast_id
    if (existing) { Object.assign(existing, incoming); return json([existing], 200); }
    const row = { ...incoming, id: nextProfileId++ };
    profiles.push(row);
    return json([row], 201);
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    patches.push({ table, body });
    if (table === 'roasts') {
      const hit = applyFilters(roasts, params);
      for (const r of hit) Object.assign(r, body);
      return json(hit.map(r => ({ id: r.id })));
    }
    return json([]);
  }

  return json([]);
});

await import('./index.ts');
await new Promise(r => setTimeout(r, 300));

// ── helpers ─────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}

const EPOCH = Math.floor(new Date('2026-09-27T14:32:07+03:00').getTime() / 1000);

/** A .alog exactly as Artisan writes it: repr(dict). */
function alog(over: Record<string, string> = {}) {
  const f = {
    roastUUID: `'uuid-yirga-1042'`,
    roastisodate: `'2026-09-27'`,
    roasttime: `'14:32:07'`,
    roastepoch: String(EPOCH),
    roastbatchprefix: `'MIN'`,
    roastbatchnr: '1042',
    title: `'Yirgacheffe'`,
    beans: `"אתיופיה יירגצ'ף"`,
    operator: `'Erez'`,
    mode: `'C'`,
    weight: `[15.0, 12.6, 'Kg']`,
    timex: `[0.0, 1.0, 2.0]`,
    temp1: `[195.0, 194.0, 193.0]`,
    computed: `{'CHARGE_ET': 195.0, 'CHARGE_BT': 92.4, 'DROP_ET': 210.5, 'DROP_BT': 208.3, 'totaltime': 1020.0}`,
    ...over,
  };
  return '{' + Object.entries(f).map(([k, v]) => `'${k}': ${v}`).join(', ') + '}';
}

function jsonProfile(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    roastUUID: 'uuid-yirga-1042', roastisodate: '2026-09-27', roasttime: '14:32:07',
    roastepoch: EPOCH, roastbatchprefix: 'MIN', roastbatchnr: 1042,
    title: 'Yirgacheffe', beans: 'Yirgacheffe', operator: 'Erez',
    mode: 'C', weight: [15, 12.6, 'Kg'], timex: [0, 1], temp1: [195, 194],
    computed: { CHARGE_ET: 195.0, CHARGE_BT: 92.4, DROP_ET: 210.5, DROP_BT: 208.3, totaltime: 1020 },
    ...over,
  });
}

async function post(body: unknown, headers: Record<string, string> = { apikey: 'test-anon-key' }) {
  const res = await fetch(`http://localhost:${PORT_FN}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const upload = (roast_id: unknown, content: string, filename = 'roast.alog') =>
  post({ roast_id, filename, content });

// ── auth ────────────────────────────────────────────────────────────────────
{
  reset();
  check('the app\'s anon key is accepted', (await upload(501, alog())).status === 200);
  reset();
  check('an unauthenticated call is refused', (await post({ roast_id: 501, content: alog() }, {})).status === 401);
  reset();
  check('a wrong key is refused', (await post({ roast_id: 501, content: alog() }, { apikey: 'nope' })).status === 401);
}

// ── the happy path, .alog ───────────────────────────────────────────────────
{
  reset();
  const r = await upload(501, alog(), '2026-09-27_1432.alog');

  check('an .alog attaches to the chosen roast', r.body.ok === true && r.body.roast_id === 501, JSON.stringify(r.body));
  check('charge ET lands on the roast', roasts[0].charge_et === 195, `${roasts[0].charge_et}`);
  check('drop BT lands on the roast', roasts[0].drop_bt === 208.3, `${roasts[0].drop_bt}`);
  check('both other probes land too', roasts[0].charge_bt === 92.4 && roasts[0].drop_et === 210.5);
  check('the roast records which file it holds', roasts[0].artisan_uuid === 'uuid-yirga-1042');
  check('the profile row is linked to the roast', profiles.length === 1 && profiles[0].roast_id === 501);
  check('a bean name with an apostrophe survives', profiles[0].beans === "אתיופיה יירגצ'ף", profiles[0].beans);
  check('the filename is recorded', profiles[0].filename === '2026-09-27_1432.alog');
  check('curve arrays are not stored', !('timex' in profiles[0].meta) && !('temp1' in profiles[0].meta));
  check('the response carries the readings back for the toast',
    r.body.charge_et === 195 && r.body.drop_bt === 208.3);

  // The roaster's own numbers are not the import's business.
  const roastPatch = patches.find(p => p.table === 'roasts')!;
  for (const forbidden of ['green_weight', 'roasted_weight', 'operator', 'origin_id', 'date', 'batch_number']) {
    check(`an import never rewrites ${forbidden}`, !(forbidden in roastPatch.body));
  }
}

// ── .json works the same ────────────────────────────────────────────────────
{
  reset();
  const r = await upload(501, jsonProfile(), 'export.json');
  check('a .json attaches identically', r.body.ok === true && roasts[0].charge_et === 195, JSON.stringify(r.body));
}

// ── replacing the file on a roast ───────────────────────────────────────────
{
  reset();
  await upload(501, alog());
  const second = await upload(501, alog({
    roastUUID: `'uuid-corrected'`,
    computed: `{'CHARGE_ET': 188.0, 'DROP_BT': 205.0, 'totaltime': 990.0}`,
  }));

  check('re-uploading a corrected file succeeds', second.body.ok === true, JSON.stringify(second.body));
  check('only one profile per roast', profiles.length === 1);
  check('the readings are replaced', roasts[0].charge_et === 188 && roasts[0].drop_bt === 205,
    `${roasts[0].charge_et} / ${roasts[0].drop_bt}`);
  check('the roast points at the new file', roasts[0].artisan_uuid === 'uuid-corrected');

  // Uploading the identical file again is harmless.
  reset();
  await upload(501, alog());
  const again = await upload(501, alog());
  check('uploading the same file twice is idempotent', again.body.ok === true && profiles.length === 1);
}

// ── mis-clicks are refused ──────────────────────────────────────────────────
{
  reset();
  roasts.push({ id: 502, batch_number: 'BATCH-20260927-002', artisan_uuid: null });
  await upload(501, alog());
  const wrongRoast = await upload(502, alog());

  check('the same file on a second roast is refused 409',
    wrongRoast.status === 409 && wrongRoast.body.code === 'already_attached_elsewhere', JSON.stringify(wrongRoast.body));
  check('the refusal names the roast that already has it', wrongRoast.body.roast_id === 501);
  check('the second roast was left untouched', roasts[1].artisan_uuid === null && roasts[1].charge_et === undefined);

  reset();
  const missing = await upload(9999, alog());
  check('uploading onto a roast that does not exist is refused 404',
    missing.status === 404 && missing.body.code === 'roast_not_found', JSON.stringify(missing.body));

  reset();
  const noId = await post({ content: alog(), filename: 'r.alog' });
  check('a missing roast_id is refused', noId.status === 400 && noId.body.code === 'bad_roast_id', JSON.stringify(noId.body));
}

// ── bad files are refused with something readable ───────────────────────────
{
  reset();
  const empty = await upload(501, '');
  check('an empty file is refused', empty.status === 400 && empty.body.code === 'empty_file');

  reset();
  const csv = await upload(501, 'date,temp\n2026-09-27,195', 'roast.csv');
  check('a CSV is refused', csv.status === 400, JSON.stringify(csv.body));

  reset();
  const notProfile = await upload(501, `{'hello': 'world'}`, 'other.alog');
  check('a Python file that is not a profile is refused',
    notProfile.status === 400 && notProfile.body.code === 'missing_uuid', JSON.stringify(notProfile.body));

  reset();
  const brokenJson = await upload(501, '{oops', 'r.json');
  check('a corrupt .json says so', brokenJson.status === 400 && brokenJson.body.code === 'bad_json', JSON.stringify(brokenJson.body));

  reset();
  const brokenAlog = await upload(501, '{oops', 'r.alog');
  check('a corrupt .alog says so', brokenAlog.status === 400 && brokenAlog.body.code === 'bad_alog', JSON.stringify(brokenAlog.body));

  reset();
  check('nothing was written by any refused upload', profiles.length === 0 && roasts[0].artisan_uuid === null);
}

// ── °F roastery ─────────────────────────────────────────────────────────────
{
  reset();
  await upload(501, alog({ mode: `'F'`, computed: `{'CHARGE_ET': 383.0, 'DROP_BT': 406.94, 'totaltime': 1020.0}` }));
  check('°F is stored as °C on the roast', roasts[0].charge_et === 195 && roasts[0].drop_bt === 208.3,
    `${roasts[0].charge_et} / ${roasts[0].drop_bt}`);
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
await db.shutdown();
Deno.exit(failures === 0 ? 0 : 1);
