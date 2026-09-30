// ============================================================================
// artisan-import — attach an Artisan roast file to one roast record
// ============================================================================
//
// POST { roast_id, filename, content }
//   roast_id  the roast the file belongs to — the roaster picked it, so there
//             is nothing to infer and nothing to guess
//   filename  used only to pick the reader (.alog vs .json) and for the record
//   content   the raw TEXT of the file. .alog is a Python literal, not JSON,
//             so the browser cannot parse it — it sends the bytes as read.
//
// Writes the charge/drop readings onto that roast and keeps the full profile
// in `artisan_profiles`. Never touches weights, stock, origin or date: those
// are the roaster's numbers, and rewriting them would move real inventory.
//
// Deploy:
//   supabase functions deploy artisan-import --project-ref <ref> --no-verify-jwt

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { createLogger } from "../_shared/logger.ts";
import { parseArtisanFile, ArtisanParseError } from "../_shared/artisan.ts";

const SUPA_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")         ?? "";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// An .alog carries the full curve, so a long roast at a high sample rate is a
// few MB. Well above that is not a roast profile.
const MAX_CONTENT_CHARS = 20_000_000;

/**
 * The app calls with its anon key (the Clerk fetch wrapper sends it as
 * `apikey`). Every table here is already anon-writable by design — see
 * CLAUDE.md — so this grants nothing that a direct PostgREST call would not.
 */
function authorised(req: Request): boolean {
  if (!ANON_KEY) return false;
  return req.headers.get("apikey") === ANON_KEY
      || req.headers.get("authorization") === `Bearer ${ANON_KEY}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405);
  if (!authorised(req))         return json({ ok: false, error: "unauthorised" }, 401);

  const log = createLogger("artisan-import");
  const supabase = createClient(SUPA_URL, SUPA_KEY);

  let body: { roast_id?: unknown; filename?: unknown; content?: unknown };
  try { body = await req.json(); }
  catch {
    log.warn("body.invalid", "request body was not JSON");
    await log.finish("error");
    return json({ ok: false, error: "Invalid JSON body", run_id: log.runId }, 400);
  }

  const roastId  = Number(body.roast_id);
  const filename = typeof body.filename === "string" ? body.filename : undefined;
  const content  = typeof body.content === "string" ? body.content : "";

  if (!Number.isInteger(roastId) || roastId <= 0) {
    await log.finish("error", { code: "bad_roast_id" });
    return json({ ok: false, error: "roast_id is required", code: "bad_roast_id", run_id: log.runId }, 400);
  }
  if (!content) {
    await log.finish("error", { code: "empty_file" });
    return json({ ok: false, error: "the file is empty", code: "empty_file", run_id: log.runId }, 400);
  }
  if (content.length > MAX_CONTENT_CHARS) {
    await log.finish("error", { code: "file_too_large" });
    return json({ ok: false, error: "that file is too large to be a roast profile", code: "file_too_large", run_id: log.runId }, 413);
  }

  // ── read the file ────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = parseArtisanFile(content, filename);
  } catch (e) {
    const code = e instanceof ArtisanParseError ? e.code : "parse_failed";
    const message = e instanceof Error ? e.message : String(e);
    log.error("file.reject", message, { filename, roast_id: roastId, code }, e);
    await log.finish("error", { code });
    return json({ ok: false, error: message, code, run_id: log.runId }, 400);
  }

  log.info("file.parsed", `${parsed.beans ?? "(bean unknown)"} @ ${parsed.roasted_at}`, {
    filename, roast_id: roastId,
    artisan_uuid: parsed.artisan_uuid,
    charge_et: parsed.charge_et, drop_bt: parsed.drop_bt,
  });

  try {
    // ── the roast must exist ───────────────────────────────────────────────
    const { data: roast, error: roastErr } = await supabase
      .from("roasts").select("id,batch_number").eq("id", roastId).maybeSingle();
    if (roastErr) throw new Error(`looking up roast ${roastId} failed: ${roastErr.message}`);
    if (!roast) {
      log.warn("roast.missing", `roast ${roastId} does not exist`);
      await log.finish("error", { code: "roast_not_found" });
      return json({ ok: false, error: "that roast no longer exists", code: "roast_not_found", run_id: log.runId }, 404);
    }

    // ── the same file must not land on two roasts ──────────────────────────
    // A genuine mis-click: uploading yesterday's file onto today's roast would
    // silently duplicate readings onto the wrong record.
    const { data: claimedElsewhere, error: dupErr } = await supabase
      .from("artisan_profiles")
      .select("id,roast_id")
      .eq("artisan_uuid", parsed.artisan_uuid)
      .neq("roast_id", roastId)
      .maybeSingle();
    if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
    if (claimedElsewhere) {
      log.warn("file.duplicate", `already attached to roast ${claimedElsewhere.roast_id}`, { roast_id: roastId });
      await log.finish("error", { code: "already_attached_elsewhere" });
      return json({
        ok: false,
        error: `This Artisan file is already attached to another roast (#${claimedElsewhere.roast_id}).`,
        code: "already_attached_elsewhere",
        roast_id: claimedElsewhere.roast_id,
        run_id: log.runId,
      }, 409);
    }

    // ── store the profile (one per roast; re-uploading replaces it) ────────
    const { data: profile, error: upsertErr } = await supabase
      .from("artisan_profiles")
      .upsert({ ...parsed, roast_id: roastId, filename: filename ?? null }, { onConflict: "roast_id" })
      .select("id")
      .single();
    if (upsertErr) throw new Error(`storing the profile failed: ${upsertErr.message}`);

    // ── put the readings on the roast ──────────────────────────────────────
    const { error: applyErr } = await supabase
      .from("roasts")
      .update({
        charge_et: parsed.charge_et,
        charge_bt: parsed.charge_bt,
        drop_et:   parsed.drop_et,
        drop_bt:   parsed.drop_bt,
        artisan_uuid: parsed.artisan_uuid,
        updated_at: new Date().toISOString(),
      })
      .eq("id", roastId);
    if (applyErr) throw new Error(`writing readings to roast ${roastId} failed: ${applyErr.message}`);

    log.info("run.done", `attached to roast ${roastId}`, {
      profile_id: profile.id, roast_id: roastId,
      charge_et: parsed.charge_et, drop_bt: parsed.drop_bt,
    });
    await log.finish("success", { roast_id: roastId });

    return json({
      ok: true,
      roast_id: roastId,
      profile_id: profile.id,
      beans: parsed.beans,
      roasted_at: parsed.roasted_at,
      charge_et: parsed.charge_et, charge_bt: parsed.charge_bt,
      drop_et:   parsed.drop_et,   drop_bt:   parsed.drop_bt,
      total_time_sec: parsed.total_time_sec,
      run_id: log.runId,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("run.throw", "import aborted by an unhandled error", { filename, roast_id: roastId }, err);
    await log.finish("error");
    return json({ ok: false, error: message, run_id: log.runId }, 500);
  }
});
