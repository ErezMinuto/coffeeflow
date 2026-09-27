#!/usr/bin/env node
// ============================================================================
// artisan-watch — ship Artisan roast profiles to CoffeeFlow
// ============================================================================
//
// Runs on the roastery computer beside Artisan. Artisan's Autosave drops a
// JSON profile into a folder the moment OFF is pressed; this watches that
// folder and posts each new file to the `artisan-import` edge function.
//
//   ARTISAN_WATCH_DIR=/path/to/artisan/json \
//   ARTISAN_INGEST_KEY=... \
//   SUPABASE_URL=https://<ref>.supabase.co \
//   node scripts/artisan-watch.mjs
//
// Flags:  --once      one sweep, then exit (use this to test)
//         --dry-run   report what would be sent, send nothing
//
// Node 18+ only — uses global fetch. No dependencies, on purpose: this has to
// keep working on a roastery machine nobody maintains.
//
// Full setup guide: docs/artisan.md
// ============================================================================

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const WATCH_DIR  = process.env.ARTISAN_WATCH_DIR ?? '';
const INGEST_KEY = process.env.ARTISAN_INGEST_KEY ?? '';
const SUPA_URL   = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ENDPOINT   = process.env.ARTISAN_IMPORT_URL || (SUPA_URL && `${SUPA_URL}/functions/v1/artisan-import`);
const STATE_FILE = process.env.ARTISAN_STATE_FILE
  ?? join(homedir(), '.coffeeflow', 'artisan-watch-state.json');

const POLL_MS = Number(process.env.ARTISAN_POLL_SECONDS ?? 15) * 1000;

// Artisan's Autosave prefix is CF_~date_long_~time_~beans_line; the JSON gets
// that same base name. Anything else in the folder is not ours.
const FILENAME_RE = /^CF_\d{4}-\d{2}-\d{2}_\d{4}_.*\.json$/i;

// A file Artisan is still writing must not be read. Autosave writes in one go,
// but a network share can lag, so leave a beat.
const SETTLE_MS = 5000;

const ONCE    = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

const ts = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log  = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}]`, ...a);

// ── state: which files we have already handed over ──────────────────────────
// Keyed by filename. Survives restarts so a reboot does not re-send the week.

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { done: {} };
  }
}

async function saveState(state) {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    warn('could not write the state file —', e.message);
    warn('  files may be re-sent after a restart (the import is idempotent, so this is safe)');
  }
}

// ── upload ──────────────────────────────────────────────────────────────────

async function send(filename, profile) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-artisan-key': INGEST_KEY },
    body: JSON.stringify({ filename, profile }),
  });

  let body;
  try { body = await res.json(); } catch { body = { error: await res.text().catch(() => '') }; }

  return { httpOk: res.ok, status: res.status, body };
}

/** @returns 'done' when the file needs no further attempts, 'retry' otherwise. */
async function handle(dir, filename) {
  const full = join(dir, filename);

  const info = await stat(full);
  if (Date.now() - info.mtimeMs < SETTLE_MS) return 'retry';   // still being written

  let profile;
  try {
    profile = JSON.parse(await readFile(full, 'utf8'));
  } catch (e) {
    warn(`${filename}: not readable JSON — ${e.message}`);
    return 'done';   // a corrupt file will not fix itself; stop retrying it
  }

  if (DRY_RUN) {
    log(`${filename}: would send (dry run)`);
    return 'retry';
  }

  const { httpOk, status, body } = await send(filename, profile);

  if (httpOk && body?.ok) {
    const where = body.status === 'attached'  ? `attached to roast ${body.roast_id}`
                : body.status === 'staged'    ? `staged (${body.reason}) — attach it in CoffeeFlow`
                : body.status;
    log(`${filename}: ${where}`);
    return 'done';
  }

  // 4xx is the server telling us this file is wrong — a filename that
  // disagrees with its body, a missing roastUUID. Retrying cannot help.
  if (status >= 400 && status < 500) {
    warn(`${filename}: rejected — ${body?.error ?? status}`);
    if (body?.code === 'filename_mismatch') {
      warn('  check Artisan ▸ Config ▸ Autosave: the prefix must be CF_~date_long_~time_~beans_line');
    }
    return 'done';
  }

  warn(`${filename}: ${status || 'network error'} — ${body?.error ?? 'will retry'}`);
  return 'retry';
}

// ── sweep ───────────────────────────────────────────────────────────────────

async function sweep(state) {
  let files;
  try {
    files = await readdir(WATCH_DIR);
  } catch (e) {
    warn(`cannot read ${WATCH_DIR} — ${e.message}`);
    return;
  }

  const pending = files.filter(f => FILENAME_RE.test(f) && !state.done[f]).sort();
  if (pending.length === 0) return;

  log(`${pending.length} new profile${pending.length === 1 ? '' : 's'}`);

  for (const filename of pending) {
    try {
      if (await handle(WATCH_DIR, filename) === 'done') {
        state.done[filename] = ts();
        await saveState(state);
      }
    } catch (e) {
      warn(`${filename}: ${e.message} — will retry`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`artisan-watch: ${msg}`);
  process.exit(1);
}

if (!WATCH_DIR) fail('set ARTISAN_WATCH_DIR to the folder Artisan writes its JSON into');
if (!ENDPOINT)  fail('set SUPABASE_URL (or ARTISAN_IMPORT_URL)');
if (!INGEST_KEY && !DRY_RUN) fail('set ARTISAN_INGEST_KEY');

const state = await loadState();

log(`watching ${WATCH_DIR}`);
log(`sending to ${ENDPOINT}`);
if (DRY_RUN) log('dry run — nothing will be sent');
log(`${Object.keys(state.done).length} profile(s) already sent`);

await sweep(state);

if (!ONCE) {
  // Polling rather than fs.watch: watch events are unreliable on Windows and
  // on network shares, and missing a roast is worse than a 15-second delay.
  setInterval(() => { sweep(state).catch(e => warn(e.message)); }, POLL_MS);
}
