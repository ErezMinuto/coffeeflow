// ============================================================================
// artisan-import — land an Artisan roast profile on the CoffeeFlow roast log
// ============================================================================
//
// POST { filename, profile }
//   filename  the Autosave filename, e.g. CF_2026-09-27_1432_Yirgacheffe.json
//   profile   the parsed Artisan JSON body (getProfile() as exportJSON writes it)
//
// Two callers:
//   * scripts/artisan-watch.mjs on the roastery computer  (header x-artisan-key)
//   * the manual drop-zone on the Roasting page           (anon key, as the app)
//
// What it does NOT do: create a roast. Creating one moves green and roasted
// stock, which is real inventory. A profile with no matching roast is staged
// for the roaster to attach in one click.
//
// Deploy:
//   supabase functions deploy artisan-import --project-ref <ref> --no-verify-jwt
// ============================================================================

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { createLogger } from "../_shared/logger.ts";
import {
  parseProfile,
  normaliseBeanName,
  ArtisanParseError,
  type ParsedProfile,
} from "../_shared/artisan.ts";

const SUPA_URL  = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY  = Deno.env.get("SUPABASE_ANON_KEY")         ?? "";
const INGEST_KEY = Deno.env.get("ARTISAN_INGEST_KEY")       ?? "";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-artisan-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// How far around the roast we look for the row the roaster typed in. They log
// after roasting — often later the same shift, sometimes that evening — so the
// window leans forward. It only gathers candidates; the local-date equality
// below is what actually decides.
const WINDOW_BEFORE_MS = 6  * 60 * 60 * 1000;
const WINDOW_AFTER_MS  = 30 * 60 * 60 * 1000;

/** Render an instant as a yyyy-MM-dd calendar date in the roastery's own timezone. */
function localDate(iso: string, tzOffsetSec: number): string {
  return new Date(new Date(iso).getTime() + tzOffsetSec * 1000).toISOString().slice(0, 10);
}

function authorised(req: Request): boolean {
  const key = req.headers.get("x-artisan-key");
  if (INGEST_KEY && key === INGEST_KEY) return true;
  // The app calls with its anon key. Every table here is already anon-writable
  // by design (see CLAUDE.md), so this grants nothing new — it just lets the
  // browser reuse this one parser instead of shipping a second copy.
  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  return Boolean(ANON_KEY) && (auth === `Bearer ${ANON_KEY}` || apikey === ANON_KEY);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405);

  if (!authorised(req)) return json({ ok: false, error: "unauthorised" }, 401);

  const log = createLogger("artisan-import");
  const supabase = createClient(SUPA_URL, SUPA_KEY);

  let body: { filename?: string; profile?: unknown };
  try { body = await req.json(); }
  catch {
    log.warn("body.invalid", "request body was not JSON");
    await log.finish("error");
    return json({ ok: false, error: "Invalid JSON body", run_id: log.runId }, 400);
  }

  const filename = typeof body.filename === "string" ? body.filename : undefined;

  // ── 1. parse + cross-check the filename against the body ─────────────────
  let parsed: ParsedProfile;
  try {
    parsed = parseProfile(body.profile, filename);
  } catch (e) {
    const code = e instanceof ArtisanParseError ? e.code : "parse_failed";
    const message = e instanceof Error ? e.message : String(e);
    // A mismatch means Artisan is misconfigured. Say so loudly rather than
    // storing a row that quietly describes the wrong roast.
    log.error("profile.reject", message, { filename, code }, e);
    await log.finish("error", { code });
    return json({ ok: false, error: message, code, run_id: log.runId }, 400);
  }

  log.info("profile.parsed", `${parsed.beans ?? "(bean unknown)"} @ ${parsed.roasted_at}`, {
    filename,
    artisan_uuid: parsed.artisan_uuid,
    charge_et: parsed.charge_et,
    drop_bt: parsed.drop_bt,
  });

  try {
    const source = req.headers.get("x-artisan-key") ? "watcher" : "manual";

    // ── 2. store the profile; re-uploading the same file updates in place ──
    const { data: upserted, error: upsertErr } = await supabase
      .from("artisan_profiles")
      .upsert({ ...parsed, filename: filename ?? null, source }, { onConflict: "artisan_uuid" })
      .select()
      .single();

    if (upsertErr) throw new Error(`storing the profile failed: ${upsertErr.message}`);

    const profileId: number = upserted.id;

    if (upserted.roast_id) {
      log.info("run.done", "profile was already attached", { profile_id: profileId, roast_id: upserted.roast_id });
      await log.finish("success", { status: "already_attached" });
      return json({
        ok: true, status: "already_attached",
        profile_id: profileId, roast_id: upserted.roast_id, run_id: log.runId,
      });
    }

    // ── 3. which bean is this? ────────────────────────────────────────────
    const beanKey = normaliseBeanName(parsed.beans);
    let originId: number | null = null;
    let profileRefId: number | null = null;

    if (beanKey) {
      const [{ data: origins }, { data: roastProfiles }] = await Promise.all([
        supabase.from("origins").select("id,name,artisan_name"),
        supabase.from("roast_profiles").select("id,name,artisan_name"),
      ]);

      // The alias the roaster taught us wins over the display name.
      const match = <T extends { id: number; name: string | null; artisan_name: string | null }>(rows: T[] | null) =>
        rows?.find(r => normaliseBeanName(r.artisan_name) === beanKey)
        ?? rows?.find(r => normaliseBeanName(r.name) === beanKey)
        ?? null;

      originId     = match(origins as never)       ?.id ?? null;
      profileRefId = match(roastProfiles as never) ?.id ?? null;
    }

    if (originId === null && profileRefId === null) {
      log.info("match.none", `no origin or roast profile is named "${parsed.beans ?? ""}"`, { profile_id: profileId });
      await log.finish("success", { status: "staged", reason: "unknown_bean" });
      return json({
        ok: true, status: "staged", reason: "unknown_bean",
        beans: parsed.beans, profile_id: profileId, run_id: log.runId,
      });
    }

    // ── 4. candidate roasts — same bean, same roasting day, not yet taken ──
    const centre = new Date(parsed.roasted_at).getTime();
    const from = new Date(centre - WINDOW_BEFORE_MS).toISOString();
    const to   = new Date(centre + WINDOW_AFTER_MS).toISOString();

    let q = supabase.from("roasts")
      .select("id,date,origin_id,roast_profile_id,artisan_uuid,batch_number")
      .is("artisan_uuid", null)
      .gte("date", from)
      .lte("date", to);

    q = originId !== null ? q.eq("origin_id", originId) : q.eq("roast_profile_id", profileRefId!);

    const { data: window, error: windowErr } = await q;
    if (windowErr) throw new Error(`looking up candidate roasts failed: ${windowErr.message}`);

    // Same *roasting day* in the roastery's own timezone, not in UTC.
    const tzOffsetSec = Number((parsed.meta as Record<string, unknown>)?.roasttzoffset ?? 0) || 0;
    const roastDay = localDate(parsed.roasted_at, tzOffsetSec);
    const candidates = (window ?? []).filter(r => r.date && localDate(r.date, tzOffsetSec) === roastDay);

    if (candidates.length !== 1) {
      const reason = candidates.length === 0 ? "no_roast_logged_yet" : "ambiguous";
      log.info("match.staged", `${candidates.length} candidate roasts — staging`, {
        profile_id: profileId, reason, candidates: candidates.map(c => c.id),
      });
      await log.finish("success", { status: "staged", reason });
      return json({
        ok: true, status: "staged", reason,
        candidates: candidates.map(c => c.id),
        profile_id: profileId, run_id: log.runId,
      });
    }

    // ── 5. attach ─────────────────────────────────────────────────────────
    const roastId = candidates[0].id;

    // `.is('artisan_uuid', null)` makes this a compare-and-set: if a concurrent
    // import took this roast first, 0 rows come back and we stage instead.
    const { data: claimed, error: claimErr } = await supabase
      .from("roasts")
      .update({
        charge_et: parsed.charge_et,
        charge_bt: parsed.charge_bt,
        drop_et:   parsed.drop_et,
        drop_bt:   parsed.drop_bt,
        artisan_uuid: parsed.artisan_uuid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", roastId)
      .is("artisan_uuid", null)
      .select("id");

    if (claimErr) throw new Error(`attaching to roast ${roastId} failed: ${claimErr.message}`);

    if (!claimed || claimed.length === 0) {
      log.warn("match.raced", `roast ${roastId} was claimed by another import — staying staged`, { profile_id: profileId });
      await log.finish("success", { status: "staged", reason: "raced" });
      return json({ ok: true, status: "staged", reason: "raced", profile_id: profileId, run_id: log.runId }, 200);
    }

    const { error: linkErr } = await supabase
      .from("artisan_profiles")
      .update({ roast_id: roastId, attached_at: new Date().toISOString() })
      .eq("id", profileId);

    if (linkErr) throw new Error(`linking profile ${profileId} to roast ${roastId} failed: ${linkErr.message}`);

    log.info("run.done", `attached to roast ${roastId}`, {
      profile_id: profileId, roast_id: roastId,
      charge_et: parsed.charge_et, drop_bt: parsed.drop_bt,
    });
    await log.finish("success", { status: "attached", roast_id: roastId });

    return json({
      ok: true, status: "attached",
      profile_id: profileId, roast_id: roastId,
      charge_et: parsed.charge_et, drop_bt: parsed.drop_bt,
      run_id: log.runId,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("run.throw", "import aborted by an unhandled error", { filename }, err);
    await log.finish("error");
    return json({ ok: false, error: message, run_id: log.runId }, 500);
  }
});
