// Invoice inbox — supplier invoices forwarded by email.
//
// A staff member forwards the supplier's email to invoices@in.minuto.co.il.
// Resend receives it (MX of in.minuto.co.il) and sends `email.received` to
// resend-webhook — metadata only, no file contents. Here:
//
//   1. Only mail addressed to the inbox is handled (any other address at the
//      subdomain falls through to the ordinary event log).
//   2. The full email is fetched from Resend. The sender must be a staff
//      member in user_roles (matched on email, bookkeepers excluded) AND the
//      message must pass DKIM or DMARC for that address. Resend's
//      `authentication` comes from its receiving server, not from headers, so
//      a forged From: fails here. A failure stores nothing.
//   3. Each PDF / image attachment is downloaded and goes through the same
//      path as a page upload (supplier-invoices/ingest.ts), under the sender.
//      Small inline images (signature logos) and unsupported types are skipped.
//
// Everything lands as `pending_review`; the sender confirms it on the page.

// deno-lint-ignore-file no-explicit-any
import type { Logger } from "../_shared/logger.ts";
import { ingestInvoiceFile, MAX_BYTES, MIME_EXT } from "../supplier-invoices/ingest.ts";

export const DEFAULT_INBOX = "invoices@in.minuto.co.il";
/** At most this many files are taken from one email. */
export const MAX_FILES = 10;
/** Inline images below this are signature logos / icons, not invoices. */
export const INLINE_IMAGE_MIN_BYTES = 50_000;
/** Any image below this is too small to be a readable invoice photo. */
export const IMAGE_MIN_BYTES = 10_000;

const lower = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** "Name <a@b.c>" or "a@b.c" → "a@b.c" (lowercase). */
export function bareAddress(s: unknown): string {
  const v = lower(s);
  const m = v.match(/<([^<>\s]+@[^<>\s]+)>/);
  return m ? m[1] : v;
}

/** Is this received email addressed to the invoice inbox (to / cc / forwarded-for)? */
export function isForInbox(data: Record<string, unknown>, inbox: string): boolean {
  const want = lower(inbox);
  if (!want) return false;
  const lists = [data.to, data.cc, data.bcc, data.received_for];
  return lists.some((l) => Array.isArray(l) && l.some((a) => bareAddress(a) === want));
}

/** Resend's receiving-server verdict: DKIM aligned with From, or DMARC, must pass. */
export function senderAuthenticated(auth: unknown): boolean {
  if (!auth || typeof auth !== "object") return false;
  const a = auth as Record<string, unknown>;
  return a.dkim === "pass" || a.dmarc === "pass";
}

export interface StaffRow { user_id: string; email: string | null; full_name?: string | null; role: string }

/** The staff member (not bookkeeper) whose registered email sent this. */
export function findStaff(roles: StaffRow[], from: string): StaffRow | null {
  const addr = bareAddress(from);
  if (!addr) return null;
  return roles.find((r) => r.role !== "bookkeeper" && lower(r.email) === addr) ?? null;
}

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
};

/** The supported mime for an attachment, from its content type or else its extension. */
export function attachmentMime(contentType: unknown, filename: unknown): string | null {
  let ct = lower(contentType).split(";")[0].trim();
  if (ct === "image/jpg" || ct === "image/pjpeg") ct = "image/jpeg";
  if (MIME_EXT[ct]) return ct;
  const ext = lower(filename).split(".").pop() ?? "";
  return EXT_MIME[ext] ?? null;
}

export interface Attachment {
  id: string; filename?: string | null; content_type?: string | null;
  content_disposition?: string | null; size?: number | null; download_url?: string;
}

export type Pick = { att: Attachment; mime: string } | { att: Attachment; skip: string };

/** Decide, per attachment, whether it is taken (and as what) or why it is skipped. */
export function pickAttachments(list: Attachment[]): Pick[] {
  let taken = 0;
  return list.map((att): Pick => {
    const mime = attachmentMime(att.content_type, att.filename);
    if (!mime) return { att, skip: "unsupported_type" };
    const size = typeof att.size === "number" ? att.size : null;
    if (size !== null && size > MAX_BYTES) return { att, skip: "too_large" };
    if (mime.startsWith("image/") && size !== null) {
      if (size < IMAGE_MIN_BYTES) return { att, skip: "tiny_image" };
      if (lower(att.content_disposition) === "inline" && size < INLINE_IMAGE_MIN_BYTES) {
        return { att, skip: "inline_logo" };
      }
    }
    if (taken >= MAX_FILES) return { att, skip: "too_many_files" };
    taken++;
    return { att, mime };
  });
}

export interface InboxDeps {
  supabase: any;
  log: Logger;
  resendKey: string;
  anthropicKey: string;
  fetchFn?: typeof fetch;
}

export interface InboxOutcome {
  code: "stored" | "partial" | "not_staff" | "not_authenticated" | "no_attachments" | "nothing_stored";
  stored: string[];
  /** Attachments that hit an infrastructure error (not a refusal). */
  failed: number;
  skipped: Array<{ filename: string | null; reason: string }>;
}

async function resendGet(path: string, key: string, fetchFn: typeof fetch): Promise<any> {
  const res = await fetchFn(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "coffeeflow-resend-webhook" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Resend GET ${path.split("/").slice(0, 3).join("/")}… ${res.status}: ${body?.message ?? "no body"}`);
  return body;
}

/** Handle one `email.received` addressed to the inbox. Throws only on infrastructure failure. */
export async function handleInboundInvoices(emailId: string, deps: InboxDeps): Promise<InboxOutcome> {
  const { supabase, log, resendKey, anthropicKey } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const out: InboxOutcome = { code: "stored", stored: [], failed: 0, skipped: [] };
  if (!resendKey) throw new Error("RESEND_API_KEY is not set");

  const email = await resendGet(`/emails/receiving/${encodeURIComponent(emailId)}`, resendKey, fetchFn);
  const from = bareAddress(email?.from);
  const subject = typeof email?.subject === "string" ? email.subject.slice(0, 200) : null;

  const { data: roles, error: rErr } = await supabase
    .from("user_roles").select("user_id,email,full_name,role");
  if (rErr) throw new Error(`user_roles lookup failed: ${rErr.message}`);
  const staff = findStaff((roles ?? []) as StaffRow[], from);
  if (!staff) {
    log.warn("inbox.not_staff", "sender is not a registered staff email — nothing stored", { email_id: emailId, from });
    return { ...out, code: "not_staff" };
  }
  if (!senderAuthenticated(email?.authentication)) {
    log.warn("inbox.not_authenticated", "sender failed DKIM and DMARC — nothing stored", {
      email_id: emailId, from, authentication: email?.authentication ?? null,
    });
    return { ...out, code: "not_authenticated" };
  }

  const listed = await resendGet(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`, resendKey, fetchFn);
  const picks = pickAttachments(Array.isArray(listed?.data) ? listed.data : []);
  if (!picks.length) {
    log.warn("inbox.no_attachments", "email has no attachments", { email_id: emailId, from, subject });
    return { ...out, code: "no_attachments" };
  }

  for (const p of picks) {
    const filename = p.att.filename ?? null;
    if ("skip" in p) {
      out.skipped.push({ filename, reason: p.skip });
      log.info("inbox.attachment.skipped", `${filename ?? "?"}: ${p.skip}`, { email_id: emailId, filename, reason: p.skip });
      continue;
    }
    try {
      if (!p.att.download_url) throw new Error("attachment has no download_url");
      const res = await fetchFn(p.att.download_url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const r = await ingestInvoiceFile(supabase, log, anthropicKey, {
        bytes, mime: p.mime, filename, userId: staff.user_id,
        source: { channel: "email", email_id: emailId, from, subject },
      });
      if (r.ok) {
        out.stored.push(r.invoice.id);
        log.info("inbox.attachment.stored", `${filename ?? "?"} → ${r.invoice.id}`, {
          email_id: emailId, id: r.invoice.id, extracted: r.extracted, duplicates: r.possible_duplicates.length,
        });
      } else {
        out.skipped.push({ filename, reason: r.code });
        log.info("inbox.attachment.refused", `${filename ?? "?"}: ${r.code}`, { email_id: emailId, filename, reason: r.code });
      }
    } catch (e) {
      out.failed++;
      out.skipped.push({ filename, reason: "error" });
      log.error("inbox.attachment.failed", `${filename ?? "?"} could not be stored`, { email_id: emailId, filename }, e);
    }
  }

  out.code = out.stored.length === 0 ? "nothing_stored" : out.failed ? "partial" : "stored";
  return out;
}
