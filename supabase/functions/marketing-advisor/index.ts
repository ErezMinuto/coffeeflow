/**
 * CoffeeFlow — Marketing Advisor Edge Function
 *
 * Three independent AI agents, each with a distinct philosophy:
 *
 *   google_ads_growth     — Aggressive: scale winners, increase budgets, maximize reach
 *   google_ads_efficiency — Conservative: maximize ROAS, cut waste, protect profitability
 *   organic_content       — Instagram + GSC content planning, inventory-aware
 *
 * POST body: { "trigger": "manual"|"cron", "agent": "google_ads_growth"|"google_ads_efficiency"|"organic_content"|"all" }
 *
 * Results stored in advisor_reports (one row per agent_type + week_start, upserted).
 * Secrets: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPA_URL      = Deno.env.get("SUPABASE_URL") ?? "";
const SUPA_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Growth + Efficiency: sonnet (structured numerical analysis)
// Organic: opus (creative content + cultural nuance)
const MODEL_ADS     = "claude-sonnet-4-5-20250929";
const MODEL_ORGANIC = "claude-opus-4-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPreviousWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysToLastMonday - 7);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split("T")[0];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function subtractDays(dateStr: string, days: number): string {
  return addDays(dateStr, -days);
}

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

async function callClaude(
  model: string,
  system: string,
  userMessage: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error (${response.status}): ${err}`);
  }

  const data = await response.json();

  // If Claude hit the token limit mid-response the JSON will be truncated
  if (data.stop_reason === "max_tokens") {
    throw new Error("Claude response was truncated (max_tokens reached). Try reducing the focus text or contact support.");
  }

  return {
    text: data.content?.[0]?.text ?? "",
    inputTokens:  data.usage?.input_tokens  ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
}

// ── Israeli Seasonal & Holiday Context ───────────────────────────────────────

interface CalendarEvent {
  name:          string;
  date:          string;  // YYYY-MM-DD (start date)
  endDate?:      string;  // for multi-day events
  type:          'major_holiday' | 'national' | 'commercial';
  marketingNote: string;
}

const CALENDAR_EVENTS: CalendarEvent[] = [
  // ── 5785 / 2025 ──
  { name: 'ראש השנה', date: '2025-09-22', endDate: '2025-09-24', type: 'major_holiday', marketingNote: 'עונת מתנות גדולה — סלסלות, קפה כמתנה, ארוחות משפחתיות. לקוחות קונים מראש.' },
  { name: 'יום כיפור', date: '2025-10-01', endDate: '2025-10-02', type: 'national', marketingNote: 'יום צום — עצור פרסום ביום עצמו ויום לפניו. אחריו: חזרה לשגרה ולקפה.' },
  { name: 'סוכות', date: '2025-10-06', endDate: '2025-10-12', type: 'major_holiday', marketingNote: 'שבוע חופש — אנשים פנויים, בילויים, קניות. הזדמנות לתוכן חגיגי.' },
  { name: 'שמחת תורה', date: '2025-10-14', type: 'major_holiday', marketingNote: 'סיום חגי תשרי — אחרי כן חזרה לשגרה מלאה.' },
  { name: 'חנוכה', date: '2025-12-14', endDate: '2025-12-22', type: 'major_holiday', marketingNote: 'עונת מתנות — חנוכה = קניות, מתנות, כינוסים משפחתיים. קפה כמתנה מעולה.' },
  // ── 5786 / 2026 ──
  { name: 'ט"ו בשבט', date: '2026-02-12', type: 'national', marketingNote: 'חיבור לטבע וקיימות — מתאים לתוכן על קפה מגידול אתי, טרייסביליטי, השפעה סביבתית.' },
  { name: 'פורים', date: '2026-03-03', type: 'major_holiday', marketingNote: 'חג שמח ומשוחרר — תוכן מהנה, משנה תחפושות, מתנות. אנשים במצב רוח קנייה.' },
  { name: 'פסח', date: '2026-04-01', endDate: '2026-04-08', type: 'major_holiday', marketingNote: 'שבוע חופש — אנשים בבית, סדרים משפחתיים. קפה חינם מחמץ = מותר. הזמנות מראש לחג.' },
  { name: 'יום השואה', date: '2026-04-16', type: 'national', marketingNote: 'יום זיכרון — אין פרסום שמח, אין קמפיינים ביום עצמו.' },
  { name: 'יום הזיכרון', date: '2026-04-28', type: 'national', marketingNote: 'יום זיכרון חללים — אין פרסום שמח ביום עצמו.' },
  { name: 'יום העצמאות', date: '2026-04-29', type: 'national', marketingNote: 'יום חגיגות — BBQ, אירועים בחוץ, ביקורים. הזדמנות לתוכן פטריוטי ולהגעה למשפחות.' },
  { name: 'שבועות', date: '2026-05-21', endDate: '2026-05-22', type: 'major_holiday', marketingNote: 'חג חלבי — לילות לבנים, ארוחות חלביות. קפה מתאים לאווירה.' },
  { name: 'ראש השנה', date: '2026-09-11', endDate: '2026-09-13', type: 'major_holiday', marketingNote: 'עונת מתנות גדולה — כנ"ל ראש השנה 2025.' },
  { name: 'יום כיפור', date: '2026-09-20', type: 'national', marketingNote: 'יום צום — עצור פרסום ביום ויום לפניו.' },
  { name: 'סוכות', date: '2026-09-25', endDate: '2026-10-01', type: 'major_holiday', marketingNote: 'שבוע חופש — תוכן חגיגי, אנשים פנויים.' },
  { name: 'חנוכה', date: '2026-12-13', endDate: '2026-12-21', type: 'major_holiday', marketingNote: 'עונת מתנות — קפה כמתנה מושלמת לחנוכה.' },
  // ── 5787 / 2027 ──
  { name: 'פורים', date: '2027-03-03', type: 'major_holiday', marketingNote: 'חג שמח — תוכן מהנה ומתנות.' },
  { name: 'פסח', date: '2027-03-22', endDate: '2027-03-30', type: 'major_holiday', marketingNote: 'שבוע חופש ומשפחות.' },
  // ── Commercial / International ──
  { name: 'ולנטיין', date: '2026-02-14', type: 'commercial', marketingNote: 'מתנות זוגיות — חוויית קפה כמתנה, מארזים לזוגות.' },
  { name: "יום האישה הבינ'ל", date: '2026-03-08', type: 'commercial', marketingNote: 'הזדמנות לתוכן שמציין נשים בשרשרת הקפה (מגדלות, קולות).' },
  { name: 'יום הקפה הבינ"ל', date: '2026-10-01', type: 'commercial', marketingNote: 'יום חגיגה לענף — תוכן, מבצע, סיפורי מקור. גדול בקהילת ספשיאלטי.' },
  { name: 'בלאק פריידי', date: '2026-11-27', type: 'commercial', marketingNote: 'עונת מכירות — ישראלים קונים בלאק פריידי. מבצעים, הנחות, מארזים.' },
];

function getSeasonalContext(weekStart: string): string {
  const date   = new Date(weekStart);
  const month  = date.getMonth() + 1; // 1–12
  const dayMs  = 1000 * 60 * 60 * 24;

  // Israeli seasons (adjusted for Mediterranean climate)
  let season: string;
  let coffeeNote: string;
  if (month === 12 || month <= 2) {
    season    = 'חורף';
    coffeeNote = 'עונת קפה חם — אספרסו, פילטר, מקורות מיוחדים. לקוחות מחפשים חוויה חמה ואווירה נעימה.';
  } else if (month >= 3 && month <= 5) {
    season    = 'אביב (ישראל = כבר חם)';
    coffeeNote = 'מעבר מהיר לקפה קר — באפריל-מאי כבר חם. Cold Brew ואייס לאטה מתחילים לקחת עליונות. מתאים לצילומי חוץ.';
  } else if (month >= 6 && month <= 9) {
    season    = 'קיץ';
    coffeeNote = 'עונת קפה קר — Cold Brew, Nitro, אייס לאטה. קיץ ישראלי = 35°+. תוכן שמראה רענון וקרירות.';
  } else {
    season    = 'סתיו';
    coffeeNote = 'חזרה לקפה חם — אחרי הקיץ הארוך, אנשים שמחים לשוב לאספרסו ומשקאות חמים. עונה טובה לסיפורי מקור.';
  }

  // Find events in window: 7 days before weekStart to 21 days after
  const windowStart = new Date(date.getTime() - 7  * dayMs);
  const windowEnd   = new Date(date.getTime() + 21 * dayMs);

  const relevant = CALENDAR_EVENTS.filter(ev => {
    const start = new Date(ev.date);
    const end   = ev.endDate ? new Date(ev.endDate) : start;
    return end >= windowStart && start <= windowEnd;
  });

  const lines: string[] = [];
  for (const ev of relevant) {
    const evDate  = new Date(ev.date);
    const diffDays = Math.round((evDate.getTime() - date.getTime()) / dayMs);
    let when: string;
    if (diffDays < -1)       when = `מתרחש עכשיו / לפני ${Math.abs(diffDays)} ימים`;
    else if (diffDays === -1) when = 'אתמול';
    else if (diffDays === 0)  when = 'היום';
    else if (diffDays === 1)  when = 'מחר';
    else if (diffDays <= 7)  when = `בעוד ${diffDays} ימים`;
    else                      when = `בעוד ${diffDays} ימים (${ev.date})`;

    const urgency = ev.type === 'national' ? '⚠️' : ev.type === 'major_holiday' ? '🎉' : '📅';
    lines.push(`${urgency} ${ev.name} — ${when}\n   → ${ev.marketingNote}`);
  }

  const eventsBlock = lines.length > 0
    ? `\nאירועים רלוונטיים (שבוע אחורה ועד 3 שבועות קדימה):\n${lines.join('\n')}`
    : '\nאין חגים או אירועים מיוחדים בשלושת השבועות הקרובים — שגרה מלאה.';

  return `=== הקשר עונתי ואירועים ===
עונה: ${season}
${coffeeNote}${eventsBlock}`;
}

async function upsertReport(
  supabase: ReturnType<typeof createClient>,
  agentType: string,
  weekStart: string,
  fields: Record<string, unknown>,
) {
  await supabase
    .from("advisor_reports")
    .upsert(
      { agent_type: agentType, week_start: weekStart, ...fields },
      { onConflict: "agent_type,week_start" },
    );
}

// ── Data fetching ─────────────────────────────────────────────────────────────

interface GoogleRow {
  campaign_id: string; name: string; status: string;
  date: string; impressions: number; clicks: number; cost: number;
  ctr: number; cpc: number; conversions: number; conversion_value: number; roas: number;
}

function aggregateGoogleCampaigns(rows: GoogleRow[]) {
  const map = new Map<string, {
    name: string; status: string;
    cost: number; clicks: number; impressions: number;
    conversions: number; convValue: number;
  }>();
  for (const r of rows) {
    const e = map.get(r.campaign_id);
    if (e) {
      e.cost        += r.cost;
      e.clicks      += r.clicks;
      e.impressions += r.impressions;
      e.conversions += r.conversions;
      e.convValue   += r.conversion_value;
    } else {
      map.set(r.campaign_id, {
        name: r.name, status: r.status,
        cost: r.cost, clicks: r.clicks, impressions: r.impressions,
        conversions: r.conversions, convValue: r.conversion_value,
      });
    }
  }
  return Array.from(map.entries()).map(([id, v]) => ({
    id, name: v.name, status: v.status,
    cost:        Math.round(v.cost * 100) / 100,
    clicks:      v.clicks,
    impressions: v.impressions,
    conversions: Math.round(v.conversions * 10) / 10,
    roas:        v.cost > 0 ? Math.round((v.convValue / v.cost) * 100) / 100 : 0,
    cpa:         v.conversions > 0 ? Math.round((v.cost / v.conversions) * 100) / 100 : null,
  }));
}

async function fetchGoogleData(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  weekEnd: string,
) {
  const fourWksAgo = subtractDays(weekStart, 28);
  const { data, error } = await supabase
    .from("google_campaigns")
    .select("campaign_id,name,status,date,impressions,clicks,cost,ctr,cpc,conversions,conversion_value,roas")
    .gte("date", fourWksAgo)
    .lte("date", weekEnd)
    .order("date", { ascending: false });

  if (error) throw new Error(`Google fetch error: ${error.message}`);

  const all = (data ?? []) as GoogleRow[];
  const currentWeek = all.filter(r => r.date >= weekStart);
  const prevWeeks   = all.filter(r => r.date < weekStart);

  return {
    currentAgg: aggregateGoogleCampaigns(currentWeek),
    prevAgg:    aggregateGoogleCampaigns(prevWeeks),
    weekStart,
    weekEnd,
  };
}

function buildGoogleDataBlock(
  currentAgg: ReturnType<typeof aggregateGoogleCampaigns>,
  prevAgg:    ReturnType<typeof aggregateGoogleCampaigns>,
  weekStart: string,
  weekEnd: string,
) {
  const totalCost        = currentAgg.reduce((s, c) => s + c.cost, 0);
  const totalClicks      = currentAgg.reduce((s, c) => s + c.clicks, 0);
  const totalImpressions = currentAgg.reduce((s, c) => s + c.impressions, 0);
  const totalConversions = currentAgg.reduce((s, c) => s + c.conversions, 0);
  const overallRoas      = totalCost > 0
    ? currentAgg.reduce((s, c) => s + c.cost * c.roas, 0) / totalCost
    : 0;

  const campaignBlock = currentAgg.length > 0
    ? currentAgg.map(c =>
        `  ${c.name} | סטטוס: ${c.status} | עלות: ₪${c.cost} | קליקים: ${c.clicks} | המרות: ${c.conversions} | ROAS: ${c.roas}x | CPA: ${c.cpa != null ? `₪${c.cpa}` : "אין"}`
      ).join("\n")
    : "  אין נתוני קמפיין";

  const prevBlock = prevAgg.length > 0
    ? prevAgg.map(c =>
        `  ${c.name} | עלות: ₪${c.cost} | המרות: ${c.conversions} | ROAS: ${c.roas}x`
      ).join("\n")
    : "  אין נתוני השוואה";

  return { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock };
}

// ── WooCommerce Sales Helper ──────────────────────────────────────────────────

async function fetchWooSales(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  weekEnd: string,
): Promise<string> {
  const fourWksAgo = subtractDays(weekStart, 28);
  const { data, error } = await supabase
    .from("woo_orders")
    .select("order_date,total,items,status,utm_source,utm_medium,utm_campaign")
    .gte("order_date", fourWksAgo)
    .lte("order_date", weekEnd)
    .in("status", ["completed", "processing"]);

  if (error || !data?.length) return "  אין נתוני מכירות WooCommerce";

  // Aggregate this week
  const thisWeek = data.filter((o: any) => o.order_date >= weekStart && o.order_date <= weekEnd);
  const prevWeeks = data.filter((o: any) => o.order_date < weekStart);

  const weekRevenue = thisWeek.reduce((s: number, o: any) => s + (o.total || 0), 0);
  const prevRevenue = prevWeeks.reduce((s: number, o: any) => s + (o.total || 0), 0);
  const prevAvgWeekly = prevRevenue / 4;

  // Top products this week
  const productMap: Record<string, { qty: number; revenue: number }> = {};
  for (const order of thisWeek) {
    for (const item of (order.items ?? [])) {
      if (!productMap[item.product_name]) productMap[item.product_name] = { qty: 0, revenue: 0 };
      productMap[item.product_name].qty     += item.quantity || 0;
      productMap[item.product_name].revenue += item.subtotal || 0;
    }
  }
  const topProducts = Object.entries(productMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 8)
    .map(([name, v]) => `  ${name}: ${v.qty} יח' | ₪${Math.round(v.revenue)}`)
    .join("\n");

  const trend = prevAvgWeekly > 0
    ? `${weekRevenue > prevAvgWeekly ? "↑" : "↓"} ${Math.abs(Math.round((weekRevenue / prevAvgWeekly - 1) * 100))}% ממוצע 4 שבועות`
    : "";

  // UTM attribution breakdown
  const utmMap: Record<string, { orders: number; revenue: number }> = {};
  for (const order of thisWeek) {
    const src = order.utm_source
      ? `${order.utm_source}/${order.utm_medium ?? "?"}${order.utm_campaign ? ` (${order.utm_campaign})` : ""}`
      : "ישיר / לא מזוהה";
    if (!utmMap[src]) utmMap[src] = { orders: 0, revenue: 0 };
    utmMap[src].orders++;
    utmMap[src].revenue += order.total || 0;
  }
  const utmBlock = Object.entries(utmMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([src, v]) => `  ${src}: ${v.orders} הזמנות | ₪${Math.round(v.revenue)}`)
    .join("\n");

  return `  הכנסות השבוע: ₪${Math.round(weekRevenue)} ${trend}
  מספר הזמנות: ${thisWeek.length}
  מקורות (UTM):
${utmBlock || "  אין נתוני UTM"}
  מוצרים מובילים:
${topProducts || "  אין נתונים"}`;
}

// ── Google Ads Agent — GROWTH ─────────────────────────────────────────────────

async function runGrowthAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  focus?: string,
) {
  const weekEnd = addDays(weekStart, 6);
  console.log(`[growth] Fetching data ${weekStart} → ${weekEnd}`);

  const [{ currentAgg, prevAgg }, wooSales] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
  ]);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const systemPrompt = `אתה יועץ צמיחה אגרסיבי לפרסום ממומן של Minuto Coffee — בית קפה ספשיאלטי ברחובות.
הפילוסופיה שלך: צמיחה. להגדיל את הנוכחות, לשנות את הסקייל על מה שעובד, לבדוק דברים חדשים.
אתה מוכן לקחת סיכון מחושב כדי לבנות מותג ולגדול.
אל תמליץ לצמצם אלא אם הנתונים מאוד גרועים — העדף להגדיל תקציב, לרחב קהל, לבדוק קריאייטיב חדש.
בנוסף להמלצות, תכתוב קמפיינים ממומנים מוכנים ליצירה עם כותרות ותיאורים אמיתיים.
כותרות Google Ads: עד 30 תווים כל אחת. תיאורים: עד 90 תווים כל אחד.
לכל קמפיין תוסיף creation_steps — שלבים מדויקים ומספרים איך ליצור אותו ב-Google Ads UI, לפי סוג הקמפיין (Search / Performance Max / Shopping). השלבים צריכים להיות מעשיים כאילו כתבת מדריך למשתמש.
חשוב בעברית ישראלית ישירות — לא מתרגם מאנגלית. כתוב כמו שישראלי מדבר: ישיר, תכליתי, לפעמים קצת בוטה. סלנג ישראלי מותר ומעודד. אל תהיה פורמלי מדי.
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו. כל שדות טקסט בעברית.`;

  const seasonalContext = getSeasonalContext(weekStart);

  const userMessage = `${seasonalContext}

נתוני Google Ads שבוע ${weekStart}–${weekEnd}:

=== קמפיינים השבוע ===
${campaignBlock}

=== סיכום ===
עלות כוללת: ₪${Math.round(totalCost * 100) / 100} | קליקים: ${totalClicks} | חשיפות: ${totalImpressions} | המרות: ${Math.round(totalConversions * 10) / 10} | ROAS: ${Math.round(overallRoas * 100) / 100}x

=== 3 שבועות קודמים (מגמה) ===
${prevBlock}

=== מכירות WooCommerce השבוע ===
${wooSales}

השתמש בהקשר העונתי למעלה — חגים קרובים, עונה, אירועים — כדי לתזמן קמפיינים ולהמליץ על תוכן רלוונטי.

החזר JSON בפורמט:
{
  "agent_philosophy": "צמיחה אגרסיבית",
  "summary": "2-3 משפטים — מה הזדמנויות הצמיחה שאתה רואה?",
  "google": {
    "total_cost": ${Math.round(totalCost * 100) / 100},
    "total_clicks": ${totalClicks},
    "total_impressions": ${totalImpressions},
    "total_conversions": ${Math.round(totalConversions * 10) / 10},
    "roas": ${Math.round(overallRoas * 100) / 100},
    "top_campaign": "הקמפיין עם הפוטנציאל הגדול ביותר לסקייל",
    "worst_campaign": "הקמפיין שדורש תשומת לב"
  },
  "budget_recommendations": [
    {
      "platform": "google",
      "campaign": "שם קמפיין",
      "action": "increase|decrease|pause|keep|test_new",
      "reason": "הסבר מנקודת מבט צמיחה",
      "suggested_budget_change_pct": 30
    }
  ],
  "growth_opportunities": [
    {
      "opportunity": "הזדמנות ספציפית",
      "action": "מה לעשות",
      "expected_impact": "מה אתה מצפה לקרות"
    }
  ],
  "campaigns_to_create": [
    {
      "campaign_name": "שם הקמפיין המוצע",
      "campaign_type": "Search|Performance Max|Shopping",
      "target_audience": "תיאור קהל היעד",
      "keywords": ["מילת מפתח 1", "מילת מפתח 2", "מילת מפתח 3"],
      "headlines": ["כותרת 1 (עד 30 תווים)", "כותרת 2 (עד 30 תווים)", "כותרת 3 (עד 30 תווים)"],
      "descriptions": ["תיאור 1 (עד 90 תווים)", "תיאור 2 (עד 90 תווים)"],
      "daily_budget_ils": 50,
      "rationale": "למה הקמפיין הזה עכשיו",
      "creation_steps": ["שלב 1: כנס ל-Google Ads → לחץ + קמפיין חדש", "שלב 2: בחר מטרה...", "שלב 3: ..."]
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"],
  "next_week_focus": "המהלך העיקרי לצמיחה השבוע הבא"
}`;

  const finalMessage = focus
    ? `${userMessage}\n\n=== הוראות מיוחדות מהצוות ===\n${focus}\nהתמקד בהוראות אלו בניתוח שלך ובהמלצות.`
    : userMessage;

  console.log(`[growth] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ADS, systemPrompt, finalMessage);
  const parsed = JSON.parse(stripCodeFences(text));
  console.log(`[growth] Done. Tokens: ${inputTokens + outputTokens}`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Google Ads Agent — EFFICIENCY ─────────────────────────────────────────────

async function runEfficiencyAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  focus?: string,
) {
  const weekEnd = addDays(weekStart, 6);
  console.log(`[efficiency] Fetching data ${weekStart} → ${weekEnd}`);

  const [{ currentAgg, prevAgg }, wooSales] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
  ]);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const systemPrompt = `אתה יועץ יעילות שמרני לפרסום ממומן של Minuto Coffee — בית קפה ספשיאלטי ברחובות.
הפילוסופיה שלך: יעילות. כל שקל צריך להחזיר ערך. לחתוך בזבוז, לרכז תקציב בקמפיינים שמוכיחים ROI.
אתה מחפש דפוסי בזבוז, קמפיינים שמפסידים כסף, ומקומות שאפשר לשפר CPA בלי להגדיל תקציב.
בנוסף לניתוח, תכתוב מודעות משופרות מוכנות להחלפה — כותרות ותיאורים חדשים לקמפיינים החלשים.
כותרות Google Ads: עד 30 תווים כל אחת. תיאורים: עד 90 תווים כל אחד.
לכל מודעה לשכתוב תוסיף creation_steps — שלבים מספרים ומדויקים איך לערוך את המודעה ב-Google Ads UI (איפה ללחוץ, מה לשנות, איך לשמור). כאילו אתה כותב מדריך למשתמש שלא מכיר את הממשק.
חשוב בעברית ישראלית ישירות — לא מתרגם מאנגלית. כתוב כמו שישראלי מדבר: קצר, עניני, ישיר. סלנג מותר. אל תהיה פורמלי.
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו. כל שדות טקסט בעברית.`;

  const seasonalContext = getSeasonalContext(weekStart);

  const userMessage = `${seasonalContext}

נתוני Google Ads שבוע ${weekStart}–${weekEnd}:

=== קמפיינים השבוע ===
${campaignBlock}

=== סיכום ===
עלות כוללת: ₪${Math.round(totalCost * 100) / 100} | קליקים: ${totalClicks} | חשיפות: ${totalImpressions} | המרות: ${Math.round(totalConversions * 10) / 10} | ROAS: ${Math.round(overallRoas * 100) / 100}x

=== 3 שבועות קודמים (מגמה) ===
${prevBlock}

=== מכירות WooCommerce השבוע ===
${wooSales}

השתמש בהקשר העונתי — חגים ואירועים — בניתוח תזמון הקמפיינים והמלצות התקציב.

החזר JSON בפורמט:
{
  "agent_philosophy": "יעילות ו-ROAS",
  "summary": "2-3 משפטים — איפה הכסף מתבזבז ואיפה אפשר לשפר?",
  "google": {
    "total_cost": ${Math.round(totalCost * 100) / 100},
    "total_clicks": ${totalClicks},
    "total_impressions": ${totalImpressions},
    "total_conversions": ${Math.round(totalConversions * 10) / 10},
    "roas": ${Math.round(overallRoas * 100) / 100},
    "top_campaign": "הקמפיין עם ה-ROAS הטוב ביותר",
    "worst_campaign": "הקמפיין שמבזבז הכי הרבה כסף"
  },
  "budget_recommendations": [
    {
      "platform": "google",
      "campaign": "שם קמפיין",
      "action": "increase|decrease|pause|keep",
      "reason": "הסבר מנקודת מבט יעילות ו-ROAS",
      "suggested_budget_change_pct": -20
    }
  ],
  "waste_identified": [
    {
      "campaign": "שם קמפיין",
      "issue": "תיאור הבעיה",
      "estimated_waste": "₪X בשבוע",
      "fix": "מה לעשות כדי לתקן"
    }
  ],
  "ads_to_rewrite": [
    {
      "campaign": "שם הקמפיין הקיים",
      "problem": "מה לא עובד במודעה הנוכחית",
      "new_headlines": ["כותרת חדשה 1 (עד 30 תווים)", "כותרת חדשה 2 (עד 30 תווים)", "כותרת חדשה 3 (עד 30 תווים)"],
      "new_descriptions": ["תיאור חדש 1 (עד 90 תווים)", "תיאור חדש 2 (עד 90 תווים)"],
      "expected_improvement": "מה ישתפר",
      "creation_steps": ["שלב 1: כנס ל-Google Ads → קמפיינים → [שם הקמפיין]", "שלב 2: לחץ על 'מודעות'...", "שלב 3: ..."]
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"],
  "next_week_focus": "המהלך העיקרי לשיפור יעילות השבוע הבא"
}`;

  const finalMessage = focus
    ? `${userMessage}\n\n=== הוראות מיוחדות מהצוות ===\n${focus}\nהתמקד בהוראות אלו בניתוח שלך ובהמלצות.`
    : userMessage;

  console.log(`[efficiency] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ADS, systemPrompt, finalMessage);
  const parsed = JSON.parse(stripCodeFences(text));
  console.log(`[efficiency] Done. Tokens: ${inputTokens + outputTokens}`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Organic Content Agent ─────────────────────────────────────────────────────

async function runOrganicAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  focus?: string,
) {
  const weekEnd       = addDays(weekStart, 6);
  const thirtyDaysAgo = subtractDays(weekStart, 30);
  console.log(`[organic] Fetching data from ${thirtyDaysAgo}`);

  const [postsRes, insightsRes, productsRes, originsRes, gscRes, wooSalesOrganic] = await Promise.all([
    supabase
      .from("meta_organic_posts")
      .select("post_id,post_type,message,created_at,reach,impressions,likes,comments,shares,saves")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("meta_daily_insights")
      .select("date,reach,impressions,follower_count,profile_views")
      .gte("date", thirtyDaysAgo)
      .order("date", { ascending: false }),
    supabase
      .from("products")
      .select("name,size,price,packed_stock,min_packed_stock"),
    supabase
      .from("origins")
      .select("name,roasted_stock,critical_stock"),
    // Google Search Console — top keywords for content inspiration
    supabase
      .from("google_search_console")
      .select("keyword,clicks,impressions,ctr,position")
      .neq("keyword", "__page__")
      .gte("date", thirtyDaysAgo)
      .order("impressions", { ascending: false })
      .limit(50),
    fetchWooSales(supabase, weekStart, weekEnd),
  ]);

  const posts    = postsRes.data    ?? [];
  const insights = insightsRes.data ?? [];
  const products = productsRes.data ?? [];
  const origins  = originsRes.data  ?? [];
  const gscRows  = gscRes.data      ?? [];

  // Aggregate GSC keywords
  const kwMap = new Map<string, { clicks: number; impressions: number; positions: number[] }>();
  for (const r of gscRows) {
    const e = kwMap.get(r.keyword);
    if (e) {
      e.clicks      += r.clicks;
      e.impressions += r.impressions;
      e.positions.push(r.position);
    } else {
      kwMap.set(r.keyword, { clicks: r.clicks, impressions: r.impressions, positions: [r.position] });
    }
  }
  const topKeywords = Array.from(kwMap.entries())
    .map(([kw, v]) => ({
      keyword:    kw,
      clicks:     v.clicks,
      impressions: v.impressions,
      position:   Math.round((v.positions.reduce((a, b) => a + b, 0) / v.positions.length) * 10) / 10,
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);

  // Instagram stats by type
  const byType = (type: string) => posts.filter((p: { post_type: string }) => p.post_type === type);
  const avgReach = (arr: { reach: number }[]) =>
    arr.length > 0 ? Math.round(arr.reduce((s, p) => s + (p.reach || 0), 0) / arr.length) : 0;
  const avgEng = (arr: { likes: number; comments: number; saves: number; reach: number }[]) => {
    if (!arr.length || !avgReach(arr)) return 0;
    return Math.round(
      (arr.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0) + (p.saves || 0), 0) /
       arr.reduce((s, p) => s + (p.reach || 0), 0)) * 1000
    ) / 10;
  };

  const reels  = byType("reel");
  const posts2 = byType("post");
  const latestInsight = (insights[0] ?? {}) as { follower_count?: number };
  const followerCount = latestInsight.follower_count ?? 0;

  const lowStock = products.filter((p: { packed_stock: number; min_packed_stock: number }) => p.packed_stock < p.min_packed_stock);
  const healthyStock = products.filter((p: { packed_stock: number; min_packed_stock: number }) => p.packed_stock >= p.min_packed_stock);

  const topPosts = [...posts]
    .sort((a: { saves: number; likes: number }, b: { saves: number; likes: number }) => (b.saves + b.likes) - (a.saves + a.likes))
    .slice(0, 5);

  const systemPrompt = `אתה מומחה תוכן אינסטגרם ו-SEO של Minuto Coffee, בית קפה ספשיאלטי ברחובות.
הקהל שלך: ישראלים אוהבי קפה, 25–45, שגדלו על פייסבוק ועכשיו גוללים אינסטגרם.
יש לך גישה לנתוני ביצועי אינסטגרם ול-Google Search Console — השתמש בשניהם ביחד.
תובנות GSC: מה שאנשים מחפשים = נושאים שאפשר להפוך לתוכן אינסטגרם שיכה.
כתוב פוסטים מוכנים לפרסום — כיתוב מלא להעתיק ישירות לאינסטגרם, כולל אמוג'ים, ריווח שורות, קריאה לפעולה, והאשטגים.
חשוב ישראלי. כתוב בעברית ישראלית אמיתית — לא מתורגמת מאנגלית. איך בן אדם ישראלי מדבר על קפה עם חבר: ספונטני, קצת הומוריסטי, מאוד אנושי. לפעמים אפשר לשים מילה באנגלית כמו שמדברים בישראל. אל תהיה שיווקי. אל תהיה מנופח.
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו. כל שדות טקסט בעברית.`;

  const gscBlock = topKeywords.length > 0
    ? topKeywords.map(k =>
        `  "${k.keyword}" | חשיפות: ${k.impressions} | קליקים: ${k.clicks} | מיקום: ${k.position}`
      ).join("\n")
    : "  אין נתוני Search Console עדיין";

  const topPostsBlock = topPosts.map((p: { post_type: string; created_at: string; reach: number; likes: number; saves: number; message: string }) =>
    `  [${p.post_type}] ${p.created_at?.split("T")[0]} | reach: ${p.reach} | saves: ${p.saves} | likes: ${p.likes} | "${p.message?.substring(0, 60) ?? ""}"`
  ).join("\n");

  const inventoryBlock = [
    `מלאי נמוך (${lowStock.length} מוצרים):`,
    ...lowStock.map((p: { name: string; packed_stock: number; min_packed_stock: number }) => `  ⚠️ ${p.name}: ${p.packed_stock}/${p.min_packed_stock} שקיות`),
    `מלאי תקין (${healthyStock.length} מוצרים):`,
    ...healthyStock.map((p: { name: string; packed_stock: number }) => `  ✅ ${p.name}: ${p.packed_stock} שקיות`),
  ].join("\n");

  const seasonalContext = getSeasonalContext(weekStart);

  const userMessage = `${seasonalContext}

=== אינסטגרם — 30 יום אחרונים ===
עוקבים: ${followerCount.toLocaleString()}
ריילס (${reels.length}): reach ממוצע ${avgReach(reels)}, engagement ${avgEng(reels)}%
פוסטים (${posts2.length}): reach ממוצע ${avgReach(posts2)}, engagement ${avgEng(posts2)}%

פוסטים מובילים:
${topPostsBlock || "אין נתונים"}

=== Google Search Console — שאילתות מובילות ===
${gscBlock}

=== מלאי ===
${inventoryBlock}

=== מכירות WooCommerce (השבוע האחרון) ===
${wooSalesOrganic}

=== לוח תוכן לשבוע ${weekStart}–${weekEnd} ===
התחשב בעונה ובחגים הקרובים בלוח התוכן — תזמן פוסטים לפני חגים, הימנע מפוסטים שמחים בימי זיכרון.

החזר JSON:
{
  "summary": "2-3 משפטים — מה עבד, מה GSC מראה, מה הכיוון",
  "account_health": {
    "avg_reach_30d": ${avgReach(posts)},
    "follower_count": ${followerCount},
    "best_post_type": "reel|post|story",
    "engagement_rate_pct": ${avgEng(posts)}
  },
  "seo_content_opportunities": [
    {
      "keyword": "מילת מפתח מ-GSC",
      "search_volume_signal": "impressions: X",
      "current_position": 8.5,
      "instagram_angle": "איך להפוך את זה לפוסט אינסטגרם"
    }
  ],
  "content_recommendations": [
    {
      "priority": 1,
      "content_type": "reel|post|story",
      "topic": "נושא ספציפי",
      "reason": "למה עכשיו — מה בנתונים מצדיק",
      "caption_idea": "רעיון קצר לכיתוב",
      "best_day": "ראשון|שני|שלישי|רביעי|חמישי|שישי",
      "best_time": "09:00"
    }
  ],
  "products_to_feature": [
    {
      "product": "שם מוצר",
      "reason": "low_stock_urgency|new_batch|bestseller",
      "content_angle": "זווית תוכן ספציפית"
    }
  ],
  "next_week_calendar": [
    { "day": "ראשון", "type": "reel", "topic": "נושא" },
    { "day": "רביעי", "type": "post", "topic": "נושא" },
    { "day": "שישי",  "type": "story", "topic": "נושא" }
  ],
  "posts_to_publish": [
    {
      "type": "reel|post|story",
      "topic": "נושא הפוסט",
      "best_day": "ראשון",
      "best_time": "09:00",
      "caption": "הכיתוב המלא שאפשר להעתיק ישירות לאינסטגרם — כולל אמוג'ים, שורות, קריאה לפעולה",
      "hashtags": ["#קפה", "#מינוטו", "#ספשלטי"],
      "hook": "המשפט הראשון שיעצור את הגלילה",
      "visual_direction": "תיאור קצר של מה לצלם / איך לצלם"
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"],
  "what_worked_last_week": ["מה עבד", "מה לא עבד"]
}`;

  const finalMessage = focus
    ? `${userMessage}\n\n=== הוראות מיוחדות מהצוות ===\n${focus}\nהתמקד בהוראות אלו בניתוח שלך ובהמלצות.`
    : userMessage;

  console.log(`[organic] Calling Claude (${MODEL_ORGANIC})...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ORGANIC, systemPrompt, finalMessage);
  const parsed = JSON.parse(stripCodeFences(text));
  console.log(`[organic] Done. Tokens: ${inputTokens + outputTokens}`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(SUPA_URL, SUPA_KEY);
  const weekStart = getPreviousWeekStart();
  console.log(`[marketing-advisor] weekStart: ${weekStart}`);

  let body: { trigger?: string; agent?: string; focus?: string } = {};
  try { body = await req.json() } catch { /* default to all */ }

  const focus = body.focus?.trim() || undefined;
  if (focus) console.log(`[marketing-advisor] Focus context: ${focus.slice(0, 100)}`);

  const agentArg = body.agent ?? "all";
  const runGrowth     = agentArg === "google_ads_growth"     || agentArg === "all";
  const runEfficiency = agentArg === "google_ads_efficiency" || agentArg === "all";
  const runOrganic    = agentArg === "organic_content"       || agentArg === "all";

  // Also support legacy "both" from old button invocations
  const runGrowthFinal     = runGrowth     || agentArg === "both";
  const runEfficiencyFinal = runEfficiency || agentArg === "both";
  const runOrganicFinal    = runOrganic    || agentArg === "both";

  const agentsRun: string[] = [];
  const errors: Record<string, string> = {};

  const runAgent = async (
    type: string,
    fn: () => Promise<{ report: unknown; tokensUsed: number }>,
    model: string,
  ) => {
    await upsertReport(supabase, type, weekStart, { status: "running", error_msg: null });
    try {
      const { report, tokensUsed } = await fn();
      await upsertReport(supabase, type, weekStart, {
        status: "done", report, model, tokens_used: tokensUsed, error_msg: null,
      });
      agentsRun.push(type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${type}] Error:`, msg);
      await upsertReport(supabase, type, weekStart, { status: "error", error_msg: msg });
      errors[type] = msg;
    }
  };

  // Run all requested agents in parallel — reduces total time from ~3x to ~1x
  await Promise.all([
    runGrowthFinal     ? runAgent("google_ads_growth",    () => runGrowthAgent(supabase, weekStart, focus),    MODEL_ADS)     : Promise.resolve(),
    runEfficiencyFinal ? runAgent("google_ads_efficiency", () => runEfficiencyAgent(supabase, weekStart, focus), MODEL_ADS)    : Promise.resolve(),
    runOrganicFinal    ? runAgent("organic_content",       () => runOrganicAgent(supabase, weekStart, focus),   MODEL_ORGANIC) : Promise.resolve(),
  ]);

  const hasErrors = Object.keys(errors).length > 0;
  return new Response(
    JSON.stringify({
      success: !hasErrors || agentsRun.length > 0,
      week_start: weekStart,
      agents_run: agentsRun,
      errors: hasErrors ? errors : undefined,
    }),
    {
      status: hasErrors && agentsRun.length === 0 ? 500 : 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    },
  );
});
