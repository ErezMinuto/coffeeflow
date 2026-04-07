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

// Both agents use sonnet-4-5 (same model used by ai-analyst + generate-campaign)
const MODEL_ADS     = "claude-sonnet-4-5-20250929";
const MODEL_ORGANIC = "claude-sonnet-4-5-20250929";

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000); // 4-minute hard timeout

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
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
  } catch (e) {
    clearTimeout(timeout);
    if ((e as Error).name === "AbortError") {
      throw new Error("Claude API timeout after 120s — try again later.");
    }
    throw e;
  }
  clearTimeout(timeout);

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

// ── Google Ads Creative Helper ────────────────────────────────────────────────

async function fetchAdCreatives(
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  const { data: ads } = await supabase
    .from("google_ads")
    .select("campaign_name,ad_group_name,status,ad_strength,headlines,descriptions,impressions,clicks,ctr,conversions")
    .neq("status", "REMOVED")
    .order("impressions", { ascending: false });

  if (!ads || ads.length === 0) return "  אין נתוני מודעות — סנכרן Google Ads כדי לקבל קריאייטיב.";

  const lines = ads.map((ad: {
    campaign_name: string; ad_group_name: string; status: string;
    ad_strength: string; headlines: string[]; descriptions: string[];
    impressions: number; clicks: number; ctr: number; conversions: number;
  }) => {
    const hl = (ad.headlines    ?? []).map((h: string) => `"${h}"`).join(" | ");
    const ds = (ad.descriptions ?? []).map((d: string) => `"${d}"`).join(" | ");
    const ctrPct = ((ad.ctr ?? 0) * 100).toFixed(1);
    return [
      `  📢 קמפיין: ${ad.campaign_name} → קבוצה: ${ad.ad_group_name}`,
      `     חוזק מודעה: ${ad.ad_strength || "לא ידוע"} | חשיפות: ${ad.impressions} | קליקים: ${ad.clicks} | CTR: ${ctrPct}% | המרות: ${ad.conversions}`,
      `     כותרות: ${hl || "אין"}`,
      `     תיאורים: ${ds || "אין"}`,
    ].join("\n");
  }).join("\n\n");

  return lines;
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
    .select("order_date,total,items,status,utm_source,utm_medium,utm_campaign,tracking_type")
    .gte("order_date", fourWksAgo)
    .lte("order_date", weekEnd)
    .in("status", ["completed", "processing"])
    .not("tracking_type", "ilike", "%advanced purchase tracking%");

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

  const [{ currentAgg, prevAgg }, wooSales, adCreatives] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
    fetchAdCreatives(supabase),
  ]);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const systemPrompt = `אתה יועץ צמיחה אגרסיבי לפרסום ממומן של Minuto Coffee — בית קלייה ספשלטי ברחובות.
הפילוסופיה שלך: צמיחה. להגדיל את הנוכחות, לסקייל על מה שעובד, לבדוק דברים חדשים.
אל תמליץ לצמצם אלא אם הנתונים מאוד גרועים — העדף להגדיל תקציב, לרחב קהל, לבדוק קריאייטיב חדש.

=== חוקי כתיבת קופי לGoogle Ads — קריטי ===
כותרות: עד 30 תווים בדיוק (כולל רווחים). לפני כל כותרת — ספור את התווים. אם עולה על 30 — קצר.
תיאורים: עד 90 תווים בדיוק. אותו כלל — ספור לפני שאתה כותב.

הסגנון: עברית של בן אדם, לא של מחשב. דוגמאות טובות:
✓ "קפה קלוי השבוע, ישר אליך" (27)
✓ "8 פולים שונים מרחבי העולם" (26)
✓ "ספשלטי ברחובות — ₪59 ומעלה" (30)
✓ "לא מדף. קלוי טרי ונשלח." (25)

דוגמאות גרועות — אל תכתוב ככה:
✗ שמות מקומות בלי הקשר ("אתיופיה, ברזיל - פרופילים") — זה לא מסביר כלום
✗ מילים גנריות שיווקיות ("בידול אמיתי", "איכות ללא פשרות")
✗ משפטים שנשמעים כמו תרגום מאנגלית
✓ שמות מוצאים כותבים באנגלית כפי שמקובל בעולם הקפה: Ethiopia Yirgacheffe, Kenya AA, Brazil Natural וכו'
✗ אל תתרגם שמות מוצאים לעברית — "אתיופיה ירגצ'פה" נשמע מוזר. כתוב Ethiopia Yirgacheffe.

לכל קמפיין תוסיף creation_steps — שלבים מספרים ומדויקים איך ליצור אותו ב-Google Ads UI.
חשוב: הנתונים כוללים רק הזמנות B2C — B2B (mflow) סוננו. אל תציין B2B.
חשוב: המילה הנכונה היא "ספשלטי" — לא "ספשיאלטי".
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

=== קריאייטיב מודעות נוכחי (RSA) ===
${adCreatives}

השתמש בהקשר העונתי למעלה — חגים קרובים, עונה, אירועים — כדי לתזמן קמפיינים ולהמליץ על תוכן רלוונטי.
בהמלצות הקריאייטיב — התבסס על הכותרות והתיאורים הקיימים, הצבע על מה שחלש ומה שאפשר לשפר.

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

  const [{ currentAgg, prevAgg }, wooSales, adCreatives] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
    fetchAdCreatives(supabase),
  ]);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const systemPrompt = `אתה יועץ יעילות שמרני לפרסום ממומן של Minuto Coffee — בית קלייה ספשלטי ברחובות.
הפילוסופיה שלך: יעילות. כל שקל צריך להחזיר ערך. לחתוך בזבוז, לרכז תקציב בקמפיינים שמוכיחים ROI.
אתה מחפש דפוסי בזבוז, קמפיינים שמפסידים כסף, ומקומות שאפשר לשפר CPA בלי להגדיל תקציב.
בנוסף לניתוח, תכתוב מודעות משופרות מוכנות להחלפה — כותרות ותיאורים חדשים לקמפיינים החלשים.

=== חוקי כתיבת קופי לGoogle Ads — קריטי ===
כותרות: עד 30 תווים בדיוק (כולל רווחים). לפני כל כותרת — ספור את התווים. אם עולה על 30 — קצר.
תיאורים: עד 90 תווים בדיוק. אותו כלל — ספור לפני שאתה כותב.

הסגנון: עברית של בן אדם, לא של מחשב. דוגמאות טובות:
✓ "קפה קלוי השבוע, ישר אליך" (27)
✓ "8 פולים שונים מרחבי העולם" (26)
✓ "ספשלטי ברחובות — ₪59 ומעלה" (30)
✓ "לא מדף. קלוי טרי ונשלח." (25)

דוגמאות גרועות — אל תכתוב ככה:
✗ שמות מקומות בלי הקשר ("אתיופיה, ברזיל - פרופילים") — זה לא מסביר כלום
✗ מילים גנריות שיווקיות ("בידול אמיתי", "איכות ללא פשרות")
✗ משפטים שנשמעים כמו תרגום מאנגלית
✗ מילים שאינן מילים עבריות אמיתיות — אם אתה לא בטוח בכתיב של שם מקום — אל תשתמש בו בכותרת

לכל מודעה לשכתוב תוסיף creation_steps — שלבים מספרים איך לערוך את המודעה ב-Google Ads UI.
חשוב: הנתונים כוללים רק הזמנות B2C — B2B (mflow) סוננו. אל תציין B2B.
חשוב: המילה הנכונה היא "ספשלטי" — לא "ספשיאלטי".
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

=== קריאייטיב מודעות נוכחי (RSA) ===
${adCreatives}

השתמש בהקשר העונתי — חגים ואירועים — בניתוח תזמון הקמפיינים והמלצות התקציב.
נתח את הכותרות והתיאורים הקיימים: האם הם חזקים? רלוונטיים? האם חוזק המודעה (Ad Strength) נמוך? ה-ads_to_rewrite צריך להתבסס על הקריאייטיב האמיתי שמוצג למעלה.

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
      .limit(25),
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
      .limit(20),
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
    .slice(0, 3);

  const systemPrompt = `אתה מומחה תוכן דיגיטלי של Minuto Coffee, בית קפה ספשלטי ברחובות.
יש לך שתי אחריויות שוות במעמד — אל תזניח אף אחת מהן:

1. אינסטגרם — ניהול תוכן ואסטרטגיית תוכן חברתי
2. Google אורגני — SEO, בלוג, דפי נחיתה, ותוכן שמדורג בחיפוש

הקהל: ישראלים אוהבי קפה, 25–45, שמחפשים בגוגל וגוללים אינסטגרם.
GSC מראה לך מה הם מחפשים בגוגל — מחויב להמיר את זה גם לתוכן SEO (בלוג/דפים) וגם לפוסטי אינסטגרם.

כתוב פוסטים אינסטגרם מוכנים לפרסום — כיתוב מלא, אמוג'ים, קריאה לפעולה, האשטגים.
כתוב המלצות תוכן SEO קונקרטיות — כותרת מוצעת, נקודות עיקריות, מה לכתוב ולמה זה ידורג.

חשוב ישראלי. עברית אמיתית — לא מתורגמת. ספונטני, קצת הומוריסטי, אנושי. לא שיווקי, לא מנופח.
חשוב: הנתונים כוללים רק הזמנות B2C מהאתר — הזמנות B2B של לקוחות עסקיים (mflow / Advanced Purchase Tracking) כבר סוננו ואינן בנתונים. אל תציין B2B בניתוח שלך.
חשוב: המילה הנכונה היא "ספשלטי" — לא "ספשיאלטי". כך אומרים בישראל.
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו. כל שדות טקסט בעברית.`;

  const gscBlock = topKeywords.length > 0
    ? topKeywords.map(k =>
        `  "${k.keyword}" | חשיפות: ${k.impressions} | קליקים: ${k.clicks} | מיקום ממוצע: ${k.position}`
      ).join("\n")
    : "  אין נתוני Search Console עדיין — השתמש בידע הכללי שלך על קפה ספשלטי ישראל";


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

=== משימה כפולה: (1) אינסטגרם — פוסטים, ריילס, סטוריז | (2) Google אורגני — בלוג, דפי נחיתה, SEO ===

=== אינסטגרם — 30 יום אחרונים ===
עוקבים: ${followerCount.toLocaleString()}
ריילס (${reels.length}): reach ממוצע ${avgReach(reels)}, engagement ${avgEng(reels)}%
פוסטים (${posts2.length}): reach ממוצע ${avgReach(posts2)}, engagement ${avgEng(posts2)}%

פוסטים מובילים:
${topPostsBlock || "אין נתונים"}

=== Google Search Console — שאילתות מובילות (בסיס ל-SEO ולאינסטגרם) ===
${gscBlock}
הנחיה: השתמש בנתוני GSC כדי להמליץ גם על תוכן Google אורגני (בלוג/דפים) וגם על זווית לפוסטי אינסטגרם.

=== מלאי ===
${inventoryBlock}

=== מכירות WooCommerce (השבוע האחרון) ===
${wooSalesOrganic}

=== לוח תוכן לשבוע ${weekStart}–${weekEnd} ===
התחשב בעונה ובחגים הקרובים בלוח התוכן — תזמן פוסטים לפני חגים, הימנע מפוסטים שמחים בימי זיכרון.

החזר JSON:
{
  "summary": "2-3 משפטים — מה עבד באינסטגרם, מה GSC מראה, ומה ההזדמנות הגדולה ביותר בתוכן אורגני",
  "account_health": {
    "avg_reach_30d": ${avgReach(posts)},
    "follower_count": ${followerCount},
    "best_post_type": "reel|post|story",
    "engagement_rate_pct": ${avgEng(posts)}
  },
  "google_organic_recommendations": [
    {
      "keyword": "מילת מפתח מ-GSC שכדאי לתקוף אורגנית",
      "current_position": 8.5,
      "search_volume_signal": "impressions: X",
      "content_type": "blog_post|landing_page|product_page|faq_page",
      "suggested_title": "כותרת מוצעת לעמוד/בלוג (H1)",
      "key_points": ["נקודה 1 לכסות", "נקודה 2", "נקודה 3"],
      "why_now": "למה הנושא הזה רלוונטי עכשיו — עונה, חג, מגמה",
      "estimated_difficulty": "קל|בינוני|קשה"
    }
  ],
  "seo_content_opportunities": [
    {
      "keyword": "מילת מפתח מ-GSC",
      "search_volume_signal": "impressions: X",
      "current_position": 8.5,
      "instagram_angle": "איך להפוך את זה לפוסט אינסטגרם מנצח"
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

// ── Weekly Email Digest ───────────────────────────────────────────────────────

const RESEND_KEY   = Deno.env.get("RESEND_API_KEY")            ?? "";
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL")              ?? "info@minuto.co.il";
const ADMIN_EMAIL  = Deno.env.get("ADMIN_EMAIL")               ?? "";
const DASHBOARD_URL = "https://coffeeflow-thaf.vercel.app/advisor";

function buildAdvisorEmailHtml(
  weekStart: string,
  weekEnd: string,
  reports: Record<string, unknown>,
): string {
  function esc(s: unknown): string {
    if (!s) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function reportSection(
    label: string,
    color: string,
    emoji: string,
    agentType: string,
  ): string {
    const r = reports[agentType] as Record<string, unknown> | undefined;
    if (!r) return "";
    const summary = esc(r.summary as string ?? "");
    const insights = ((r.key_insights ?? []) as string[]).slice(0, 3);
    const insightRows = insights
      .map(i => `<li style="margin: 6px 0; color: #555; font-size: 14px; line-height: 1.5;">${esc(i)}</li>`)
      .join("");
    const focus = esc((r.next_week_focus ?? "") as string);

    return `
      <tr>
        <td style="padding: 0 32px 24px;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border-radius: 10px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>
              <td style="background: ${color}; padding: 14px 20px;">
                <p style="margin: 0; color: white; font-size: 16px; font-weight: 700;">${emoji} ${esc(label)}</p>
              </td>
            </tr>
            <tr>
              <td style="background: white; padding: 16px 20px;">
                <p style="margin: 0 0 12px; font-size: 14px; line-height: 1.6; color: #333;">${summary}</p>
                ${insightRows ? `<ul style="margin: 0; padding-right: 20px;">${insightRows}</ul>` : ""}
                ${focus ? `<p style="margin: 12px 0 0; font-size: 13px; color: #6B7280; font-style: italic;">▶ ${esc(focus)}</p>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>`;
  }

  const dateFrom = weekStart.split("-").reverse().join("/");
  const dateTo   = weekEnd.split("-").reverse().join("/");

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F5F5F0;font-family:Arial,Helvetica,sans-serif;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F5F0;">
<tr><td align="center" style="padding:24px 16px;">
<table cellpadding="0" cellspacing="0" border="0" width="600"
       style="max-width:600px;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr>
    <td style="background:linear-gradient(135deg,#3D4A2E,#556B3A);padding:28px 24px;text-align:center;">
      <h1 style="margin:0;color:white;font-size:26px;font-weight:700;">Minuto — יועץ שיווק AI</h1>
      <p style="margin:8px 0 0;color:#B5C69A;font-size:14px;">דוח שבועי · ${esc(dateFrom)} – ${esc(dateTo)}</p>
    </td>
  </tr>

  <!-- Spacer -->
  <tr><td style="height:24px;"></td></tr>

  ${reportSection("סוכן צמיחה — Google Ads", "#1D4ED8", "🚀", "google_ads_growth")}
  ${reportSection("סוכן יעילות — Google Ads", "#D97706", "🛡️", "google_ads_efficiency")}
  ${reportSection("סוכן תוכן אורגני — Instagram + SEO", "#15803D", "🌿", "organic_content")}

  <!-- CTA -->
  <tr>
    <td style="padding:8px 32px 32px;text-align:center;">
      <a href="${DASHBOARD_URL}"
         style="display:inline-block;padding:14px 32px;background:#3D4A2E;color:white;border-radius:8px;text-decoration:none;font-size:16px;font-weight:700;">
        לדוח המלא בדשבורד
      </a>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#EBEFE2;padding:16px 32px;text-align:center;font-size:12px;color:#666;">
      <p style="margin:0;">CoffeeFlow — Minuto Café &amp; Roastery</p>
      <p style="margin:6px 0 0;color:#999;">נשלח אוטומטית על ידי מערכת ה-AI</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function sendAdvisorEmail(
  weekStart: string,
  weekEnd: string,
  reports: Record<string, unknown>,
): Promise<void> {
  if (!RESEND_KEY)   { console.log("[email] RESEND_API_KEY not set — skipping email"); return; }
  if (!ADMIN_EMAIL)  { console.log("[email] ADMIN_EMAIL not set — skipping email"); return; }

  const dateFrom = weekStart.split("-").reverse().join("/");
  const dateTo   = weekEnd.split("-").reverse().join("/");
  const subject  = `דוח שיווק שבועי Minuto — ${dateFrom}–${dateTo}`;
  const html     = buildAdvisorEmailHtml(weekStart, weekEnd, reports);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from:    `Minuto AI <${SENDER_EMAIL}>`,
      to:      [ADMIN_EMAIL],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[email] Resend error (${res.status}):`, err.substring(0, 200));
  } else {
    const data = await res.json();
    console.log(`[email] Sent successfully. Resend ID: ${data.id}`);
  }
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
  const weekEnd = addDays(weekStart, 6);
  const SINGLE_AGENTS = ["google_ads_growth", "google_ads_efficiency", "organic_content"];
  const isOrchestrator = agentArg === "all" || agentArg === "both";
  const isSingleAgent  = SINGLE_AGENTS.includes(agentArg);

  // ── ORCHESTRATOR MODE ────────────────────────────────────────────────────────
  // Called by the frontend with agent="all". Marks all 3 as "running", fires
  // one self-invocation per agent (each gets its own HTTP connection + timeout),
  // then returns 202 immediately. No EdgeRuntime tricks needed.
  if (isOrchestrator) {
    await Promise.all(
      SINGLE_AGENTS.map(type =>
        upsertReport(supabase, type, weekStart, { status: "running", error_msg: null })
      )
    );

    const selfUrl = `${SUPA_URL}/functions/v1/marketing-advisor`;
    for (const agent of SINGLE_AGENTS) {
      fetch(selfUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPA_KEY}`,
        },
        body: JSON.stringify({ agent, focus }),
      }).catch(e => console.error(`[orchestrator] fire ${agent} error:`, e.message));
    }

    return new Response(
      JSON.stringify({ started: true, week_start: weekStart }),
      { status: 202, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  // ── SINGLE AGENT MODE ────────────────────────────────────────────────────────
  // Called by the orchestrator (or directly) with a specific agent name.
  // Runs one agent synchronously — no background tricks, no timeouts from proxy.
  if (!isSingleAgent) {
    return new Response(
      JSON.stringify({ error: `Unknown agent: ${agentArg}` }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  console.log(`[${agentArg}] Starting single-agent run for week ${weekStart}`);
  await upsertReport(supabase, agentArg, weekStart, { status: "running", error_msg: null });

  try {
    let result: { report: unknown; tokensUsed: number };
    let model: string;

    if (agentArg === "google_ads_growth") {
      result = await runGrowthAgent(supabase, weekStart, focus);
      model  = MODEL_ADS;
    } else if (agentArg === "google_ads_efficiency") {
      result = await runEfficiencyAgent(supabase, weekStart, focus);
      model  = MODEL_ADS;
    } else {
      result = await runOrganicAgent(supabase, weekStart, focus);
      model  = MODEL_ORGANIC;
    }

    await upsertReport(supabase, agentArg, weekStart, {
      status: "done", report: result.report, model,
      tokens_used: result.tokensUsed, error_msg: null,
    });
    console.log(`[${agentArg}] Done. Tokens: ${result.tokensUsed}`);

    // If all 3 agents are now done → send email digest
    const { data: allRows } = await supabase
      .from("advisor_reports")
      .select("agent_type,status,report")
      .eq("week_start", weekStart)
      .in("agent_type", SINGLE_AGENTS);

    const doneRows = (allRows ?? []).filter((r: { status: string }) => r.status === "done");
    if (doneRows.length === SINGLE_AGENTS.length) {
      const reports: Record<string, unknown> = {};
      for (const r of doneRows) reports[r.agent_type] = r.report;
      sendAdvisorEmail(weekStart, weekEnd, reports).catch(e =>
        console.error("[email] Failed:", e.message)
      );
    }

    return new Response(
      JSON.stringify({ success: true, agent: agentArg, week_start: weekStart }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${agentArg}] Error:`, msg);
    await upsertReport(supabase, agentArg, weekStart, { status: "error", error_msg: msg });
    return new Response(
      JSON.stringify({ success: false, agent: agentArg, error: msg }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
