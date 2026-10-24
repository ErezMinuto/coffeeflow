// Tests for google-ads-draft's guards, run against a fake PostgREST + Auth that
// behave like the real ones where it matters: unknown keys are rejected, only
// the service role may list Auth users, and unique(idea_id) is enforced.
//
//   deno run --allow-net --allow-env supabase/functions/google-ads-draft/index_test.ts
//
// Nothing here reaches Google. The handler-level checks (auth, unknown action)
// must refuse before the function loads its Google context, and the request
// log proves they did. The create bookkeeping is driven through guards.ts with
// the real supabase-js client.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'

const PORT_DB = 8792;
const PORT_FN = 8000;   // std@0.168.0 serve() default

const SERVICE = 'test-service-role';
const SERVICE_OTHER_FORMAT = 'test-service-role-legacy-jwt';   // same role, other key format
const ANON = 'test-anon-key';

Deno.env.set('SUPABASE_URL', `http://localhost:${PORT_DB}`);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE);

// ── the fake backend ────────────────────────────────────────────────────────

let drafts: Array<Record<string, any>> = [];
let nextId = 1;
let requests: string[] = [];
let failUpdates = false;

function reset() {
  drafts = [];
  nextId = 1;
  requests = [];
  failUpdates = false;
}

function matches(row: Record<string, any>, params: URLSearchParams): boolean {
  return [...params.entries()].every(([col, expr]) => {
    if (['select', 'order', 'limit', 'columns', 'page', 'per_page'].includes(col)) return true;
    const [op, ...rest] = expr.split('.');
    const val = rest.join('.');
    switch (op) {
      case 'eq':  return String(row[col]) === val;
      case 'gte': return String(row[col]) >= val;
      default:    return true;
    }
  });
}

const db = Deno.serve({ port: PORT_DB, onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  requests.push(`${req.method} ${url.pathname}`);
  const key = req.headers.get('apikey') ?? '';
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

  if (![SERVICE, SERVICE_OTHER_FORMAT, ANON].includes(key)) return json({ message: 'Invalid API key' }, 401);

  if (url.pathname === '/auth/v1/admin/users') {
    return key === ANON ? json({ msg: 'User not allowed' }, 403) : json({ users: [] });
  }

  if (url.pathname !== '/rest/v1/google_ad_drafts') return json({ message: 'not found' }, 404);
  const params = url.searchParams;
  const wantsObject = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object+json');
  const out = (rows: unknown[]) => wantsObject ? json(rows[0] ?? null) : json(rows);

  if (req.method === 'GET') return out(drafts.filter(r => matches(r, params)));

  if (req.method === 'POST') {
    const body = await req.json();
    if (drafts.some(r => r.idea_id === body.idea_id)) {
      return json({ code: '23505', message: 'duplicate key value violates unique constraint "google_ad_drafts_idea_id_key"' }, 409);
    }
    const row = { id: nextId++, created_at: new Date().toISOString(), ...body };
    drafts.push(row);
    return out([row]);
  }

  if (req.method === 'PATCH') {
    if (failUpdates) return json({ code: '42501', message: 'permission denied for table google_ad_drafts' }, 403);
    const body = await req.json();
    const hit = drafts.filter(r => matches(r, params));
    hit.forEach(r => Object.assign(r, body));
    return out(hit);
  }

  if (req.method === 'DELETE') {
    drafts = drafts.filter(r => !matches(r, params));
    return new Response(null, { status: 204 });
  }
  return json({ message: 'method' }, 405);
});

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

// Starts the handler on PORT_FN.
await import('./index.ts');
const G = await import('./guards.ts');

async function post(body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${SERVICE}` }) {
  const res = await fetch(`http://localhost:${PORT_FN}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const VALID_CREATE = {
  idea_id: 'idea-42',
  spec: { campaign_type: 'search', campaign_name: 'Beans', daily_budget_ils: 10, duration_days: 14 },
};

// ── who may call ────────────────────────────────────────────────────────────
{
  reset();
  const none = await post({ action: 'list' }, {});
  check('no credentials → 401', none.status === 401, JSON.stringify(none.body));

  const anon = await post({ action: 'update_campaign', campaign_id: '1', status: 'ENABLED' }, { Authorization: `Bearer ${ANON}`, apikey: ANON });
  check('the public anon key → 401 (it ships in the frontend)', anon.status === 401, JSON.stringify(anon.body));

  const junk = await post({ action: 'delete', campaign_id: '1' }, { Authorization: 'Bearer not-a-key' });
  check('a made-up key → 401', junk.status === 401);

  check('refused callers never touched the drafts table', !requests.some(r => r.includes('/rest/v1/')), requests.join(', '));

  const ok = await G.isServiceCaller(new Request('http://x', { headers: { Authorization: `Bearer ${SERVICE}` } }),
    { supabaseUrl: `http://localhost:${PORT_DB}`, serviceKey: SERVICE });
  check('the service-role key (marketing-advisor\'s path) is accepted', ok);

  const other = await G.isServiceCaller(new Request('http://x', { headers: { Authorization: `Bearer ${SERVICE_OTHER_FORMAT}` } }),
    { supabaseUrl: `http://localhost:${PORT_DB}`, serviceKey: SERVICE });
  check('the service role in its other key format is accepted', other);
}

// ── which actions exist ─────────────────────────────────────────────────────
{
  reset();
  const typo = await post({ action: 'cretae', ...VALID_CREATE });
  check('a misspelt action is a 400, not a create', typo.status === 400 && /must be one of/.test(typo.body.error), JSON.stringify(typo.body));
  check('the misspelt action wrote nothing', drafts.length === 0 && !requests.some(r => r.startsWith('POST /rest')), requests.join(', '));

  const missing = await post({ ...VALID_CREATE });
  check('a missing action is a 400', missing.status === 400);

  let threw = false;
  for (const a of G.ACTIONS) { try { G.parseAction(a) } catch { threw = true } }
  check('every real action still parses', !threw);
}

// ── create: one campaign per idea, even under concurrency ───────────────────
const supabase = createClient(`http://localhost:${PORT_DB}`, SERVICE, { auth: { persistSession: false } });
const claimRow = { idea_id: 'idea-42', customer_id: '123', campaign_name: 'Beans', daily_budget_ils: 10, spec: VALID_CREATE.spec };
{
  reset();
  const [a, b] = await Promise.all([G.claimIdea(supabase, claimRow), G.claimIdea(supabase, claimRow)]);
  const kinds = [a.kind, b.kind].sort().join(',');
  check('two concurrent creates: exactly one wins the claim', kinds === 'claimed,taken', kinds);
  const loser = a.kind === 'taken' ? a : b;
  check('the loser sees an in-flight claim, not a finished campaign',
    loser.kind === 'taken' && G.isClaim(loser.row) && G.claimConflict(loser.row).status === 409);
  check('only one row exists for the idea', drafts.length === 1);
}
{
  reset();
  const c = await G.claimIdea(supabase, claimRow);
  if (c.kind !== 'claimed') throw new Error('setup');
  await G.releaseClaim(supabase, c.id);
  check('a failed mutate releases the claim', drafts.length === 0);
  const again = await G.claimIdea(supabase, claimRow);
  check('…so the same idea can be retried', again.kind === 'claimed');
}
{
  reset();
  const c = await G.claimIdea(supabase, claimRow);
  if (c.kind !== 'claimed') throw new Error('setup');
  const err = await G.finalizeClaim(supabase, c.id, { campaign_id: '999', campaign_type: 'SEARCH' });
  check('a recorded campaign finalizes cleanly', err === null && drafts[0].campaign_id === '999' && drafts[0].status === 'PAUSED', String(err));
  await G.releaseClaim(supabase, c.id);
  check('a late release never deletes a finished row', drafts.length === 1);
  const dup = await G.claimIdea(supabase, claimRow);
  check('re-running a finished idea returns the existing campaign', dup.kind === 'taken' && !G.isClaim(dup.row) && dup.row.campaign_id === '999');
}
{
  reset();
  const c = await G.claimIdea(supabase, claimRow);
  if (c.kind !== 'claimed') throw new Error('setup');
  failUpdates = true;
  const err = await G.finalizeClaim(supabase, c.id, { campaign_id: '999' });
  check('a failed record is surfaced, not swallowed', typeof err === 'string' && err.length > 0, String(err));
  check('…and the claim stays at CREATING as the trail to the campaign', drafts[0].status === G.CLAIM_STATUS);
}
{
  const fresh = { idea_id: 'x', status: G.CLAIM_STATUS, created_at: new Date().toISOString() };
  const old = { ...fresh, id: 7, campaign_name: 'Beans', created_at: new Date(Date.now() - G.CLAIM_STALE_MS - 1000).toISOString() };
  check('a fresh claim reads as in progress', G.claimConflict(fresh).body.in_progress === true);
  check('a stale claim names the row to check by hand', G.claimConflict(old).body.stale_claim_id === 7);
}

// ── budget edits keep the monthly cap honest ────────────────────────────────
{
  reset();
  const c = await G.claimIdea(supabase, claimRow);
  if (c.kind !== 'claimed') throw new Error('setup');
  await G.finalizeClaim(supabase, c.id, { campaign_id: '999' });
  check('₪10/day × 14 days is committed', await G.committedThisMonth(supabase) === 140);

  const warn = await G.syncDraftBudget(supabase, '999', 100);
  check('raising the budget to ₪100/day is written back', warn === null && Number(drafts[0].daily_budget_ils) === 100, String(warn));
  check('…and the cap now counts ₪100/day × 14', await G.committedThisMonth(supabase) === 1400);

  check('a campaign with no draft row is a no-op', await G.syncDraftBudget(supabase, '555', 50) === null);

  failUpdates = true;
  const failed = await G.syncDraftBudget(supabase, '999', 80);
  check('a failed write-back comes back as a warning', typeof failed === 'string' && /monthly cap/.test(failed!), String(failed));
}

// ── monthly cap under concurrency (different ideas) ─────────────────────────
// Each create is ₪100/day × 14 = ₪1400 against a ₪2000 cap: one fits, two don't.
// The old order (cap check, then claim) let both pass.
{
  const createUnderCap = async (idea: string) => {
    const c = await G.claimIdea(supabase, { ...claimRow, idea_id: idea, daily_budget_ils: 100 });
    if (c.kind !== 'claimed') return 'taken';
    const cap = await G.capAfterClaim(supabase, 0, 2000);
    if (!cap.ok) { await G.releaseClaim(supabase, c.id); return 'over_cap'; }
    return 'created';
  };
  for (let round = 0; round < 10; round++) {
    reset();
    const outcomes = await Promise.all([createUnderCap('idea-a'), createUnderCap('idea-b')]);
    const created = outcomes.filter(o => o === 'created').length;
    if (created > 1) { check('two concurrent creates for different ideas never both pass the cap', false, outcomes.join(',')); break; }
    if (round === 9) check('two concurrent creates for different ideas never both pass the cap', true);
  }
  reset();
  check('a create that fits is allowed', await createUnderCap('idea-c') === 'created');
  check('…and the next one that does not fit is refused and leaves no claim',
    await createUnderCap('idea-d') === 'over_cap' && drafts.length === 1);

  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const create = src.slice(src.indexOf('// create\n'));
  check('index.ts runs the decisive cap check after the claim',
    create.indexOf('claimIdea(') > 0 && create.indexOf('capAfterClaim(') > create.indexOf('claimIdea('));
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
await db.shutdown();
Deno.exit(failures === 0 ? 0 : 1);
