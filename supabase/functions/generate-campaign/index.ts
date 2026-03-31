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
const SENDER_EMAIL   = Deno.env.get("SENDER_EMAIL")              ?? "info@minuto.co.il";
const UNSUBSCRIBE_BASE = Deno.env.get("UNSUBSCRIBE_BASE_URL")   ?? `${SUPA_URL}/functions/v1/generate-campaign`;
const LOGO_URL       = "https://minuto.co.il/content/uploads/2025/03/Frame-14.png";
const SITE_URL       = "https://minuto.co.il";

// Allowed origins for CORS (CoffeeFlow app + Minuto website)
const ALLOWED_ORIGINS = [
  Deno.env.get("COFFEEFLOW_ORIGIN") || "https://coffeeflow-thaf.vercel.app",
  "https://minuto.co.il",
  "https://www.minuto.co.il",
];

function getCorsHeaders(req?: Request) {
  const origin = req?.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

// Default cors headers (for backward compat where req isn't available)
const corsHeaders = getCorsHeaders();

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

function formatPrice(raw: string): string {
  if (!raw) return "";
  // "4700.0000" → "4,700" | "5490" → "5,490" | "89.90" → "89.90"
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  // If it's a whole number (or .0000), drop decimals; otherwise keep 2
  const isWhole = num === Math.floor(num);
  return isWhole
    ? Math.floor(num).toLocaleString("en-IL")
    : num.toLocaleString("en-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    const imagePrompt = `A wide landscape photograph for a coffee roastery email newsletter. Prefer showing: coffee beans, roasted coffee, latte art, steaming cups, coffee bags, roasting drum, café counter atmosphere. If the theme mentions a specific machine type, you may show it — but NEVER invent machine details or add parts that don't belong (e.g. don't add a portafilter to a super-automatic machine). When in doubt, focus on beans and cups rather than equipment. Style: warm and inviting, artisan premium feel with earthy tones (dark browns, cream, olive green). Lighting: soft natural or warm studio lighting. ABSOLUTELY NO people, NO faces, NO hands, NO human figures. ABSOLUTELY NO text, NO letters, NO words, NO numbers, NO logos in the image. Clean composition, high quality, 16:9 aspect ratio. Theme: ${prompt}`;

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

    console.log("All Gemini image generation attempts failed, no banner produced");
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
  promoDeadline?: string | null;
}): string {
  const { subject, preheader, greeting, body, ctaText, ctaUrl, bannerUrl, products, unsubscribeUrl, promoDeadline } = params;

  // Build a single product card cell — fixed dimensions, no description, consistent height
  const buildProductCell = (p: any) => {
    const hasDiscount = p.sale_price && p.regular_price && p.sale_price !== p.regular_price;
    const priceHtml = hasDiscount
      ? `<span style="text-decoration:line-through;color:#B0A898;font-size:12px;">₪${formatPrice(p.regular_price!)}</span>&nbsp;
         <span style="color:#C4543A;font-weight:800;font-size:16px;">₪${formatPrice(p.sale_price!)}</span>`
      : p.price ? `<span style="color:#3D4A2E;font-weight:800;font-size:16px;">₪${formatPrice(p.price)}</span>` : "";

    // Truncate name to ~40 chars to keep cards uniform
    const shortName = p.name && p.name.length > 40 ? p.name.slice(0, 38) + "..." : (p.name || "");

    return `<td valign="top" width="50%" style="padding:6px;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFFFFF;border-radius:12px;border:1px solid #EAE6DF;">
    <tr><td style="padding:0;background:#FAFAF7;">
      <a href="${escapeHtml(p.permalink || ctaUrl)}" style="text-decoration:none;display:block;">
        ${p.image_url ? `
        <!--[if mso]>
        <img src="${escapeHtml(p.image_url)}" width="260" height="200" alt="${escapeHtml(shortName)}" style="display:block;width:260px;height:200px;border:0;" />
        <![endif]-->
        <!--[if !mso]><!-->
        <div style="width:100%;height:200px;background:url('${escapeHtml(p.image_url)}') center center/contain no-repeat #FAFAF7;font-size:0;line-height:0;">
          &nbsp;
        </div>
        <!--<![endif]-->` : `
        <div style="width:100%;height:200px;background:#F5F0EB;text-align:center;line-height:200px;">
          <span style="font-size:48px;">☕</span>
        </div>`}
      </a>
    </td></tr>
    <tr><td style="padding:14px 12px;direction:rtl;text-align:right;">
      <a href="${escapeHtml(p.permalink || ctaUrl)}" style="font-size:13px;font-weight:700;color:#2C3522;text-decoration:none;display:block;margin-bottom:8px;line-height:1.3;min-height:34px;">
        ${escapeHtml(shortName)}
      </a>
      ${priceHtml ? `<div style="margin-bottom:12px;">${priceHtml}</div>` : ""}
      <table cellpadding="0" cellspacing="0" border="0">
        <tr><td style="background:#3D4A2E;border-radius:8px;">
          <a href="${escapeHtml(p.permalink || ctaUrl)}" style="display:inline-block;padding:8px 18px;color:white;text-decoration:none;font-size:12px;font-weight:600;">
            לרכישה &larr;
          </a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</td>`;
  };

  // Build 2-column table rows; center the last product if odd count
  const productRowsHtml = (() => {
    let rows = '';
    const len = products.length;
    for (let i = 0; i < len; i += 2) {
      if (i + 1 < len) {
        // Full 2-column row
        rows += '<tr>';
        rows += buildProductCell(products[i]);
        rows += buildProductCell(products[i + 1]);
        rows += '</tr>';
      } else {
        // Last product alone — center it with empty cells on each side
        rows += '<tr>';
        rows += '<td width="25%" style="padding:0;">&nbsp;</td>';
        rows += buildProductCell(products[i]).replace('width="50%"', 'width="50%"');
        rows += '<td width="25%" style="padding:0;">&nbsp;</td>';
        rows += '</tr>';
      }
    }
    return rows;
  })();

  return `<!DOCTYPE html>
<html dir="rtl" lang="he" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(subject)}</title>
  <!--[if !mso]><!-->
  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;600;700;800&display=swap" rel="stylesheet">
  <!--<![endif]-->
  <style>
    body { font-family: 'Heebo', 'Segoe UI', Arial, Helvetica, sans-serif; }
    /* Constrain product images to their container */
    .product-grid img { max-width: 100%; height: auto; }
    .product-grid table { table-layout: fixed; }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; }
      .fluid { width: 100% !important; max-width: 100% !important; height: auto !important; }
      .stack { display: block !important; width: 100% !important; max-width: 100% !important; }
      .product-table td { display: block !important; width: 100% !important; }
      .product-grid table { width: 100% !important; max-width: 100% !important; }
      .product-grid img { width: 100% !important; max-width: 100% !important; }
      .product-grid td { width: 100% !important; max-width: 100% !important; }
      .content-pad { padding-left: 20px !important; padding-right: 20px !important; }
      .banner-img { height: auto !important; max-height: 220px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F5F0EB;font-family:'Heebo','Segoe UI',Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
  ${preheader ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>` : ""}

  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F0EB;">
    <tr><td align="center" style="padding:32px 16px;">

      <!-- Top accent line -->
      <table class="email-container" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
        <tr><td style="height:4px;background:linear-gradient(90deg,#3D4A2E,#7C9A5E,#3D4A2E);border-radius:4px 4px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
      </table>

      <table class="email-container" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.05);">

        <!-- Logo Bar -->
        <tr>
          <td style="padding:24px 36px;text-align:center;">
            <a href="${SITE_URL}" style="text-decoration:none;">
              <img src="${LOGO_URL}" width="130" height="54" alt="Minuto" style="display:inline-block;height:54px;width:auto;" />
            </a>
          </td>
        </tr>

        ${bannerUrl ? `
        <!-- Banner with text overlay -->
        <tr>
          <td style="padding:0;">
            <!--[if gte mso 9]>
            <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;height:280px;">
              <v:fill type="frame" src="${escapeHtml(bannerUrl)}" />
              <v:textbox inset="0,0,0,0">
            <![endif]-->
            <div style="background:url('${escapeHtml(bannerUrl)}') center/cover no-repeat;height:280px;display:table;width:100%;">
              <div style="display:table-cell;vertical-align:end;padding:0;">
                <div style="background:linear-gradient(0deg,rgba(0,0,0,0.65) 0%,rgba(0,0,0,0.25) 60%,transparent 100%);padding:60px 36px 28px;direction:rtl;text-align:right;">
                  <h1 style="margin:0 0 4px;color:#FFFFFF;font-size:26px;font-weight:800;line-height:1.3;text-shadow:0 1px 4px rgba(0,0,0,0.4);">
                    ${escapeHtml(subject)}
                  </h1>
                  ${preheader ? `<p style="margin:0;color:rgba(255,255,255,0.85);font-size:14px;font-weight:400;text-shadow:0 1px 2px rgba(0,0,0,0.3);">${escapeHtml(preheader)}</p>` : ""}
                </div>
              </div>
            </div>
            <!--[if gte mso 9]>
              </v:textbox>
            </v:rect>
            <![endif]-->
          </td>
        </tr>` : `
        <!-- Gradient Header (fallback — no banner) -->
        <tr>
          <td style="background:linear-gradient(135deg,#2C3522 0%,#4A6332 40%,#6B8F4A 100%);padding:48px 36px;direction:rtl;text-align:right;">
            <h1 style="margin:0 0 4px;color:white;font-size:26px;font-weight:800;line-height:1.3;">
              ${escapeHtml(subject)}
            </h1>
            ${preheader ? `<p style="margin:0;color:rgba(255,255,255,0.8);font-size:14px;">${escapeHtml(preheader)}</p>` : ""}
          </td>
        </tr>`}

        ${greeting ? `
        <!-- Greeting -->
        <tr>
          <td class="content-pad" style="padding:28px 36px 0;font-size:20px;font-weight:700;color:#2C3522;direction:rtl;text-align:right;">
            ${escapeHtml(greeting)}
          </td>
        </tr>` : ""}

        <!-- Body Content -->
        <tr>
          <td class="content-pad" style="padding:${greeting ? '12px' : '28px'} 36px 32px;font-size:16px;line-height:2;color:#4A4A42;direction:rtl;text-align:right;">
            ${body.replace(/\n\n/g, '</p><p style="margin:0 0 18px;">').replace(/\n/g, "<br>")}
          </td>
        </tr>

        ${ctaText ? `
        <!-- Primary CTA Button -->
        <tr>
          <td style="padding:0 36px 36px;text-align:center;">
            <table cellpadding="0" cellspacing="0" border="0" align="center">
              <tr><td style="background:#3D4A2E;border-radius:10px;">
                <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:16px 48px;color:white;text-decoration:none;font-size:16px;font-weight:700;letter-spacing:0.3px;">
                  ${escapeHtml(ctaText)} &larr;
                </a>
              </td></tr>
            </table>
          </td>
        </tr>` : ""}

        ${products.length > 0 ? `
        <!-- Products Section -->
        <tr>
          <td style="padding:0;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAF8F5;">
              <!-- Section divider -->
              <tr>
                <td class="content-pad" style="padding:32px 36px 4px;direction:rtl;text-align:right;">
                  <table cellpadding="0" cellspacing="0" border="0" width="100%">
                    <tr>
                      <td style="width:4px;background:#7C9A5E;border-radius:2px;font-size:0;">&nbsp;</td>
                      <td style="padding-right:14px;">
                        <h2 style="margin:0;font-size:20px;color:#2C3522;font-weight:800;">מוצרים שיעניינו אותך</h2>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Product Grid (table-based 2-col) -->
              <tr>
                <td style="padding:12px 20px 24px;">
                  <table class="product-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout:fixed;">
                    ${productRowsHtml}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : ""}

        <!-- Footer -->
        <tr>
          <td style="background:#2C3522;padding:36px 36px 28px;text-align:center;">
            <img src="${LOGO_URL}" width="90" height="37" alt="Minuto" style="display:inline-block;height:37px;width:auto;margin-bottom:16px;filter:brightness(10);" />
            <p style="margin:0 0 2px;font-size:14px;color:rgba(255,255,255,0.85);font-weight:600;">Minuto Caf&eacute; &amp; Roastery</p>
            <p style="margin:0 0 20px;font-size:12px;color:rgba(255,255,255,0.5);">קפה טרי מהקלייה</p>
            <div style="margin:0 auto;padding-top:16px;border-top:1px solid rgba(255,255,255,0.1);">
              <a href="${SITE_URL}" style="color:rgba(255,255,255,0.7);text-decoration:none;font-size:12px;margin:0 10px;">לאתר</a>
              <span style="color:rgba(255,255,255,0.2);">|</span>
              <a href="https://www.instagram.com/minuto_coffee/" style="color:rgba(255,255,255,0.7);text-decoration:none;font-size:12px;margin:0 10px;">Instagram</a>
              <span style="color:rgba(255,255,255,0.2);">|</span>
              <a href="${escapeHtml(unsubscribeUrl)}" style="color:rgba(255,255,255,0.4);text-decoration:underline;font-size:11px;margin:0 10px;">להסרה מרשימת התפוצה</a>
            </div>
            <!-- Legal disclaimer -->
            <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);direction:rtl;text-align:center;">
              ${promoDeadline ? `<p style="margin:0 0 8px;font-size:11px;color:rgba(255,255,255,0.45);line-height:1.7;font-weight:600;">
                המבצע עד ה־${new Date(promoDeadline).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" })} או עד גמר המלאי, הראשון מבינהם | ט.ל.ח
              </p>` : ""}
              <p style="margin:0 0 6px;font-size:10px;color:rgba(255,255,255,0.3);line-height:1.7;">
                הפניה אליך נעשית בדיוור ישיר בעקבות הרשמתך לקפה מינוטו.
              </p>
              <p style="margin:0 0 6px;font-size:10px;color:rgba(255,255,255,0.3);line-height:1.7;">
                הודעת דואר זו נשלחה מכתובת דואר אלקטרוני שאינה נבדקת.
                אין באפשרותנו להגיב על תשובות שנשלחות לכתובת דואר אלקטרוני זאת.
                אנו מכבדים את פרטיותך, כנדרש עפ&quot;י דין.
              </p>
              <p style="margin:0 0 6px;font-size:10px;color:rgba(255,255,255,0.35);line-height:1.7;">
                להסרה מרשימת הדיוור
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:rgba(255,255,255,0.5);text-decoration:underline;">לחץ/י כאן</a>
                או שלח/י הודעת &quot;הסר&quot; למייל: info@minuto.co.il
              </p>
              <p style="margin:0 0 2px;font-size:10px;color:rgba(255,255,255,0.25);line-height:1.5;">
                Please do not reply to this mail
              </p>
              <p style="margin:0 0 2px;font-size:9px;color:rgba(255,255,255,0.2);">
                ט.ל.ח
              </p>
              <p style="margin:0;font-size:9px;color:rgba(255,255,255,0.2);">
                מינוטו קפה | אחד העם 22 רחובות, שפלה 7626101
              </p>
            </div>
          </td>
        </tr>

      </table>

      <!-- Bottom accent line -->
      <table class="email-container" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">
        <tr><td style="height:4px;background:linear-gradient(90deg,#3D4A2E,#7C9A5E,#3D4A2E);border-radius:0 0 4px 4px;font-size:0;line-height:0;">&nbsp;</td></tr>
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

// In-memory cache to prevent multiple WooCommerce syncs within the same function invocation
const recentSyncCache = new Map<string, number>();

async function ensureProductsFresh(userId: string): Promise<void> {
  // Skip if we already synced in this invocation (e.g. ideas → generate back-to-back)
  const cacheKey = `sync_${userId}`;
  const lastMemSync = recentSyncCache.get(cacheKey);
  if (lastMemSync && (Date.now() - lastMemSync) < 5 * 60 * 1000) {
    console.log("Products synced recently (in-memory), skipping");
    return;
  }

  const { data } = await supabase
    .from("woo_products")
    .select("synced_at")
    .eq("user_id", userId)
    .order("synced_at", { ascending: false })
    .limit(1);

  const lastSync = data?.[0]?.synced_at;
  // Only auto-sync if products are older than 72 hours (WooCommerce catalog is slow)
  const staleHours = 72;
  const isStale = !lastSync || (Date.now() - new Date(lastSync).getTime()) > staleHours * 60 * 60 * 1000;

  if (isStale && WOO_URL && WOO_KEY) {
    console.log(`Products stale (last sync: ${lastSync || 'never'}, threshold: ${staleHours}h), syncing...`);
    await handleSyncWooProducts(userId);
    recentSyncCache.set(cacheKey, Date.now());
  } else {
    console.log(`Products fresh (last sync: ${lastSync}, threshold: ${staleHours}h), skipping`);
    recentSyncCache.set(cacheKey, Date.now());
  }
}

// ── AI Generate Ideas ────────────────────────────────────────────────────────

interface IdeasPayload {
  userId: string;
  context?: string;
}

async function handleGenerateIdeas(p: IdeasPayload) {
  console.log("handleGenerateIdeas called, userId:", p.userId, "context:", p.context);
  if (!p.userId) return err(400, "userId is required");
  if (!ANTHROPIC_KEY) return err(500, "ANTHROPIC_API_KEY not configured");

  await ensureProductsFresh(p.userId);

  const { data: wooProducts } = await supabase
    .from("woo_products")
    .select("name, price, sale_price, categories, short_description")
    .eq("user_id", p.userId)
    .eq("stock_status", "instock");

  const productNames = (wooProducts || []).map((pr: any) => pr.name).join(", ");
  const hasDiscounts = (wooProducts || []).some((pr: any) => pr.sale_price && pr.sale_price !== pr.price);

  const { data: pastCampaigns } = await supabase
    .from("campaigns")
    .select("subject")
    .eq("user_id", p.userId)
    .eq("channel", "email")
    .order("created_at", { ascending: false })
    .limit(10);

  const pastSubjects = (pastCampaigns || []).map((c: any) => c.subject).filter(Boolean);
  const seasonalContext = getSeasonalContext();

  const systemPrompt = `אתה עוזר לארז, בעלים של מינוטו בית קלייה קטן בישראל, לחשוב על רעיונות לקמפיין אימייל.

מוצרים בחנות: ${productNames || "לא זמינים"}
${hasDiscounts ? "יש מוצרים במבצע בחנות" : ""}
${seasonalContext}
נושאים קודמים (לא לחזור): ${pastSubjects.join(", ") || "אין"}
${p.context ? "הקשר מהמשתמש: " + p.context : ""}

צור 5 רעיונות מגוונים לקמפיין אימייל. כל רעיון צריך להיות שונה בגישה.
חשוב על: מבצעים, חינוך על קפה, סיפור מהקלייה, עונתיות, טיפים, מוצר חדש.

החזר JSON בלבד:
{
  "ideas": [
    {
      "title": "כותרת קצרה בעברית (5-8 מילים)",
      "description": "תיאור של 1-2 משפטים על מה הקמפיין",
      "theme": "tips|story|promo|seasonal|education",
      "suggestedProducts": ["שם מוצר אחד או שניים אם רלוונטי"]
    }
  ]
}`;

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-20250514",
      max_tokens: 800,
      system:     systemPrompt,
      messages:   [{ role: "user", content: p.context || "תן לי 5 רעיונות לקמפיין הבא" }],
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error("Claude API error:", aiRes.status, errText);
    return err(500, "Claude API error: " + aiRes.status);
  }

  const aiJson = await aiRes.json();
  const rawText = aiJson.content?.[0]?.text ?? "";

  let parsed: any;
  try {
    const clean = rawText.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error("AI parse error:", rawText);
    return err(500, "Failed to parse AI response");
  }

  return ok({ ok: true, ideas: parsed.ideas || [] });
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

  // Keep catalog compact to stay under rate limits (30k input tokens/min)
  // If user mentioned specific products, prioritize those in the catalog
  const allProducts = wooProducts || [];
  let prioritized: any[] = [];
  if (p.customInstructions) {
    const instr = p.customInstructions.toLowerCase();
    prioritized = allProducts.filter((pr: any) => {
      const name = (pr.name || "").toLowerCase();
      // Check if any English token from product name is in instructions
      const tokens = name.match(/[a-zA-Z0-9]+/g) || [];
      return tokens.some((t: string) => t.length >= 2 && instr.toLowerCase().includes(t.toLowerCase()));
    });
  }
  const rest = allProducts.filter((pr: any) => !prioritized.includes(pr));
  const orderedProducts = [...prioritized, ...rest].slice(0, 40);

  const productCatalog = orderedProducts.map((pr: any) => ({
    woo_id: pr.woo_id,
    name: pr.name,
    price: pr.price,
    sale_price: pr.sale_price || undefined,
    categories: pr.categories?.slice(0, 2),
  }));
  console.log("Catalog size:", productCatalog.length, "prioritized:", prioritized.length, prioritized.map((p: any) => `${p.name}(${p.woo_id})`).join(", "));

  // 3. Fetch past campaigns (for AI to avoid repetition + learn patterns)
  const { data: pastCampaigns } = await supabase
    .from("campaigns")
    .select("subject, campaign_type")
    .eq("user_id", p.userId)
    .eq("channel", "email")
    .order("created_at", { ascending: false })
    .limit(5);

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
- "מהפכה בטעם" / "חוללת מהפכה"
- "במיוחד בשבילך" / "נבחרו במיוחד"
- "משהו מיוחד" / "משהו שווה במיוחד" / "הכנו משהו מיוחד"
- "מחירים חגיגיים" / "מחירים מיוחדים" / "מחירים שלא יחזרו"
- "המבצע לא נמשך כל השנה"
- "ישירות אליך"
- כל ביטוי עם המילה "מיוחד" — זה קלישאה שיווקית. תמיד יש דרך ספציפית יותר.
- שימוש ב-"!" יותר מפעם אחת
- שימוש ביותר מאימוג'י 1

כללי איכות:
- בדוק איות של מילים לועזיות: specialty = ספשיאלטי (לא ספשלטי), espresso = אספרסו
- אל תמציא מבצעים או אחוזי הנחה שלא צוינו בהנחיית המשתמש
- אם המשתמש לא ציין הנחה ספציפית, אל תכתוב אחוזי הנחה
- כתוב מחירים כמו שהם מופיעים בקטלוג. אם המחיר הוא 4500.0000, כתוב ₪4,500

${seasonalContext}

נושאים קודמים (לא לחזור): ${pastSubjects.join(", ") || "אין"}

מוצרים זמינים:
${JSON.stringify(productCatalog, null, 2)}

${p.customInstructions ? "הנחיה מהמשתמש: " + p.customInstructions : ""}

חובה: בחר מוצרים מהרשימה למעלה! אם המשתמש ציין שמות מוצרים, מצא אותם בקטלוג לפי שם (חיפוש חלקי). תמיד כלול לפחות 2-4 מוצרים.

החזר JSON בלבד:
{
  "subject": "נושא קצר עד 50 תווים, פשוט, עם אימוג'י אחד",
  "preheader": "משפט אחד קצר עד 60 תווים",
  "greeting": "היי או שלום, בלי תארים",
  "body": "גוף קצר בעברית פשוטה. שבירת שורות עם \\n",
  "cta_text": "טקסט קצר לכפתור",
  "cta_url": "https://minuto.co.il/shop",
  "product_ids": ["חובה! woo_id מספרים מהקטלוג למעלה. לפחות 2 מוצרים"],
  "campaign_theme": "tips|story|promo|seasonal|education",
  "banner_prompt": "Prefer: coffee beans close-up, latte art, roasting process, steaming cup, café atmosphere. Avoid super-automatic machines (AI renders them wrong). Barista/portafilter machines are OK if relevant. Short english description, photographic style, no text in image"
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
  // Normalize IDs to numbers for comparison (AI may return strings or numbers)
  const rawIds = campaign.product_ids || [];
  const selectedIds = rawIds.map((id: any) => Number(id));
  console.log("AI returned product_ids:", JSON.stringify(rawIds), "normalized:", JSON.stringify(selectedIds));
  console.log("Available woo_ids:", (wooProducts || []).slice(0, 10).map((p: any) => `${p.woo_id}(${typeof p.woo_id})`).join(", "));

  let selectedProducts = (wooProducts || [])
    .filter((pr: any) => selectedIds.includes(Number(pr.woo_id)))
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

  // Fallback: if no products matched by ID, try matching by brand/model from user instructions
  if (selectedProducts.length === 0 && p.customInstructions) {
    console.log("No products matched by ID, trying brand/model-based fallback");
    const instructions = p.customInstructions.toLowerCase();

    // Extract brand/model tokens (e.g., "Jura C8", "ENA 8", "Chemex") — skip common Hebrew words
    const hebrewStopWords = new Set(["קפה", "מכונת", "מכונה", "פולי", "על", "של", "את", "עם", "גם", "או", "לא", "כל", "יש", "אין", "מבצע", "הנחה", "חדש", "חדשה", "מחיר", "במחיר", "למכירה"]);

    selectedProducts = (wooProducts || [])
      .filter((pr: any) => {
        const name = (pr.name || "").toLowerCase();
        // Score: how many specific (non-stopword) tokens from the product name appear in instructions
        const tokens = name.split(/[\s\-,]+/).filter((w: string) => w.length > 1 && !hebrewStopWords.has(w));
        const matchCount = tokens.filter((w: string) => instructions.includes(w)).length;
        // Require at least 2 token matches, OR 1 match if it's a brand/model name (>= 3 chars, alphanumeric)
        const hasBrandMatch = tokens.some((w: string) => /[a-zA-Z]/.test(w) && w.length >= 2 && instructions.includes(w));
        return matchCount >= 2 || hasBrandMatch;
      })
      .slice(0, 6)
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
    console.log("Brand/model fallback matched:", selectedProducts.length, "products:", selectedProducts.map((p: any) => p.name).join(", "));
  }

  console.log("Final selectedProducts count:", selectedProducts.length);

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
  promoDeadline?: string | null;
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
    promoDeadline:  p.promoDeadline || null,
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

// ── Fetch Contacts from Resend (single source of truth) ─────────────────────

async function fetchResendContacts(): Promise<Array<{ email: string; name?: string }>> {
  if (!RESEND_KEY) return [];

  const allContacts: Array<{ email: string; name?: string }> = [];
  let after: string | null = null;

  while (true) {
    const url = new URL("https://api.resend.com/contacts");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${RESEND_KEY}` },
    });

    if (!res.ok) {
      console.error("Resend contacts API error:", res.status);
      break;
    }

    const json = await res.json();
    const contacts = json.data || [];

    for (const c of contacts) {
      // Only include subscribed contacts
      if (!c.unsubscribed) {
        allContacts.push({
          email: c.email,
          name: [c.first_name, c.last_name].filter(Boolean).join(" ") || undefined,
        });
      }
    }

    if (!json.has_more || contacts.length === 0) break;
    after = contacts[contacts.length - 1].id;
  }

  return allContacts;
}

// ── Send Campaign via Resend ────────────────────────────────────────────────

interface SendCampaignPayload {
  userId:     string;
  campaignId: number;
  testEmail?: string;
  selectedRecipients?: Array<{ email: string; name?: string }>;
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
  } else if (p.selectedRecipients && p.selectedRecipients.length > 0) {
    // User selected specific recipients
    recipients = p.selectedRecipients;
    console.log(`Sending to ${recipients.length} selected recipients`);
  } else {
    // Fetch all subscribed recipients from Resend Contacts
    recipients = await fetchResendContacts();
    console.log(`Fetched ${recipients.length} subscribed contacts from Resend`);
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
          // Store Resend email ID for webhook event tracking
          try {
            const resBody = await res.json();
            if (resBody.id) {
              await supabase.from("campaign_events").insert({
                user_id: p.userId,
                campaign_id: p.campaignId,
                resend_email_id: resBody.id,
                event_type: "sent",
                recipient_email: recipient.email,
              });
            }
          } catch (_) { /* non-critical */ }
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

// ── Sync Contacts from Resend ────────────────────────────────────────────────

async function handleSyncResendContacts(userId: string) {
  if (!RESEND_KEY) return err(500, "RESEND_API_KEY not configured");

  let allContacts: any[] = [];
  let after: string | null = null;

  // Paginate through all Resend contacts
  while (true) {
    const url = new URL("https://api.resend.com/contacts");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${RESEND_KEY}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Resend contacts API error:", res.status, errText);
      return err(500, `Resend API error: ${res.status}`);
    }

    const json = await res.json();
    const contacts = json.data || [];
    allContacts = allContacts.concat(contacts);

    if (!json.has_more || contacts.length === 0) break;
    after = contacts[contacts.length - 1].id;
  }

  console.log("Fetched", allContacts.length, "contacts from Resend");

  let synced = 0;
  for (const c of allContacts) {
    const { error: dbErr } = await supabase
      .from("marketing_contacts")
      .upsert({
        user_id:   userId,
        email:     (c.email || "").toLowerCase().trim(),
        name:      [c.first_name, c.last_name].filter(Boolean).join(" ") || "",
        opted_in:  !c.unsubscribed,
        source:    "resend",
      }, { onConflict: "user_id,email" });

    if (!dbErr) synced++;
    else console.error("Sync error:", dbErr.message);
  }

  return ok({ ok: true, synced, total: allContacts.length });
}

// ── Public Subscribe (for website forms) ─────────────────────────────────────

async function handlePublicSubscribe(payload: { email: string; name?: string; phone?: string; userId?: string }) {
  const email = (payload.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) return err(400, "Invalid email");

  if (!RESEND_KEY) return err(500, "RESEND_API_KEY not configured");

  // Single source of truth: Resend Contacts only
  try {
    const nameParts = (payload.name || "").split(" ");
    const res = await fetch("https://api.resend.com/contacts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        first_name: nameParts[0] || "",
        last_name: nameParts.slice(1).join(" ") || "",
        unsubscribed: false,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("Resend contact create error:", res.status, errBody);
      return err(500, "Failed to create contact in Resend");
    }
  } catch (e: any) {
    console.error("Resend contact create error:", e.message);
    return err(500, e.message);
  }

  return ok({ ok: true, email });
}

// ── Main ────────────────────────────────────────────────────────────────────

serve(async (req) => {
  const dynamicCors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: dynamicCors });

  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("action") === "unsubscribe") {
    return handleUnsubscribe(url);
  }

  try {
    const body = await req.json();
    const { action, ...payload } = body;
    console.log("Action:", action, "userId:", payload.userId, "keys:", Object.keys(payload).join(","));

    let response: Response;
    switch (action) {
      case "generate-ideas":    response = await handleGenerateIdeas(payload as IdeasPayload); break;
      case "generate":          response = await handleGenerate(payload as GeneratePayload); break;
      case "update-draft":      response = await handleUpdateDraft(payload as UpdateDraftPayload); break;
      case "sync-woo-products": response = await handleSyncWooProducts(payload.userId); break;
      case "send-campaign":     response = await handleSendCampaign(payload as SendCampaignPayload); break;
      case "send-test":         response = await handleSendCampaign({ ...payload, testEmail: payload.testEmail } as SendCampaignPayload); break;
      case "sync-resend-contacts": response = await handleSyncResendContacts(payload.userId); break;
      case "subscribe":        response = await handlePublicSubscribe(payload); break;
      default:                  response = err(400, `Unknown action: ${action}`); break;
    }
    // Override CORS headers with dynamic origin
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", dynamicCors["Access-Control-Allow-Origin"]);
    return new Response(response.body, { status: response.status, headers: newHeaders });
  } catch (e: any) {
    console.error("Edge function error:", e);
    return new Response(JSON.stringify({ error: e.message || "Internal error" }), {
      status: 500,
      headers: { ...dynamicCors, "Content-Type": "application/json" },
    });
  }
});
