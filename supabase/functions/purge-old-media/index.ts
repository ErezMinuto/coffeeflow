/**
 * CoffeeFlow — Purge Old Media
 *
 * Deletes stale throwaway renders from the `marketing` storage bucket so it
 * doesn't grow without bound. Ported from scripts/purge-old-renders.mjs and
 * put on a weekly cron (see supabase/migrations/*_purge_old_media_weekly_cron.sql).
 *
 * Only the prefixes listed in TARGETS are ever touched. Everything else —
 * upload_images/, reference PNGs, published assets — is left alone.
 *
 * ig-reels/ is status-aware: a rendered product reel is deleted 3 days after it
 * was made, EXCEPT while it is still awaiting review in the dashboard (IG holds
 * the copy that matters once it is published).
 *
 * SAFETY: defaults to DRY RUN. It only deletes when called with
 *   { "commit": true }
 * The cron passes that explicitly; an accidental empty POST just reports what
 * *would* go and deletes nothing.
 *
 * POST body (optional):
 *   { "commit": true }   — actually delete (cron uses this)
 *   {}                   — dry run: list what would be deleted, delete nothing
 *
 * Deploy: --no-verify-jwt (cron calls it with no auth header).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const URL    = Deno.env.get("SUPABASE_URL")              ?? "";
const KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "marketing";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Each prefix gets its own "keep last N days" window. Files older than the
// window are deleted; newer ones are kept. keepDays:0 means delete everything
// under that prefix. Conservative windows (chosen 2026-08-09) — err toward
// keeping history since deletes against prod storage are irreversible.
const TARGETS: Array<{ prefix: string; keepDays: number; keepAwaitingReview?: boolean }> = [
  { prefix: "vertex-test", keepDays: 0  }, // pure test renders — no keepers
  { prefix: "ig-test",     keepDays: 4  }, // pre-publish previews; published copy lives on IG
  { prefix: "ig-overlay",  keepDays: 7  }, // story overlays; may be pending review a few days
  { prefix: "banners",     keepDays: 14 }, // WP sideloads its own copy after publish
  // Product reels are ~2MB each and IG keeps its own copy once published, so the
  // Storage copy is only needed while a human is reviewing it in /reels. Anything
  // still awaiting review is kept no matter how old (see awaitingReviewPaths).
  { prefix: "ig-reels",    keepDays: 3, keepAwaitingReview: true },
];

// Reel videos still waiting for a human decision in the dashboard. Their Storage
// object is the ONLY copy, so age alone must never delete them.
async function awaitingReviewPaths(headers: HeadersInit): Promise<Set<string>> {
  const keep = new Set<string>();
  const res = await fetch(
    `${URL}/rest/v1/seo_tasks?task_type=eq.reel_render&status=eq.completed&select=id,result_data`,
    { headers },
  );
  if (!res.ok) {
    // Fail safe: an unreadable task list means we cannot prove a reel was reviewed,
    // so tell the caller to skip reel deletion entirely this run.
    throw new Error(`reel review lookup failed: ${res.status} ${await res.text()}`);
  }
  for (const row of await res.json()) {
    const rd = row?.result_data ?? {};
    const reviewed = rd.published_via_ui_at || rd.rejected_via_ui_at;
    if (rd.review_required === true && !reviewed) keep.add(`ig-reels/reel_${row.id}.mp4`);
  }
  return keep;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StorageObject {
  path:    string;
  created: string;
  size:    number;
}

async function listPage(headers: HeadersInit, prefix: string, offset: number, limit: number): Promise<any[]> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${URL}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prefix: prefix + "/", limit, offset, sortBy: { column: "name", order: "asc" } }),
      });
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(attempt * 1000);
      continue;
    }
    if (res.ok) return res.json();
    // 502/503/504/429 — transient, back off and retry
    if ([429, 502, 503, 504].includes(res.status) && attempt < 5) {
      await sleep(attempt * 1500);
      continue;
    }
    throw new Error(`list ${prefix} failed: ${res.status} ${await res.text()}`);
  }
  return [];
}

async function listAll(headers: HeadersInit, prefix: string): Promise<StorageObject[]> {
  const out: StorageObject[] = [];
  let offset = 0;
  const limit = 100; // small pages — large folders 504 on big page sizes
  for (;;) {
    const page = await listPage(headers, prefix, offset, limit);
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

async function removeBatch(headers: HeadersInit, paths: string[]): Promise<void> {
  const res = await fetch(`${URL}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!URL || !KEY) {
    return new Response(JSON.stringify({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  // NOTE: the eyJ-vs-sb_secret_ concern applies to PostgREST role assignment
  // (UPDATE/INSERT), not to the Storage REST API used here — the injected
  // service-role key authenticates storage list/delete regardless of format.

  let commit = false;
  try {
    const body = await req.json();
    commit = body?.commit === true;
  } catch { /* empty body → dry run */ }

  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const now = Date.now();

  const perPrefix: Array<Record<string, unknown>> = [];
  const toDelete: StorageObject[] = [];
  try {
    const protectedPaths = await awaitingReviewPaths(headers);

    for (const t of TARGETS) {
      const all    = await listAll(headers, t.prefix);
      const cutoff = now - t.keepDays * 24 * 60 * 60 * 1000;
      const aged   = t.keepDays === 0 ? all : all.filter((o) => new Date(o.created).getTime() < cutoff);
      const old    = t.keepAwaitingReview ? aged.filter((o) => !protectedPaths.has(o.path)) : aged;
      const bytes  = old.reduce((s, o) => s + o.size, 0);
      perPrefix.push({
        prefix:    t.prefix,
        keepDays:  t.keepDays,
        total:     all.length,
        toDelete:  old.length,
        keeping:   all.length - old.length,
        awaitingReview: t.keepAwaitingReview ? aged.length - old.length : undefined,
        deleteMB:  +(bytes / 1048576).toFixed(1),
      });
      toDelete.push(...old);
    }

    const totalBytes = toDelete.reduce((s, o) => s + o.size, 0);
    let deleted = 0;

    if (commit) {
      const BATCH = 200;
      for (let i = 0; i < toDelete.length; i += BATCH) {
        const batch = toDelete.slice(i, i + BATCH).map((o) => o.path);
        await removeBatch(headers, batch);
        deleted += batch.length;
      }
    }

    return new Response(JSON.stringify({
      ok:            true,
      dryRun:        !commit,
      bucket:        BUCKET,
      perPrefix,
      filesTargeted: toDelete.length,
      filesDeleted:  deleted,
      totalMB:       +(totalBytes / 1048576).toFixed(1),
    }, null, 2), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e), perPrefix }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
