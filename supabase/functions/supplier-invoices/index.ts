// ============================================================================
// supplier-invoices — store a supplier invoice and read its fields
// ============================================================================
//
// POST { action: "ingest", filename, mime, data }
//   data      the file, base64. The browser has already shrunk a photo to a
//             small JPEG; a PDF arrives as the supplier sent it.
//   Stores the file in the private `supplier-invoices` bucket, has Claude read
//   supplier / number / date / amounts, and inserts a `pending_review` row.
//   The uploader checks the fields and confirms from the page (a plain table
//   UPDATE under RLS) — nothing here is final.
//   409 when the very same file is already stored. A different file of the
//   same supplier + invoice number is stored, and returned with
//   `possible_duplicates` so the page can warn.
//
// POST { action: "delete", id }
//   Removes the row and its file. Admin: any invoice. Other staff: their own,
//   while still pending_review. (Storage deletes need the Storage API with the
//   service key — a SQL DELETE on storage.objects is blocked by a trigger.)
//
// Callers: Minuto staff (Clerk token → public.is_staff()). The bookkeeper role
// is NOT staff and cannot call this; they only read, through RLS.
//
// Deploy:
//   supabase functions deploy supplier-invoices --project-ref <ref> --no-verify-jwt

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { createLogger } from "../_shared/logger.ts";
import { callerRole, isStaff, jwtSub } from "../_shared/role_caller.ts";
import { BUCKET, fromBase64, ingestInvoiceFile, MAX_BYTES, MIME_EXT } from "./ingest.ts";

const SUPA_URL      = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405);

  const log = createLogger("supplier-invoices");

  // isStaff() asks the database with the caller's own token, so a 200 means
  // the token is genuine — after that, its `sub` can be trusted.
  if (!(await isStaff(req))) {
    log.warn("auth.reject", "caller is not Minuto staff");
    await log.finish("error", { code: "unauthorised" });
    return json({ ok: false, error: "unauthorised", run_id: log.runId }, 401);
  }
  const token = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const userId = jwtSub(token);
  if (!userId) {
    // The service role passes isStaff() but is nobody; there is no cron here.
    await log.finish("error", { code: "no_user" });
    return json({ ok: false, error: "sign in to upload invoices", run_id: log.runId }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch {
    await log.finish("error", { code: "bad_json" });
    return json({ ok: false, error: "Invalid JSON body", run_id: log.runId }, 400);
  }

  const supabase = createClient(SUPA_URL, SUPA_KEY);

  try {
    if (body.action === "delete") {
      const id = typeof body.id === "string" ? body.id : "";
      const { data: row, error } = await supabase
        .from("supplier_invoices").select("id,file_path,uploaded_by,status").eq("id", id).maybeSingle();
      if (error) throw new Error(`lookup failed: ${error.message}`);
      if (!row) {
        await log.finish("error", { code: "not_found" });
        return json({ ok: false, error: "החשבונית לא נמצאה", run_id: log.runId }, 404);
      }
      const isAdmin = (await callerRole(req)) === "admin";
      if (!isAdmin && !(row.uploaded_by === userId && row.status === "pending_review")) {
        log.warn("delete.forbidden", "not the uploader, or already confirmed", { id });
        await log.finish("error", { code: "forbidden" });
        return json({ ok: false, error: "אפשר למחוק רק חשבונית שהעלית ועוד לא אושרה", run_id: log.runId }, 403);
      }
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove([row.file_path]);
      if (rmErr) throw new Error(`removing the file failed: ${rmErr.message}`);
      const { error: delErr } = await supabase.from("supplier_invoices").delete().eq("id", id);
      if (delErr) throw new Error(`deleting the row failed: ${delErr.message}`);
      log.info("invoice.deleted", id, { id, by: userId });
      await log.finish("success", { id });
      return json({ ok: true, id, run_id: log.runId });
    }

    if (body.action !== "ingest") {
      await log.finish("error", { code: "bad_action" });
      return json({ ok: false, error: "unknown action", run_id: log.runId }, 400);
    }

    // ── validate the payload, then the shared ingest path (ingest.ts) ──────
    const mime     = typeof body.mime === "string" ? body.mime : "";
    const filename = typeof body.filename === "string" ? body.filename : null;
    const b64      = typeof body.data === "string" ? body.data : "";
    if (!MIME_EXT[mime]) {
      await log.finish("error", { code: "bad_mime" });
      return json({ ok: false, error: "סוג קובץ לא נתמך — תמונה או PDF בלבד", run_id: log.runId }, 400);
    }
    // Refuse an oversized body before decoding it.
    if (b64.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) {
      await log.finish("error", { code: "too_large" });
      return json({ ok: false, error: "הקובץ גדול מ-10MB", run_id: log.runId }, 413);
    }
    const bytes = fromBase64(b64);
    if (!bytes) {
      await log.finish("error", { code: "bad_file" });
      return json({ ok: false, error: "הקובץ פגום או אינו תמונה/PDF", run_id: log.runId }, 400);
    }

    const r = await ingestInvoiceFile(supabase, log, ANTHROPIC_KEY, { bytes, b64, mime, filename, userId });
    if (!r.ok) {
      await log.finish("error", { code: r.code });
      return json({
        ok: false, ...(r.code === "duplicate_file" ? { code: r.code, existing: r.existing } : {}),
        error: r.error, run_id: log.runId,
      }, r.status);
    }

    await log.finish(r.extracted ? "success" : "partial", { id: r.invoice.id, duplicates: r.possible_duplicates.length });
    return json({ ok: true, invoice: r.invoice, extracted: r.extracted,
      possible_duplicates: r.possible_duplicates, run_id: log.runId });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("run.throw", "aborted by an unhandled error", {}, err);
    await log.finish("error");
    return json({ ok: false, error: message, run_id: log.runId }, 500);
  }
});
