#!/usr/bin/env node
// Purge old throwaway test renders from the `marketing` storage bucket.
// Deletes:  vertex-test/*  (all)  +  ig-test/*  (older than CUTOFF_DAYS)
// Keeps everything else. Dry-run by default; pass --commit to actually delete.
//
// Usage:
//   export SUPABASE_URL=https://ytydgldyeygpzmlxvpvb.supabase.co
//   export SUPABASE_SERVICE_ROLE_KEY=eyJ...        # JWT format, from dashboard
//   node scripts/purge-old-renders.mjs             # dry run (lists what would go)
//   node scripts/purge-old-renders.mjs --commit    # actually delete

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMMIT = process.argv.includes('--commit');
const BUCKET = 'marketing';

// Each prefix gets its own "keep last N days" window. Files older than the
// window are deleted; newer ones are kept. keepDays:0 means delete everything.
const TARGETS = [
  { prefix: 'vertex-test', keepDays: 0 }, // pure test renders — already cleared, no-op now
  { prefix: 'ig-test',     keepDays: 2 }, // pre-publish previews; published copy lives on IG
  { prefix: 'ig-overlay',  keepDays: 4 }, // keep 06-24+ — two stories pending review (review_required=true)
  { prefix: 'banners',     keepDays: 7 }, // WP sideloads its own copy; 0 seo_tasks refs
];

if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
  process.exit(1);
}
if (!KEY.startsWith('eyJ')) {
  console.error('SERVICE_ROLE_KEY must be the JWT (eyJ...) format, not sb_secret_*.');
  process.exit(1);
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const now = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listPage(prefix, offset, limit) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(`${URL}/storage/v1/object/list/${BUCKET}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prefix: prefix + '/', limit, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(attempt * 1000);
      continue;
    }
    if (res.ok) return res.json();
    // 504/502/503/429 — transient, back off and retry
    if ([429, 502, 503, 504].includes(res.status) && attempt < 5) {
      await sleep(attempt * 1500);
      continue;
    }
    throw new Error(`list ${prefix} failed: ${res.status} ${await res.text()}`);
  }
}

async function listAll(prefix) {
  const out = [];
  let offset = 0;
  const limit = 100; // small pages — large folders 504 on big page sizes
  for (;;) {
    const page = await listPage(prefix, offset, limit);
    if (!page.length) break;
    for (const o of page) {
      if (o.id === null) continue; // sub-folder placeholder, skip
      out.push({ path: `${prefix}/${o.name}`, created: o.created_at, size: Number(o.metadata?.size || 0) });
    }
    if (page.length < limit) break;
    offset += limit;
  }
  return out;
}

async function removeBatch(paths) {
  const res = await fetch(`${URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
}

const targets = [];
for (const t of TARGETS) {
  const all = await listAll(t.prefix);
  const cutoff = now - t.keepDays * 24 * 60 * 60 * 1000;
  const old = t.keepDays === 0 ? all : all.filter((o) => new Date(o.created).getTime() < cutoff);
  const bytes = old.reduce((s, o) => s + o.size, 0);
  console.log(
    `${t.prefix.padEnd(12)} keep ${t.keepDays}d → delete ${old.length}/${all.length} files  (${(bytes / 1048576).toFixed(0)} MB, keeping ${all.length - old.length})`
  );
  targets.push(...old);
}
const totalBytes = targets.reduce((s, o) => s + o.size, 0);
console.log(`TOTAL to delete: ${targets.length} files, ${(totalBytes / 1048576).toFixed(0)} MB`);

if (!COMMIT) {
  console.log('\nDRY RUN — nothing deleted. Re-run with --commit to delete.');
  process.exit(0);
}

let done = 0;
const BATCH = 200;
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH).map((o) => o.path);
  await removeBatch(batch);
  done += batch.length;
  console.log(`deleted ${done}/${targets.length}`);
}
console.log(`\nDone. Removed ${done} files, ~${(totalBytes / 1048576).toFixed(0)} MB.`);
