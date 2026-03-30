/**
 * Generate Campaign -AI-powered email campaign generator
 * With Gemini Imagen banner generation + Resend delivery
 *
 * Actions:
 *   generate          -AI generates complete Hebrew email campaign + banner image
 *   update-draft      -save edits to a draft campaign
 *   sync-woo-products -refresh WooCommerce product cache
 *   send-campaign     -send via Resend API
 *   send-test         -send test email to specific address
 *   unsubscribe       -handle unsubscribe requests (GET)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ──────────────────────────────────────────────────────────────────

const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";
const GEMINI_KEY     = Deno.env.get("GEMINI_API_KEY")            ?? "";
const RESEND_KEY     = Deno.env.get("RESEND_API_KEY")            ?? "";
const WOO_URL        = Deno.env.get("WOO_URL")                  ?? "";
const WOO_KEY        = Deno.env.get("WOO_KEY")                  ?? "";
const WOO_SEC        = Deno.env.get("WOO_SECRET")               ?? "";
const SUPA_URL       = Deno.env.get("SUPABASE_URL")             ?? "";
const SUPA_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN")         ?? "https://coffeeflow-thaf.vercel.app";
const SENDER_EMAIL   = Deno.env.get("SENDER_EMAIL")              ?? "info@minuto.co.il";
const UNSUBSCRIBE_BASE = Deno.env.get("UNSUBSCRIBE_BASE_URL")   ?? `${SUPA_URL}/functions/v1/generate-campaign`;
const LOGO_URL       = "https://minuto.co.il/content/uploads/2025/03/Frame-14.png";
const SITE_URL       = "https://minuto.co.il";

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

// ── Gemini Imagen -Generate Banner Image ───────────────────────────────────

async function generateBannerImage(prompt: string): Promise<string | null> {
  if (!GEMINI_KEY) {
    console.log("No GEMINI_API_KEY, skipping banner generation");
    return null;
  }

  try {
    const imagePrompt = `Professional email marketing banner for an artisan coffee roastery. Style: warm, inviting, premium feel. Colors: earthy greens, warm browns, cream tones. NO TEXT in the image. NO letters, NO words. Photographic style, high quality, wide landscape format. Theme: ${prompt}`;

    let base64: string | null = null;
    let mime = "image/png";

    // Try models in order: Imagen 4 -> Gemini 2.0 Flash -> Gemini 2.0 Flash Preview
    const attempts = [
      {
        name: "Imagen 4",
        url: `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict`,
        headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
        body: { instances: [{ prompt: imagePrompt }], parameters: { sampleCount: 1, aspectRatio: "16:9" } },
        parse: (json: any) => {
          const pred = json.predictions?.[0];
          return pred?.bytesBase64Encoded ? { data: pred.bytesBase64Encoded, mime: pred.mimeType || "image/png" } : null;
        },
      },
      {
        name: "Gemini 2.0 Flash Preview Image",
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GEMINI_KEY}`,
        headers: { "Content-Type": "application/json" },
        body: { contents: [{ parts: [{ text: `Generate an image: ${imagePrompt}` }] }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } },
        parse: (json: any) => {
          for (const part of json.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData?.mimeType?.startsWith("image/")) return { data: part.inlineData.data, mime: part.inlineData.mimeType };
          }
          return null;
        },
      },
      {
        name: "Gemini 2.0 Flash Exp",
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GEMINI_KEY}`,
        headers: { "Content-Type": "application/json" },
        body: { contents: [{ parts: [{ text: `Generate an image: ${imagePrompt}` }] }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } },
        parse: (json: any) => {
          for (const part of json.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData?.mimeType?.startsWith("image/")) return { data: part.inlineData.data, mime: part.inlineData.mimeType };
          }
          return null;
        },
      },
    ];

    for (const attempt of attempts) {
      if (base64) break;
      try {
        console.log(`Trying ${attempt.name}...`);
        const res = await fetch(attempt.url, {
          method: "POST",
          headers: attempt.headers,
          body: JSON.stringify(attempt.body),
        });
        if (res.ok) {
          const json = await res.json();
          const result = attempt.parse(json);
          if (result) {
            base64 = result.data;
            mime = result.mime;
            console.log(`Banner generated via ${attempt.name}`);
          } else {
            console.log(`${attempt.name}: no image in response`);
          }
        } else {
          const errText = await res.text().catch(() => "");
          console.log(`${attempt.name} failed: ${res.status} ${errText.slice(0, 200)}`);
        }
      } catch (e: any) {
        console.log(`${attempt.name} error: ${e.message}`);
      }
    }

    if (base64) {
      console.log("Banner base64 length:", base64.length, "mime:", mime);
      const filename = `banners/campaign_${Date.now()}.${mime.includes("png") ? "png" : "jpg"}`;
      const fileBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      console.log("Uploading banner:", filename, "size:", fileBytes.length);

      const { error: uploadErr } = await supabase.storage
        .from("marketing")
        .upload(filename, fileBytes, { contentType: mime, upsert: true });

      if (uploadErr) {
        console.error("Upload error:", JSON.stringify(uploadErr));
        return null;
      }

      const { data: publicUrl } = supabase.storage
        .from("marketing")
        .getPublicUrl(filename);

      console.log("Banner URL:", publicUrl?.publicUrl);
      return publicUrl?.publicUrl || null;
    }

    console.log("No image in Gemini response:", JSON.stringify(json).slice(0, 200));
    return null;
  } catch (e: any) {
    console.error("Banner generation error:", e.message);
    return null;
  }
}

// ── Israeli Holiday Calendar ────────────────────────────────────────────────

function getSeasonalContext(): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const holidays: string[] = [];

  if (month === 9 || (month === 10 && day <= 15)) holidays.push("תקופת החגים (ראש השנה, יום כיפור, סוכות)");
  if (month === 12) holidays.push("חנוכה");
  if (month === 3 || (month === 4 && day <= 15)) holidays.push("פסח");
  if (month === 5 && day <= 15) holidays.push("יום העצמאות");
  if (month === 6) holidays.push("שבועות");
  if (month === 2 && day >= 10 && day <= 20) holidays.push("טו בשבט");

  const seasons: Record<number, string> = {
    1: "חורף -קפה חם ומחמם", 2: "חורף -קפה חם ומחמם",
    3: "אביב -טעמים רעננים", 4: "אביב -טעמים רעננים", 5: "אביב -טעמים רעננים",
    6: "קיץ -קפה קר ומרענן", 7: "קיץ -קפה קר ומרענן", 8: "קיץ -קפה קר ומרענן",
    9: "סתיו -חזרה לשגרה", 10: "סתיו -חזרה לשגרה",
    11: "סתיו -חזרה לשגרה", 12: "חורף -קפה חם ומחמם",
  };

  return [
    `חודש: ${now.toLocaleString("he-IL", { month: "long" })}`,
    `עונה: ${seasons[month] || ""}`,
    holidays.length > 0 ? `חגים/אירועים: ${holidays.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

// ── Professional Email Template ─────────────────────────────────────────────

function buildCampaignHtml(params: {
  subject: string;
  preheader: string;
  greeting: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  bannerUrl?: string | null;
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
  const { subject, preheader, greeting, body, ctaText, ctaUrl, bannerUrl, products, unsubscribeUrl } = params;

  // Product cards -2-column grid for desktop
  const productCardsHtml = products.map(p => {
    const hasDiscount = p.sale_price && p.regular_price && p.sale_price !== p.regular_price;
    const priceHtml = hasDiscount
      ? `<span style="text-decoration:line-through;color:#999;font-size:13px;">₪${escapeHtml(p.regular_price!)}</span>
         <span style="color:#DC2626;font-weight:800;font-size:18px;margin-right:6px;">₪${escapeHtml(p.sale_price!)}</span>`
      : p.price ? `<span style="color:#3D4A2E;font-weight:800;font-size:18px;">₪${escapeHtml(p.price)}</span>` : "";

    return `
    <!--[if mso]><td valign="top" width="260"><![endif]-->
    <div style="display:inline-block;vertical-align:top;width:100%;max-width:260px;margin:0 auto;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:16px;">
        <tr><td style="padding:8px;">
          <div style="background:#FAFAF7;border-radius:12px;overflow:hidden;border:1px solid #E8E8E0;">
            ${p.image_url ? `
            <a href="${escapeHtml(p.permalink || ctaUrl)}" style="text-decoration:none;">
              <img src="${escapeHtml(p.image_url)}" width="244" height="180"
                   style="display:block;width:100%;height:180px;object-fit:cover;" alt="${escapeHtml(p.name)}" />
            </a>` : ""}
            <div style="padding:14px;direction:rtl;text-align:right;">
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="font-size:15px;font-weight:700;color:#3D4A2E;text-decoration:none;display:block;margin-bottom:6px;">
                ${escapeHtml(p.name)}
              </a>
              ${priceHtml ? `<div style="margin-bottom:8px;">${priceHtml}</div>` : ""}
              ${p.short_description ? `<div style="font-size:12px;color:#888;line-height:1.4;margin-bottom:10px;">${p.short_description.slice(0, 80)}</div>` : ""}
              <a href="${escapeHtml(p.permalink || ctaUrl)}" style="display:inline-block;padding:8px 20px;background:#556B3A;color:white;border-radius:20px;text-decoration:none;font-size:13px;font-weight:600;">
                לרכישה →
              </a>
            </div>
          </div>
        </td></tr>
      </table>
    </div>
    <!--[if mso]></td><![endif]-->`;
  }).join("");

  return `<!DOCTYPE html>
<html dir="rtl" lang="he" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(subject)}</title>
  <style>
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; }
      .fluid { width: 100% !important; max-width: 100% !important; height: auto !important; }
      .stack { display: block !important; width: 100% !important; max-width: 100% !important; }
      .product-grid div { display: block !important; width: 100% !important; max-width: 100% !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#EFEDE8;font-family:'Segoe UI',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  ${preheader ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>` : ""}

  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#EFEDE8;">
    <tr><td align="center" style="padding:24px 12px;">
      <table class="email-container" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">

        <!-- Logo Bar -->
        <tr>
          <td style="padding:20px 32px;text-align:center;border-bottom:1px solid #F0EDE8;">
            <a href="${SITE_URL}" style="text-decoration:none;">
              <img src="${LOGO_URL}" width="120" height="50" alt="Minuto" style="display:inline-block;height:50px;width:auto;" />
            </a>
          </td>
        </tr>

        ${bannerUrl ? `
        <!-- AI-Generated Banner -->
        <tr>
          <td style="padding:0;">
            <img src="${escapeHtml(bannerUrl)}" width="600" height="300"
                 style="display:block;width:100%;height:auto;max-height:300px;object-fit:cover;" alt="" />
          </td>
        </tr>` : `
        <!-- Gradient Header (fallback) -->
        <tr>
          <td style="background:linear-gradient(135deg,#3D4A2E 0%,#6B8F4A 50%,#3D4A2E 100%);padding:40px 32px;text-align:center;">
            <h1 style="margin:0;color:white;font-size:26px;font-weight:800;letter-spacing:0.5px;text-shadow:0 2px 4px rgba(0,0,0,0.2);">
              ${escapeHtml(greeting || 'שלום ☕')}
            </h1>
          </td>
        </tr>`}

        ${bannerUrl && greeting ? `
        <!-- Greeting -->
        <tr>
          <td style="padding:28px 32px 0;font-size:20px;font-weight:700;color:#3D4A2E;direction:rtl;text-align:right;">
            ${escapeHtml(greeting)}
          </td>
        </tr>` : ""}

        <!-- Body Content -->
        <tr>
          <td style="padding:${bannerUrl ? '16px' : '24px'} 32px 28px;font-size:15px;line-height:1.9;color:#444;direction:rtl;text-align:right;">
            ${body.replace(/\n\n/g, '</p><p style="margin:0 0 16px;">').replace(/\n/g, "<br>")}
          </td>
        </tr>

        ${ctaText ? `
        <!-- Primary CTA Button -->
        <tr>
          <td style="padding:0 32px 32px;text-align:center;">
            <table cellpadding="0" cellspacing="0" border="0" align="center">
              <tr><td style="background:#3D4A2E;border-radius:28px;box-shadow:0 4px 12px rgba(61,74,46,0.3);">
                <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:16px 40px;color:white;text-decoration:none;font-size:16px;font-weight:700;letter-spacing:0.5px;">
                  ${escapeHtml(ctaText)} &rarr;
                </a>
              </td></tr>
            </table>
          </td>
        </tr>` : ""}

        ${products.length > 0 ? `
        <!-- Divider -->
        <tr>
          <td style="padding:0 32px;">
            <div style="border-top:2px solid #E8E8E0;margin:0;"></div>
          </td>
        </tr>

        <!-- Products Header -->
        <tr>
          <td style="padding:24px 32px 8px;direction:rtl;text-align:right;">
            <h2 style="margin:0;font-size:20px;color:#3D4A2E;font-weight:800;">☕ מוצרים מומלצים</h2>
            <p style="margin:4px 0 0;font-size:13px;color:#999;">נבחרו במיוחד בשבילך</p>
          </td>
        </tr>

        <!-- Product Grid -->
        <tr>
          <td style="padding:8px 24px 16px;">
            <div class="product-grid" style="text-align:center;font-size:0;">
              <!--[if mso]><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><![endif]-->
              ${productCardsHtml}
              <!--[if mso]></tr></table><![endif]-->
            </div>
          </td>
        </tr>` : ""}

        <!-- Footer -->
        <tr>
          <td style="background:#F5F3EE;padding:28px 32px;text-align:center;border-top:1px solid #E8E8E0;">
            <img src="${LOGO_URL}" width="80" height="33" alt="Minuto" style="display:inline-block;height:33px;width:auto;opacity:0.7;margin-bottom:12px;" />
            <p style="margin:0;font-size:13px;color:#888;font-weight:600;">Minuto Caf&eacute; &amp; Roastery</p>
            <p style="margin:4px 0 0;font-size:12px;color:#AAA;">קפה טרי מהקלייה -ישירות אליך</p>
            <div style="margin:16px 0 0;padding-top:12px;border-top:1px solid #E0DDD8;">
              <a href="${SITE_URL}" style="color:#556B3A;text-decoration:none;font-size:12px;margin:0 8px;">לאתר</a>
              <span style="color:#ddd;">|</span>
              <a href="${escapeHtml(unsubscribeUrl)}" style="color:#999;text-decoration:underline;font-size:11px;margin:0 8px;">להסרה מרשימת התפוצה</a>
            </div>
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
  const staleHours = 24;
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

  // 3. Fetch past campaigns (for AI to avoid repetition + learn patterns)
  const { data: pastCampaigns } = await supabase
    .from("campaigns")
    .select("subject, message, campaign_type, created_at, status")
    .eq("user_id", p.userId)
    .eq("channel", "email")
    .order("created_at", { ascending: false })
    .limit(15);

  const pastSubjects = (pastCampaigns || []).map((c: any) => c.subject).filter(Boolean);
  const sentCampaigns = (pastCampaigns || []).filter((c: any) => c.status === "sent");
  const pastPatterns = sentCampaigns.slice(0, 3).map((c: any) =>
    `נושא: ${c.subject} | סוג: ${c.campaign_type}`
  ).join("\n");

  // 4. Seasonal context
  const seasonalContext = getSeasonalContext();

  // 5. Call Claude AI
  const systemPrompt = `אתה ארז, בעלים של מינוטו. בית קלייה קטן בישראל. אתה כותב מייל ללקוחות.

איך אתה כותב:
- כמו וואטסאפ לחבר טוב. קצר, ישיר, אמיתי
- לא "חובבי קפה המתוחכמים". פשוט "היי" או "שלום"
- מספר מה קרה השבוע בקלייה. משהו ספציפי ואמיתי
- ממליץ על מוצר? מסביר למה אתה אוהב אותו. חוויה, לא תכונות
- משפטים קצרים. 5-10 מילים
- מקסימום 100-120 מילים בסך הכל

דוגמה לטון הנכון:
"היי,
השבוע קליתי אצלנו אתיופיה יירגשפה. הארומה שעלתה מהקלייה היתה מטורפת. פירותי, פרחוני.
שמרתי כמה שקיות. מי שרוצה לנסות, יש באתר."

דוגמה נוספת:
"מה קורה,
הבאנו מכונת Jura חדשה לקלייה לבדיקה. עשינו איתה אספרסו כפול מהתערובת שלנו.
בקיצור, אנחנו מכורים. המכונה עכשיו במבצע באתר למי שמתעניין."

מילים וביטויים אסורים (לא להשתמש בשום מצב):
- "חובבי הקפה המתוחכמים"
- "דיוק שוויצרי"
- "משקה משיי"
- "בלחיצת כפתור"
- "מהפכה בטעם"
- "במיוחד בשבילך"
- "משהו שווה במיוחד"
- "המבצע לא נמשך כל השנה"
- "חוללת מהפכה"
- "ישירות אליך"
- "נבחרו במיוחד"
- שימוש ב-"!" יותר מפעם אחת
- שימוש ביותר מאימוג'י 1

${seasonalContext}

נושאים קודמים (לא לחזור): ${pastSubjects.join(", ") || "אין"}

מוצרים זמינים:
${JSON.stringify(productCatalog, null, 2)}

${p.customInstructions ? "הנחיה מהמשתמש: " + p.customInstructions : ""}

החזר JSON בלבד:
{
  "subject": "נושא קצר עד 50 תווים, פשוט, עם אימוג'י אחד",
  "preheader": "משפט אחד קצר עד 60 תווים",
  "greeting": "היי או שלום, בלי תארים",
  "body": "גוף קצר בעברית פשוטה. שבירת שורות עם \\n",
  "cta_text": "טקסט קצר לכפתור",
  "cta_url": "https://minuto.co.il/shop",
  "product_ids": [woo_ids],
  "campaign_theme": "tips|story|promo|seasonal|education",
  "banner_prompt": "short english description for banner image, photographic style, no text in image"
}`;

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system:     systemPrompt,
      messages:   [{ role: "user", content: p.customInstructions || "צור קמפיין שבועי" }],
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error("Claude API error:", aiRes.status, errText);
    return err(500, "Claude API error: " + aiRes.status);
  }

  const aiJson = await aiRes.json();
  const rawText = aiJson.content?.[0]?.text ?? "";
  console.log("Claude raw response length:", rawText.length);

  let campaign: any;
  try {
    const clean = rawText.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    campaign = JSON.parse(clean);
  } catch {
    console.error("AI parse error:", rawText);
    return err(500, "Failed to parse AI response");
  }

  // 6. Generate banner image with Gemini
  let bannerUrl: string | null = null;
  if (campaign.banner_prompt) {
    bannerUrl = await generateBannerImage(campaign.banner_prompt);
  }

  // 7. Match selected products with full data
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

  // 8. Build HTML
  const htmlContent = buildCampaignHtml({
    subject:        campaign.subject,
    preheader:      campaign.preheader || "",
    greeting:       campaign.greeting || "",
    body:           campaign.body,
    ctaText:        campaign.cta_text || "לחנות",
    ctaUrl:         campaign.cta_url || "https://minuto.co.il/shop",
    bannerUrl,
    products:       selectedProducts,
    unsubscribeUrl: "{{UNSUBSCRIBE_URL}}",
  });

  // 9. Save draft to database
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
      bannerUrl,
      bannerPrompt: campaign.banner_prompt,
      products:    selectedProducts,
      htmlContent,
    },
  });
}

// ── Update Draft ────────────────────────────────────────────────────────────

interface UpdateDraftPayload {
  userId: string;
  campaignId: number;
  subject?: string;
  body?: string;
  greeting?: string;
  preheader?: string;
  ctaText?: string;
  ctaUrl?: string;
  bannerUrl?: string | null;
  products?: any[];
}

async function handleUpdateDraft(p: UpdateDraftPayload) {
  // Fetch existing campaign
  const { data: existing, error: fetchErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", p.campaignId)
    .eq("user_id", p.userId)
    .single();

  if (fetchErr || !existing) return err(404, "Campaign not found");

  // Rebuild HTML with edits
  const htmlContent = buildCampaignHtml({
    subject:        p.subject || existing.subject,
    preheader:      p.preheader ?? existing.preheader ?? "",
    greeting:       p.greeting ?? "",
    body:           p.body || existing.message,
    ctaText:        p.ctaText ?? existing.cta_text ?? "לחנות",
    ctaUrl:         p.ctaUrl ?? existing.cta_url ?? "https://minuto.co.il/shop",
    bannerUrl:      p.bannerUrl !== undefined ? p.bannerUrl : null,
    products:       p.products || [],
    unsubscribeUrl: "{{UNSUBSCRIBE_URL}}",
  });

  // Save updates
  const { error: updateErr } = await supabase
    .from("campaigns")
    .update({
      subject:      p.subject || existing.subject,
      message:      p.body || existing.message,
      html_content: htmlContent,
      preheader:    p.preheader ?? existing.preheader,
      cta_text:     p.ctaText ?? existing.cta_text,
      cta_url:      p.ctaUrl ?? existing.cta_url,
      product_ids:  p.products ? p.products.map((pr: any) => String(pr.woo_id)) : existing.product_ids,
    })
    .eq("id", p.campaignId);

  if (updateErr) return err(500, updateErr.message);

  return ok({ ok: true, htmlContent });
}

// ── Send Campaign via Resend ────────────────────────────────────────────────

interface SendCampaignPayload {
  userId:     string;
  campaignId: number;
  testEmail?: string;
}

async function handleSendCampaign(p: SendCampaignPayload) {
  if (!RESEND_KEY) return err(500, "RESEND_API_KEY not configured");

  const { data: campaign, error: campErr } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", p.campaignId)
    .eq("user_id", p.userId)
    .single();

  if (campErr || !campaign) return err(404, "Campaign not found");

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

  const batchSize = 50;
  let sent = 0;
  let errors: string[] = [];

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);

    for (const recipient of batch) {
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
            headers: { "List-Unsubscribe": `<${unsubUrl}>` },
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

    if (i + batchSize < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

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

  return ok({ ok: true, sent, total: recipients.length, errors: errors.length, isTest: !!p.testEmail });
}

// ── Unsubscribe Handler ─────────────────────────────────────────────────────

async function handleUnsubscribe(url: URL): Promise<Response> {
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("token");

  if (!email || !token) {
    return new Response(htmlPage("שגיאה", "קישור לא תקין."), {
      status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  await supabase
    .from("marketing_contacts")
    .update({ opted_in: false, updated_at: new Date().toISOString() })
    .eq("email", email.toLowerCase().trim());

  return new Response(
    htmlPage("הוסרת בהצלחה",
      `<p>הכתובת <strong>${escapeHtml(email)}</strong> הוסרה מרשימת התפוצה של מינוטו.</p>
       <p>לא תקבל/י יותר מיילים שיווקיים מאיתנו.</p>
       <p style="margin-top:24px;color:#888;font-size:14px;">תודה, צוות מינוטו ☕</p>`),
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title} -Minuto</title></head>
<body style="margin:0;padding:40px 20px;background:#F5F5F0;font-family:Arial,sans-serif;direction:rtl;text-align:center;">
<div style="max-width:500px;margin:0 auto;background:white;border-radius:12px;padding:40px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<h1 style="color:#3D4A2E;font-size:24px;margin-bottom:16px;">${title}</h1>
<div style="font-size:16px;line-height:1.6;color:#333;">${body}</div></div></body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("action") === "unsubscribe") {
    return handleUnsubscribe(url);
  }

  try {
    const body = await req.json();
    const { action, ...payload } = body;

    switch (action) {
      case "generate":          return await handleGenerate(payload as GeneratePayload);
      case "update-draft":      return await handleUpdateDraft(payload as UpdateDraftPayload);
      case "sync-woo-products": return await handleSyncWooProducts(payload.userId);
      case "send-campaign":     return await handleSendCampaign(payload as SendCampaignPayload);
      case "send-test":         return await handleSendCampaign({ ...payload, testEmail: payload.testEmail } as SendCampaignPayload);
      default:                  return err(400, `Unknown action: ${action}`);
    }
  } catch (e: any) {
    console.error("Edge function error:", e);
    return err(500, e.message || "Internal error");
  }
});
