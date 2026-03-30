/**
 * Generate Campaign — AI-powered email campaign generator
 *
 * Actions:
 *   generate          — AI generates complete Hebrew email campaign
 *   sync-woo-products — refresh WooCommerce product cache
 *   send-campaign     — send via Resend API
 *   send-test         — send test email to specific address
 *   unsubscribe       — handle unsubscribe requests
 *
 * Environment secrets:
 *   ANTHROPIC_API_KEY
 *   RESEND_API_KEY
 *   WOO_URL, WOO_KEY, WOO_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   COFFEEFLOW_ORIGIN
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ──────────────────────────────────────────────────────────────────

const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";
const RESEND_KEY     = Deno.env.get("RESEND_API_KEY")            ?? "";
const WOO_URL        = Deno.env.get("WOO_URL")                  ?? "";
const WOO_KEY        = Deno.env.get("WOO_KEY")                  ?? "";
const WOO_SEC        = Deno.env.get("WOO_SECRET")               ?? "";
const SUPA_URL       = Deno.env.get("SUPABASE_URL")             ?? "";
const SUPA_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN")         ?? "https://coffeeflow-thaf.vercel.app";
const SENDER_EMAIL   = Deno.env.get("SENDER_EMAIL")              ?? "info@minuto.co.il";
const UNSUBSCRIBE_BASE = Deno.env.get("UNSUBSCRIBE_BASE_URL")   ?? `${SUPA_URL}/functions/v1/generate-campaign`;

const corsHeaders = {
  "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const supabase = createClient(SUPA_URL, SUPA_KEY);
const wooAuth  = btoa(`${WOO_KEY}:${WOO_SEC}`);

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

function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function generateUnsubscribeUrl(email: string): string {
  const token = btoa(`${email}:${Date.now()}`);
  return `${UNSUBSCRIBE_BASE}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
}

// ── Israeli Holiday Calendar ────────────────────────────────────────────────

function getSeasonalContext(): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  const holidays: string[] = [];

  // Approximate dates — adjust yearly
  if (month === 9 || (month === 10 && day <= 15)) holidays.push("תקופת החגים (ראש השנה, יום כיפור, סוכות)");
  if (month === 12) holidays.push("חנוכה");
  if (month === 3 || (month === 4 && day <= 15)) holidays.push("פסח");
  if (month === 5 && day <= 15) holidays.push("יום העצמאות");
  if (month === 6) holidays.push("שבועות");
  if (month === 2 && day >= 10 && day <= 20) holidays.push("טו בשבט");

  const seasons: Record<number, string> = {
    1: "חורף — קפה חם ומחמם", 2: "חורף — קפה חם ומחמם",
    3: "אביב — טעמים רעננים", 4: "אביב — טעמים רעננים", 5: "אביב — טעמים רעננים",
    6: "קיץ — קפה קר ומרענן", 7: "קיץ — קפה קר ומרענן", 8: "קיץ — קפה קר ומרענן",
    9: "סתיו — חזרה לשגרה", 10: "סתיו — חזרה לשגרה",
    11: "סתיו — חזרה לשגרה", 12: "חורף — קפה חם ומחמם",
  };

  const monthHebrew = now.toLocaleString("he-IL", { month: "long" });

  return [
    `חודש: ${monthHebrew}`,
    `עונה: ${seasons[month] || ""}`,
    holidays.length > 0 ? `חגים/אירועים: ${holidays.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

// ── Email Template Builder ──────────────────────────────────────────────────

function buildCampaignHtml(params: {
  subject: string;
  preheader: string;
  greeting: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  products: Array<{
    name: string;
    price?: string;
    regular_price?: string;
    sale_price?: string;
    short_description?: string;
    image_url?: string;
    permalink?: string;
  }>;
  unsubscribeUrl: string;
}): string {
  const { subject, preheader, greeting, body, ctaText, ctaUrl, products, unsubscribeUrl } = params;

  const productCards = products.map(p => `
    <tr>
      <td style="padding: 16px 0; border-bottom: 1px solid #EBEFE2;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" dir="rtl">
          <tr>
            ${p.image_url ? `
            <td width="120" style="vertical-align: top; padding-left: 16px;">
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="text-decoration: none;">
                <img src="${escapeHtml(p.image_url)}" width="120" height="120"
                     style="border-radius: 8px; display: block; object-fit: cover; border: 1px solid #eee;"
                     alt="${escapeHtml(p.name)}" />
              </a>
            </td>` : ""}
            <td style="vertical-align: top; direction: rtl; text-align: right;">
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="font-size: 16px; font-weight: 600; color: #3D4A2E; text-decoration: none;">
                ${escapeHtml(p.name)}
              </a>
              ${p.sale_price && p.regular_price && p.sale_price !== p.regular_price ? `
                <div style="margin: 4px 0;">
                  <span style="font-size: 14px; color: #999; text-decoration: line-through;">₪${escapeHtml(p.regular_price)}</span>
                  <span style="font-size: 18px; color: #DC2626; font-weight: 700; margin-right: 8px;">₪${escapeHtml(p.sale_price)}</span>
                </div>` : p.price ? `<div style="font-size: 18px; color: #556B3A; font-weight: 700; margin: 4px 0;">₪${escapeHtml(p.price)}</div>` : ""}
              ${p.short_description ? `<div style="font-size: 13px; color: #666; line-height: 1.4; margin-top: 4px;">${p.short_description}</div>` : ""}
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="display: inline-block; margin-top: 8px; padding: 6px 16px; background: #556B3A; color: white; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600;">
                לרכישה
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background: #F5F5F0; font-family: Arial, Helvetica, sans-serif;">
  ${preheader ? `<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${escapeHtml(preheader)}</div>` : ""}
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #F5F5F0;">
    <tr><td align="center" style="padding: 24px 16px;">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background: linear-gradient(135deg, #3D4A2E, #556B3A); padding: 28px 24px; text-align: center;">
            <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: 1px;">Minuto</h1>
            <p style="margin: 6px 0 0; color: #B5C69A; font-size: 14px;">קפה ובית קלייה</p>
          </td>
        </tr>
        ${greeting ? `
        <tr>
          <td style="padding: 24px 32px 0; font-size: 18px; font-weight: 600; color: #3D4A2E; direction: rtl; text-align: right;">
            ${escapeHtml(greeting)}
          </td>
        </tr>` : ""}
        <tr>
          <td style="padding: 16px 32px 24px; font-size: 15px; line-height: 1.8; color: #333; direction: rtl; text-align: right;">
            ${body.replace(/\n/g, "<br>")}
          </td>
        </tr>
        ${ctaText ? `
        <tr>
          <td style="padding: 0 32px 24px; text-align: center;">
            <a href="${escapeHtml(ctaUrl)}" style="display: inline-block; padding: 14px 32px; background: #3D4A2E; color: white; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 700;">
              ${escapeHtml(ctaText)}
            </a>
          </td>
        </tr>` : ""}
        ${products.length > 0 ? `
        <tr>
          <td style="padding: 0 32px 8px;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td style="padding-bottom: 12px; font-size: 18px; font-weight: 700; color: #3D4A2E; border-bottom: 2px solid #B5C69A; direction: rtl; text-align: right;">
                  ☕ מוצרים מומלצים
                </td>
              </tr>
              ${productCards}
            </table>
          </td>
        </tr>` : ""}
        <tr><td style="height: 16px;"></td></tr>
        <tr>
          <td style="background: #EBEFE2; padding: 20px 32px; text-align: center; font-size: 12px; color: #666;">
            <p style="margin: 0; font-weight: 600;">Minuto Café & Roastery</p>
            <p style="margin: 6px 0 0; color: #888;">קפה טרי מהקלייה — ישירות אליך</p>
            <p style="margin: 12px 0 0;">
              <a href="${escapeHtml(unsubscribeUrl)}" style="color: #556B3A; text-decoration: underline; font-size: 11px;">להסרה מרשימת התפוצה</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Sync WooCommerce Products ───────────────────────────────────────────────

async function handleSyncWooProducts(userId: string) {
  if (!WOO_URL || !WOO_KEY) return err(500, "WooCommerce credentials not configured");

  let page = 1;
  let allProducts: any[] = [];

  while (true) {
    const res = await fetch(
      `${WOO_URL}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish`,
      { headers: { Authorization: `Basic ${wooAuth}` } }
    );
    if (!res.ok) return err(500, `WooCommerce API error: ${res.status}`);
    const products = await res.json();
    if (!products || products.length === 0) break;
    allProducts = allProducts.concat(products);
    if (products.length < 100) break;
    page++;
  }

  let synced = 0;
  for (const p of allProducts) {
    const { error: dbErr } = await supabase
      .from("woo_products")
      .upsert({
        user_id:           userId,
        woo_id:            p.id,
        name:              p.name || "",
        slug:              p.slug || "",
        permalink:         p.permalink || "",
        price:             p.price || "",
        regular_price:     p.regular_price || "",
        sale_price:        p.sale_price || "",
        short_description: (p.short_description || "").replace(/<[^>]*>/g, "").trim(),
        image_url:         p.images?.[0]?.src || "",
        image_urls:        (p.images || []).map((img: any) => img.src),
        categories:        (p.categories || []).map((c: any) => c.name),
        stock_status:      p.stock_status || "instock",
        sku:               p.sku || "",
        synced_at:         new Date().toISOString(),
      }, { onConflict: "user_id,woo_id" });

    if (!dbErr) synced++;
    else console.error("Sync error:", dbErr);
  }

  return ok({ ok: true, synced, total: allProducts.length });
}

// ── Auto-sync if stale ──────────────────────────────────────────────────────

async function ensureProductsFresh(userId: string): Promise<void> {
  const { data } = await supabase
    .from("woo_products")
    .select("synced_at")
    .eq("user_id", userId)
    .order("synced_at", { ascending: false })
    .limit(1);

  const lastSync = data?.[0]?.synced_at;
  const staleHours = 6;
  const isStale = !lastSync || (Date.now() - new Date(lastSync).getTime()) > staleHours * 60 * 60 * 1000;

  if (isStale && WOO_URL && WOO_KEY) {
    console.log("Products stale, syncing...");
    await handleSyncWooProducts(userId);
  }
}

// ── AI Generate Campaign ────────────────────────────────────────────────────

interface GeneratePayload {
  userId: string;
  customInstructions?: string;
  campaignType?: string;
}

async function handleGenerate(p: GeneratePayload) {
  if (!ANTHROPIC_KEY) return err(500, "ANTHROPIC_API_KEY not configured");

  // 1. Ensure products are fresh
  await ensureProductsFresh(p.userId);

  // 2. Fetch available products
  const { data: wooProducts } = await supabase
    .from("woo_products")
    .select("*")
    .eq("user_id", p.userId)
    .eq("stock_status", "instock");

  const productCatalog = (wooProducts || []).map((pr: any) => ({
    woo_id: pr.woo_id,
    name: pr.name,
    price: pr.price,
    regular_price: pr.regular_price,
    sale_price: pr.sale_price,
    categories: pr.categories,
    short_description: pr.short_description?.slice(0, 100),
  }));

  // 3. Fetch past campaigns to avoid repetition
  const { data: pastCampaigns } = await supabase
    .from("campaigns")
    .select("subject, created_at")
    .eq("user_id", p.userId)
    .eq("channel", "email")
    .order("created_at", { ascending: false })
    .limit(10);

  const pastSubjects = (pastCampaigns || []).map((c: any) => c.subject).filter(Boolean);

  // 4. Seasonal context
  const seasonalContext = getSeasonalContext();

  // 5. Call Claude AI
  const systemPrompt = `אתה קופירייטר שיווקי מומחה לבתי קלייה ובתי קפה בוטיק בישראל.
אתה כותב עבור "מינוטו" — בית קלייה ובית קפה ישראלי.

המטרה: ליצור ניוזלטר שבועי שמשלב תוכן ערך עם הצעת מוצרים, בטון חם ואישי.

כללים:
- כתוב בעברית תקנית
- הטון: חם, מקצועי, לא מכירתי מדי. כמו מכתב מבעל בית הקלייה ללקוחות שלו
- אורך: 150-250 מילים לגוף ההודעה
- תמיד כלול: פתיח מעניין (טיפ/סיפור/עובדה על קפה), גוף עם ערך, סיום עם הזמנה לפעולה
- אל תחזור על נושאים מקמפיינים קודמים
- התחשב בעונתיות ובחגים ישראליים
- בחר 2-4 מוצרים מהקטלוג שמתאימים לנושא הקמפיין

${seasonalContext}

נושאים קודמים (הימנע מחזרה): ${pastSubjects.join(", ") || "אין"}

קטלוג מוצרים זמינים:
${JSON.stringify(productCatalog, null, 2)}

${p.customInstructions ? `הנחיות מיוחדות מהמשתמש: ${p.customInstructions}` : ""}

החזר JSON בלבד, ללא טקסט נוסף:
{
  "subject": "שורת נושא (עד 60 תווים, מושכת, עם אימוג'י אחד)",
  "preheader": "טקסט קדם-כותרת (עד 90 תווים)",
  "greeting": "פתיח קצר (שורה אחת, למשל: שלום חובבי קפה ☕)",
  "body": "גוף ההודעה בעברית. השתמש ב-\\n לשבירת שורות. כלול תוכן ערך + המלצה טבעית למוצרים",
  "cta_text": "טקסט לכפתור הפעולה",
  "cta_url": "https://minuto.co.il/shop",
  "product_ids": [מערך של woo_id לפי הקטלוג למעלה],
  "campaign_theme": "tips|story|promo|seasonal|education"
}`;

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5",
      max_tokens: 1500,
      system:     systemPrompt,
      messages:   [{ role: "user", content: p.customInstructions || "צור קמפיין שבועי מושלם" }],
    }),
  });

  const aiJson = await aiRes.json();
  const rawText = aiJson.content?.[0]?.text ?? "";

  let campaign: any;
  try {
    const clean = rawText.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    campaign = JSON.parse(clean);
  } catch {
    console.error("AI parse error:", rawText);
    return err(500, "Failed to parse AI response");
  }

  // 6. Match selected products with full data
  const selectedIds = campaign.product_ids || [];
  const selectedProducts = (wooProducts || [])
    .filter((pr: any) => selectedIds.includes(pr.woo_id))
    .map((pr: any) => ({
      woo_id:            pr.woo_id,
      name:              pr.name,
      price:             pr.price,
      regular_price:     pr.regular_price,
      sale_price:        pr.sale_price,
      short_description: pr.short_description,
      image_url:         pr.image_url,
      permalink:         pr.permalink,
    }));

  // 7. Build HTML — unsubscribe URL is a placeholder, replaced per-recipient at send time
  const htmlContent = buildCampaignHtml({
    subject:        campaign.subject,
    preheader:      campaign.preheader || "",
    greeting:       campaign.greeting || "",
    body:           campaign.body,
    ctaText:        campaign.cta_text || "לחנות",
    ctaUrl:         campaign.cta_url || "https://minuto.co.il/shop",
    products:       selectedProducts,
    unsubscribeUrl: "{{UNSUBSCRIBE_URL}}",
  });

  // 8. Save draft
  const { data: inserted, error: insertErr } = await supabase
    .from("campaigns")
    .insert({
      user_id:         p.userId,
      channel:         "email",
      subject:         campaign.subject,
      message:         campaign.body,
      html_content:    htmlContent,
      status:          "draft",
      campaign_type:   p.campaignType || "auto",
      product_ids:     selectedIds.map(String),
      preheader:       campaign.preheader,
      cta_text:        campaign.cta_text,
      cta_url:         campaign.cta_url,
    })
    .select()
    .single();

  if (insertErr) return err(500, insertErr.message);

  return ok({
    ok:       true,
    campaign: {
      id:          inserted.id,
      subject:     campaign.subject,
      preheader:   campaign.preheader,
      greeting:    campaign.greeting,
      body:        campaign.body,
      ctaText:     campaign.cta_text,
      ctaUrl:      campaign.cta_url,
      theme:       campaign.campaign_theme,
      products:    selectedProducts,
      htmlContent,
    },
  });
}

// ── Send Campaign via Resend ────────────────────────────────────────────────

interface SendCampaignPayload {
  userId:     string;
  campaignId: number;
  testEmail?: string;  // if provided, send only to this address
}

async function handleSendCampaign(p: SendCampaignPayload) {
  if (!RESEND_KEY) return err(500, "RESEND_API_KEY not configured");

  // Fetch campaign
  const { data: campaign, error: campErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", p.campaignId)
    .eq("user_id", p.userId)
    .single();

  if (campErr || !campaign) return err(404, "Campaign not found");

  // Determine recipients
  let recipients: Array<{ email: string; name?: string }>;

  if (p.testEmail) {
    recipients = [{ email: p.testEmail }];
  } else {
    const { data: contacts } = await supabase
      .from("marketing_contacts")
      .select("email, name")
      .eq("user_id", p.userId)
      .eq("opted_in", true);

    recipients = (contacts || []).map((c: any) => ({ email: c.email, name: c.name || undefined }));
  }

  if (recipients.length === 0) return err(400, "No recipients");

  // Send via Resend — batch in groups of 50
  const batchSize = 50;
  let sent = 0;
  let errors: string[] = [];

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);

    for (const recipient of batch) {
      // Replace unsubscribe placeholder with personalized URL
      const unsubUrl = generateUnsubscribeUrl(recipient.email);
      const personalizedHtml = campaign.html_content.replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsubUrl);

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from:    `Minuto <${SENDER_EMAIL}>`,
            to:      [recipient.email],
            subject: campaign.subject,
            html:    personalizedHtml,
            headers: {
              "List-Unsubscribe": `<${unsubUrl}>`,
            },
          }),
        });

        if (res.ok) {
          sent++;
        } else {
          const errBody = await res.json();
          errors.push(`${recipient.email}: ${errBody.message || res.status}`);
        }
      } catch (e: any) {
        errors.push(`${recipient.email}: ${e.message}`);
      }
    }

    // Small delay between batches to avoid rate limits
    if (i + batchSize < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  // Update campaign status
  if (!p.testEmail) {
    await supabase
      .from("campaigns")
      .update({
        status:          sent > 0 ? "sent" : "failed",
        recipient_count: sent,
        sent_at:         new Date().toISOString(),
        error:           errors.length > 0 ? errors.slice(0, 5).join("; ") : null,
      })
      .eq("id", p.campaignId);
  }

  return ok({
    ok:    true,
    sent,
    total: recipients.length,
    errors: errors.length,
    isTest: !!p.testEmail,
  });
}

// ── Unsubscribe Handler ─────────────────────────────────────────────────────

async function handleUnsubscribe(url: URL): Promise<Response> {
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("token");

  if (!email || !token) {
    return new Response(htmlPage("שגיאה", "קישור לא תקין."), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Update all user records for this email
  const { error: dbErr } = await supabase
    .from("marketing_contacts")
    .update({ opted_in: false, updated_at: new Date().toISOString() })
    .eq("email", email.toLowerCase().trim());

  if (dbErr) {
    console.error("Unsubscribe error:", dbErr);
  }

  return new Response(
    htmlPage(
      "הוסרת בהצלחה",
      `<p>הכתובת <strong>${escapeHtml(email)}</strong> הוסרה מרשימת התפוצה של מינוטו.</p>
       <p>לא תקבל/י יותר מיילים שיווקיים מאיתנו.</p>
       <p style="margin-top: 24px; color: #888; font-size: 14px;">תודה, צוות מינוטו ☕</p>`
    ),
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Minuto</title></head>
<body style="margin: 0; padding: 40px 20px; background: #F5F5F0; font-family: Arial, sans-serif; direction: rtl; text-align: center;">
  <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
    <h1 style="color: #3D4A2E; font-size: 24px; margin-bottom: 16px;">${title}</h1>
    <div style="font-size: 16px; line-height: 1.6; color: #333;">${body}</div>
  </div>
</body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // GET request — unsubscribe handler
  if (req.method === "GET" && url.searchParams.get("action") === "unsubscribe") {
    return handleUnsubscribe(url);
  }

  // POST requests — all other actions
  try {
    const body = await req.json();
    const { action, ...payload } = body;

    switch (action) {
      case "generate":
        return await handleGenerate(payload as GeneratePayload);
      case "sync-woo-products":
        return await handleSyncWooProducts(payload.userId);
      case "send-campaign":
        return await handleSendCampaign(payload as SendCampaignPayload);
      case "send-test":
        return await handleSendCampaign({ ...payload, testEmail: payload.testEmail } as SendCampaignPayload);
      default:
        return err(400, `Unknown action: ${action}`);
    }
  } catch (e: any) {
    console.error("Edge function error:", e);
    return err(500, e.message || "Internal error");
  }
});
