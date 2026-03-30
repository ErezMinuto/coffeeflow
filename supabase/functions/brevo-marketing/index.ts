/**
 * Brevo Marketing — Supabase Edge Function
 *
 * Actions:
 *   send-email      — send email campaign to opted-in contacts
 *   send-whatsapp   — send WhatsApp message to opted-in contacts
 *   sync-contacts   — upsert contacts locally + sync to Brevo
 *   import-woo      — import WooCommerce customers (opted_in = false)
 *   suggest-content  — AI-generated email content ideas
 *
 * Environment secrets:
 *   BREVO_API_KEY
 *   ANTHROPIC_API_KEY
 *   COFFEEFLOW_ORIGIN
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ──────────────────────────────────────────────────────────────────

const BREVO_KEY      = Deno.env.get("BREVO_API_KEY")                ?? "";
const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")            ?? "";
const SUPA_URL       = Deno.env.get("SUPABASE_URL")                 ?? "";
const SUPA_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")    ?? "";
const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN")            ?? "https://coffeeflow-thaf.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function brevoFetch(path: string, body: unknown) {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: "POST",
    headers: {
      "api-key":      BREVO_KEY,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `Brevo ${res.status}`);
  return json;
}

// ── Send Email ──────────────────────────────────────────────────────────────

interface SendEmailPayload {
  userId:      string;
  subject:     string;
  htmlContent: string;
  senderName?: string;
  senderEmail?: string;
}

async function handleSendEmail(p: SendEmailPayload) {
  if (!BREVO_KEY) return err(500, "BREVO_API_KEY not configured");
  if (!p.subject || !p.htmlContent) return err(400, "subject and htmlContent required");

  // Fetch opted-in contacts
  const { data: contacts, error: dbErr } = await supabase
    .from("marketing_contacts")
    .select("email, name")
    .eq("user_id", p.userId)
    .eq("opted_in", true);

  if (dbErr) return err(500, dbErr.message);
  if (!contacts || contacts.length === 0) return err(400, "No opted-in contacts");

  const to = contacts.map((c: any) => ({ email: c.email, name: c.name || undefined }));

  try {
    // Brevo limits ~50 recipients per transactional call — batch if needed
    const batchSize = 50;
    for (let i = 0; i < to.length; i += batchSize) {
      const batch = to.slice(i, i + batchSize);
      await brevoFetch("/smtp/email", {
        sender: { name: p.senderName || "Minuto", email: p.senderEmail || "noreply@minuto.co.il" },
        to: batch,
        subject: p.subject,
        htmlContent: p.htmlContent,
      });
    }

    // Log campaign
    await supabase.from("campaigns").insert({
      user_id:         p.userId,
      channel:         "email",
      subject:         p.subject,
      html_content:    p.htmlContent,
      recipient_count: to.length,
      status:          "sent",
      sent_at:         new Date().toISOString(),
    });

    return ok({ ok: true, recipientCount: to.length });
  } catch (e: any) {
    await supabase.from("campaigns").insert({
      user_id:  p.userId,
      channel:  "email",
      subject:  p.subject,
      status:   "failed",
      error:    e.message,
    });
    return err(500, e.message);
  }
}

// ── Send WhatsApp ───────────────────────────────────────────────────────────

interface SendWhatsAppPayload {
  userId:       string;
  templateId?:  number;
  text?:        string;
  senderNumber: string;
  params?:      Record<string, string>;
}

async function handleSendWhatsApp(p: SendWhatsAppPayload) {
  if (!BREVO_KEY) return err(500, "BREVO_API_KEY not configured");
  if (!p.senderNumber) return err(400, "senderNumber required");
  if (!p.templateId && !p.text) return err(400, "templateId or text required");

  const { data: contacts, error: dbErr } = await supabase
    .from("marketing_contacts")
    .select("phone, name")
    .eq("user_id", p.userId)
    .eq("opted_in", true)
    .not("phone", "is", null);

  if (dbErr) return err(500, dbErr.message);
  if (!contacts || contacts.length === 0) return err(400, "No opted-in contacts with phone numbers");

  const contactNumbers = contacts.map((c: any) => c.phone.replace(/[^0-9+]/g, ""));

  try {
    const body: any = {
      senderNumber: p.senderNumber,
      contactNumbers,
    };

    if (p.templateId) {
      body.templateId = p.templateId;
      if (p.params) body.params = p.params;
    } else {
      body.text = p.text;
    }

    await brevoFetch("/whatsapp/sendMessage", body);

    await supabase.from("campaigns").insert({
      user_id:         p.userId,
      channel:         "whatsapp",
      subject:         p.text || `Template #${p.templateId}`,
      recipient_count: contactNumbers.length,
      status:          "sent",
      sent_at:         new Date().toISOString(),
    });

    return ok({ ok: true, recipientCount: contactNumbers.length });
  } catch (e: any) {
    await supabase.from("campaigns").insert({
      user_id: p.userId,
      channel: "whatsapp",
      status:  "failed",
      error:   e.message,
    });
    return err(500, e.message);
  }
}

// ── Sync Contacts ───────────────────────────────────────────────────────────

interface SyncContactsPayload {
  userId:   string;
  contacts: Array<{ email: string; name?: string; phone?: string; opted_in?: boolean }>;
  source?:  string;
}

async function handleSyncContacts(p: SyncContactsPayload) {
  if (!p.contacts || p.contacts.length === 0) return err(400, "contacts array required");

  let synced = 0;
  for (const c of p.contacts) {
    if (!c.email) continue;

    // Upsert locally
    const { error: dbErr } = await supabase
      .from("marketing_contacts")
      .upsert(
        {
          user_id:    p.userId,
          email:      c.email.toLowerCase().trim(),
          name:       c.name || null,
          phone:      c.phone || null,
          source:     p.source || "manual",
          opted_in:   c.opted_in ?? false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,email" }
      );

    if (dbErr) { console.error("Upsert error:", dbErr); continue; }

    // Sync to Brevo if API key configured
    if (BREVO_KEY) {
      try {
        await brevoFetch("/contacts", {
          email:         c.email.toLowerCase().trim(),
          attributes:    { FIRSTNAME: c.name || "", SMS: c.phone || "" },
          updateEnabled: true,
        });
      } catch (e: any) {
        console.error("Brevo sync error:", e.message);
      }
    }

    synced++;
  }

  return ok({ ok: true, synced });
}

// ── Import from WooCommerce ─────────────────────────────────────────────────

interface ImportWooPayload {
  userId:         string;
  wooUrl:         string;
  consumerKey:    string;
  consumerSecret: string;
}

async function handleImportWoo(p: ImportWooPayload) {
  if (!p.wooUrl || !p.consumerKey || !p.consumerSecret) {
    return err(400, "wooUrl, consumerKey, consumerSecret required");
  }

  const baseUrl = p.wooUrl.replace(/\/+$/, "");
  const auth = btoa(`${p.consumerKey}:${p.consumerSecret}`);
  let page = 1;
  let allCustomers: any[] = [];

  // Paginate through WooCommerce customers
  while (true) {
    const res = await fetch(
      `${baseUrl}/wp-json/wc/v3/customers?per_page=100&page=${page}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) return err(500, `WooCommerce API error: ${res.status}`);
    const customers = await res.json();
    if (!customers || customers.length === 0) break;
    allCustomers = allCustomers.concat(customers);
    if (customers.length < 100) break;
    page++;
  }

  // Map to contacts — opted_in defaults to false
  const contacts = allCustomers
    .filter((c: any) => c.email)
    .map((c: any) => ({
      email:    c.email,
      name:     [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
      phone:    c.billing?.phone || null,
      opted_in: false,
    }));

  // Reuse sync handler
  return handleSyncContacts({ userId: p.userId, contacts, source: "woocommerce" });
}

// ── AI Content Suggestions ──────────────────────────────────────────────────

interface SuggestContentPayload {
  userId:       string;
  products?:    Array<{ name: string; description?: string }>;
  pastSubjects?: string[];
}

async function handleSuggestContent(p: SuggestContentPayload) {
  if (!ANTHROPIC_KEY) return err(500, "ANTHROPIC_API_KEY not configured");

  const productList = (p.products || []).map(pr => pr.name).join(", ") || "אין מוצרים";
  const pastList    = (p.pastSubjects || []).slice(0, 10).join(", ") || "אין";

  const now = new Date();
  const month = now.toLocaleString("he-IL", { month: "long" });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5",
      max_tokens: 800,
      system: `אתה יועץ שיווק דיגיטלי לבית קלייה ובית קפה ישראלי בשם "מינוטו".
צור 4 רעיונות לניוזלטר שבועי במייל. לא רק מכירה ישירה — גם תוכן ערך, טיפים, סיפורים וחינוך.

המוצרים הנוכחיים: ${productList}
נושאים קודמים (הימנע מחזרה): ${pastList}
חודש נוכחי: ${month}

החזר JSON בלבד, ללא טקסט נוסף:
[
  {
    "type": "tips" | "story" | "promo" | "seasonal" | "education",
    "title": "כותרת המייל",
    "preview": "2-3 משפטים שמתארים את התוכן",
    "subject": "שורת נושא מוצעת למייל"
  }
]`,
      messages: [{ role: "user", content: "צור 4 רעיונות לניוזלטר השבועי" }],
    }),
  });

  const json = await res.json();
  const raw  = json.content?.[0]?.text ?? "";

  try {
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const ideas = JSON.parse(clean);
    return ok({ ideas });
  } catch {
    console.error("Claude parse error:", raw);
    return err(500, "Failed to parse AI suggestions");
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, ...payload } = body;

    switch (action) {
      case "send-email":       return await handleSendEmail(payload as SendEmailPayload);
      case "send-whatsapp":    return await handleSendWhatsApp(payload as SendWhatsAppPayload);
      case "sync-contacts":    return await handleSyncContacts(payload as SyncContactsPayload);
      case "import-woo":       return await handleImportWoo(payload as ImportWooPayload);
      case "suggest-content":  return await handleSuggestContent(payload as SuggestContentPayload);
      default:                 return err(400, `Unknown action: ${action}`);
    }
  } catch (e: any) {
    console.error("Edge function error:", e);
    return err(500, e.message || "Internal error");
  }
});
