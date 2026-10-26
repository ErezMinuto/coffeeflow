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
import { extractInvoice } from "./extract.ts";
import { duplicateReason } from "./duplicates.ts";

const SUPA_URL      = Deno.env.get("SUPABASE_URL")              ?? "";
const SUPA_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";
const BUCKET = "supplier-invoices";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
};
// Matches the bucket's file_size_limit (10 MB).
const MAX_BYTES = 10 * 1024 * 1024;

function fromBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The file must be what it claims: a renamed .exe labelled image/jpeg is not stored.
function magicMatches(mime: string, b: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  switch (mime) {
    case "image/jpeg":      return starts(0xff, 0xd8, 0xff);
    case "image/png":       return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/webp":      return starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45;
    case "application/pdf": return starts(0x25, 0x50, 0x44, 0x46);
    default:                return false;
  }
}

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

    // ── validate the file ──────────────────────────────────────────────────
    const mime     = typeof body.mime === "string" ? body.mime : "";
    const filename = typeof body.filename === "string" ? body.filename.slice(0, 200) : null;
    const b64      = typeof body.data === "string" ? body.data : "";
    const ext = MIME_EXT[mime];
    if (!ext) {
      await log.finish("error", { code: "bad_mime" });
      return json({ ok: false, error: "סוג קובץ לא נתמך — תמונה או PDF בלבד", run_id: log.runId }, 400);
    }
    if (b64.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) {
      await log.finish("error", { code: "too_large" });
      return json({ ok: false, error: "הקובץ גדול מ-10MB", run_id: log.runId }, 413);
    }
    const bytes = fromBase64(b64);
    if (!bytes || bytes.length === 0 || !magicMatches(mime, bytes)) {
      await log.finish("error", { code: "bad_file" });
      return json({ ok: false, error: "הקובץ פגום או אינו תמונה/PDF", run_id: log.runId }, 400);
    }

    // ── the same file twice ────────────────────────────────────────────────
    const hash = await sha256(bytes);
    const { data: same, error: sameErr } = await supabase
      .from("supplier_invoices").select("id,supplier_name,invoice_number,invoice_date")
      .eq("file_sha256", hash).maybeSingle();
    if (sameErr) throw new Error(`duplicate check failed: ${sameErr.message}`);
    if (same) {
      log.warn("file.duplicate", "identical file already stored", { existing: same.id });
      await log.finish("error", { code: "duplicate_file" });
      return json({ ok: false, code: "duplicate_file", existing: same,
        error: "הקובץ הזה כבר הועלה", run_id: log.runId }, 409);
    }

    // ── store, then read ───────────────────────────────────────────────────
    const path = `${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: false });
    if (upErr) throw new Error(`storing the file failed: ${upErr.message}`);

    // A failed read still keeps the invoice: the uploader types the fields.
    let fields: Record<string, unknown> = {};
    let extraction: Record<string, unknown>;
    try {
      const r = await extractInvoice(ANTHROPIC_KEY, mime, b64);
      fields = { ...r.fields };
      extraction = { ok: true, fields: r.fields, raw: r.raw.slice(0, 4000) };
      log.info("extract.done", `${r.fields.supplier_name ?? "?"} #${r.fields.invoice_number ?? "?"}`, r.fields);
    } catch (e) {
      extraction = { ok: false, error: e instanceof Error ? e.message : String(e) };
      log.error("extract.failed", "Claude could not read the invoice", { path }, e);
    }

    const { data: who } = await supabase
      .from("user_roles").select("full_name,email").eq("user_id", userId).maybeSingle();

    const { data: row, error: insErr } = await supabase
      .from("supplier_invoices")
      .insert({
        ...fields,
        file_path: path,
        file_mime: mime,
        file_size: bytes.length,
        file_sha256: hash,
        original_filename: filename,
        extraction,
        uploaded_by: userId,
        uploaded_by_name: who?.full_name || who?.email || null,
      })
      .select("*")
      .single();
    if (insErr) {
      await supabase.storage.from(BUCKET).remove([path]);   // no orphan file
      throw new Error(`saving the invoice failed: ${insErr.message}`);
    }

    // ── the same invoice from another photo / another uploader ─────────────
    // Candidates: this supplier's invoices (by ע.מ, else by the exact name the
    // AI read); duplicates.ts decides. All uploaders' rows — this runs as the
    // service role, so two employees uploading the same paper are caught.
    let possible_duplicates: Array<Record<string, unknown>> = [];
    let invoice = row;
    if (row.supplier_tax_id || row.supplier_name) {
      const q = supabase.from("supplier_invoices")
        .select("id,supplier_name,supplier_tax_id,invoice_number,doc_type,invoice_date,total_incl_vat,status,uploaded_by_name,created_at")
        .neq("id", row.id).order("created_at").limit(200);
      const { data: cands, error: dErr } = row.supplier_tax_id
        ? await q.eq("supplier_tax_id", row.supplier_tax_id)
        : await q.is("supplier_tax_id", null).eq("supplier_name", row.supplier_name);
      if (dErr) log.warn("dup.lookup_failed", dErr.message);
      possible_duplicates = (cands ?? [])
        .map((c) => ({ ...c, reason: duplicateReason(row, c) }))
        .filter((c) => c.reason);
      if (possible_duplicates.length) {
        const { data: marked, error: mErr } = await supabase.from("supplier_invoices")
          .update({ possible_duplicate_of: possible_duplicates[0].id }).eq("id", row.id).select("*").single();
        if (mErr) log.warn("dup.mark_failed", mErr.message);
        else invoice = marked;
        log.info("dup.found", `${possible_duplicates.length} earlier upload(s) look the same`, {
          id: row.id, of: possible_duplicates.map((d) => d.id), reason: possible_duplicates[0].reason,
        });
      }
    }

    await log.finish(extraction.ok ? "success" : "partial", { id: row.id, duplicates: possible_duplicates.length });
    return json({ ok: true, invoice, extracted: extraction.ok === true, possible_duplicates, run_id: log.runId });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("run.throw", "aborted by an unhandled error", {}, err);
    await log.finish("error");
    return json({ ok: false, error: message, run_id: log.runId }, 500);
  }
});
