// Storing one supplier-invoice file: the steps every upload goes through,
// whoever sent it.
//
// Two callers, one path:
//   • supplier-invoices/index.ts — a staff member uploads from the page.
//   • resend-webhook (inbound_invoices.ts) — a staff member forwards the
//     supplier's email to the invoice inbox.
// Either way the file is checked (type, size, magic bytes), refused when the
// identical file is already stored, put in the private bucket, read by Claude,
// and inserted as `pending_review` under the person who sent it. Nothing here
// is final: that person checks the fields and confirms from the page.
//
// The caller has already decided WHO `userId` is (a verified Clerk token, or a
// staff email whose DKIM/DMARC passed). This module trusts it.

// deno-lint-ignore-file no-explicit-any
import type { Logger } from "../_shared/logger.ts";
import { extractInvoice } from "./extract.ts";
import { duplicateReason } from "./duplicates.ts";

export const BUCKET = "supplier-invoices";

export const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf",
};
// Matches the bucket's file_size_limit (10 MB).
export const MAX_BYTES = 10 * 1024 * 1024;

export function fromBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;   // String.fromCharCode(...) overflows the stack on a whole PDF
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The file must be what it claims: a renamed .exe labelled image/jpeg is not stored.
export function magicMatches(mime: string, b: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  switch (mime) {
    case "image/jpeg":      return starts(0xff, 0xd8, 0xff);
    case "image/png":       return starts(0x89, 0x50, 0x4e, 0x47);
    case "image/webp":      return starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45;
    case "application/pdf": return starts(0x25, 0x50, 0x44, 0x46);
    default:                return false;
  }
}

export interface IngestInput {
  bytes: Uint8Array;
  mime: string;
  filename: string | null;
  userId: string;
  /** Base64 of `bytes`, when the caller already has it (saves re-encoding). */
  b64?: string;
  /** Where the file came from, kept in `extraction.source` (e.g. the email). */
  source?: Record<string, unknown>;
}

export type IngestResult =
  | { ok: true; invoice: any; extracted: boolean; possible_duplicates: Array<Record<string, unknown>> }
  | { ok: false; status: number; code: string; error: string; existing?: unknown };

/**
 * Validate, de-duplicate, store, read and insert one file.
 * Refusals (bad type, too large, corrupt, identical file) come back as
 * `{ ok: false }`; infrastructure failures throw.
 */
export async function ingestInvoiceFile(
  supabase: any, log: Logger, anthropicKey: string, input: IngestInput,
): Promise<IngestResult> {
  const { bytes, mime, userId } = input;
  const filename = input.filename ? input.filename.slice(0, 200) : null;

  // ── validate the file ──────────────────────────────────────────────────
  const ext = MIME_EXT[mime];
  if (!ext) {
    return { ok: false, status: 400, code: "bad_mime", error: "סוג קובץ לא נתמך — תמונה או PDF בלבד" };
  }
  if (bytes.length > MAX_BYTES) {
    return { ok: false, status: 413, code: "too_large", error: "הקובץ גדול מ-10MB" };
  }
  if (bytes.length === 0 || !magicMatches(mime, bytes)) {
    return { ok: false, status: 400, code: "bad_file", error: "הקובץ פגום או אינו תמונה/PDF" };
  }

  // ── the same file twice ────────────────────────────────────────────────
  const hash = await sha256(bytes);
  const { data: same, error: sameErr } = await supabase
    .from("supplier_invoices").select("id,supplier_name,invoice_number,invoice_date")
    .eq("file_sha256", hash).maybeSingle();
  if (sameErr) throw new Error(`duplicate check failed: ${sameErr.message}`);
  if (same) {
    log.warn("file.duplicate", "identical file already stored", { existing: same.id });
    return { ok: false, status: 409, code: "duplicate_file", existing: same, error: "הקובץ הזה כבר הועלה" };
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
    const r = await extractInvoice(anthropicKey, mime, input.b64 ?? toBase64(bytes));
    fields = { ...r.fields };
    extraction = { ok: true, fields: r.fields, raw: r.raw.slice(0, 4000) };
    log.info("extract.done", `${r.fields.supplier_name ?? "?"} #${r.fields.invoice_number ?? "?"}`, r.fields);
  } catch (e) {
    extraction = { ok: false, error: e instanceof Error ? e.message : String(e) };
    log.error("extract.failed", "Claude could not read the invoice", { path }, e);
  }
  if (input.source) extraction.source = input.source;

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
    possible_duplicates = ((cands ?? []) as Array<Record<string, unknown>>)
      .map((c) => ({ ...c, reason: duplicateReason(row, c as any) }))
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

  return { ok: true, invoice, extracted: extraction.ok === true, possible_duplicates };
}
