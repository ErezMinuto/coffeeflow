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
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  return {
    text: data.content?.[0]?.text ?? "",
    inputTokens:  data.usage?.input_tokens  ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  };
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

// ── Google Ads Agent — GROWTH ─────────────────────────────────────────────────

async function runGrowthAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
) {
  const weekEnd = addDays(weekStart, 6);
  console.log(`[growth] Fetching data ${weekStart} → ${weekEnd}`);

  const { currentAgg, prevAgg } = await fetchGoogleData(supabase, weekStart, weekEnd);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const systemPrompt = `אתה יועץ צמיחה אגרסיבי לפרסום ממומן של Minuto Coffee — בית קפה ספשיאלטי ברחובות.
הפילוסופיה שלך: צמיחה. להגדיל את הנוכחות, לשנות את הסקייל על מה שעובד, לבדוק דברים חדשים.
אתה מוכן לקחת סיכון מחושב כדי לבנות מותג ולגדול.
אל תמליץ לצמצם אלא אם הנתונים מאוד גרועים — העדף להגדיל תקציב, לרחב קהל, לבדוק קריאייטיב חדש.
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו. כל שדות טקסט בעברית.`;

  const userMessage = `נתוני Google Ads שבוע ${weekStart}–${weekEnd}:

=== קמפיינים השבוע ===
${campaignBlock}

=== סיכום ===
עלות כוללת: ₪${Math.round(totalCost * 100) / 100} | קליקים: ${totalClicks} | חשיפות: ${totalImpressions} | המרות: ${Math.round(totalConversions * 10) / 10} | ROAS: ${Math.round(overallRoas * 100) / 100}x

=== 3 שבועות קודמים (מגמה) ===
${prevBlock}

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
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"],
  "next_week_focus": "המהלך העיקרי לצמיחה השבוע הבא"
}`;

  console.log(`[growth] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ADS, systemPrompt, userMessage);
  const parsed = JSON.parse(stripCodeFences(text));
  console.log(`[growth] Done. Tokens: ${inputTokens + outputTokens}`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Google Ads Agent — EFFICIENCY ─────────────────────────────────────────────

async function runEfficiencyAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
) {
  const weekEnd = addDays(weekStart, 6);
  console.log(`[efficiency] Fetching data ${weekStart} → ${weekEnd}`);

  const { currentAgg, prevAgg } = await fetchGoogleData(supabase, weekStart, weekEnd);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const systemPrompt = `אתה יועץ יעילות שמרני לפרסום ממומן של Minuto Coffee — בית קפה ספשיאלטי ברחובות.
הפילוסופיה שלך: יעילות. כל שקל צריך להחזיר ערך. לחתוך בזבוז, לרכז תקציב בקמפיינים שמוכיחים ROI.
אתה מחפש דפוסי בזבוז, קמפיינים שמפסידים כסף, ומקומות שאפשר לשפר CPA בלי להגדיל תקציב.
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו. כל שדות טקסט בעברית.`;

  const userMessage = `נתוני Google Ads שבוע ${weekStart}–${weekEnd}:

=== קמפיינים השבוע ===
${campaignBlock}

=== סיכום ===
עלות כוללת: ₪${Math.round(totalCost * 100) / 100} | קליקים: ${totalClicks} | חשיפות: ${totalImpressions} | המרות: ${Math.round(totalConversions * 10) / 10} | ROAS: ${Math.round(overallRoas * 100) / 100}x

=== 3 שבועות קודמים (מגמה) ===
${prevBlock}

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
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"],
  "next_week_focus": "המהלך העיקרי לשיפור יעילות השבוע הבא"
}`;

  console.log(`[efficiency] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ADS, systemPrompt, userMessage);
  const parsed = JSON.parse(stripCodeFences(text));
  console.log(`[efficiency] Done. Tokens: ${inputTokens + outputTokens}`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Organic Content Agent ─────────────────────────────────────────────────────

async function runOrganicAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
) {
  const weekEnd       = addDays(weekStart, 6);
  const thirtyDaysAgo = subtractDays(weekStart, 30);
  console.log(`[organic] Fetching data from ${thirtyDaysAgo}`);

  const [postsRes, insightsRes, productsRes, originsRes, gscRes] = await Promise.all([
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

  const systemPrompt = `אתה מומחה אסטרטגיית תוכן לאינסטגרם ו-SEO של Minuto Coffee, בית קפה ספשיאלטי ברחובות.
הקהל: אוהבי קפה ישראלים, 25–45. שפה: עברית אותנטית, לא שיווקית.
יש לך גישה לנתוני אינסטגרם אורגני וגם ל-Google Search Console — השתמש בשניהם.
תובנות GSC: מילות מפתח שאנשים מחפשים עליהן = נושאים שכדאי לדבר עליהם גם באינסטגרם.
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

  const userMessage = `
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

=== לוח תוכן לשבוע ${weekStart}–${weekEnd} ===

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
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"],
  "what_worked_last_week": ["מה עבד", "מה לא עבד"]
}`;

  console.log(`[organic] Calling Claude (${MODEL_ORGANIC})...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ORGANIC, systemPrompt, userMessage);
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

  let body: { trigger?: string; agent?: string } = {};
  try { body = await req.json() } catch { /* default to all */ }

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

  if (runGrowthFinal)     await runAgent("google_ads_growth",     () => runGrowthAgent(supabase, weekStart),     MODEL_ADS);
  if (runEfficiencyFinal) await runAgent("google_ads_efficiency",  () => runEfficiencyAgent(supabase, weekStart),  MODEL_ADS);
  if (runOrganicFinal)    await runAgent("organic_content",         () => runOrganicAgent(supabase, weekStart),     MODEL_ORGANIC);

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
