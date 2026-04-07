/**
 * CoffeeFlow — Marketing Advisor Edge Function
 *
 * Runs two independent AI agents weekly:
 *   1. paid_ads         — Google Ads performance analysis + budget recommendations
 *   2. organic_content  — Instagram organic content planning + inventory-based suggestions
 *
 * Invocation:
 *   POST /functions/v1/marketing-advisor
 *   Body: { "trigger": "manual"|"cron", "agent": "paid_ads"|"organic_content"|"both" }
 *
 * Results stored in advisor_reports table (one row per agent_type + week_start, upserted).
 *
 * Secrets required: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPA_URL      = Deno.env.get("SUPABASE_URL") ?? "";
const SUPA_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Paid ads: sonnet for structured numerical analysis
// Organic: opus for creative content ideas + cultural nuance
const MODEL_PAID_ADS = "claude-sonnet-4-5-20250929";
const MODEL_ORGANIC  = "claude-opus-4-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns Monday of the previous full week (Mon–Sun) */
function getPreviousWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  // Days since last Monday: if today is Mon (1), go back 7; if Sun (0), go back 6
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  // Always go to previous week (not current week), so add 7 more days
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

/** Strip markdown code fences Claude sometimes wraps JSON in */
function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** Call Claude API — returns response text */
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

/** Upsert an advisor_reports row */
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

// ── Aggregation helpers ───────────────────────────────────────────────────────

interface GoogleRow {
  campaign_id: string; name: string; status: string;
  date: string; impressions: number; clicks: number; cost: number;
  ctr: number; cpc: number; conversions: number; conversion_value: number; roas: number;
}

interface MetaAdRow {
  campaign_id: string; name: string; status: string; objective: string;
  date: string; spend: number; impressions: number; clicks: number;
  cpm: number; cpc: number; ctr: number; conversions: number;
}

function aggregateGoogleCampaigns(rows: GoogleRow[]) {
  const map = new Map<string, {
    name: string; status: string;
    cost: number; clicks: number; impressions: number;
    conversions: number; convValue: number;
  }>();

  for (const r of rows) {
    const existing = map.get(r.campaign_id);
    if (existing) {
      existing.cost        += r.cost;
      existing.clicks      += r.clicks;
      existing.impressions += r.impressions;
      existing.conversions += r.conversions;
      existing.convValue   += r.conversion_value;
    } else {
      map.set(r.campaign_id, {
        name: r.name, status: r.status,
        cost: r.cost, clicks: r.clicks, impressions: r.impressions,
        conversions: r.conversions, convValue: r.conversion_value,
      });
    }
  }

  return Array.from(map.entries()).map(([id, v]) => ({
    id,
    name: v.name,
    status: v.status,
    cost: Math.round(v.cost * 100) / 100,
    clicks: v.clicks,
    impressions: v.impressions,
    conversions: Math.round(v.conversions * 10) / 10,
    roas: v.cost > 0 ? Math.round((v.convValue / v.cost) * 100) / 100 : 0,
    cpa:  v.conversions > 0 ? Math.round((v.cost / v.conversions) * 100) / 100 : null,
  }));
}

// ── Paid Ads Agent ────────────────────────────────────────────────────────────

async function runPaidAdsAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
) {
  const weekEnd     = addDays(weekStart, 6);
  const fourWksAgo  = subtractDays(weekStart, 28);

  console.log(`[paid_ads] Fetching Google Ads data from ${fourWksAgo} to ${weekEnd}`);

  const { data: googleRows, error: gErr } = await supabase
    .from("google_campaigns")
    .select("campaign_id,name,status,date,impressions,clicks,cost,ctr,cpc,conversions,conversion_value,roas")
    .gte("date", fourWksAgo)
    .lte("date", weekEnd)
    .order("date", { ascending: false });

  if (gErr) throw new Error(`Google fetch error: ${gErr.message}`);

  const allRows = (googleRows ?? []) as GoogleRow[];

  // Split current week vs previous 3 weeks for trend context
  const currentWeekRows = allRows.filter(r => r.date >= weekStart);
  const prevWeeksRows   = allRows.filter(r => r.date < weekStart);

  const currentAgg = aggregateGoogleCampaigns(currentWeekRows);
  const prevAgg    = aggregateGoogleCampaigns(prevWeeksRows);

  // Totals for the week
  const totalCost        = currentAgg.reduce((s, c) => s + c.cost, 0);
  const totalClicks      = currentAgg.reduce((s, c) => s + c.clicks, 0);
  const totalImpressions = currentAgg.reduce((s, c) => s + c.impressions, 0);
  const totalConversions = currentAgg.reduce((s, c) => s + c.conversions, 0);
  const overallRoas      = totalCost > 0
    ? currentAgg.reduce((s, c) => s + c.cost * c.roas, 0) / totalCost
    : 0;

  const systemPrompt = `אתה יועץ פרסום ממומן מומחה לעסקי קפה מיוחד בישראל.
המותג: Minuto Coffee — בית קפה ספשיאלטי ברחובות.
המשימה שלך: לנתח את ביצועי קמפיינים ממומנים (כרגע Google Ads בלבד, Meta בהמתנה לאישור) ולהמליץ המלצות ספציפיות ומעשיות.
חשוב מאוד:
- ענה אך ורק ב-JSON תקין ומלא — ללא טקסט לפניו או אחריו, ללא markdown.
- כל שדות הטקסט יהיו בעברית.
- אל תמציא נתונים — בסס את הכל על הנתונים שסופקו.
- אם אין מספיק נתונים לקמפיין מסוים, ציין זאת בשדה reason.`;

  const campaignSummary = currentAgg.length > 0
    ? currentAgg.map(c =>
        `  קמפיין: ${c.name} | סטטוס: ${c.status} | הוצאה: ₪${c.cost} | קליקים: ${c.clicks} | המרות: ${c.conversions} | ROAS: ${c.roas}x | CPA: ${c.cpa != null ? `₪${c.cpa}` : "אין"}`
      ).join("\n")
    : "  אין נתוני קמפיין לתקופה זו";

  const prevSummary = prevAgg.length > 0
    ? prevAgg.map(c =>
        `  קמפיין: ${c.name} | הוצאה: ₪${c.cost} | המרות: ${c.conversions} | ROAS: ${c.roas}x`
      ).join("\n")
    : "  אין נתוני השוואה";

  const userMessage = `
נתוני Google Ads לשבוע ${weekStart} עד ${weekEnd}:

=== ביצועי השבוע (מצטבר לפי קמפיין) ===
${campaignSummary}

=== סיכום כולל לשבוע ===
הוצאה כוללת: ₪${Math.round(totalCost * 100) / 100}
קליקים כוללים: ${totalClicks}
חשיפות כוללות: ${totalImpressions}
המרות כוללות: ${Math.round(totalConversions * 10) / 10}
ROAS ממוצע משוקלל: ${Math.round(overallRoas * 100) / 100}x

=== ביצועי 3 שבועות קודמים (להשוואת מגמה) ===
${prevSummary}

=== הנחיות ===
החזר JSON אחד בדיוק בפורמט הבא:

{
  "summary": "2-3 משפטי סיכום בעברית",
  "google": {
    "total_cost": ${Math.round(totalCost * 100) / 100},
    "total_clicks": ${totalClicks},
    "total_impressions": ${totalImpressions},
    "total_conversions": ${Math.round(totalConversions * 10) / 10},
    "roas": ${Math.round(overallRoas * 100) / 100},
    "top_campaign": "שם הקמפיין הטוב ביותר (לפי ROAS)",
    "worst_campaign": "שם הקמפיין הגרוע ביותר"
  },
  "meta": null,
  "budget_recommendations": [
    {
      "platform": "google",
      "campaign": "שם קמפיין",
      "action": "increase|decrease|pause|keep",
      "reason": "הסבר קצר",
      "suggested_budget_change_pct": 20
    }
  ],
  "campaign_changes": [
    {
      "platform": "google",
      "campaign": "שם קמפיין",
      "action": "pause|activate|test_new_creative|review_targeting",
      "reason": "הסבר קצר"
    }
  ],
  "key_insights": [
    "תובנה 1",
    "תובנה 2",
    "תובנה 3"
  ],
  "next_week_focus": "המלצה עיקרית אחת לשבוע הבא"
}
`;

  console.log(`[paid_ads] Calling Claude (${MODEL_PAID_ADS})...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_PAID_ADS, systemPrompt, userMessage);

  const parsed = JSON.parse(stripCodeFences(text));
  console.log(`[paid_ads] Done. Tokens: ${inputTokens}in / ${outputTokens}out`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Organic Content Agent ─────────────────────────────────────────────────────

async function runOrganicAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
) {
  const thirtyDaysAgo = subtractDays(weekStart, 30);
  const weekEnd       = addDays(weekStart, 6);

  console.log(`[organic] Fetching organic data from ${thirtyDaysAgo}`);

  const [postsRes, insightsRes, productsRes, originsRes] = await Promise.all([
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
  ]);

  const posts    = (postsRes.data    ?? []);
  const insights = (insightsRes.data ?? []);
  const products = (productsRes.data ?? []);
  const origins  = (originsRes.data  ?? []);

  // Compute engagement stats per post type
  const byType = (type: string) => posts.filter((p: { post_type: string }) => p.post_type === type);
  const avgReach = (arr: { reach: number }[]) =>
    arr.length > 0 ? Math.round(arr.reduce((s, p) => s + (p.reach || 0), 0) / arr.length) : 0;
  const avgEngagement = (arr: { likes: number; comments: number; saves: number; reach: number }[]) => {
    if (arr.length === 0 || avgReach(arr) === 0) return 0;
    const totalEng = arr.reduce((s, p) => s + (p.likes || 0) + (p.comments || 0) + (p.saves || 0), 0);
    return Math.round((totalEng / arr.reduce((s, p) => s + (p.reach || 0), 0)) * 1000) / 10;
  };

  const reels  = byType("reel");
  const posts2 = byType("post");
  const stories = byType("story");

  // Latest follower count
  const latestInsight = insights[0] ?? {};
  const followerCount = latestInsight.follower_count ?? 0;

  // Products that need attention
  const lowStock    = products.filter((p: { packed_stock: number; min_packed_stock: number }) => p.packed_stock < p.min_packed_stock);
  const healthyStock = products.filter((p: { packed_stock: number; min_packed_stock: number }) => p.packed_stock >= p.min_packed_stock);
  const criticalOrigins = origins.filter((o: { roasted_stock: number; critical_stock: number }) => o.roasted_stock < o.critical_stock);

  // Top posts for context
  const topPosts = [...posts]
    .sort((a: { saves: number; likes: number }, b: { saves: number; likes: number }) => (b.saves + b.likes) - (a.saves + a.likes))
    .slice(0, 5);

  const systemPrompt = `אתה מומחה אסטרטגיית תוכן לאינסטגרם עבור Minuto Coffee, בית קפה ספשיאלטי ברחובות, ישראל.
הקהל: אוהבי קפה ישראלים, גילאי 25–45, המכירים את עולם הספשיאלטי.
שפת התוכן: עברית, אותנטית, לא שיווקית מדי — יותר אהבה לקפה, פחות פרסום.
המשימה: לנתח ביצועי תוכן אורגני ומצב מלאי, ולהמליץ על לוח תוכן לשבוע הבא.
חשוב מאוד:
- ענה אך ורק ב-JSON תקין ומלא — ללא טקסט לפניו או אחריו, ללא markdown.
- כל שדות הטקסט יהיו בעברית.
- הצע רעיונות ספציפיים ומעשיים, לא כלליים.
- התחשב במלאי — אל תמליץ להציג מוצר שאין בו מלאי.`;

  const postTypeSummary = [
    `ריילס (${reels.length} פוסטים): reach ממוצע ${avgReach(reels)}, engagement ${avgEngagement(reels)}%`,
    `פוסטים (${posts2.length} פוסטים): reach ממוצע ${avgReach(posts2)}, engagement ${avgEngagement(posts2)}%`,
    `סטוריז (${stories.length} פוסטים): reach ממוצע ${avgReach(stories)}`,
  ].join("\n");

  const topPostsSummary = topPosts.map((p: { post_type: string; created_at: string; reach: number; likes: number; saves: number; message: string }) =>
    `  [${p.post_type}] ${p.created_at?.split("T")[0]} | reach: ${p.reach} | saves: ${p.saves} | likes: ${p.likes} | "${p.message?.substring(0, 60) ?? ""}..."`
  ).join("\n");

  const inventorySummary = [
    `מוצרים עם מלאי נמוך (${lowStock.length}):`,
    ...lowStock.map((p: { name: string; packed_stock: number; min_packed_stock: number }) => `  ⚠️ ${p.name}: ${p.packed_stock} שקיות (מינימום: ${p.min_packed_stock})`),
    `\nמוצרים עם מלאי תקין (${healthyStock.length}):`,
    ...healthyStock.map((p: { name: string; packed_stock: number }) => `  ✅ ${p.name}: ${p.packed_stock} שקיות`),
    criticalOrigins.length > 0
      ? `\nמקורות במלאי קריטי:\n${criticalOrigins.map((o: { name: string; roasted_stock: number; critical_stock: number }) => `  ⚠️ ${o.name}: ${o.roasted_stock}ג' (קריטי: ${o.critical_stock}ג')`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");

  const userMessage = `
=== נתוני ביצועי תוכן אורגני — 30 יום אחרונים ===

מעקב: ${followerCount.toLocaleString()} עוקבים

ביצועים לפי סוג תוכן:
${postTypeSummary}

הפוסטים המובילים (לפי saves + likes):
${topPostsSummary || "אין נתונים"}

=== מצב מלאי ===
${inventorySummary}

=== שבוע המלצות: ${weekStart} עד ${weekEnd} ===

החזר JSON אחד בדיוק בפורמט הבא:

{
  "summary": "2-3 משפטי סיכום על מה עבד, מה לא, ומה הכיוון לשבוע הבא",
  "account_health": {
    "avg_reach_30d": ${avgReach(posts)},
    "follower_count": ${followerCount},
    "best_post_type": "reel|post|story",
    "engagement_rate_pct": ${avgEngagement(posts)}
  },
  "content_recommendations": [
    {
      "priority": 1,
      "content_type": "reel|post|story",
      "topic": "נושא ספציפי לפוסט",
      "reason": "למה עכשיו — מה בנתונים מצדיק את זה",
      "caption_idea": "רעיון לכיתוב — משפטים ספציפיים, לא כללי",
      "best_day": "ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת",
      "best_time": "שעה מומלצת כ-09:00"
    }
  ],
  "products_to_feature": [
    {
      "product": "שם מוצר",
      "reason": "low_stock_urgency|new_batch|bestseller|seasonal",
      "content_angle": "זווית תוכן ספציפית — מה לספר על המוצר"
    }
  ],
  "next_week_calendar": [
    { "day": "ראשון", "type": "reel", "topic": "נושא קצר" },
    { "day": "רביעי", "type": "post", "topic": "נושא קצר" },
    { "day": "שישי",  "type": "story", "topic": "נושא קצר" }
  ],
  "key_insights": [
    "תובנה 1 מהנתונים",
    "תובנה 2 מהנתונים",
    "תובנה 3 מהנתונים"
  ],
  "what_worked_last_week": [
    "מה עבד טוב",
    "מה לא עבד"
  ]
}
`;

  console.log(`[organic] Calling Claude (${MODEL_ORGANIC})...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ORGANIC, systemPrompt, userMessage);

  const parsed = JSON.parse(stripCodeFences(text));
  console.log(`[organic] Done. Tokens: ${inputTokens}in / ${outputTokens}out`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const supabase = createClient(SUPA_URL, SUPA_KEY);

  const weekStart = getPreviousWeekStart();
  console.log(`[marketing-advisor] weekStart: ${weekStart}`);

  let body: { trigger?: string; agent?: string } = {};
  try {
    body = await req.json();
  } catch {
    // ignore — default to "both"
  }

  const agentArg = body.agent ?? "both";
  const runPaid    = agentArg === "paid_ads"        || agentArg === "both";
  const runOrganic = agentArg === "organic_content" || agentArg === "both";

  const agentsRun: string[] = [];
  const errors: Record<string, string> = {};

  // ── Paid Ads Agent ──
  if (runPaid) {
    await upsertReport(supabase, "paid_ads", weekStart, { status: "running", error_msg: null });
    try {
      const { report, tokensUsed } = await runPaidAdsAgent(supabase, weekStart);
      await upsertReport(supabase, "paid_ads", weekStart, {
        status: "done",
        report,
        model: MODEL_PAID_ADS,
        tokens_used: tokensUsed,
        error_msg: null,
      });
      agentsRun.push("paid_ads");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[paid_ads] Error:", msg);
      await upsertReport(supabase, "paid_ads", weekStart, { status: "error", error_msg: msg });
      errors["paid_ads"] = msg;
    }
  }

  // ── Organic Content Agent ──
  if (runOrganic) {
    await upsertReport(supabase, "organic_content", weekStart, { status: "running", error_msg: null });
    try {
      const { report, tokensUsed } = await runOrganicAgent(supabase, weekStart);
      await upsertReport(supabase, "organic_content", weekStart, {
        status: "done",
        report,
        model: MODEL_ORGANIC,
        tokens_used: tokensUsed,
        error_msg: null,
      });
      agentsRun.push("organic_content");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[organic] Error:", msg);
      await upsertReport(supabase, "organic_content", weekStart, { status: "error", error_msg: msg });
      errors["organic_content"] = msg;
    }
  }

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
