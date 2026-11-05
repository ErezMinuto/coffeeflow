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
import { forbidden, hasRole } from "../_shared/role_caller.ts";
import { callClaude, MODEL_CAMPAIGN, MODEL_CAMPAIGN_CHEAP } from "../seo-agent/claude.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { buildCampaignHtml, decodeDesign, DEFAULT_STYLE } from "./email_template.ts";

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
const RESEND_AUDIENCE_ID = Deno.env.get("RESEND_AUDIENCE_ID");
if (!RESEND_AUDIENCE_ID) throw new Error("RESEND_AUDIENCE_ID secret is required");
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

// Campaign brand guard: these never lead an email (green / unroasted coffee,
// resold Veneto and Toddy). Same list as fetchMinutoCoffeeCatalog.
function isOffBrandHero(name: string): boolean {
  return /ירוק|green coffee|unroasted|raw coffee|veneto|ונטו|toddy|טודי/i.test(String(name ?? ""));
}

const PROMO_RE = /\d+\s*%|הנחה|מבצע|חסכון|במחיר\s+מיוחד/;

// Woo short descriptions arrive tag-stripped but with entities (&#8211;).
function plainText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
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

    // Try models in order: Gemini 3.1 Flash Image (preview) -> Nano Banana 2.1.
    // Imagen 4 and the Gemini 2.0 image models used to sit here; all three
    // were retired (404), which left this chain with no working model.
    // imageConfig pins 16:9 — the prompt's "16:9" line alone is ignored.
    const geminiImageAttempt = (name: string, model: string) => ({
      name,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      headers: { "Content-Type": "application/json" },
      body: {
        contents: [{ parts: [{ text: `Generate an image: ${imagePrompt}` }] }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "16:9" } },
      },
      parse: (json: any) => {
        for (const part of json.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData?.mimeType?.startsWith("image/")) return { data: part.inlineData.data, mime: part.inlineData.mimeType };
        }
        return null;
      },
    });
    const attempts = [
      geminiImageAttempt("Gemini 3.1 Flash Image", "gemini-3.1-flash-image-preview"),
      geminiImageAttempt("Nano Banana 2.1", "gemini-nano-banana-2.1"),
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

  // Routed through the shared client: measured in agent_cost_ledger and
  // switchable by the MODEL_CAMPAIGN_CHEAP slot, like the rest of the marketing stack.
  let rawText = "";
  try {
    const res = await callClaude({
      sourceFn:  "generate-campaign",
      model:     MODEL_CAMPAIGN_CHEAP,
      system:    systemPrompt,
      messages:  [{ role: "user", content: p.context || "תן לי 5 רעיונות לקמפיין הבא" }],
      maxTokens: 2000,
    });
    rawText = res.text;
  } catch (e: unknown) {
    console.error("model error:", e instanceof Error ? e.message : String(e));
    return err(500, "Claude API error: " + (e instanceof Error ? e.message : String(e)));
  }

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
  // false = return the generated draft WITHOUT writing a campaigns row. The
  // strategist loop keeps the draft in strategic_recommendations.artifact_snapshot
  // while the critic reviews it, and writes the campaigns row once, on pass.
  persist?: boolean;
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
    // Match on distinctive name words in any script ("דיי בנסה", "Jura"),
    // not the generic ones every coffee shares.
    const instr = p.customInstructions.toLowerCase();
    const generic = new Set(["פולי", "קפה", "ספשלטי", "ספיישלטי", "מינוטו", "טרי", "זני", "בקלייה", "בהירה", "כהה", "ערביקה", "specialty", "coffee", "minuto", "arabica", "100%", "מבצע", "הנחה", "חדש", "מתנה"]);
    const score = (pr: any) => new Set(((pr.name || "").toLowerCase().match(/[\p{L}\p{N}+]+/gu) || [])
      .filter((w: string) => w.length >= 3 && !generic.has(w) && instr.includes(w))).size;
    prioritized = allProducts
      .map((pr: any) => ({ pr, n: score(pr) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 12)
      .map((x) => x.pr);
  }
  // Minuto's own roasted coffee is always in view, so the model can pick a
  // real bean as the hero; then the rest of the catalog, up to 50 items.
  const isMinutoCoffee = (pr: any) =>
    (pr.categories || []).some((c: any) => /פולי קפה טרי|תערובות קפה מינוטו/.test(typeof c === "string" ? c : c?.name || "")) &&
    !isOffBrandHero(pr.name);
  const coffee = allProducts.filter((pr: any) => isMinutoCoffee(pr) && !prioritized.includes(pr));
  const rest = allProducts.filter((pr: any) => !prioritized.includes(pr) && !coffee.includes(pr));
  const orderedProducts = [...prioritized, ...coffee, ...rest].slice(0, 50);

  // The model gets each product's own description so the notes it writes
  // come from the shop page, not from its imagination. Descriptions only for
  // the first 30 (matches, then our coffee) to keep the prompt small.
  const productCatalog = orderedProducts.map((pr: any, i: number) => ({
    woo_id: pr.woo_id,
    name: pr.name,
    price: pr.price,
    sale_price: pr.sale_price || undefined,
    categories: pr.categories?.slice(0, 2),
    off_brand: isOffBrandHero(pr.name) || undefined,
    description: i < 30 ? plainText(pr.short_description).slice(0, 240) || undefined : undefined,
  }));
  console.log("Catalog size:", productCatalog.length, "prioritized:", prioritized.length, prioritized.map((p: any) => `${p.name}(${p.woo_id})`).join(", "));

  // 3. Fetch past campaigns (for AI to avoid repetition)
  const { data: pastCampaigns } = await supabase
    .from("campaigns")
    .select("subject, campaign_type")
    .eq("user_id", p.userId)
    .eq("channel", "email")
    .order("created_at", { ascending: false })
    .limit(5);

  const pastSubjects = (pastCampaigns || []).map((c: any) => c.subject).filter(Boolean);

  // 4. Seasonal context
  const seasonalContext = getSeasonalContext();

  // The owner's instructions are the only source of a promotion. Without
  // one, every promo word is stripped below (Consumer Protection Law §7).
  const userAuthorizedPromo = PROMO_RE.test(p.customInstructions || "");

  // 5. Call the model
  const systemPrompt = `אתה כותב ועורך מייל שיווקי בעברית למינוטו קפה בית קלייה ספיישלטי, בית קלייה קטן ברחובות.
המייל נבנה מסקשנים קבועים בתבנית מעוצבת: כותרת ראשית עם מוצר גיבור, תגיות טעם, פס עובדות, טקסט קצר, טיפ הכנה, בלוק הצעה, רשת מוצרים, וכפתור סיום. אתה ממלא את התוכן של כל סקשן. העיצוב כבר קיים, אל תכתוב HTML.

=== חוק היסוד: מה אתה לא יודע ===
אתה לא ארז. אתה לא יודע מה קרה בקלייה השבוע, מה המלאי, או מה לקוחות אמרו. אל תמציא אירועים, סטטיסטיקות, ציטוטים, מספרי יחידות או "אתמול קליתי".
כל עובדה על מוצר (טעמים, מקור, גובה, זן, עיבוד, משקל) חייבת להופיע בשדה description שלו בקטלוג. אם היא לא שם, אל תכתוב אותה. עדיף להשמיט שדה מאשר לנחש.

=== עובדות קבועות על מינוטו (מותר להשתמש) ===
- קולים פולים טריים בכל שבוע. לעולם לא "כל בוקר" או "כל יום".
- שקית קמעונאית של 330 גרם, סגורה. לעולם לא לתאר שקית פתוחה.
- מהדורות מיוחדות (Roastery) נמכרות בצנצנת, לא בשקית.

=== מוצר הגיבור ===
- hero_product_id: המוצר שהמייל עליו. בדרך כלל פולי קפה קלויים של מינוטו.
- אסור כגיבור: מוצרים עם off_brand=true (קפה ירוק/לא קלוי, Veneto, Toddy).
- אם המשתמש ביקש מוצר מסוים, הוא הגיבור.

=== הקול ===
- חם, ישיר, ספציפי. משפטים קצרים. כמו הודעה מבית הקלייה, לא כמו פרסומת.
- פנייה ברבים ("אתם", "תטעמו") או ניסוח ניטרלי. לא פנייה בלשון זכר יחיד ("תחזור", "תיהנה", "אתה").
- בלי מקפים ארוכים (— או –) כסימן פיסוק. נקודות ופסיקים בלבד.
- לא להשוות למתחרים, לסופרמרקט או לקפה של אחרים. רק היתרונות שלנו.
- לא "ספשלטי" אלא "ספיישלטי". לא "מקלה" אלא "בית קלייה".
- סימן קריאה אחד לכל היותר. בלי אימוג'י בגוף.
- אסורים: "חוויה", "מיוחד", "לרמה הבאה", "מהפכה", "במיוחד בשבילך", "מעולה", "מדהים", "הכי טוב", "כדאי לנסות", "הסוד הוא", "הקיץ כבר כאן", "בלחיצת כפתור", "ישירות אליך".

=== פתיחה (שדה body, פסקה ראשונה) ===
אחת משלוש: סצנה שהקורא מזהה ("בוקר חם. הכוס הראשונה נשארת חצי מלאה."), חישוב בראש של הקורא, או טענה שבאמת מפתיעה. לא תזה גנרית, לא "השבוע בקלייה".

=== מבצעים ===
${userAuthorizedPromo
  ? "המשתמש ציין מבצע בהנחיות. השתמש רק בפרטים שהוא נתן (אחוז, קוד, מוצרים, תאריך). אל תוסיף פרטים ואל תחשב מחירים אחרי הנחה. שים את המבצע בשדה offer."
  : "המשתמש לא ציין מבצע. אסור לכתוב אחוז, 'הנחה', 'מבצע', 'חסכון' או 'מחיר מיוחד' בשום שדה. offer יכול להציג רק מוצר אמיתי מהקטלוג (למשל ערכת התנסות) במחיר שלו בקטלוג, או להיות null."}

${seasonalContext}

נושאים קודמים (לא לחזור): ${pastSubjects.join(", ") || "אין"}

מוצרים זמינים (JSON):
${JSON.stringify(productCatalog)}

${p.customInstructions
  ? `**הנחיית המשתמש (זה הקלט האמיתי היחיד, אל תמציא סביבו):**\n${p.customInstructions}`
  : "**אין הנחיה מהמשתמש.** בחר פולי קפה של מינוטו מהקטלוג וכתוב מזווית הקורא או מעובדה מתוך ה-description."}

החזר JSON בלבד, בלי טקסט לפניו או אחריו:
{
  "subject": "עד 50 תווים, אימוג'י אחד לכל היותר. בלי המילה 'פרסומת' (המערכת מוסיפה).",
  "preheader": "משפט אחד עד 80 תווים. מוצג גם מתחת לכותרת.",
  "kicker": "תווית קצרה מעל הכותרת, עד 5 מילים, למשל 'חד זני מאתיופיה · קלייה בהירה'",
  "headline": "כותרת ראשית, עד 8 מילים, בלי אימוג'י",
  "greeting": "'היי,' או 'שלום,' או ''",
  "body": "2-3 פסקאות קצרות, 50-100 מילים בסך הכל. פסקאות מופרדות ב-\\n\\n. מותר **הדגשה** אחת.",
  "cta_text": "טקסט כפתור, 2-4 מילים, פועל ברבים או שם פעולה (למשל 'להזמנת דיי בנסה')",
  "cta_url": "קישור minuto.co.il של מוצר הגיבור, או https://minuto.co.il/shop",
  "hero_product_id": 0,
  "notes": ["2-4 תגיות טעם של מוצר הגיבור, מילה או שתיים כל אחת, רק מתוך ה-description. [] אם אין"],
  "facts": [{"label": "מקור", "value": "..."}],
  "tip": {"title": "איך להכין", "text": "משפט או שניים"},
  "offer": null,
  "products": [{"id": 0, "note": "שורת טעם קצרה מתוך ה-description שלו, עד 6 מילים", "display_name": "שם קצר עד 4 מילים"}],
  "grid_title": "כותרת לרשת המוצרים, עד 5 מילים",
  "closing_text": "משפט סיום קצר מעל הכפתור האחרון, או ''",
  "campaign_theme": "tips|story|promo|seasonal|education",
  "banner_prompt": "English, 10-20 words, a concrete coffee-only scene (beans, cup, bag). Used only when the hero has no product photo."
}

הערות לשדות:
- facts: עד 4 פריטים (מקור, גובה, זן, עיבוד, קלייה) ורק מה שכתוב ב-description של הגיבור. [] אם אין.
- tip: רק אם יש טיפ הכנה כללי ונכון לסוג המוצר. אחרת null.
- offer: null, או {"title": "...", "text": "...", "code": "רק קוד שהמשתמש נתן", "cta_text": "...", "cta_url": "קישור minuto.co.il", "product_id": 0}.
- products: 2-4 מוצרים לרשת, לא כולל הגיבור. מוצרים משלימים אמיתיים מהקטלוג.`;

  // Routed through the shared client: measured in agent_cost_ledger and
  // switchable by the MODEL_CAMPAIGN slot, like the rest of the marketing stack.
  let rawText = "";
  let stopReason = "";
  try {
    const res = await callClaude({
      sourceFn:  "generate-campaign",
      model:     MODEL_CAMPAIGN,
      system:    systemPrompt,
      messages:  [{ role: "user", content: p.customInstructions || "צור קמפיין שבועי" }],
      // Thinking models spend part of max_tokens before the JSON starts; the
      // reply itself is ~1.5k tokens. A tight cap cut it off mid-JSON in prod.
      maxTokens: 8192,
    });
    rawText = res.text;
    stopReason = res.stop_reason;
  } catch (e: unknown) {
    console.error("model error:", e instanceof Error ? e.message : String(e));
    return err(500, "Claude API error: " + (e instanceof Error ? e.message : String(e)));
  }
  console.log("model raw response length:", rawText.length, "stop:", stopReason, "model:", MODEL_CAMPAIGN);

  let campaign: any;
  try {
    const unfenced = rawText.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    campaign = JSON.parse(start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced);
  } catch {
    console.error("AI parse error:", stopReason, rawText.slice(0, 2000));
    return err(500, stopReason === "max_tokens"
      ? "AI response was cut off (max_tokens)"
      : "Failed to parse AI response");
  }
  if (!campaign || typeof campaign !== "object" || !campaign.subject || !campaign.body) {
    return err(500, "AI response is missing subject or body");
  }

  // ── Clean every text field the same way ────────────────────────────────
  // Em/en dashes are an AI tell the prompt alone doesn't stop; "פרסומת"
  // belongs in the subject suffix only; without the owner's say-so a
  // promotion line is removed (fake "15% הנחה" = §7 exposure).
  const clean = (v: unknown, max = 400): string => {
    let s = String(v ?? "").replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");
    s = s.replace(/[\s‎‏]*\|[\s‎‏]*פרסומת[\s‎‏]*/g, " ").replace(/[\s‎‏]+פרסומת\b/g, "");
    if (!userAuthorizedPromo && PROMO_RE.test(s)) return "";
    return s.replace(/ {2,}/g, " ").trim().slice(0, max);
  };
  const cleanBody = (v: unknown): string => {
    let s = String(v ?? "").replace(/\s*[—–]\s*/g, ". ").replace(/\.\s*\./g, ".");
    s = s.replace(/[\s‎‏]*\|[\s‎‏]*פרסומת[\s‎‏]*/g, "").replace(/[\s‎‏]+פרסומת\b/g, "");
    if (!userAuthorizedPromo) {
      const stripped = s.replace(/^.*(\d+\s*%|הנחה|מבצע|חסכון|במחיר\s+מיוחד).*$/gm, "");
      if (stripped !== s) console.warn("Stripped unauthorised promotion lines from body");
      s = stripped;
    }
    return s.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
  };

  // Israeli Communications Law §30א: one " | פרסומת" suffix on the subject.
  // Any marker the model produced (prefix, suffix, stray) is stripped first.
  const SUBJECT_SUFFIX = " | פרסומת";
  const subjectCore = String(campaign.subject)
    .replace(/\s*[—–]\s*/g, " ")
    .replace(/^[\s‎‏]*פרסומת[\s‎‏]*/g, "")
    .replace(/[\s‎‏]*\|[\s‎‏]*פרסומת[\s‎‏]*$/g, "")
    .replace(/[\s‎‏]+פרסומת\b/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  campaign.subject = `${subjectCore}${SUBJECT_SUFFIX}`;
  campaign.body = cleanBody(campaign.body);
  campaign.preheader = clean(campaign.preheader, 150);
  campaign.greeting = clean(campaign.greeting, 40);
  campaign.cta_text = clean(campaign.cta_text, 60) || "לחנות";
  campaign.cta_url = isMinutoUrl(String(campaign.cta_url ?? "")) ? String(campaign.cta_url) : `${SITE_URL}/shop`;

  // 6. Match products with full data. Ids may come back as strings.
  const byId = new Map((wooProducts || []).map((pr: any) => [Number(pr.woo_id), pr]));
  const toEmailProduct = (pr: any, extra: { note?: string; display_name?: string } = {}) => ({
    woo_id:            pr.woo_id,
    name:              pr.name,
    display_name:      extra.display_name || undefined,
    note:              extra.note || undefined,
    price:             pr.price,
    regular_price:     pr.regular_price,
    sale_price:        pr.sale_price,
    short_description: pr.short_description,
    image_url:         pr.image_url,
    permalink:         pr.permalink,
  });

  let heroId = Number(campaign.hero_product_id);
  let hero: any = byId.get(heroId);
  if (hero && isOffBrandHero(hero.name)) {
    console.warn("Model picked an off-brand hero, dropped:", hero.name);
    hero = undefined;
  }
  if (!hero) heroId = NaN;

  const gridSpec: Array<{ id: number; note?: string; display_name?: string }> = (Array.isArray(campaign.products) ? campaign.products : [])
    .map((x: any) => (typeof x === "object" && x ? { id: Number(x.id), note: clean(x.note, 80), display_name: clean(x.display_name, 40) } : { id: Number(x) }))
    .filter((x: any) => Number.isFinite(x.id) && x.id !== heroId && byId.has(x.id));
  // Older response shape: plain product_ids.
  if (!gridSpec.length && Array.isArray(campaign.product_ids)) {
    for (const id of campaign.product_ids.map(Number)) if (id !== heroId && byId.has(id)) gridSpec.push({ id });
  }
  const seen = new Set<number>();
  let selectedProducts = [
    ...(hero ? [toEmailProduct(hero)] : []),
    ...gridSpec.filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, 4).map((x) => toEmailProduct(byId.get(x.id), x)),
  ];

  // Fallback: nothing matched by id, try brand/model tokens from the instructions
  if (selectedProducts.length === 0 && p.customInstructions) {
    console.log("No products matched by ID, trying brand/model-based fallback");
    const instructions = p.customInstructions.toLowerCase();
    const hebrewStopWords = new Set(["קפה", "מכונת", "מכונה", "פולי", "על", "של", "את", "עם", "גם", "או", "לא", "כל", "יש", "אין", "מבצע", "הנחה", "חדש", "חדשה", "מחיר", "במחיר", "למכירה"]);
    selectedProducts = (wooProducts || [])
      .filter((pr: any) => {
        const tokens = (pr.name || "").toLowerCase().split(/[\s\-,]+/).filter((w: string) => w.length > 1 && !hebrewStopWords.has(w));
        const matchCount = tokens.filter((w: string) => instructions.includes(w)).length;
        const hasBrandMatch = tokens.some((w: string) => /[a-zA-Z]/.test(w) && w.length >= 2 && instructions.includes(w));
        return matchCount >= 2 || hasBrandMatch;
      })
      .slice(0, 5)
      .map((pr: any) => toEmailProduct(pr));
    console.log("Brand/model fallback matched:", selectedProducts.length, selectedProducts.map((x: any) => x.name).join(", "));
  }
  if (!hero) {
    const first = selectedProducts.find((x: any) => x.image_url && !isOffBrandHero(x.name));
    if (first) { hero = byId.get(Number(first.woo_id)); heroId = Number(first.woo_id); }
  }
  console.log("Hero:", hero?.name ?? "none", "| grid:", selectedProducts.length - (hero ? 1 : 0));

  // Notes and facts only about a real hero; the model fills them from its description.
  const notes = hero ? (Array.isArray(campaign.notes) ? campaign.notes : []).map((n: unknown) => clean(n, 30)).filter(Boolean).slice(0, 4) : [];
  const facts = hero ? (Array.isArray(campaign.facts) ? campaign.facts : [])
    .map((f: any) => ({ label: clean(f?.label, 20), value: clean(f?.value, 40) }))
    .filter((f: any) => f.label && f.value).slice(0, 4) : [];
  const tip = campaign.tip && campaign.tip.text ? { title: clean(campaign.tip.title, 40) || "איך להכין", text: clean(campaign.tip.text, 300) } : null;

  // Offer: a real catalog product at its catalog price, or the owner's own
  // promotion. A code only when the owner wrote that exact code.
  let offer: any = null;
  if (campaign.offer && typeof campaign.offer === "object") {
    const o = campaign.offer;
    const code = String(o.code ?? "").trim();
    const codeOk = code && userAuthorizedPromo && (p.customInstructions || "").includes(code);
    const offerProduct = byId.get(Number(o.product_id));
    const title = clean(o.title, 80);
    const text = clean(o.text, 240);
    if (title && (userAuthorizedPromo || offerProduct)) {
      offer = {
        title,
        text: text || undefined,
        code: codeOk ? code : undefined,
        ctaText: clean(o.cta_text, 40) || undefined,
        ctaUrl: isMinutoUrl(String(o.cta_url ?? "")) ? String(o.cta_url) : offerProduct?.permalink || undefined,
      };
    }
  }

  // 7. Hero image: the real product photo. The AI banner is only a fallback
  // for a campaign without one.
  let bannerUrl: string | null = null;
  if (!hero?.image_url && campaign.banner_prompt) {
    bannerUrl = await generateBannerImage(String(campaign.banner_prompt));
  }

  const design = {
    style:         DEFAULT_STYLE,
    kicker:        clean(campaign.kicker, 60) || undefined,
    headline:      clean(campaign.headline, 90) || undefined,
    heroProductId: hero ? hero.woo_id : null,
    notes,
    facts,
    tip,
    offer,
    gridTitle:     clean(campaign.grid_title, 50) || undefined,
    closingText:   clean(campaign.closing_text, 120) || undefined,
  };

  // 8. Build HTML
  const htmlContent = buildCampaignHtml({
    subject:        campaign.subject,
    preheader:      campaign.preheader,
    greeting:       campaign.greeting,
    body:           campaign.body,
    ctaText:        campaign.cta_text,
    ctaUrl:         campaign.cta_url,
    bannerUrl,
    products:       selectedProducts,
    unsubscribeUrl: "{{UNSUBSCRIBE_URL}}",
    ...design,
  });
  const productIds = selectedProducts.map((pr: any) => String(pr.woo_id));

  // 9. Save draft to database (skipped for persist:false — see GeneratePayload)
  if (p.persist === false) {
    return ok({
      ok:       true,
      persisted: false,
      campaign: {
        id:           null,
        subject:      campaign.subject,
        preheader:    campaign.preheader,
        greeting:     campaign.greeting,
        body:         campaign.body,
        ctaText:      campaign.cta_text,
        ctaUrl:       campaign.cta_url,
        theme:        campaign.campaign_theme,
        bannerUrl,
        products:     selectedProducts.map((pr: any) => ({ name: pr.name, permalink: pr.permalink })),
        productIds,
        htmlContent,
        campaignType: p.campaignType || "auto",
      },
    });
  }
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
      product_ids:     productIds,
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
  // Current layout: <img class="banner-img" src="...">. Older drafts:
  // background:url('...') or <v:fill src="...">.
  const m0 = html.match(/<img class="banner-img" src="([^"]+)"/);
  if (m0) return m0[1].replace(/&amp;/g, "&");
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

    // Section fields (hero, notes, offer ...) ride in the stored HTML; the
    // editor only sends the text columns. Drafts from before the new
    // template have none and render with the defaults.
    const design = decodeDesign(existing.html_content);
    const productNotes = design.productNotes && typeof design.productNotes === "object" ? design.productNotes : {};

    // Normalize products to the shape buildCampaignHtml expects.
    // Anything missing a woo_id or name is dropped to avoid HTML-build surprises.
    const safeProducts = (p.products || []).filter((pr: any) => pr && pr.woo_id != null).map((pr: any) => ({
      woo_id:            pr.woo_id,
      name:              String(pr.name ?? ""),
      note:              typeof productNotes[String(pr.woo_id)]?.note === "string" ? productNotes[String(pr.woo_id)].note : undefined,
      display_name:      typeof productNotes[String(pr.woo_id)]?.display_name === "string" ? productNotes[String(pr.woo_id)].display_name : undefined,
      price:             pr.price != null ? String(pr.price) : undefined,
      regular_price:     pr.regular_price != null ? String(pr.regular_price) : undefined,
      sale_price:        pr.sale_price != null ? String(pr.sale_price) : undefined,
      short_description: pr.short_description != null ? String(pr.short_description) : undefined,
      image_url:         pr.image_url != null ? String(pr.image_url) : undefined,
      permalink:         pr.permalink != null ? String(pr.permalink) : undefined,
    }));

    // Preserve banner URL from the existing HTML if caller didn't provide one
    const bannerUrl =
      p.bannerUrl !== undefined ? p.bannerUrl
      : typeof design.bannerUrl === "string" ? design.bannerUrl
      : extractBannerUrl(existing.html_content);

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
        style:          design.style,
        kicker:         design.kicker,
        headline:       design.headline,
        heroProductId:  design.heroProductId,
        notes:          Array.isArray(design.notes) ? design.notes : undefined,
        facts:          Array.isArray(design.facts) ? design.facts : undefined,
        tip:            design.tip,
        offer:          design.offer,
        gridTitle:      design.gridTitle,
        closingText:    design.closingText,
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

// ── Render Draft (finished copy, no AI) ─────────────────────────────────────
// The marketing brain's chat hands over copy the owner already approved word
// for word. `generate` would rewrite it, so this path only renders the house
// template around it and saves a draft. It never sends.

interface RenderDraftPayload {
  userId: string;
  subject: string;
  preheader?: string;
  body: string;
  ctaText?: string;
  ctaUrl?: string;
  campaignType?: string;
}

const RENDER_SUBJECT_SUFFIX = " | פרסומת";

// The CTA can only point at our own site: the draft goes to the whole list.
function isMinutoUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "minuto.co.il" || u.hostname === "www.minuto.co.il");
  } catch { return false; }
}

async function handleRenderDraft(p: RenderDraftPayload) {
  const subjectIn = String(p.subject ?? "").trim();
  const body      = String(p.body ?? "").replace(/\r\n/g, "\n").trim();
  const preheader = String(p.preheader ?? "").trim();
  const ctaText   = String(p.ctaText ?? "").trim();
  const ctaUrl    = String(p.ctaUrl ?? "").trim();
  if (!p.userId) return err(400, "userId is required");
  if (!subjectIn || !body) return err(400, "subject and body are required");
  if (subjectIn.length > 200 || preheader.length > 300 || body.length > 8000 || ctaText.length > 80) {
    return err(400, "copy too long (subject ≤200, preheader ≤300, body ≤8000, cta_text ≤80)");
  }
  if (ctaText && !ctaUrl) return err(400, "cta_url is required when cta_text is given");
  if (ctaUrl && !isMinutoUrl(ctaUrl)) return err(400, "cta_url must be an https://minuto.co.il link");

  // Same legal marker the AI path adds (Communications Law §30א). Only the
  // marker is added; the creative subject stays as given.
  const subject = subjectIn
    .replace(/[\s‎‏]*\|[\s‎‏]*פרסומת[\s‎‏]*$/, "")
    .trim() + RENDER_SUBJECT_SUFFIX;

  // A chat tool can fire twice for one approval. Same copy, still a draft,
  // within 15 minutes = the same draft.
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: dupe } = await supabase
    .from("campaigns")
    .select("id, html_content")
    .eq("user_id", p.userId)
    .eq("status", "draft")
    .eq("subject", subject)
    .eq("message", body)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle();
  if (dupe) return ok({ ok: true, existed: true, campaign: { id: dupe.id, subject, htmlContent: dupe.html_content } });

  // The template escapes the body itself and applies **bold** and line
  // breaks, so the copy goes in exactly as approved.
  const htmlContent = buildCampaignHtml({
    subject,
    preheader,
    greeting:       "",
    body,
    ctaText,
    ctaUrl:         ctaUrl || SITE_URL,
    bannerUrl:      null,
    products:       [],
    unsubscribeUrl: "{{UNSUBSCRIBE_URL}}",
  });

  const { data: inserted, error: insertErr } = await supabase
    .from("campaigns")
    .insert({
      user_id:       p.userId,
      channel:       "email",
      subject,
      message:       body,
      html_content:  htmlContent,
      status:        "draft",
      campaign_type: String(p.campaignType || "brain").slice(0, 40),
      product_ids:   [],
      preheader:     preheader || null,
      cta_text:      ctaText || null,
      cta_url:       ctaUrl || null,
    })
    .select("id")
    .single();
  if (insertErr) return err(500, insertErr.message);

  return ok({ ok: true, campaign: { id: inserted.id, subject, htmlContent } });
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
  // Target a specific contact_group (e.g. 'rfm_champions'). Recipients will
  // be intersected with opted_in marketing_contacts. The group name is also
  // injected as {{UTM_GROUP}} so tracking shows WHICH segment got the mail.
  groupName?: string;
  // Optional human-readable campaign slug for UTM. Falls back to
  // `campaign_<id>` if not provided.
  utmCampaignSlug?: string;
  // When true, the campaign's status stays 'draft' after the send so the
  // user can keep iterating. Used by the "send to test group" button — it
  // goes to real people but the campaign isn't considered "sent for real".
  isTestSend?: boolean;
  // When true, pre-filter the recipient list to exclude addresses that
  // already have a `sent` event for this campaign_id. Used to finish a
  // partial send that got cut short by rate limits or plan quota — one
  // click from the History tab picks up where the first run left off
  // without double-mailing anyone who already received it.
  resume?: boolean;
}

// Lower-cased addresses that may receive a campaign: opted_in contacts.
// null = the read failed, and the caller must refuse to send rather than
// fall back to an unchecked list.
async function optedInEmails(): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data: rows, error } = await supabase
      .from("marketing_contacts")
      .select("email")
      .eq("opted_in", true)
      .order("id")
      .range(from, from + 999);
    if (error) { console.error("optedInEmails:", error.message); return null; }
    for (const r of rows ?? []) if (r.email) out.add(String(r.email).toLowerCase().trim());
    if (!rows || rows.length < 1000) return out;
  }
}

// Lower-cased members of every is_test_group group (the internal test list).
async function testGroupEmails(): Promise<Set<string> | null> {
  const { data: groups, error: gErr } = await supabase
    .from("contact_groups").select("id").eq("is_test_group", true);
  if (gErr) { console.error("testGroupEmails:", gErr.message); return null; }
  const ids = (groups ?? []).map((g: any) => g.id);
  const out = new Set<string>();
  if (ids.length === 0) return out;
  for (let from = 0; ; from += 1000) {
    const { data: rows, error } = await supabase
      .from("contact_group_members")
      .select("email")
      .in("group_id", ids)
      .order("id")
      .range(from, from + 999);
    if (error) { console.error("testGroupEmails:", error.message); return null; }
    for (const r of rows ?? []) if (r.email) out.add(String(r.email).toLowerCase().trim());
    if (!rows || rows.length < 1000) return out;
  }
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
  let consentSkipped = 0;

  if (p.testEmail) {
    recipients = [{ email: p.testEmail }];
  } else if (p.selectedRecipients && p.selectedRecipients.length > 0) {
    // A hand-picked list or a group picked in the UI (the dashboard sends a
    // group as its member list). Membership is not consent, so the list is
    // checked here, never trusted from the caller: a real send keeps only
    // opted-in contacts; a test send keeps only members of a test group.
    const allowed = p.isTestSend ? await testGroupEmails() : await optedInEmails();
    if (!allowed) return err(500, "Could not load the consent list; nothing was sent");
    const seen = new Set<string>();
    recipients = [];
    for (const r of p.selectedRecipients) {
      const e = String(r?.email || "").toLowerCase().trim();
      if (!e || seen.has(e) || !allowed.has(e)) continue;
      seen.add(e);
      recipients.push({ email: e, name: r.name || undefined });
    }
    consentSkipped = p.selectedRecipients.length - recipients.length;
    console.log(`Sending to ${recipients.length} of ${p.selectedRecipients.length} selected recipients (${consentSkipped} skipped: ${p.isTestSend ? "not in a test group" : "not opted in"} or duplicate)`);
  } else if (p.groupName) {
    // Target a specific contact_group — intersect with opted-in marketing_contacts.
    const { data: groupRow } = await supabase
      .from("contact_groups")
      .select("id")
      .eq("name", p.groupName)
      .maybeSingle();
    if (!groupRow) return err(404, `Contact group '${p.groupName}' not found`);

    const { data: groupMembers } = await supabase
      .from("contact_group_members")
      .select("email, name")
      .eq("group_id", (groupRow as any).id);

    const groupEmails = new Set(((groupMembers ?? []) as Array<{ email: string }>).map(m => m.email.toLowerCase()));

    // Filter to opted-in only — group membership ≠ consent, always respect opt-in
    recipients = [];
    for (let from = 0; ; from += 1000) {
      const { data: rows } = await supabase
        .from("marketing_contacts")
        .select("email, name")
        .eq("opted_in", true)
        .range(from, from + 999);
      if (!rows || rows.length === 0) break;
      for (const r of rows) {
        if (r.email && groupEmails.has(r.email.toLowerCase())) {
          recipients.push({ email: r.email, name: r.name || undefined });
        }
      }
      if (rows.length < 1000) break;
    }
    console.log(`Sending to ${recipients.length} ${p.groupName} members (opted-in)`);
  } else {
    // Default audience = all opted-in rows in marketing_contacts. Previously
    // this pulled from Resend's Audience list, which silently capped the
    // reachable audience to whatever had been "pushed to Resend" — one send
    // shipped to 172/3,582 contacts because the rest weren't in the audience.
    // Reading from the DB directly makes the opted-in column the single
    // source of truth for who gets a campaign, and drops the extra "push to
    // Resend" step that used to be required before every bulk send.
    recipients = [];
    for (let from = 0; ; from += 1000) {
      const { data: rows, error: dbErr } = await supabase
        .from("marketing_contacts")
        .select("email, name")
        .eq("opted_in", true)
        .range(from, from + 999);
      if (dbErr) {
        console.error("marketing_contacts fetch error:", dbErr.message);
        break;
      }
      if (!rows || rows.length === 0) break;
      for (const r of rows) {
        if (r.email) recipients.push({ email: r.email, name: r.name || undefined });
      }
      if (rows.length < 1000) break;
    }
    console.log(`Fetched ${recipients.length} opted-in contacts from DB`);
  }

  // Resume mode — drop anyone we already emailed for this campaign so a
  // rate-limited / quota-capped prior run can be finished without double
  // mailing. Skip for test sends since those have a synthetic recipient.
  if (p.resume === true && !p.testEmail) {
    const alreadySent = new Set<string>();
    // Paginate in 1,000-row chunks — Supabase client caps a single query at
    // 1,000 rows by default and we have campaigns with 3,000+ recipients.
    for (let from = 0; ; from += 1000) {
      const { data: batch } = await supabase
        .from("campaign_events")
        .select("recipient_email")
        .eq("campaign_id", p.campaignId)
        .eq("event_type", "sent")
        .range(from, from + 999);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        if (row.recipient_email) alreadySent.add(String(row.recipient_email).toLowerCase().trim());
      }
      if (batch.length < 1000) break;
    }
    const before = recipients.length;
    recipients = recipients.filter(r => !alreadySent.has(r.email.toLowerCase().trim()));
    console.log(`Resume: ${before} -> ${recipients.length} (excluded ${alreadySent.size} already-sent)`);
  }

  if (recipients.length === 0) {
    return err(400, consentSkipped > 0
      ? `No recipients: all ${consentSkipped} selected addresses were skipped (${p.isTestSend ? "not in a test group" : "not opted in to marketing email"})`
      : "No recipients");
  }

  // Resend Batch API: up to 100 personalized emails per request. This keeps
  // us well under any rate limit (each call = 1 request, not N) and is the
  // only practical way to blast 3,000+ contacts from within a 60-second
  // edge function invocation window.
  //
  // Even with batching, Resend can return 429 sporadically — we retry the
  // batch up to 3 times with exponential backoff (1s, 2s, 4s) plus respect
  // for any Retry-After header. If it still fails after the 3rd attempt,
  // the recipients are recorded as errors and the caller can `resume: true`
  // on a later run to pick them back up.
  const BATCH_SIZE = 100;
  const BATCH_DELAY_MS = 1100; // ~0.9 batches/sec — headroom under 2/sec
  const MAX_RETRIES = 3;
  let sent = 0;
  let errors: string[] = [];
  const sentEvents: Array<Record<string, unknown>> = [];

  // Israeli Communications Law §30א requires commercial emails to be clearly
  // identified as advertising. Append " | פרסומת" to every sent subject line.
  // Idempotent: strips any existing "פרסומת" marker (prefix, suffix, or
  // stray) then re-appends a single clean suffix. Applied at send time as
  // a safety rail — the stored subject in handleGenerate's post-processor
  // already does this on generation, so normally this is a no-op.
  const sendSubject = (() => {
    const raw = String(campaign.subject || "")
      .replace(/^[\s\u200e\u200f]*פרסומת[\s\u200e\u200f]*/, "")
      .replace(/[\s\u200e\u200f]*\|[\s\u200e\u200f]*פרסומת[\s\u200e\u200f]*$/, "")
      .replace(/[\s\u200e\u200f]+פרסומת\b/g, "")
      .trim();
    return `${raw} | פרסומת`;
  })();

  // UTM campaign tag — human-readable slug if provided, otherwise
  // fallback to `campaign_<id>`. Test sends get a suffix so they don't
  // pollute production analytics.
  const baseSlug = p.utmCampaignSlug?.trim() || `campaign_${p.campaignId}`;
  const utmCampaignTag = p.testEmail ? `${baseSlug}_test` : baseSlug;

  // UTM group tag — which contact_group this send targets. Used in
  // utm_content so analytics can break down conversion by RFM segment
  // (rfm_champions converts X%, rfm_atrisk converts Y%). Defaults to
  // 'all_optedin' when no group was specified.
  const utmGroupTag = p.testEmail
    ? "test"
    : (p.groupName || "all_optedin").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const chunk = recipients.slice(i, i + BATCH_SIZE);

    // Build a per-recipient payload so each email gets its own unique
    // unsubscribe URL (HMAC-signed per address) and UTM tag.
    const batchPayload = chunk.map(r => {
      const unsubUrl = generateUnsubscribeUrl(r.email);
      const personalizedHtml = campaign.html_content
        .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsubUrl)
        .replace(/\{\{UTM_CAMPAIGN\}\}/g, utmCampaignTag)
        .replace(/\{\{UTM_GROUP\}\}/g, utmGroupTag);
      return {
        from:    `Minuto <${SENDER_EMAIL}>`,
        to:      [r.email],
        subject: sendSubject,
        html:    personalizedHtml,
        headers: { "List-Unsubscribe": `<${unsubUrl}>` },
      };
    });

    let res: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batchPayload),
      });
      if (res.status !== 429) break;
      if (attempt === MAX_RETRIES) break;
      // 429 — honor Retry-After if present, else exponential backoff
      const headerRetry = parseInt(res.headers.get("retry-after") || "0", 10) * 1000;
      const backoff = headerRetry || (1000 * Math.pow(2, attempt));
      console.warn(`Batch 429 on attempt ${attempt + 1}, sleeping ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }

    try {
      if (!res) throw new Error("no response");

      if (res.ok) {
        const resBody = await res.json();
        // Batch API returns { data: [{ id: "..." }, ...] } preserving order.
        const ids: Array<{ id?: string }> = Array.isArray(resBody?.data) ? resBody.data : [];
        for (let j = 0; j < chunk.length; j++) {
          const id = ids[j]?.id;
          if (id) {
            sent++;
            sentEvents.push({
              user_id:         p.userId,
              campaign_id:     p.campaignId,
              resend_email_id: id,
              event_type:      "sent",
              recipient_email: chunk[j].email,
            });
          } else {
            errors.push(`${chunk[j].email}: missing id in batch response`);
          }
        }
      } else {
        // Batch as a whole failed — record the error for every recipient in
        // the chunk so the user sees the full scope in the History error
        // column rather than just an opaque "send failed".
        let detail = `${res.status}`;
        try {
          const errBody = await res.json();
          detail = `${res.status} ${errBody.name || ""}: ${errBody.message || JSON.stringify(errBody)}`.trim();
        } catch {
          try { detail = `${res.status} ${await res.text()}`; } catch { /* ignore */ }
        }
        console.error("Resend batch send failed -", detail);
        for (const r of chunk) errors.push(`${r.email}: ${detail}`);
      }
    } catch (e: any) {
      console.error("Resend batch fetch threw -", e?.message);
      for (const r of chunk) errors.push(`${r.email}: ${e?.message || "unknown fetch error"}`);
    }

    if (i + BATCH_SIZE < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Bulk-insert every sent event in one round trip. 3k rows fits fine in a
  // single insert and avoids 3k individual PostgREST calls that used to run
  // inline in the old per-email loop.
  if (sentEvents.length > 0) {
    // Chunk the insert too — Postgres tolerates huge inserts but PostgREST
    // limits payload size at ~4MB; 1k rows per chunk is safe.
    for (let i = 0; i < sentEvents.length; i += 1000) {
      const chunk = sentEvents.slice(i, i + 1000);
      const { error: insertErr } = await supabase.from("campaign_events").insert(chunk);
      if (insertErr) console.error("sent event bulk insert error:", insertErr.message);
    }
  }

  // Real sends flip the draft to 'sent' so the History tab shows the right
  // state and the Edit button hides. Test sends (single-address testEmail
  // OR the test-group isTestSend flag) leave the draft alone so the user
  // can keep iterating after a pre-flight blast to testers.
  const isTest = !!p.testEmail || !!p.isTestSend;
  if (!isTest) {
    // On resume, add to the existing recipient_count instead of overwriting
    // it — otherwise a follow-up send would clobber the first run's count.
    const priorCount = p.resume ? (campaign.recipient_count || 0) : 0;
    const totalCount = priorCount + sent;
    await supabase
      .from("campaigns")
      .update({
        status:          totalCount > 0 ? "sent" : "failed",
        recipient_count: totalCount,
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
    consentSkipped,
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
  // Resend's contacts API is 5 req/sec hard limit. A single sequential loop
  // with 300ms spacing gives ~3.3 req/sec — well inside the cap and leaves
  // headroom if the edge function is processing other Resend traffic in
  // parallel (e.g. an in-flight campaign send).
  const REQUEST_SPACING_MS = 300;

  async function pushOne(c: { email: string; name?: string }, attempt = 0): Promise<void> {
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
      if (res.status === 429 && attempt < 4) {
        // Exponential backoff — start at 1s, double each retry. Respects
        // Retry-After header when Resend provides one.
        const headerRetry = parseInt(res.headers.get("retry-after") || "0", 10) * 1000;
        const backoff = headerRetry || (1000 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, backoff));
        return pushOne(c, attempt + 1);
      }
      const txt = await res.text();
      console.error("Resend push error:", res.status, txt, email);
      failed++;
    } catch (e: any) { console.error("Resend push exception:", e.message, email); failed++; }
  }

  // Sequential with fixed spacing — predictable, not bursty, and easy to
  // reason about. Parallel CONCURRENCY loops were the origin of the prior
  // 429 storms because Promise.all + no inter-group sleep fires all N
  // requests at once, blowing past a per-second cap immediately.
  for (const c of contacts) {
    await pushOne(c);
    await new Promise(r => setTimeout(r, REQUEST_SPACING_MS));
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

    // verify_jwt is off, so the caller is checked here. Everything but
    // `subscribe` (adds one email to the Resend audience, the same thing the
    // public forms-submit does) can email the list or rewrite contacts.
    // Callers: an admin from the dashboard, or strategist-executor with the
    // service key. The GET unsubscribe link above stays public.
    if (action !== "subscribe" && !(await hasRole(req, ["admin"]))) return forbidden(dynamicCors);

    let response: Response;
    switch (action) {
      case "generate-ideas":    response = await handleGenerateIdeas(payload as IdeasPayload); break;
      case "generate":          response = await handleGenerate(payload as GeneratePayload); break;
      case "update-draft":      response = await handleUpdateDraft(payload as UpdateDraftPayload); break;
      case "render-draft":      response = await handleRenderDraft(payload as RenderDraftPayload); break;
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
