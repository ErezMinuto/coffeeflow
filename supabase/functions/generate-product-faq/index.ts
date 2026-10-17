/**
 * generate-product-faq — AI-generate FAQ for a WooCommerce product, grounded in
 * the product's real description, then write it via set-product-faq.
 *
 * POST body:
 *   { "product_id": 65384, "dry_run": false }
 *
 * Response on success (dry_run=false):
 *   { success: true, product_id, product_name, faq, written: true, faq_count }
 *
 * Response on dry_run=true (no write):
 *   { success: true, product_id, product_name, faq, written: false, dry_run: true }
 *
 * Notes:
 *  - Uses public WC Store API (/wc/store/v1) for read — no auth required.
 *  - Calls Anthropic Haiku 4.5. Prompt is category-aware (beans get a
 *    bean-specific structure; equipment/grinders get different prompts).
 *  - Hebrew-only output, gender-inclusive copy.
 *  - Anti-hallucination: prompt forbids inventing facts not in the description.
 *  - Chains to set-product-faq (same-project) for the actual write.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { isServiceCaller, unauthorized } from "../_shared/service_caller.ts";

const ANTHROPIC_KEY  = Deno.env.get("ANTHROPIC_API_KEY") || "";
const SUPA_URL       = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const WOO_URL        = (Deno.env.get("WOO_URL") || "").replace(/\/+$/, "");

const MODEL = "claude-sonnet-4-6";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

interface FaqItem { q: string; a: string }

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function clean(s: string | undefined | null): string {
  return decodeEntities(stripHtml(s || ""));
}

interface WcProduct {
  id: number;
  name: string;
  sku?: string;
  short_description?: string;
  description?: string;
  categories?: { id: number; name: string }[];
  attributes?: { name: string; terms?: { name: string }[] }[];
  prices?: { price?: string; currency_code?: string };
}

async function fetchProduct(productId: number): Promise<WcProduct> {
  const res = await fetch(`${WOO_URL}/wp-json/wc/store/v1/products/${productId}`);
  if (!res.ok) {
    throw new Error(`WC Store API error ${res.status} for product ${productId}`);
  }
  return await res.json();
}

/**
 * Decide which prompt template to use based on category names.
 * Each category gets a different structural focus to maximize accuracy.
 */
function detectCategory(p: WcProduct): "beans" | "espresso_machine" | "grinder" | "brewer" | "other" {
  const cats = (p.categories || []).map(c => c.name);
  const text = cats.join(" ");
  if (text.includes("פולי קפה")) return "beans";
  if (text.includes("מטחנ")) return "grinder";
  if (text.includes("מכונת קפה") || text.includes("מכונות קפה")) return "espresso_machine";
  if (text.includes("חליטה") || text.includes("Hario") || text.includes("מקינטה")) return "brewer";
  return "other";
}

function buildPrompt(p: WcProduct, category: string): string {
  const name      = clean(p.name);
  const shortDesc = clean(p.short_description);
  const longDesc  = clean(p.description);
  const attrs     = (p.attributes || [])
    .map(a => `${a.name}: ${(a.terms || []).map(t => t.name).join(", ")}`)
    .join("\n");
  const cats      = (p.categories || []).map(c => c.name).join(" • ");

  // Per-category structural guidance.
  const categoryGuidance: Record<string, string> = {
    beans: `קטגוריה: פולי קפה ספשלטי. השאלות חייבות לכלול לפחות:
1. שאלה על טעם הקפה - הניסוח חייב להיות "מה טעמו של [שם הזן/המקור]?" (למשל "מה טעמו של אתיופיה דיי בנסה?", "מה טעמו של קניה AA?"). אם השם ארוך מדי - השתמשי ב"מה טעמו של הקפה הזה?". זה ניסוח של מינוטו - לא לכתוב "איך טעום" או "איך מרגיש"
2. שאלה על מקור הפולים (ארץ + אזור + גובה גידול)
3. שאלה על זן/זנים או שיטת עיבוד (washed/natural/honey)
4. שאלה על שיטות חליטה מתאימות
5. שאלה אחת חופשית על משהו ייחודי לפול הזה (פרופיל קלייה, היסטוריה של החווה, וכד')`,
    grinder: `קטגוריה: מטחנת קפה. השאלות חייבות לכלול לפחות:
1. שאלה על המאפיינים העיקריים (סוגי סכינים, גודל, חומר)
2. שאלה על ייעוד (אספרסו / פילטר / רב-תכליתי)
3. שאלה על תכונות חכמות (אם קיימות בתיאור: שקילה אוטומטית, תזמון, וכד')
4. שאלה על מי מתאים למטחנה הזו
5. שאלה על תחזוקה או על משהו ייחודי`,
    espresso_machine: `קטגוריה: מכונת אספרסו. השאלות חייבות לכלול לפחות:
1. שאלה על תכונות המכונה (PID, בויילרים, פרה-אינפוזיה - מהתיאור בלבד)
2. שאלה על מי המכונה מתאימה (מתחיל / חובב / מקצועי)
3. שאלה על אביזרים שמגיעים בקופסה (מהתיאור)
4. שאלה על שטיפת חלב / קיטור / לאטה ארט (אם רלוונטי)
5. שאלה אחת על משהו ייחודי שעולה מהתיאור`,
    brewer: `קטגוריה: מכשיר חליטה. השאלות יכלולו: שיטת השימוש, סוג הקפה שמתאים, נפח, חומרים.`,
    other: `קטגוריה: כללית. תעשי FAQ של 5 שאלות שמועילות לקונה הפוטנציאלי, על בסיס התיאור בלבד.`,
  };

  return `את כותבת FAQ עבור עמוד מוצר באתר של בית קלייה ספשלטי בישראל בשם מינוטו קפה.
המטרה: 5 שאלות ותשובות ברורות, מקצועיות, שיועילו לקונה הפוטנציאלי וגם יעזרו לדיסקאברביליטי במנועי AI.

# כללים מחייבים
- כתיבה ב-עברית בלבד
- עברית טבעית של דובר ילידי, לא תרגום-קלקה. אסור לתרגם מילולית מאנגלית
- שפה מכילה מגדרית - אסור להשתמש בפעלים בגוף שני זכר יחיד ('תוכל', 'תיהנה', 'תזמין', 'אם אתה רוצה', 'נותן לך', 'יש לו'). פתרונות מועדפים, לפי הסדר:
  1. לשון רבים זוגית: "אם אתם רוצים", "כשאתם מכינים", "מאפשרת לכם" — טבעי וזורם
  2. מבנים ניטרליים: "אפשר", "ניתן", "מומלץ", "כדאי"
  3. הימנעי לגמרי מפנייה ישירה אם אפשר ("המכונה מאפשרת חליטה עקבית" במקום "מאפשרת לך")
- כשמתארים קבוצת לקוחות מועדפת — השתמשי ב"אלו ש..." ולא ב"מי ש...". הניסוח עם "אלו" טבעי יותר ומקצועי יותר
- ✅ "אלו שרוצים שליטה מלאה על האספרסו" / "אלו שמחפשים מכונה ביתית מקצועית" / "אלו שמתאמנים על לאטה ארט"
- ❌ "מי שרוצים שליטה מלאה" / "מי שמחפש" / "מי שמתאמנים"
- כשבוחרים על מה ללקוח אכפת — "אספרסו", "טעם", "חוויה" קודמים ל"טמפרטורה", "PID", "פרמטר טכני". טכני זה אמצעי, לא מטרה
- שמרי על קול המותג: ענייני, מדויק, חם. לא מנופח, לא שיווקי-יתר. לא סלנג ("ממש צריך", "סחבה", "שווה את זה")
- **אסור להשתמש בקו מפריד ארוך (em-dash, התו "—")** — זה סימן מובהק של כתיבת AI ופוגע בקול המותג. השתמשי בפסיק, נקודה, או נקודה-ופסיק במקום. גם קו מפריד רגיל ("-") אפשר אך במידה
- ✅ "טמפרטורה ויעילות אנרגיה ברמה מסחרית, אך עם זמן חימום מהיר בהרבה" (פסיק)
- ❌ "טמפרטורה ויעילות אנרגיה ברמה מסחרית — אך עם זמן חימום מהיר בהרבה" (em-dash)
- אל תזלזלי בקפה אחר, במכונות אחרות, או בלקוחות (אסור)
- **אנטי-הזיה (חמור)**: אסור להמציא מספרים, נפחים, ספקים טכניים, או טכנולוגיות שאינן מופיעות מילולית בתיאור המוצר. אם התיאור לא אומר "1.6 ליטר" — אל תכתבי "1.6 ליטר". אם התיאור לא מזכיר PID — אל תניחי שיש PID. בדקי כל ספק טכני מול התיאור לפני שאת מצטטת אותו
- **אסור להזכיר מתנות, מבצעים, הטבות שיווקיות, או חבילות בונוס** (לדוגמה: "מערכת אוסמוזה הפוכה כמתנה לרוכשים", "כולל סדנה במתנה"). FAQ הוא תוכן קבוע באתר; מבצעים משתנים. גם אם זה מופיע בתיאור המוצר — דלגי על זה
- כל תשובה: 2-4 משפטים, לא יותר
- כל שאלה: קצרה וטבעית, כפי שלקוח אמיתי היה מנסח אותה
- אסור לערבב מילים באנגלית באמצע משפט עברי ("shot לshot", "espresso shot") — או עברית מלאה ("מנה למנה", "בין מנה למנה") או ניסוח אחר. מילה לועזית בודדת בעברית מקובלת רק אם זה שם מותג/מודל

# ניסוחים נכונים בעברית (אל תטעי באלה)

## כללי
- ✅ "להתאים את רמת הטחינה" / "טחינה מתאימה" / "סוג טחינה"
- ❌ "לחייט את גובה הטחינה" / "גובה טחינה" (תרגום-קלקה)
- ✅ "פרופיל קלייה" / "סוג קלייה"
- ❌ "טמפרטורה של קלייה" כשמתכוונים לעוצמת קלייה
- ✅ "החליטה" / "להכין קפה"
- ❌ "להכנת" כפועל לבד

## תיאור טעם
- ✅ "מתיקות עדינה" / "מתיקות מאוזנת" / "מתיקות טבעית" (מתיקות = שם עצם)
- ❌ "ממתקת בעדינות" / "ממתקת" כתיאור טעם (ממתקת זה פועל)
- ✅ "סיומת נקייה" / "סיומת ארוכה" / "סיומת ערבה" (סיומת = aftertaste, נקבה)
- ❌ "סיום נקי" / "סיום ורעננה" (גם המילה הלא נכונה וגם סתירת מין — צריך "סיומת נקייה ורעננה")
- ✅ התאם מין: "ארומה פרחונית" (נקבה+נקבה), "גוף מלא" (זכר+זכר), "תהליך חלק" (זכר+זכר)

## דוגמאות תיקון מין — בדקי כל משפט לפני הפלט
- ❌ "כן, הוא מותאמת" → ✅ "כן, היא מתאימה" (מכונה=נקבה, אז גם הכינוי וגם התואר חייבים להיות בנקבה)
- ❌ "מגש טפטוף מוארת" → ✅ "מגש טפטוף מואר" (מגש=זכר, אז התואר מואר ולא מוארת)
- ❌ "הוא מתוכנת מראש" כשמדובר בפונקציה/חליטה → ✅ "היא מתוכנתת מראש" (פונקציה=נקבה)
- ❌ "פשוט הפעל את הפדל ותן לה" → ✅ "פשוט מפעילים את הפדל ונותנים לה" (גוף ראשון רבים סתמי, לא ציווי בזכר)
- ❌ "כך שתוכל תמיד לדעת" → ✅ "כך שתמיד אפשר לדעת" או "כך שאתם תמיד יודעים"
- ❌ "אלו שחשובה להם הביצועים" → ✅ "אלו שחשובים להם הביצועים" / "אלו שהביצועים חשובים להם" (ביצועים = זכר רבים, אז התואר חייב להיות "חשובים" ברבים)
- שמות עצם נפוצים בזכר רבים שצריך להתאים אליהם תואר ברבים: ביצועים, אביזרים, פולים, מים, חיים. ❌ "אביזרים מקצועית" → ✅ "אביזרים מקצועיים"
- כלל זהב: לפני שאת סוגרת תשובה, עברי על כל פועל ותואר וודאי שהמין והמספר שלהם תואמים לשם העצם שאליו הם מתייחסים. אם יש פנייה לקורא — חייבת להיות ברבים זוגית או ניטרלית, לעולם לא בזכר יחיד

## תרגום-קלקה (calques) שאסור להשתמש
- ❌ "אמנות חלב" / "אומנות חלב" (תרגום מילולי של milk art) → ✅ "לאטה ארט"
- ❌ "אמן בריסטה" → ✅ "בריסטה" (זה התואר עצמו)
- ❌ "טכנולוגיית קצה" → ✅ "טכנולוגיה מתקדמת"
- כלל: אם הביטוי בעברית נשמע מילולי-תרגומי ולא משהו שדובר עברית טבעי היה אומר, השתמשי במונח המקצועי הלועזי המקובל (לאטה ארט, micro foam, ספשלטי) או בניסוח טבעי

## מונחים מקצועיים למכונות אספרסו ומטחנות
- ✅ "להקציף חלב" / "קיטור חלב" / "להכין micro foam"
- ❌ "לקטור חלב" / "לקטור" כפועל (לא קיים בעברית)
- ⚠️ המונח "micro foam" נשאר באנגלית — לא לתעתק ל"מיקרו-פום" (זה מונח מקצועי מקובל גם בקהילת הקפה הישראלית)
- ✅ "הרטבת עוגיית הקפה" / "הרטבת האספרסו" / "הרטבה מקדימה" (זה pre-infusion — הרטבת עוגיית הקפה לפני החליטה)
- ❌ "מברטטת את הקפה" / "מבטטת" / "מקרינה" (מילים לא קיימות)
- ✅ "ירידה בטמפרטורה" / "אובדן חום" / "טמפרטורה לא יציבה"
- ❌ "סחבה בטמפרטורה" (סלנג)
- ✅ "ראש חליטה יחיד" (single group head) / "שני ראשי חליטה" (dual group)
- ✅ "דוד כפול" (double boiler — שני דודים נפרדים) ≠ "מחליף חום" / "HX" (heat exchanger — דוד אחד עם מחליף)
- ⚠️ אל תבלבלי בין "דוד כפול" ל"מחליף חום" — אלה שתי טכנולוגיות שונות. ציטטי מהתיאור בדיוק
- ✅ "אספרסו עקבי" / "חליטה עקבית" / "מנה למנה"
- ❌ "shot לshot" (ערבוב שפות)

# מבנה הפלט (JSON)
{"faq":[{"q":"שאלה","a":"תשובה"}, ... 5 פריטים]}

# הנחיה לקטגוריה
${categoryGuidance[category] || categoryGuidance.other}

# נתוני המוצר
שם: ${name}
קטגוריות: ${cats}
${attrs ? `תכונות:\n${attrs}\n` : ""}
תיאור קצר: ${shortDesc || "(אין)"}
תיאור מלא: ${longDesc || "(אין)"}

# פלט
החזירי JSON תקין בלבד, ללא טקסט נוסף לפני או אחרי. השתמשי במבנה המדויק שצוין למעלה.`;
}

async function callAnthropic(prompt: string): Promise<FaqItem[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.content?.[0]?.text;
  if (typeof content !== "string") {
    throw new Error(`Anthropic returned no text content: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Extract JSON from response. Model is instructed to return JSON only,
  // but defensively look for the first { ... } block.
  let parsed: { faq?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Anthropic response not valid JSON: ${content.slice(0, 300)}`);
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(`Anthropic JSON.parse failed: ${match[0].slice(0, 300)}`);
    }
  }

  const rawFaq = (parsed as { faq?: unknown }).faq;
  if (!Array.isArray(rawFaq)) {
    throw new Error(`Anthropic response missing 'faq' array: ${JSON.stringify(parsed).slice(0, 300)}`);
  }

  const out: FaqItem[] = [];
  for (const item of rawFaq) {
    if (!item || typeof item !== "object") continue;
    const q = typeof (item as Record<string, unknown>).q === "string" ? ((item as Record<string, unknown>).q as string).trim() : "";
    const a = typeof (item as Record<string, unknown>).a === "string" ? ((item as Record<string, unknown>).a as string).trim() : "";
    if (!q || !a) continue;
    out.push({ q, a });
  }

  if (out.length === 0) {
    throw new Error("Anthropic returned no valid FAQ items");
  }
  return out;
}

async function writeViaSetFaq(productId: number, faq: FaqItem[]): Promise<{ success: boolean; product_name?: string; faq_count?: number; error?: string }> {
  const res = await fetch(`${SUPA_URL}/functions/v1/set-product-faq`, {
    method: "POST",
    // set-product-faq accepts the service role only.
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
    body: JSON.stringify({ product_id: productId, faq }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    return { success: false, error: `set-product-faq failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}` };
  }
  return { success: true, product_name: data.product_name, faq_count: data.faq_count };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  // verify_jwt is off, so the caller is checked here. Spends an LLM call and writes live product FAQ. Operator tool: service key only.
  if (!(await isServiceCaller(req))) return unauthorized(cors);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  if (!ANTHROPIC_KEY) return json(500, { error: "ANTHROPIC_API_KEY not configured" });
  if (!WOO_URL)       return json(500, { error: "WOO_URL not configured" });
  if (!SUPA_URL)      return json(500, { error: "SUPABASE_URL not configured" });

  let body: { product_id?: unknown; dry_run?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const productId = Number(body.product_id);
  const dryRun    = Boolean(body.dry_run);
  if (!Number.isInteger(productId) || productId <= 0) {
    return json(400, { error: "product_id must be a positive integer" });
  }

  let product: WcProduct;
  try {
    product = await fetchProduct(productId);
  } catch (e) {
    return json(502, { error: `WC fetch failed: ${(e as Error).message}` });
  }

  const category = detectCategory(product);
  const prompt   = buildPrompt(product, category);

  let faq: FaqItem[];
  try {
    faq = await callAnthropic(prompt);
  } catch (e) {
    return json(502, { error: `Anthropic generation failed: ${(e as Error).message}` });
  }

  if (dryRun) {
    return json(200, {
      success: true,
      dry_run: true,
      product_id: productId,
      product_name: clean(product.name),
      category,
      faq,
      written: false,
    });
  }

  const writeRes = await writeViaSetFaq(productId, faq);
  if (!writeRes.success) {
    return json(502, {
      success: false,
      product_id: productId,
      product_name: clean(product.name),
      category,
      faq,
      written: false,
      error: writeRes.error,
    });
  }

  return json(200, {
    success: true,
    product_id: productId,
    product_name: writeRes.product_name ?? clean(product.name),
    category,
    faq_count: writeRes.faq_count ?? faq.length,
    written: true,
    faq,
  });
});
