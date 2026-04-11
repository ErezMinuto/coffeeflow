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
const RESEND_AUDIENCE_ID = Deno.env.get("RESEND_AUDIENCE_ID") ?? "24bb0a2b-eaf8-4a2e-ae57-749bbbc3a2f9";
const LOGO_URL       = "https://minuto.co.il/content/uploads/2025/03/Frame-14.png";
const SITE_URL       = "https://minuto.co.il";

// Allowed origins for CORS (CoffeeFlow app + Minuto website)
const ALLOWED_ORIGINS = [
  Deno.env.get("COFFEEFLOW_ORIGIN") || "https://coffeeflow-thaf.vercel.app",
  "https://coffeeflow-neon.vercel.app",
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
    "Access-Control-Max-Age":       "86400",
    "Vary":                          "Origin",
  };
}

// Default cors headers (for backward compat where req isn't available)
const corsHeaders = getCorsHeaders();

const JWT_SECRET = Deno.env.get("JWT_SECRET") ?? "";

const supabase = createClient(SUPA_URL, SUPA_KEY);
const wooAuth  = btoa(`${WOO_KEY}:${WOO_SEC}`);

// ── JWT verification ──────────────────────────────────────────────────────────
async function verifyJWT(token: string): Promise<string | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return null;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const data      = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(
      atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub ?? null;
  } catch { return null; }
}

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

  // Sanitize the theme: strip words that routinely hijack Gemini into
  // generating landscapes/vehicles instead of coffee imagery.
  const banned = /\b(motorcycle|motorbike|bike|bicycle|car|truck|vehicle|road|highway|mountain|mountains|forest|journey|travel|ride|landscape|sunset|sunrise|sky|cloud|nature|scenic|adventure)\b/gi;
  const safeTheme = (prompt || "").replace(banned, "").replace(/\s+/g, " ").trim();

  try {
    const imagePrompt = `PRIMARY SUBJECT (mandatory): coffee. The image MUST clearly and prominently show coffee content — one or more of: raw or roasted coffee beans, a steaming cup of coffee, latte art, a coffee bag, a portafilter shot pouring, a roasting drum, or a café counter. This is for a specialty coffee roastery email newsletter.

Style: warm and inviting, artisan premium feel with earthy tones (dark browns, cream, olive green). Soft natural or warm studio lighting. Close to mid-range product photography. 16:9 wide landscape format. High quality.

STRICTLY FORBIDDEN — do NOT include any of: people, faces, hands, human figures, text, letters, words, numbers, logos, motorcycles, bicycles, cars, trucks, vehicles, roads, highways, mountains, forests, landscapes, skies, clouds, sunsets, sunrises, animals, or any outdoor scenery. If the theme hint below suggests such things, IGNORE it and default to coffee beans and a steaming cup.

Equipment rule: if a specific machine is relevant you may show it, but NEVER invent parts. When in doubt, show beans and cups instead of equipment. Never show a super-automatic machine with a portafilter.

Theme hint (use only if it fits the above — coffee-only imagery): ${safeTheme || "close-up of freshly roasted specialty coffee beans with a steaming cup"}`;

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

// Jewish holiday windows (Gregorian), keyed by year. Each entry is [startMonth, startDay, endMonth, endDay] inclusive.
// Windows start ~5 days before the holiday (lead-up marketing) and end on the last day.
const JEWISH_HOLIDAYS: Record<number, Array<{ name: string; range: [number, number, number, number] }>> = {
  2026: [
    { name: "טו בשבט",        range: [1, 28, 2, 2]   }, // Feb 2
    { name: "פסח",            range: [3, 27, 4, 9]   }, // Apr 1–9
    { name: "יום העצמאות",   range: [4, 17, 4, 22]  }, // Apr 22
    { name: "שבועות",         range: [5, 17, 5, 22]  }, // May 21–22
    { name: "תקופת החגים (ראש השנה, יום כיפור, סוכות)", range: [9, 7, 10, 6] }, // Sep 12 – Oct 4
    { name: "חנוכה",          range: [11, 30, 12, 12] }, // Dec 4–12
  ],
  2027: [
    { name: "טו בשבט",        range: [1, 17, 1, 22]  }, // Jan 22
    { name: "פסח",            range: [4, 16, 4, 29]  }, // Apr 21–29
    { name: "יום העצמאות",   range: [5, 7, 5, 12]   }, // May 12
    { name: "שבועות",         range: [6, 6, 6, 11]   }, // Jun 10–11
    { name: "תקופת החגים (ראש השנה, יום כיפור, סוכות)", range: [9, 27, 10, 26] }, // Oct 2 – Oct 23
    { name: "חנוכה",          range: [12, 20, 12, 31] }, // Dec 24 – Jan 1
  ],
  2028: [
    { name: "טו בשבט",        range: [2, 6, 2, 11]   }, // Feb 11
    { name: "פסח",            range: [4, 5, 4, 18]   }, // Apr 10–18
    { name: "יום העצמאות",   range: [4, 26, 5, 1]   }, // May 1
    { name: "שבועות",         range: [5, 26, 5, 31]  }, // May 30–31
    { name: "תקופת החגים (ראש השנה, יום כיפור, סוכות)", range: [9, 15, 10, 14] }, // Sep 21 – Oct 11
    { name: "חנוכה",          range: [12, 7, 12, 19] }, // Dec 12–19
  ],
};

// Fixed-date commercial/secular events — same window every year.
const FIXED_COMMERCIAL_EVENTS: Array<{ name: string; range: [number, number, number, number] }> = [
  { name: "ולנטיין",           range: [2, 7, 2, 14]   }, // Feb 14
  { name: "יום המשפחה",        range: [2, 15, 2, 21]  }, // Feb 21 (IL)
  { name: "יום האישה הבינלאומי", range: [3, 1, 3, 8]    }, // Mar 8
  { name: "יום האם",            range: [5, 5, 5, 12]   }, // 2nd Sun of May (approx window)
  { name: "11.11 (יום הרווקים / מבצעי נובמבר)", range: [11, 8, 11, 11] }, // Nov 11
  { name: "תחילת שנת הלימודים", range: [8, 25, 9, 5]   }, // Sep 1
];

// Year-specific commercial events (Black Friday / Cyber Monday shift yearly).
const COMMERCIAL_EVENTS_BY_YEAR: Record<number, Array<{ name: string; range: [number, number, number, number] }>> = {
  2026: [
    { name: "בלאק פריידיי",    range: [11, 23, 11, 27] }, // Fri Nov 27
    { name: "סייבר מאנדיי",    range: [11, 28, 11, 30] }, // Mon Nov 30
  ],
  2027: [
    { name: "בלאק פריידיי",    range: [11, 22, 11, 26] }, // Fri Nov 26
    { name: "סייבר מאנדיי",    range: [11, 27, 11, 29] }, // Mon Nov 29
  ],
  2028: [
    { name: "בלאק פריידיי",    range: [11, 20, 11, 24] }, // Fri Nov 24
    { name: "סייבר מאנדיי",    range: [11, 25, 11, 27] }, // Mon Nov 27
  ],
};

function getSeasonalContext(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const holidays: string[] = [];

  const inRange = (r: [number, number, number, number]) => {
    const [sM, sD, eM, eD] = r;
    const cur = month * 100 + day;
    const start = sM * 100 + sD;
    const end = eM * 100 + eD;
    return cur >= start && cur <= end;
  };

  for (const h of JEWISH_HOLIDAYS[year] ?? []) {
    if (inRange(h.range)) holidays.push(h.name);
  }
  for (const e of FIXED_COMMERCIAL_EVENTS) {
    if (inRange(e.range)) holidays.push(e.name);
  }
  for (const e of COMMERCIAL_EVENTS_BY_YEAR[year] ?? []) {
    if (inRange(e.range)) holidays.push(e.name);
  }

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

  // Append UTM parameters to minuto.co.il links only. Uses a {{UTM_CAMPAIGN}}
  // placeholder because the campaign id isn't known at build time —
  // handleSendCampaign substitutes the real value per-send. Encoded manually
  // instead of via URL/URLSearchParams so the curly-brace placeholder survives
  // (URLSearchParams would percent-encode it as %7B%7BUTM_CAMPAIGN%7D%7D and
  // break the string replace downstream).
  const addUtms = (rawUrl: string | undefined, content: string): string => {
    if (!rawUrl) return "";
    if (!rawUrl.includes("minuto.co.il")) return rawUrl;
    if (rawUrl.includes("utm_source=")) return rawUrl; // don't double-up
    const sep = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${sep}utm_source=newsletter&utm_medium=email&utm_campaign={{UTM_CAMPAIGN}}&utm_content=${encodeURIComponent(content)}`;
  };

  // Build a single product card cell — fixed dimensions, no description, consistent height
  const buildProductCell = (p: any) => {
    const productUrl = addUtms(p.permalink || ctaUrl, `product_${p.woo_id || "unknown"}`);
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
      <a href="${escapeHtml(productUrl)}" style="text-decoration:none;display:block;">
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
      <a href="${escapeHtml(productUrl)}" style="font-size:13px;font-weight:700;color:#2C3522;text-decoration:none;display:block;margin-bottom:8px;line-height:1.3;min-height:34px;">
        ${escapeHtml(shortName)}
      </a>
      ${priceHtml ? `<div style="margin-bottom:12px;">${priceHtml}</div>` : ""}
      <table cellpadding="0" cellspacing="0" border="0">
        <tr><td style="background:#3D4A2E;border-radius:8px;">
          <a href="${escapeHtml(productUrl)}" style="display:inline-block;padding:8px 18px;color:white;text-decoration:none;font-size:12px;font-weight:600;">
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
                <a href="${escapeHtml(addUtms(ctaUrl, "cta_button"))}" style="display:inline-block;padding:16px 48px;color:white;text-decoration:none;font-size:16px;font-weight:700;letter-spacing:0.3px;">
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
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:rgba(255,255,255,0.5);text-decoration:underline;">לחץ/י כאן</a>.
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
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 2000,
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
    // Extract just the JSON object in case Claude adds surrounding text
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
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
  pinnedProductIds?: number[];
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
  // Pinned products (matched from idea suggestions) go first, then rest
  const allProducts = wooProducts || [];
  let prioritized: any[] = [];
  if (p.pinnedProductIds?.length) {
    // Use exact pinned product IDs from the frontend match
    prioritized = p.pinnedProductIds
      .map(id => allProducts.find((pr: any) => pr.woo_id === id))
      .filter(Boolean);
  } else if (p.customInstructions) {
    const instr = p.customInstructions.toLowerCase();
    prioritized = allProducts.filter((pr: any) => {
      const name = (pr.name || "").toLowerCase();
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
  const systemPrompt = `אתה כותב מייל שיווקי בעברית למינוטו, בית קלייה קטן בישראל של ארז.

=== חוק היסוד: מה אתה לא יודע ===

אתה מודל שפה. אתה **לא** ארז. אתה לא יודע מה ארז עשה אתמול, מה הוא שתה, מה קרה בקלייה השבוע, כמה יחידות יש במלאי, או מה היה בחנות. **אל תמציא אירועים.**

אסור בכל מחיר:
- "אתמול הכנתי / שתיתי / טעמתי / קליתי / בדקתי"
- "השבוע קליתי / עשינו / הוצאנו / טעמנו"
- "יש X במלאי" או כל מספר ספציפי של יחידות
- "X% יותר טוב" / "הכי טוב שבדקנו" / כל סטטיסטיקה
- ציטוטי לקוחות שלא סופקו לך

**הכלל:** אם אתה לא יכול לאמת את המשפט עם הנתונים שבפרומפט הזה, אל תכתוב אותו כאילו הוא עובדה.

=== מה לכתוב במקום ===

אם המשתמש נתן לך רגע ספציפי בהנחיות (customInstructions) — תשתמש בו כמו שהוא. זה הקלט האמיתי היחיד שלך.

אם המשתמש לא נתן כלום — תכתוב מזווית שלא מצריכה לדעת מה קרה השבוע:
1. **זווית הקורא:** הסצנה של הקורא עכשיו. "הבוקר הזה כבר חם מדי לקפה חם בכוס."
2. **עובדה על המוצר:** דבר שאפשר לאמת מהקטלוג. "חבילה של 250 גרם יוצאת ל-4 ליטר קולד ברו."
3. **תצפית כללית:** אמירה שנכונה תמיד, לא השבוע. "קפה עם גוף מלא עובד יותר טוב קר מקפה עם חומציות גבוהה."

=== איך אתה כותב ===
- כמו וואטסאפ לחבר טוב. קצר, ישיר, חם.
- **חובה** להתחיל ב-"היי," או "שלום," או "מה קורה," — לעולם לא בלי ברכת פתיחה.
- משפטים קצרים. 5-10 מילים.
- 70-110 מילים בסך הכל.

=== חוק הפתיחה (קריטי) ===

פתיחה חזקה היא אחת משלוש אפשרויות. כל השאר אסורות.

**אפשרות 1 — סצנה/רגש שהקורא מזהה:**
- "בוקר חם. הכוס הראשונה של הקפה החם נשארת חצי מלאה." ← הקורא *מרגיש* את זה.
- "יש לך קפה בבית, יש לך מקרר, יש לך 18 שעות." ← הקורא חושב "נכון, אז מה הבעיה?".

**אפשרות 2 — חישוב כלכלי בראש של הקורא:**
- "בית קפה לוקח 22 שקל לכוס קולד ברו. אחת ביום זה 660 שקל בחודש." ← מחייב את הקורא לעצור ולחשב.

**אפשרות 3 — טענה קונטרה-אינטואיטיבית (רק אם באמת מפתיעה):**
- "רוב האנשים חושבים שקולד ברו = קלייה כהה. זה לא נכון." ← מפר את ציפיית הקורא, מחייב אותו להמשיך כדי לראות למה.
- "קפה בהיר יותר טוב קר מקפה כהה." ← הפוך מהאינטואיציה, מעניין.

זה חייב להיות באמת קונטרה-אינטואיטיבי. "הקפה שלנו הוא הכי טוב" זה לא קונטרה-אינטואיטיבי, זה רק בוסט.

**פתיחות אסורות — כל השאר, כולל:**
- תזה גנרית: "הקלייה היא הסוד בקולד ברו" ← משהו שכולם יודעים, לא מפתיע.
- הכרזה על המותג: "אנחנו אוהבים להכין קולד ברו" ← מי אכפת.
- הודעת חדשות גנרית: "השבוע בקלייה..." ← זה "השבוע ב...", לא פתיחה.
- סיפור מומצא בגוף ראשון: "אתמול הכנתי..." ← אתה לא יודע מה הוא הכין אתמול.

**כלל הבדיקה:** אם הפתיחה שלך יכולה להיות משפט ראשון בכתבה במגזין קפה בלי שינוי — **לא טוב**. מייל חייב להיות אישי (סצנה של הקורא), כלכלי (חישוב של הקורא), או מפתיע (טענה שמפרה ציפייה). בלוגים יכולים להיות מידע, מיילים לא יכולים.

=== דוגמאות לטון הנכון ===

**שם לב לשני דברים:** (א) אף אחת לא מתחילה ב"אתמול הכנתי" או "השבוע טעמנו", (ב) כולן פותחות ברגש/סצנה/חישוב, לא בתזה. זה הדפוס שאתה צריך להעתיק.

דוגמה 1 (סצנה של בוקר):
"היי,
בוקר חם. הכוס הראשונה של הקפה החם נשארת חצי מלאה. זה הרגע שקולד ברו הופך מרעיון לצורך.
הקולומביה שלנו — שוקולד, מעט פרי, חומציות רכה. מבנה שמחזיק קר במקום להתפרק.
חבילת 250 גרם, באתר."

דוגמה 2 (חישוב כלכלי מזווית הקורא):
"שלום,
כוס קולד ברו בבית קפה = 22 שקל. אחת ביום = 660 שקל בחודש.
ערכת Toddy + חבילת 250 גרם של הפולים הקולומביאנים שלנו מייצרת 4 ליטר קולד ברו. קצת יותר משבועיים של בקרים, בפחות מכוס אחת של בית קפה.
הערכה באתר."

דוגמה 3 (אמירה שמזמינה את הקורא פנימה):
"מה קורה,
יש לך קפה בבית. יש לך מקרר. יש לך 18 שעות. זה כל מה שצריך לקולד ברו שלא נופל מזה של בית קפה.
התערובת הקולומביאנית שלנו — גוף מלא, שוקולד, מעט פרי — עושה את העבודה. טחינה גסה, מים קרים, לילה במקרר.
חבילת 250 גרם, באתר."

מילים וביטויים אסורים (לא להשתמש בשום מצב):
- "חובבי הקפה המתוחכמים"
- "דיוק שוויצרי" / "דיוק גרמני"
- "משקה משיי" / "משקה חלק" / "משקה שמחזיר לחיים"
- "בלחיצת כפתור"
- "מהפכה בטעם" / "חוללת מהפכה" / "לרמה הבאה" / "לוקחים את X לרמה הבאה"
- "במיוחד בשבילך" / "נבחרו במיוחד"
- "משהו מיוחד" / "משהו שווה במיוחד" / "הכנו משהו מיוחד"
- "מחירים חגיגיים" / "מחירים מיוחדים" / "מחירים שלא יחזרו"
- "המבצע לא נמשך כל השנה"
- "ישירות אליך" / "ישירות אל המטבח שלך"
- "קפה ברמה של בית קפה" / "חוויה ברמה של בית קפה"
- "חלק, צלול ודל בחומציות" (כל רשימת שמות תואר גנרית)
- "שנולד לX" / "שפשוט נולדו ל" (אנתרופומורפיזם זול)
- "להתרענן בסטייל" / "מרגיש יותר טוב בסטייל"
- "אנחנו יודעים מה חסר לך"
- "השנה החלטנו" / "החלטנו לקחת"
- "הקיץ כבר כאן" / "החורף הגיע" / "האביב פה" / "הסתיו מתקרב"
- "חוויה בלתי נשכחת" / "חוויה ייחודית" / "חוויית קפה"
- "הטריק הוא" / "הסוד הוא" / "הטיפ" / "הטיפ הוא" / "הטיפ שלי" / "רק צריך" / "רק סבלנות"
- "כדאי לנסות" / "שווה לנסות" (סתמיים)
- "יאללה לחנות" / "מחכה לך" / "בא לקחת"
- כל ביטוי עם המילה "מיוחד" — קלישאה. תמיד יש דרך ספציפית יותר.
- "מעולה" / "מדהים" / "פנטסטי" / "מצוין" / "המובחרים ביותר" / "הכי טוב שיש" — סופרלטיבים ריקים
- שימוש ב-"!" יותר מפעם אחת
- שימוש ביותר מאימוג'י 1
- bullet lists עם אמוג'י — זה לא מייל, זה פוסט לינקדאין
- **מקף ארוך (—, em dash) או מקף רגיל (–, en dash) כסימן פיסוק.** זה "טלפון" של AI — קופירייטרים אנושיים כמעט לא משתמשים במקפים באמצע משפט. **השתמש בנקודות ופסיקים במקום.** אם אתה רוצה לומר "X, Y, Z" — תשבור לשני משפטים: "X. Y ו-Z." אם אתה רוצה סוגרי משנה — תשבור גם אותם למשפטים נפרדים.

**חוק בלתי-עביר: לא להמציא מבצעים, הנחות, אחוזים, או מחירים ספציפיים.**
אם המשתמש לא ציין בהנחיות שלו "יש X% הנחה" או "המחיר ירד ל-Y", **אסור לך לכתוב שום דבר שכולל אחוז, מילה "הנחה", "מבצע", "חסכון", או "במחיר מיוחד".** זו עבירה על חוק הגנת הצרכן הישראלי ועל חוק הספאם. אם תכתוב "15% הנחה השבוע" כשאין כזה מבצע, העסק חשוף לתביעה ייצוגית. זה לא עניין של סגנון, זה עניין של חוקיות.

אם אתה רוצה לסיים עם CTA, תשתמש ב-"באתר." פשוט — או "זמין באתר." או "במלאי באתר." אף פעם לא אחוז שלא אומת.

**מבנה אסור:** אף פעם לא "מה מחכה לך בחנות?" ואחריו רשימת bullet points. זה קטלוג, לא מייל.

כללי איכות:
- בדוק איות של מילים לועזיות: specialty = ספשיאלטי (לא ספשלטי), espresso = אספרסו
- אל תמציא מבצעים או אחוזי הנחה שלא צוינו בהנחיית המשתמש
- אם המשתמש לא ציין הנחה ספציפית, אל תכתוב אחוזי הנחה
- כתוב מחירים כמו שהם מופיעים בקטלוג. אם המחיר הוא 4500.0000, כתוב ₪4,500

${seasonalContext}

נושאים קודמים (לא לחזור): ${pastSubjects.join(", ") || "אין"}

מוצרים זמינים:
${JSON.stringify(productCatalog, null, 2)}

${p.customInstructions
  ? `**הנחיית המשתמש (השתמש בזה כקלט אמיתי, אל תמציא סביב זה):**\n${p.customInstructions}`
  : "**אין הנחיה מהמשתמש.** זה אומר: אל תמציא אירוע אישי של ארז. תפתח מזווית הקורא, כעובדה על המוצר, או כתצפית כללית (ראה דוגמאות)."}

חובה: בחר מוצרים מהרשימה למעלה! אם המשתמש ציין שמות מוצרים, מצא אותם בקטלוג לפי שם (חיפוש חלקי). תמיד כלול לפחות 2-4 מוצרים. **אל תמציא שמות של פולים, מחירים, או מספרי יחידות שלא בקטלוג.**

החזר JSON בלבד:
{
  "subject": "נושא קצר עד 50 תווים, אימוג'י אחד מקסימום. **אסור לכלול את המילה 'פרסומת'** — המערכת מוסיפה אותה אוטומטית בהתחלה. אם תכלול אותה, היא תופיע פעמיים.",
  "preheader": "משפט אחד קצר עד 60 תווים",
  "greeting": "חובה: 'היי' או 'שלום' או 'מה קורה' — בלי תארים",
  "body": "גוף קצר בעברית פשוטה, 70-110 מילים. שבירת שורות עם \\n. **אסור לכלול את הטקסט '| פרסומת' או כל וריאציה שלו בגוף** — המערכת מוסיפה אותה אוטומטית בסוף. אם תכלול אותה, היא תופיע פעמיים.",
  "cta_text": "טקסט קצר לכפתור",
  "cta_url": "https://minuto.co.il/shop",
  "product_ids": ["חובה! woo_id מספרים מהקטלוג למעלה. לפחות 2 מוצרים"],
  "campaign_theme": "tips|story|promo|seasonal|education",
  "banner_prompt": "A short English description of a CONCRETE coffee-only scene — beans, cup, latte art, bag, roasting drum, or café counter. NO metaphors. NO 'journey', 'road', 'mountain', 'landscape', 'travel', 'adventure'. NO people, vehicles, or outdoor scenery. Example: 'close-up of dark roasted coffee beans next to a white ceramic cup with steam, warm lighting, wooden table'. 10-20 words max."
}`;

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-5-20250929",
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

  // ── Em-dash / en-dash stripper ──────────────────────────────────────────
  // Claude Sonnet 4.5 keeps using em dashes for mid-sentence asides despite
  // an explicit prompt ban. Em dashes are a classic AI tell — real Hebrew
  // copywriters almost never use them. Regex beats prompt rules on this.
  //
  // Strategy: replace "word — word" with "word. Word" (break into two
  // sentences). Also catches the parenthetical pattern "X — Y — Z" → "X. Y.
  // Z.". Works for both em dash (U+2014) and en dash (U+2013).
  if (campaign.body) {
    campaign.body = String(campaign.body)
      .replace(/\s*[—–]\s*/g, ". ")
      // Collapse ".  ." type artifacts from replacements
      .replace(/\.\s*\./g, ".")
      // Collapse multiple spaces
      .replace(/ {2,}/g, " ");
  }
  if (campaign.subject) {
    campaign.subject = String(campaign.subject)
      .replace(/\s*[—–]\s*/g, " ")
      .replace(/ {2,}/g, " ")
      .trim();
  }

  // ── Anti-hallucinated-promotion safety net ──────────────────────────────
  // The prompt tells the AI not to invent percentage discounts, but it
  // occasionally does anyway. Sending a campaign with a fake "15% הנחה"
  // line is a Consumer Protection Law §7 violation (misleading advertising)
  // and a class-action risk. This post-processor strips any line that
  // contains promotional language when the user's customInstructions
  // didn't authorize a promotion.
  const userAuthorizedPromo = /\d+\s*%|הנחה|מבצע|חסכון|במחיר\s+מיוחד/.test(p.customInstructions || "");
  if (!userAuthorizedPromo && campaign.body) {
    const originalBody = String(campaign.body);
    const promoLineRegex = /^.*(\d+\s*%|הנחה|מבצע|חסכון|במחיר\s+מיוחד).*$/gm;
    const cleaned = originalBody.replace(promoLineRegex, "");
    if (cleaned !== originalBody) {
      console.warn(
        "Stripped hallucinated promotion lines from body. Original length:",
        originalBody.length,
        "cleaned length:",
        cleaned.length,
      );
      // Collapse multi-blank runs created by the strip.
      campaign.body = cleaned.replace(/\n{3,}/g, "\n\n").trim();
    }
  }

  // Israeli Communications Law §30א requires clear identification of
  // commercial emails. We enforce "פרסומת" in two editable places at
  // generation time so the user sees it in the composer and can reposition
  // it if needed:
  //   1. Prefix of the subject line (must be first word per legal convention)
  //   2. End-of-body marker in the form "| פרסומת"
  // Additionally, handleSendCampaign applies the same subject prefix at send
  // time as an idempotent non-editable safety rail.
  //
  // Idempotence is enforced by STRIPPING any existing markers the AI might
  // have included (often with invisible RTL marks or stray whitespace that
  // break string equality), then re-appending a single clean marker. This
  // is more robust than endsWith() checks which the AI occasionally evaded.
  const SUBJECT_PREFIX = "פרסומת ";
  const BODY_MARKER = "| פרסומת";
  if (campaign.subject) {
    const subj = String(campaign.subject)
      .replace(/^[\s\u200e\u200f]*פרסומת[\s\u200e\u200f]*/g, "") // strip any existing prefix, incl. RTL marks
      .trim();
    campaign.subject = `${SUBJECT_PREFIX}${subj}`;
  }
  if (campaign.body) {
    const cleaned = String(campaign.body)
      // Strip every "| פרסומת" occurrence regardless of surrounding
      // whitespace, pipe variants, or RTL marks. Anchored to a pipe
      // followed by optional spacing then the Hebrew word.
      .replace(/[\s\u200e\u200f]*\|[\s\u200e\u200f]*פרסומת[\s\u200e\u200f]*/g, "")
      .trimEnd();
    campaign.body = `${cleaned}\n\n${BODY_MARKER}`;
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

// Extract the banner image URL from a previously-generated campaign HTML
// (banner_url isn't stored as a column, so we recover it from html_content)
function extractBannerUrl(html: string | null | undefined): string | null {
  if (!html) return null;
  // Matches the generated: background:url('...') or <v:fill src="...">
  const m1 = html.match(/background:url\('([^']+)'\)/);
  if (m1) return m1[1];
  const m2 = html.match(/<v:fill[^>]*src="([^"]+)"/);
  if (m2) return m2[1];
  return null;
}

async function handleUpdateDraft(p: UpdateDraftPayload) {
  console.log("update-draft:start", {
    campaignId: p.campaignId,
    userId: p.userId,
    productCount: (p.products || []).length,
    hasBody: !!p.body,
    hasCta: !!p.ctaUrl,
  });

  try {
    // Fetch existing campaign
    const { data: existing, error: fetchErr } = await supabase
      .from("campaigns")
      .select("*")
      .eq("id", p.campaignId)
      .eq("user_id", p.userId)
      .single();

    if (fetchErr || !existing) {
      console.error("update-draft:not-found", { campaignId: p.campaignId, fetchErr: fetchErr?.message });
      return err(404, "Campaign not found");
    }

    // Normalize products to the shape buildCampaignHtml expects.
    // Anything missing a woo_id or name is dropped to avoid HTML-build surprises.
    const safeProducts = (p.products || []).filter((pr: any) => pr && pr.woo_id != null).map((pr: any) => ({
      woo_id:            pr.woo_id,
      name:              String(pr.name ?? ""),
      price:             pr.price != null ? String(pr.price) : undefined,
      regular_price:     pr.regular_price != null ? String(pr.regular_price) : undefined,
      sale_price:        pr.sale_price != null ? String(pr.sale_price) : undefined,
      short_description: pr.short_description != null ? String(pr.short_description) : undefined,
      image_url:         pr.image_url != null ? String(pr.image_url) : undefined,
      permalink:         pr.permalink != null ? String(pr.permalink) : undefined,
    }));

    // Preserve banner URL from the existing HTML if caller didn't provide one
    const bannerUrl =
      p.bannerUrl !== undefined ? p.bannerUrl : extractBannerUrl(existing.html_content);

    // Rebuild HTML with edits
    let htmlContent: string;
    try {
      htmlContent = buildCampaignHtml({
        subject:        p.subject || existing.subject,
        preheader:      p.preheader ?? existing.preheader ?? "",
        greeting:       p.greeting ?? "",
        body:           p.body || existing.message || "",
        ctaText:        p.ctaText ?? existing.cta_text ?? "",
        ctaUrl:         p.ctaUrl ?? existing.cta_url ?? "https://minuto.co.il/shop",
        bannerUrl,
        products:       safeProducts,
        unsubscribeUrl: "{{UNSUBSCRIBE_URL}}",
        promoDeadline:  p.promoDeadline || null,
      });
    } catch (buildErr: any) {
      console.error("update-draft:build-html-failed", buildErr?.message, buildErr?.stack);
      return err(500, `Failed to build HTML: ${buildErr?.message || "unknown"}`);
    }

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
        product_ids:  p.products ? safeProducts.map(pr => String(pr.woo_id)) : existing.product_ids,
      })
      .eq("id", p.campaignId);

    if (updateErr) {
      console.error("update-draft:db-update-failed", updateErr.message);
      return err(500, updateErr.message);
    }

    console.log("update-draft:ok", { campaignId: p.campaignId, htmlLength: htmlContent.length });
    return ok({ ok: true, htmlContent });
  } catch (e: any) {
    console.error("update-draft:uncaught", e?.message, e?.stack);
    return err(500, `update-draft failed: ${e?.message || "unknown"}`);
  }
}

// ── Fetch Contacts from Resend (single source of truth) ─────────────────────

async function fetchResendContacts(): Promise<Array<{ email: string; name?: string }>> {
  if (!RESEND_KEY) return [];

  const allContacts: Array<{ email: string; name?: string }> = [];
  let after: string | null = null;

  while (true) {
    const url = new URL(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`);
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

  // Israeli Communications Law §30א requires commercial emails to be clearly
  // identified as advertising. Prepend "פרסומת" to every sent subject line.
  // Idempotent: won't double-prefix if the AI (or a duplicated draft) already
  // put it there. Applied at send time only — the stored subject in the
  // editor stays clean so the word doesn't bleed into the preview / history.
  const sendSubject = (() => {
    const raw = (campaign.subject || "").trim();
    if (/^פרסומת\b/.test(raw)) return raw;
    return `פרסומת ${raw}`;
  })();

  // UTM campaign tag — substituted into every {{UTM_CAMPAIGN}} placeholder
  // that buildCampaignHtml baked into links. Test sends get a suffix so
  // they don't pollute production analytics.
  const utmCampaignTag = p.testEmail
    ? `campaign_${p.campaignId}_test`
    : `campaign_${p.campaignId}`;

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);

    for (const recipient of batch) {
      const unsubUrl = generateUnsubscribeUrl(recipient.email);
      const personalizedHtml = campaign.html_content
        .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsubUrl)
        .replace(/\{\{UTM_CAMPAIGN\}\}/g, utmCampaignTag);

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
            subject: sendSubject,
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
          // Capture the full Resend error response so the frontend can
          // show something actionable (e.g., "domain not verified").
          let detail = `${res.status}`;
          try {
            const errBody = await res.json();
            detail = `${res.status} ${errBody.name || ""}: ${errBody.message || JSON.stringify(errBody)}`.trim();
          } catch {
            try { detail = `${res.status} ${await res.text()}`; } catch { /* ignore */ }
          }
          console.error("Resend send failed for", recipient.email, "-", detail);
          errors.push(`${recipient.email}: ${detail}`);
        }
      } catch (e: any) {
        console.error("Resend fetch threw for", recipient.email, "-", e?.message);
        errors.push(`${recipient.email}: ${e?.message || "unknown fetch error"}`);
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

  // Return the actual error messages (not just the count) so the frontend
  // can show why a send failed. Capped to 5 messages to avoid huge payloads.
  return ok({
    ok:          sent > 0,
    sent,
    total:       recipients.length,
    errorCount:  errors.length,
    errors:      errors.slice(0, 5),
    isTest:      !!p.testEmail,
  });
}

// ── Unsubscribe Handler ─────────────────────────────────────────────────────

// Mark a contact as unsubscribed in Resend (source of truth for the list).
//
// IMPORTANT: Resend's contact update endpoint is TOP-LEVEL `/contacts/{email}`,
// NOT the audience-nested `/audiences/{aid}/contacts/{email}` path. The nested
// one returns 404 even for contacts that exist in that audience. The top-level
// path accepts either a contact ID or an email string and resolves across all
// audiences the API key has access to.
//
// Return shape:
//   { ok: true }                         — patched, or genuinely not found
//   { ok: false, error }                 — Resend API failure (401/500/network)
//
// "Not found" is treated as success because the desired end state ("recipient
// won't get mail") is already true.
async function unsubscribeInResend(email: string): Promise<{ ok: boolean; error?: string; notFound?: boolean }> {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not configured" };
  const normalized = email.toLowerCase().trim();

  try {
    const res = await fetch(
      `https://api.resend.com/contacts/${encodeURIComponent(normalized)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ unsubscribed: true }),
      },
    );
    if (res.ok) {
      console.log("unsubscribeInResend:ok", normalized);
      return { ok: true };
    }
    if (res.status === 404) {
      // Contact isn't in any audience we have access to — already in the
      // desired state ("not receiving mail").
      console.log("unsubscribeInResend: not found, treating as success:", normalized);
      return { ok: true, notFound: true };
    }
    const body = await res.text().catch(() => "");
    console.error("unsubscribeInResend: Resend PATCH failed:", res.status, body.slice(0, 200));
    return { ok: false, error: `Resend PATCH failed: ${res.status} ${body.slice(0, 120)}` };
  } catch (e: any) {
    console.error("unsubscribeInResend: fetch threw:", e?.message);
    return { ok: false, error: e?.message || "unknown Resend error" };
  }
}

// Where to send the user after we've unsubscribed them. Must be a plain
// static page — Supabase Edge Functions' gateway forces text/plain +
// Content-Security-Policy: sandbox on any HTML we try to return directly,
// so we do the work then 302 to a page Vercel serves.
const UNSUBSCRIBE_REDIRECT_BASE =
  Deno.env.get("UNSUBSCRIBE_REDIRECT_BASE") ||
  "https://coffeeflow-neon.vercel.app/unsubscribed.html";

function redirectTo(target: string): Response {
  return new Response(null, { status: 302, headers: { Location: target } });
}

async function handleUnsubscribe(url: URL): Promise<Response> {
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("token");

  if (!email || !token) {
    return redirectTo(`${UNSUBSCRIBE_REDIRECT_BASE}?status=invalid`);
  }

  const normalized = email.toLowerCase().trim();

  // 1. Resend is the source of truth for the list — unsubscribe there first.
  const resendResult = await unsubscribeInResend(normalized);
  if (!resendResult.ok) {
    console.error("handleUnsubscribe: Resend unsubscribe failed for", normalized, "-", resendResult.error);
  }

  // 2. Mirror to marketing_contacts so any Supabase-backed reads stay
  //    consistent. The send flow already reads from Resend directly.
  await supabase
    .from("marketing_contacts")
    .update({ opted_in: false, updated_at: new Date().toISOString() })
    .eq("email", normalized);

  const status = resendResult.ok ? "ok" : "partial";
  const target = `${UNSUBSCRIBE_REDIRECT_BASE}?email=${encodeURIComponent(normalized)}&status=${status}`;
  return redirectTo(target);
}

// ── Sync Contacts from Resend ────────────────────────────────────────────────

async function handleSyncResendContacts(userId: string) {
  if (!RESEND_KEY) return err(500, "RESEND_API_KEY not configured");

  const startedAt = Date.now();
  let allContacts: any[] = [];
  let after: string | null = null;

  // Paginate through all Resend contacts. No artificial delay between pages —
  // Resend's published limit is 10 req/s and we're nowhere near that for a
  // few-thousand-contact audience. Only back off on an actual 429.
  let page = 0;
  while (true) {
    page++;

    const url = new URL(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${RESEND_KEY}` },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "2") * 1000;
      console.warn(`Rate limited on page ${page}, waiting ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      page--;
      continue;
    }

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

  console.log(`Fetched ${allContacts.length} contacts from Resend in ${Date.now() - startedAt}ms (${page} pages)`);

  // Build set of all Resend emails for cleanup
  const resendEmails = new Set(allContacts.map((c: any) => (c.email || "").toLowerCase().trim()));

  // 1. Bulk upsert all Resend contacts into Supabase in one call
  const rows = allContacts
    .map((c: any) => {
      const email = (c.email || "").toLowerCase().trim();
      if (!email) return null;
      return {
        user_id:  userId,
        email,
        name:     [c.first_name, c.last_name].filter(Boolean).join(" ") || undefined,
        opted_in: !c.unsubscribed,
        source:   "resend",
      };
    })
    .filter(Boolean);

  let synced = 0;
  let firstUpsertErr: string | null = null;
  // Supabase upsert limit ~1000 rows — chunk if needed.
  // onConflict is "email" only: marketing_contacts is an org-wide shared
  // table per CLAUDE.md, and the unique constraint on (email) reflects that.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error: dbErr } = await supabase
      .from("marketing_contacts")
      .upsert(chunk, { onConflict: "email" });
    if (!dbErr) {
      synced += chunk.length;
    } else {
      console.error("Bulk upsert error:", dbErr.message, "chunk", i, "sample row:", JSON.stringify(chunk[0]));
      if (!firstUpsertErr) firstUpsertErr = `${dbErr.message} (chunk ${i}, sample: ${JSON.stringify(chunk[0])})`;
    }
  }

  // 2. Mark contacts as opted_out if Resend shows them unsubscribed
  // We do NOT delete contacts that aren't in Resend — they may be valid and just not pushed yet
  const unsubscribedEmails = allContacts
    .filter((c: any) => c.unsubscribed)
    .map((c: any) => (c.email || "").toLowerCase().trim())
    .filter(Boolean);

  let unsubscribed = 0;
  if (unsubscribedEmails.length > 0) {
    const { error: unsubErr } = await supabase
      .from("marketing_contacts")
      .update({ opted_in: false })
      .eq("user_id", userId)
      .in("email", unsubscribedEmails);
    if (!unsubErr) unsubscribed = unsubscribedEmails.length;
  }

  // 3. Delete contacts that exist in CoffeeFlow but not in Resend (Resend is source of truth)
  // Paginate through ALL contacts — Supabase default limit is 1000 rows
  const resendEmailSet = new Set(allContacts.map((c: any) => (c.email || "").toLowerCase().trim()).filter(Boolean));
  let allDbEmails: string[] = [];
  let dbFrom = 0;
  const DB_PAGE = 1000;
  while (true) {
    const { data: page } = await supabase
      .from("marketing_contacts")
      .select("email")
      .range(dbFrom, dbFrom + DB_PAGE - 1);
    if (!page || page.length === 0) break;
    allDbEmails = allDbEmails.concat(page.map((r: any) => (r.email || "").toLowerCase().trim()).filter(Boolean));
    if (page.length < DB_PAGE) break;
    dbFrom += DB_PAGE;
  }

  const toDelete = allDbEmails.filter(email => !resendEmailSet.has(email));

  let deleted = 0;
  const DELETE_CHUNK = 200;
  for (let i = 0; i < toDelete.length; i += DELETE_CHUNK) {
    const chunk = toDelete.slice(i, i + DELETE_CHUNK);
    const { error: delErr, count } = await supabase
      .from("marketing_contacts")
      .delete({ count: "exact" })
      .in("email", chunk);
    if (!delErr && count) deleted += count;
  }

  console.log(`Sync done: synced=${synced}, unsubscribed=${unsubscribed}, deleted=${deleted}, resend_total=${allContacts.length}`);
  return ok({ ok: true, synced, unsubscribed, deleted, total: allContacts.length, upsertError: firstUpsertErr });
}

// ── Push Contacts to Resend ──────────────────────────────────────────────────

async function pushContactsToResend(contacts: Array<{ email: string; name?: string }>) {
  let pushed = 0, failed = 0;
  const CONCURRENCY = 5; // conservative parallel requests to avoid Resend rate limits

  async function pushOne(c: { email: string; name?: string }, retries = 3): Promise<void> {
    const email = (c.email || "").toLowerCase().trim();
    if (!email || !email.includes("@")) { failed++; return; }
    const parts = (c.name || "").trim().split(/\s+/);
    try {
      const res = await fetch(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, first_name: parts[0] || "", last_name: parts.slice(1).join(" ") || "", unsubscribed: false }),
      });
      if (res.ok) { pushed++; return; }
      if (res.status === 429 && retries > 0) {
        // Rate limited — wait and retry
        const retryAfter = parseInt(res.headers.get("retry-after") || "2") * 1000;
        await new Promise(r => setTimeout(r, retryAfter || 2000));
        return pushOne(c, retries - 1);
      }
      const txt = await res.text();
      console.error("Resend push error:", res.status, txt, email);
      failed++;
    } catch (e: any) { console.error("Resend push exception:", e.message, email); failed++; }
  }

  // Run CONCURRENCY requests in parallel, chunk by chunk
  for (let i = 0; i < contacts.length; i += CONCURRENCY) {
    await Promise.all(contacts.slice(i, i + CONCURRENCY).map(c => pushOne(c)));
  }

  return { pushed, failed };
}

async function handlePushToResend(payload: {
  contacts?: Array<{ email: string; name?: string }>;
  userId?: string;
  offset?: number;
  limit?: number;
}) {
  if (!RESEND_KEY) return err(500, "RESEND_API_KEY not configured");

  let contacts: Array<{ email: string; name?: string }> = [];
  let total = 0;

  if (payload.contacts && Array.isArray(payload.contacts) && payload.contacts.length > 0) {
    contacts = payload.contacts;
    total = contacts.length;
  } else if (payload.userId) {
    // Server-side: fetch a page of opted-in contacts from Supabase
    const offset = payload.offset ?? 0;
    const limit  = payload.limit  ?? 500;
    const { data, error, count } = await supabase
      .from("marketing_contacts")
      .select("email, name", { count: "exact" })
      .eq("opted_in", true)
      .range(offset, offset + limit - 1);
    if (error) return err(500, "DB error: " + error.message);
    contacts = data || [];
    total = count ?? 0;
  } else {
    return err(400, "contacts array or userId required");
  }

  if (contacts.length === 0) return ok({ ok: true, pushed: 0, failed: 0, total, done: true });

  console.log(`Pushing ${contacts.length} contacts to Resend (offset=${payload.offset ?? 0})...`);
  const { pushed, failed } = await pushContactsToResend(contacts);
  console.log(`Done: pushed=${pushed} failed=${failed}`);

  const offset = payload.offset ?? 0;
  const limit  = payload.limit  ?? 500;
  const done   = offset + contacts.length >= total;

  return ok({ ok: true, pushed, failed, total, offset: offset + contacts.length, done });
}

// ── Public Subscribe (for website forms) ─────────────────────────────────────

async function handlePublicSubscribe(payload: { email: string; name?: string; phone?: string; userId?: string }) {
  const email = (payload.email || "").toLowerCase().trim();
  if (!email || !email.includes("@")) return err(400, "Invalid email");

  if (!RESEND_KEY) return err(500, "RESEND_API_KEY not configured");

  // Single source of truth: Resend Contacts only
  try {
    const nameParts = (payload.name || "").split(" ");
    const res = await fetch(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`, {
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

// ── TEMP: verify erez is in the audience and in supabase ───────────────────
async function handleDebugVerifyErez() {
  const target = "erez@minuto.co.il";
  const out: any = { target };

  // 1. Walk the audience to confirm erez is now a member
  try {
    let after: string | null = null;
    let found = false;
    let totalWalked = 0;
    for (let p = 0; p < 200; p++) {
      const url = new URL(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`);
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${RESEND_KEY}` } });
      if (!r.ok) { out.audience_list_error = `${r.status}`; break; }
      const j = await r.json();
      const contacts = j.data || [];
      totalWalked += contacts.length;
      if (contacts.find((c: any) => (c.email || "").toLowerCase() === target)) {
        found = true;
        break;
      }
      if (contacts.length < 100) break;
      after = contacts[contacts.length - 1]?.id || null;
      if (!after) break;
    }
    out.in_audience = found;
    out.audience_total_walked = totalWalked;
  } catch (e: any) {
    out.audience_walk_threw = e?.message;
  }

  // 2. Check Supabase
  const { data: rows } = await supabase
    .from("marketing_contacts")
    .select("*")
    .eq("email", target);
  out.supabase_rows = rows;

  return ok(out);
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

    // Auth guard temporarily disabled — JWT signing mismatch between Clerk and PostgREST

    let response: Response;
    switch (action) {
      case "generate-ideas":    response = await handleGenerateIdeas(payload as IdeasPayload); break;
      case "generate":          response = await handleGenerate(payload as GeneratePayload); break;
      case "update-draft":      response = await handleUpdateDraft(payload as UpdateDraftPayload); break;
      case "sync-woo-products": response = await handleSyncWooProducts(payload.userId); break;
      case "send-campaign":     response = await handleSendCampaign(payload as SendCampaignPayload); break;
      case "send-test":         response = await handleSendCampaign({ ...payload, testEmail: payload.testEmail } as SendCampaignPayload); break;
      case "sync-resend-contacts": response = await handleSyncResendContacts(payload.userId); break;
      case "push-to-resend":   response = await handlePushToResend(payload as any); break;
      case "list-models":      response = await (async () => {
        const r = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        });
        const d = await r.json();
        return ok({ status: r.status, models: d });
      })(); break;
      case "subscribe":        response = await handlePublicSubscribe(payload); break;
      case "debug-verify-erez":    response = await handleDebugVerifyErez(); break;
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
