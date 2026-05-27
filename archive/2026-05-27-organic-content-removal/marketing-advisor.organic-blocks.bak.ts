/*
 * ARCHIVED — DO NOT EDIT. Reference only.
 *
 * Removed from: supabase/functions/marketing-advisor/index.ts
 * Date:         2026-05-27
 * Reason:       organic-content agent retired (replaced by organic-orchestrator
 *               + workers). See PRs #95, #96, #97, #98 for the retirement
 *               sequence (cron → UI panel → function dispatch → code removal).
 *
 * Contents of this file are EXTRACTED VERBATIM from index.ts:
 *   - runOrganicAgent       (was lines 4572-5594, ~1025 lines)
 *   - generateSceneDescription (was lines 5924-5984, dead-code helper)
 *
 * Imports + helper function references inside the extracted code will not
 * resolve here — this file is reference material, not compilable. To
 * restore: cherry-pick the function bodies back into index.ts and re-add
 * the import of enrichPostsForPublishing from ./enrichment.ts (archived
 * as marketing-advisor.enrichment.bak.ts next to this file).
 *
 * If you need this in 6 months and it's gone from git history (e.g.
 * truncated by GitHub's UI), the full content lives in commit
 * 6e9320b..HEAD (whichever commit removed it).
 */

// ──────────────────────────────────────────────────────────────────────
// PART 1 — runOrganicAgent (extracted from index.ts:4570-5594)
// ──────────────────────────────────────────────────────────────────────

// ── Organic Content Agent ─────────────────────────────────────────────────────

async function runOrganicAgent(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  focus?: string,
) {
  const weekEnd       = addDays(weekStart, 6);
  const thirtyDaysAgo = subtractDays(weekStart, 30);
  console.log(`[organic] Fetching data from ${thirtyDaysAgo}`);

  const [postsRes, insightsRes, productsRes, originsRes, gscRes, wooSalesOrganic, pastReportsOrganic, wooEquipmentRes] = await Promise.all([
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
    fetchPastReports(supabase, "organic_content", weekStart),
    // Equipment catalog from WooCommerce — grinders, machines, brewing
    // tools, accessories. Without this, the organic agent recommends
    // global brands (Baratza/Wilfa/Fellow) that aren't sold in Israel.
    // Forcing it to recommend from Minuto's actual catalog keeps the
    // examples relevant to Israeli buyers AND drives sales to products
    // we sell, not to competitors.
    supabase
      .from("woo_products")
      .select("name,price")
      .not("image_url", "is", null)
      .order("name"),
  ]);
  const completedActions = await getCompletedActions(supabase);

  // Minuto blog posts already published — agent must NOT re-recommend these.
  // Cutoff: only posts from 2026-04-01 onwards count as "recently covered".
  // Older posts can be revisited with fresh angles without the agent blocking.
  const { data: existingBlogPosts } = await supabase
    .from("minuto_blog_posts")
    .select("title, url, published_at")
    .gte("published_at", "2026-04-01T00:00:00Z")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(100);

  const posts    = postsRes.data    ?? [];
  const insights = insightsRes.data ?? [];
  const products = productsRes.data ?? [];
  const origins  = originsRes.data  ?? [];
  const gscRows  = gscRes.data      ?? [];
  const wooEq    = (wooEquipmentRes.data ?? []) as Array<{ name: string; price: number | null }>;

  // Bucket the WooCommerce catalog by equipment category via name pattern
  // matching (no category column on woo_products). The agent uses these
  // to suggest concrete examples instead of pulling global brand names
  // from training data (Baratza/Wilfa/Fellow — not sold in Israel).
  const wooGrinders    = wooEq.filter(p => /(\bמטחנת\b|\bgrinder\b|allground|olympus|fiorenzato|mahlkonig|mahlk[öo]nig|eureka|anfim|wilfa|baratza|comandante|kingrinder|1zpresso|timemore)/i.test(p.name));
  const wooMachines    = wooEq.filter(p => /(\bמכונת אספרסו\b|\bמכונת קפה\b|\bespresso machine\b|\bstrada\b|\blinea\b|\bgs3\b|\bdelonghi\b|\bsage\b|\bbreville\b|\bgaggia\b|\brancilio\b|\bla pavoni\b|lelit|profitec|bezzera|rocket espresso)/i.test(p.name));
  const wooBrewing     = wooEq.filter(p => /(\bv60\b|\bchemex\b|\baeropress\b|\bfrench press\b|\bפילטר\b|\bhario\b|\bkalita\b|\bmoka\b|\bקלברי\b|\bdripper\b|\bpour[\-\s]?over\b)/i.test(p.name));
  const wooAccessories = wooEq.filter(p => /(\bscale\b|\bמשקל\b|\btamper\b|\bטמפר\b|\bkettle\b|\bקומקום\b|\bknock\b|\bwdt\b|\bתרמומטר\b|\bthermometer\b|\bdistribut(?:or|ion)\b|\bmilk pitcher\b|\bפיצ'ר\b)/i.test(p.name));

  function listProducts(items: Array<{ name: string; price: number | null }>, max = 8): string {
    return items.slice(0, max).map(p => `  • ${p.name}${p.price ? ` (₪${p.price})` : ''}`).join('\n');
  }

  const equipmentCatalogBlock = wooEq.length > 0 ? `

=== קטלוג הציוד של Minuto (המוצרים שאנחנו מוכרים בפועל ב-minuto.co.il) ===

${wooGrinders.length > 0 ? `**מטחנות (${wooGrinders.length}):**\n${listProducts(wooGrinders)}\n` : '**מטחנות:** אין מטחנות בקטלוג כרגע. אל תמליץ על נושאי מטחנות עד שיהיו.\n'}
${wooMachines.length > 0 ? `**מכונות אספרסו (${wooMachines.length}):**\n${listProducts(wooMachines)}\n` : ''}
${wooBrewing.length > 0 ? `**ציוד חליטה ידני (V60/Chemex/Aeropress/Moka וכו') (${wooBrewing.length}):**\n${listProducts(wooBrewing)}\n` : ''}
${wooAccessories.length > 0 ? `**אביזרים (משקלים, טמפרים, קומקומים, תרמומטרים) (${wooAccessories.length}):**\n${listProducts(wooAccessories)}\n` : ''}

⛔ **כלל קשיח — דוגמאות ציוד חייבות לבוא מהקטלוג הזה בלבד:**

כשאתה ממליץ על נושא תוכן שכולל דוגמת ציוד (מטחנה, מכונה, אביזר), **חובה** להשתמש בשמות מוצרים מהקטלוג למעלה. **אסור מוחלט** להמליץ על:
  ✗ Baratza Encore / Virtuoso / Sette / Forte
  ✗ Wilfa Svart / Uniform / Aroma
  ✗ Fellow Ode / Opus / Atmos / Stagg
  ✗ Comandante C40
  ✗ 1Zpresso / Kingrinder / Timemore (אלא אם הם בקטלוג למעלה)
  ✗ כל מותג שלא מופיע בקטלוג למעלה — הקונה הישראלי לא יכול לקנות אותם דרך Minuto, ואסור לשלוח אותו למתחרים.

אם נושא ההמלצה דורש דוגמת ציוד מקטגוריה שאין לנו בקטלוג, **דלג על הנושא הזה** ובחר תוכן אחר. עדיף פוסט פולים נוסף מאשר פוסט ציוד שמפרסם מתחרים בטעות.

הזווית האסטרטגית: כשאנחנו ממליצים על FIORENZATO Allground (משלנו) במקום על Wilfa (לא משלנו), אנחנו (א) משאירים את ה-LTV אצלנו, (ב) מציבים את עצמנו כסמכות בציוד מקצועי לבית הקפה הישראלי.
` : '';

  // ── Fetch live Instagram follower count ──────────────────────────────────
  let liveFollowerCount = 0;
  try {
    const { data: tokenRow } = await supabase
      .from("oauth_tokens").select("access_token").eq("platform", "meta").single();
    if (tokenRow?.access_token) {
      const pagesRes = await fetch(
        `https://graph.facebook.com/v23.0/me/accounts?access_token=${tokenRow.access_token}`
      );
      const pages = await pagesRes.json();
      if (pages.data?.length) {
        const pageToken = pages.data[0].access_token;
        const pageId    = pages.data[0].id;
        const igRes = await fetch(
          `https://graph.facebook.com/v23.0/${pageId}?fields=instagram_business_account&access_token=${pageToken}`
        );
        const igData = await igRes.json();
        const igId   = igData.instagram_business_account?.id;
        if (igId) {
          const acctRes = await fetch(
            `https://graph.facebook.com/v23.0/${igId}?fields=followers_count&access_token=${pageToken}`
          );
          const acct = await acctRes.json();
          liveFollowerCount = acct.followers_count ?? 0;
          console.log(`[organic] Live IG followers: ${liveFollowerCount}`);
          // Back-fill today's row so future advisor runs use DB
          if (liveFollowerCount > 0) {
            const today = new Date().toISOString().split("T")[0];
            await supabase.from("meta_daily_insights").upsert(
              { date: today, follower_count: liveFollowerCount },
              { onConflict: "date" }
            );
          }
        }
      }
    }
  } catch (e) {
    console.log("[organic] Could not fetch live follower count:", (e as Error).message);
  }

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
  // Live fetch wins; fall back to most recent DB row with a real value
  const dbFollower = (insights.find((i: { follower_count?: number }) => (i.follower_count ?? 0) > 0) as { follower_count?: number } | undefined)?.follower_count ?? 0;
  const followerCount = liveFollowerCount > 0 ? liveFollowerCount : dbFollower;
  const followerStr = followerCount > 0 ? followerCount.toLocaleString() : "לא זמין";

  const lowStock = products.filter((p: { packed_stock: number; min_packed_stock: number }) => p.packed_stock < p.min_packed_stock);
  const healthyStock = products.filter((p: { packed_stock: number; min_packed_stock: number }) => p.packed_stock >= p.min_packed_stock);

  const topPosts = [...posts]
    .sort((a: { saves: number; likes: number }, b: { saves: number; likes: number }) => (b.saves + b.likes) - (a.saves + a.likes))
    .slice(0, 3);

  const focusOverride = focus
    ? `=== הוראות מנהל — עדיפות עליונה ===
${focus}
התעלם מכל נתון שסותר הוראות אלה. אם GSC מראה הזדמנות שמנהל ביקש לא לקדם — דלג עליה ואל תזכיר אותה. אם המנהל ביקש להתמקד בנושא מסוים — כל ההמלצות שלך חייבות להיות על הנושא הזה.\n\n`
    : '';

  // ── VoC context injection — real customer language from voc_insights ──
  // Agents that can "hear" what customers actually say produce copy that
  // matches their Hebrew instead of translationese. Pull top insights by
  // frequency, bucketed by type so the agent sees a balanced sample.
  const vocSnapshot = await supabase
    .from("voc_insights")
    .select("insight_type,pattern,real_meaning,suggested_response,frequency,example_phrases,customer_stage")
    .order("frequency", { ascending: false })
    .limit(40);
  const vocRows = (vocSnapshot.data ?? []) as any[];
  const vocBlock = vocRows.length > 0 ? `
=== VoC — מה לקוחות באמת אומרים (מבוסס על ${vocRows.length} תבניות מעומק הנתונים) ===
${(['objection','question','motivation','praise','complaint','trigger'] as const).map(t => {
  const byType = vocRows.filter(r => r.insight_type === t);
  if (!byType.length) return '';
  const label = { objection:'התנגדויות', question:'שאלות', motivation:'מוטיבציות',
                  praise:'שבחים', complaint:'תלונות', trigger:'טריגרים' }[t];
  return `\n${label}:\n${byType.slice(0, 5).map(r =>
    `• "${r.pattern}" — המשמעות: ${r.real_meaning} → תגובה: ${r.suggested_response}`
  ).join('\n')}`;
}).filter(Boolean).join('\n')}

**חובה**: כשאתה כותב hook/caption — השתמש בשפה שמהדהדת לפטרנים האלה. אם קיימת התנגדות דומיננטית, טפל בה. אם יש מוטיבציה דומיננטית, הפעל אותה.
` : '';

  const systemPrompt = `${focusOverride}אתה מנהל שיווק דיגיטלי בכיר עם ניסיון בתוכן ו-SEO לעסקי מזון/קפה. אתה מייעץ ל-Minuto Coffee.
${BUSINESS_BRIEF}
${COMPETITIVE_INTELLIGENCE}
${ORGANIC_EXPERTISE}
${PLAYBOOK_2026}
${CUSTOMER_JOURNEY}
${BUYING_MOTIVATIONS}
${HEBREW_COPY_RULES}
${vocBlock}
${equipmentCatalogBlock}

⚠️ **חובה לפני כתיבה (חדש)**:
לפני שאתה כותב כל פוסט, קבע במפורש:
1. באיזה Awareness Stage אני מכוון? (gateway/discovery/commitment/mastery/identity)
2. איזו מוטיבציית קנייה אני מפעיל? (ritual/identity/escape/craft/gift/health)
3. איזו התנגדות/שאלה דומיננטית אני מטפל בה? (מתוך VoC למעלה, אם קיים)

הוסף את ההחלטות האלה כ-meta בתוך ה-JSON (targeting_stage, activating_motivation, addressing_objection).
זה לא formality — זה המנוע של כל הקופי שלך. אם לא ידעת לענות על 3 השאלות, אתה כותב גנרי.


⚠️ כלל קריטי: אנחנו מוכרים פולי קפה בלבד.
אם GSC מראה הזדמנות על "מטחנת קפה" או "מכונת קפה" — דלג עליה לגמרי ואל תזכיר אותה, גם אם המיקום מצוין.
לא לכתוב תוכן על מטחנות, מכונות, cold brew, אביזרים. רק על פולי קפה, קלייה, מקורות, טעמים.

=== ידע קפה בסיסי (חובה לדעת — אם אתה טועה פה, אתה מאבד אמינות) ===
• מקיאטו (macchiato) = כתם חלב באיטלקית. זה אותו דבר בדיוק. אל תכתוב "ההבדל בין מקיאטו לכתם חלב".
• אספרסו = שוט קפה לחוץ. ריסטרטו = שוט קצר יותר. לונגו = שוט ארוך יותר.
• קורטדו = אספרסו + חלב חם בכמות שווה (מספרד). שונה ממקיאטו שיש בו רק כתם חלב.
• פלט וויט = אספרסו כפול + חלב מוקצף דק. שונה מלאטה שיש בו יותר חלב.
• Single Origin = חד-זני = פולים ממקור אחד. Blend = תערובת = פולים ממספר מקורות.
• SCA Score = ציון איכות של Specialty Coffee Association. מעל 80 = ספשלטי.
• Light/Medium/Dark Roast = רמת קלייה. ספשלטי בדרך כלל לייט-מדיום.

יש לך שתי אחריויות — שתיהן משרתות את המטרה הראשית: מכירת פולי קפה.

1. אינסטגרם/פייסבוק — תוכן שמחזק את המותג ומושך אנשים לקנות פולים
2. Google אורגני — SEO, בלוג, דפי נחיתה על קפה ספשלטי שמדורגים בחיפוש

הקהל: ישראלים אוהבי קפה, 25–45, שמחפשים בגוגל וגוללים אינסטגרם.
GSC מראה לך מה הם מחפשים בגוגל — מחויב להמיר את זה גם לתוכן SEO (בלוג/דפים) וגם לפוסטי אינסטגרם.

כתוב פוסטים אינסטגרם מוכנים לפרסום — כיתוב מלא, אמוג'ים, קריאה לפעולה, האשטגים.
כתוב המלצות תוכן SEO קונקרטיות — כותרת מוצעת, נקודות עיקריות, מה לכתוב ולמה זה ידורג.

חשוב ישראלי. עברית אמיתית — לא מתורגמת. ספונטני, קצת הומוריסטי, אנושי. לא שיווקי, לא מנופח.
חשוב: הנתונים כוללים רק הזמנות B2C — B2B (mflow) סוננו. אל תציין B2B.
חשוב: המילה הנכונה היא "ספשלטי" — לא "ספשיאלטי".

⛔ אסורים לחלוטין בהמלצות (לא מופיעים בחיפוש ישראלי):
• "cold brew" / "קפה קר" / "קפה קרח" — נפח חיפוש נמוך מאוד בישראל, אל תמליץ.
• המלצות SEO על ביטויים שלא מופיעים ב-GSC — השתמש רק בביטויים מהנתונים.

🚫 קוד התנהגות מותגי — חל על כל השדות (posts_to_publish, content_recommendations, products_to_feature, blog/SEO):

חוק הזהב: לעולם לא ללעוג, לבזות או לזלזל בקפה אחר, במתחרים, במוצרים שהלקוח כבר משתמש בהם, או בבחירות הצריכה שלו. רק מסגור חיובי.

אסור בהחלט:
• שמות מתחרים בכל הקשר (Lavazza, Illy, Hausbrandt, Nespresso, Starbucks, Costa, Mauro, Bristot, Kimbo, Segafredo, נחת, Jera, אגרו, Origem, Kilimanjaro, Nahat) — לא בכותרת, לא בקאפשן, לא ב-hook, לא ב-visual_direction. גם לא ניטרלית, גם לא חיובית.
• "הפולים של [מותג] נקלו לפני..." או כל טענה שמשווה איכות/טריות מול מתחרה ספציפי, גם אם נכונה — זו השמצה.
• ויז'ואל השוואתי שמראה שתי שקיות זו לצד זו (מינוטו vs אחרת/גנרית) — גם בלי שם מותג, הפריים הוא לעג ויזואלי.
• ללעוג על "פולים מהסופר" / "קפה מסחרי" כאילו הצרכן טיפש שקנה אותו. לא לכתוב "אתה לא יודע מתי הפולים שלך נקלו, נכון?" באירוניה.
• ללעוג על מכונת הקפה של הצרכן ("הדלונגי הזולה שלך") — נכון שמותר להזכיר דגם מכונה כדי לחבר פולים, לא ללעוג עליו.

מותר ועובד טוב:
• "תאריך קלייה" כערך עומד בפני עצמו — בלי השוואה ("הפולים האלה נקלו השבוע, ב-Minuto זה הסטנדרט").
• להפנות את הלקוח להסתכל בעצמו על מה שיש לו ("תבדוק בשקית שלך אם יש תאריך קלייה" — בלי לקרוא לזה רע, בלי לרמוז שהשקית שלו פגומה).
• להציג את היתרון של מינוטו כעובדה חיובית, לא כביקורת על אחרים ("נקלה הבוקר. אצלך מחר.").
• הזכרת קטגוריה ("קפה מסחרי") רק אם זה לא ככינוי גנאי — למשל בהקשר של תוכן חינוכי על תהליכי קלייה ויעדים שונים.

אם הרעיון שעולה לך לא יכול להישאר תקף בלי לנקוב בשם מתחרה או בלי השוואה ויזואלית — הוא לא רעיון לפי קוד המותג. החלף אותו.

הגבלות פלט קפדניות — חרוג מהן = שגיאה:
• google_organic_recommendations — פריט אחד בלבד
• content_recommendations — עד 2 פריטים
• products_to_feature — פריט אחד בלבד
• posts_to_publish — **בדיוק 3 פוסטים**. השדה intent חייב להיות אחד משלושה ערכים בלבד: "save" OR "share" OR "behind_the_scenes". אסור לחזור על intent. אסור ערכים אחרים (NO "promote_product", NO "educate", NO "engage"). אם החזרת פחות מ-3 או עם intent אחר — הדוח נדחה ומוחזר שגיאה.
• key_insights — עד 2
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו.

=== מה זה save / share / behind_the_scenes (חובה להבין לפני שכותבים) ===

**intent: "save"** — תוכן שימושי שאנשים שומרים כדי לחזור אליו:
  • מדריך/רפרנס ("יחסי V60 לכל כמות קפה", "טמפרטורת מים לכל שיטה")
  • תיקון בעיה ("5 סיבות שהאספרסו שלך מר", "איך לנקות מקינטה נכון")
  • טבלה/צ'ק-ליסט ("זמני חליטה לפי שיטה", "מדריך בחירת פולים לפי מכונה")
  • צורה מועדפת: carousel או ריל עם טקסט-על-גבי-סרטון שאפשר לעצור ולצלם
  • מדד הצלחה: saves > likes*2

**intent: "share"** — תוכן שגורם לאנשים לשלוח לחבר או לסטורי:
  • הומור פנימי של החובבים ("5 דברים שחובבי קפה אומרים שאוהבי נס-קפה לא מבינים")
  • דעה שנויה במחלוקת ("המקינטה עדיפה על האספרסו הביתי — הנה למה")
  • חשיפה/סוד מהתעשייה ("זה מה שהסופר לא מספר לכם על הקפה שלכם")
  • אתגר/בדיקה עיוורת ("לוואצה נגד מינוטו — מי מנצח?")
  • טריוויה שמפתיעה ("כמה זמן באמת נשאר פולי קפה טריים?")
  • צורה מועדפת: ריל עם hook ב-2 שניות הראשונות
  • מדד הצלחה: shares > 10, יחס reach:followers גדול מ-3

**intent: "behind_the_scenes"** — תוכן שבונה מותג לאורך זמן:
  • הקלייה עצמה (מכונת הקלייה, מדידת טמפרטורה, קירור הפולים)
  • הצוות (ברריסטות בעבודה, הטעימה היומית, הגעת שקי פולים ירוקים)
  • הלקוחות (לקוחות קבועים, משלוחים יוצאים, הזמנות B2B)
  • סיפורי מקור (חוואים, טיולי השקה, נסיעות לאתיופיה/ברזיל)
  • צורה מועדפת: סטורי אותנטי או ריל קצר לא מלוטש
  • מדד הצלחה: engagement rate + הגדלת היכרות-עם-המותג (follower growth)

**חובה לוודא שהמיקס מאוזן — save + share + BTS = שלושה פוסטים שונים לחלוטין, לא וריאציות של אותו רעיון.**

דוגמאות לסגנון עברית נכון לשדות הטקסט:
✓ "ה-CTR של Coffee_beans_oam נפל — הקופי גנרי ולא מדבר לאף אחד. עוצרים."
✓ "ה-ROAS של MM|SRC ירד ב-40% למרות CTR גבוה — בעיה ב-landing page, לא במודעה."
✓ "קמפיין טריות עם הכותרת 'נקלה ונשלח היום' יכול להכפיל את ה-CTR הנוכחי."
✗ "הקמפיין הינו בעל ביצועים שאינם מספקים" — עברית מתה. NEVER.
✗ "מומלץ לבחון אפשרות של שיפור" — ריק ולא אומר כלום. NEVER.
✗ "יש לציין כי" / "יש לקחת בחשבון" / "כמו כן" — לא כותבים ככה. NEVER.

=== כללי כתיבת CAPTION ב-posts_to_publish (חובה — חרוג מהם = שגיאה) ===

🎯 **חוק ה"הבטחה-משלוח"** — אם ה-hook או ה-topic מבטיחים תוכן ספציפי ("3 סיבות", "5 טעויות", "סוד אחד", "מדריך מהיר", "תגלית מפתיעה", "ההבדל בין X ל-Y"), הקאפשן **חייב לספק את ההבטחה במלואה**. אסור לסיים את הקאפשן בלי לפרט את כל הסיבות/הטעויות/הצעדים. הקורא שעצר על הפוסט בגלל הכותרת — צריך לצאת עם הערך שהובטח לו, ולא רק עם השאלה שחזרה על עצמה.

  ✗ אסור (תקלה אמיתית מהשטח): hook "3 סיבות שלא ידעת" + caption "🤔 למה הקפוצ'ינו שלך לא דומה לזה בבית קפה? 3 סיבות שלא ידעת" — חוזר על השאלה, **לא עונה**. הקורא יוצא מתוסכל.
  ✓ מותר: hook "3 סיבות" + caption:
        "לא המכונה. לא החלב. זה משהו אחר.

         1. טריות הפולים — אחרי 30 יום מהקלייה הפול מאבד 50% מהארומה. בבית קפה הפול נטחן 30 שניות לפני השוט.
         2. יחס חלב-קפה — בבית קפה זה 1:2 (אספרסו לחלב), בבית רוב האנשים שמים יותר חלב.
         3. טמפרטורת החלב — 60–65°C ולא 75°C. חלב חם מדי שורף את הטעם.

         פולים שנקלו השבוע: minuto.co.il"

📏 **אורך הקאפשן**: 300–800 תווים. קצר מ-300 = לא מספק ערך (קופי "טיזר" שמתעלם מההבטחה). ארוך מ-800 = נחתך ב-IG ב-"...more". יוצא דופן יחיד: behind_the_scenes רגוע יכול לרדת ל-150–300 תווים כי לא מבטיח רשימה — מספר סיפור אווירה. save ו-share חייבים את האורך.

מבנה מומלץ של caption טוב (לא מחייב אבל עובד):
  שורה 1 — hook קצר שחוטף את הקורא (גרסה ויראלית של הכותרת)
  [שורה ריקה]
  גוף — התשובה/הרשימה/ההסבר במלואו (זה ה"משלוח" של ההבטחה)
  [שורה ריקה]
  CTA — קישור או הזמנה ספציפית (למשל: "פולים טריים מהשבוע: minuto.co.il/shop")

🚫 **קוד הקאפשן — האשטגים הם שדה נפרד, לא חלק מהטקסט**:
  המערכת מרכיבה את הפוסט הסופי כך: **caption** + שורה ריקה + **hashtags.join(' ')**.
  לכן **אסור** לשתול האשטגים בתוך מחרוזת ה-caption — זה גורם להאשטגים להופיע **פעמיים** בפוסט הסופי (פעם בתוך הטקסט, פעם אחרי). נראה ספאמי וחאפרי.

  ✗ אסור: caption: "🤔 למה הקפוצ'ינו שלך לא דומה לזה... #קפה #מינוטו #קפוצינו" (האשטגים שתולים בקאפשן)
  ✓ מותר: caption: "🤔 למה הקפוצ'ינו שלך לא דומה לזה בבית קפה? ..." (בלי האשטגים) | hashtags: ["#קפה", "#מינוטו", "#קפוצינו", "#קפהביתי", "#אספרסו", "#specialtycoffee"]

ה-caption צריך לעמוד לבדו כטקסט עברי שוטף, **בלי שום סולמית בתוכו**. כל ההאשטגים — רק במערך hashtags.

📋 **כמות האשטגים**: 6–10 בערבוב של רחבים (#קפה #ספשלטי), נישתיים (#קפהבבית #פולי_קפה), ומותגיים (#מינוטו). לא פחות מ-5, לא יותר מ-12.

⛔⛔⛔ **כללי עברית קשיחים ל-caption** (גוברים על כל דבר אחר; חרוג = הקאפשן נדחה) ⛔⛔⛔

1. **אפס מקפים כתחליף לפסיק**. אסור em-dash (—), אסור en-dash (–), אסור " - " (רווח-מקף-רווח). זה הסימן הכי בולט של תרגום AI לעברית — קוראים ישראלים מזהים אותו בשנייה. במקום, השתמש בפסיק, נקודה, או מילת קישור ("כי", "זאת אומרת", "כלומר", "בקיצור"). מקפים מותרים רק בתחיליות עבריות (ב-, ל-, מ-, ה-, ש-) ובמילים מורכבות צמודות (בלי רווחים סביבן).
   ✗ אסור: "האמת פשוטה יותר — ומרגיזה קצת"
   ✓ מותר: "האמת פשוטה יותר, ומרגיזה קצת" או "האמת פשוטה יותר. ומרגיזה קצת."

2. **גוף שני — תמיד רבים מכלילים (אתם/לכם/שתיתם/חזרתם/זכרתם)**, או נטרל לגמרי (מבנה ללא פנייה ישירה). אסור גוף שני יחיד-זכר (אתה / לך / שתית / חזרת / זכרת / נשבר). אנחנו פונים לכל הקהל — גברים, נשים, כולם.
   ✗ אסור: "שתית קפה בנאפולי וחזרת הביתה נשבר?"
   ✓ מותר: "שתיתם קפה בנאפולי וחזרתם הביתה אכזבה?" או נייטרלי: "מי שטס לנאפולי וחזר מאוכזב מהקפה בבית, מכיר את התחושה."
   ✗ אסור: "הקפה שזכרת"
   ✓ מותר: "הקפה שזכרתם" או "הקפה שנשאר בזיכרון"

3. **"כל מי ש..." → "כל אלו ש..."** (או נסח מחדש). הביטוי "מי ש..." הוא תבנית AI מובהקת בעברית; אלו ש... זורם טבעי.
   ✗ אסור: "כל מי שחזר מטיול עם 'הקפה שם היה אחר'"
   ✓ מותר: "כל אלו שחזרו מטיול עם 'הקפה שם היה אחר'"

4. **התאמת מין בין שם-עצם לתואר-שלו**. כל תואר חייב להתאים במין ובמספר לשם העצם שלו. אם אתה לא בטוח — בדוק לפני שאתה שולח.
   ✗ אסור: "הקפה שלך טעם אחרת" (טעם זכר, אחרת נקבה — שגיאת התאמה)
   ✓ מותר: "הקפה שלכם טעמו אחר" (טעם זכר → אחר זכר) או אדוורבי: "הקפה שלכם טועם אחרת" (כאן אחרת = adv., not adj.)
   ✗ אסור: "סיום נקייה ורעננה" (סיום זכר, נקייה/רעננה נקבה)
   ✓ מותר: "סיומת נקייה ורעננה" (סיומת נקבה → נקייה/רעננה נקבה) — "סיומת" היא המילה הנכונה לאפטר-טייסט.
   ✗ אסור: "ממתקת בפה" ("ממתקת" זה פועל, לא תכונה)
   ✓ מותר: "מתיקות עדינה בפה"

5. **בלי clichés של AI עברי**: "ללא ספק", "חשוב לציין", "כמובן", "בסופו של דבר", "ניתן לומר", "מעניין לציין", "יש לציין", "בהחלט", "בואו נדבר על", "לסיכום", "כדאי לדעת", "חשוב להבין". אם אתה מרגיש דחף לכתוב אחת מאלה — חתוך והתחל את המשפט ישירות.

6. **מובילים את מה שהקורא מרגיש, לא את המנגנון שמאחור**. הוובר טמפרטורה / יחס / קלייה הם הסבר; הקפה הטעים / השוט שזכרתם / הסיומת שנמשכת הם החוויה. תפתח עם החוויה.

7. **בלי ביוש הקונה (CUSTOMER-SHAMING)** — אסור להפנות את הקורא לבדוק את השקית שלו עכשיו, את התאריך שלו, את הציוד שלו. גם אם המטרה חינוכית, זה גורם לקורא להרגיש שטעה בקנייה הקודמת. במקום: דבר על מינוטו בחיוב, לא על הקיים בשלילה.
   ✗ אסור: "בדקו את השקית שנמצאת אצלכם עכשיו, יש עליה תאריך?"
   ✗ אסור: "תסתכלו על הקפה שאתם שותים היום"
   ✓ מותר: "בשקיות של מינוטו תמצאו תאריך קלייה בולט. פולים שנקלו השבוע מריחים אחרת."

8. **בלי לעג להבטחות של שקיות אחרות**. גם בלי שם מותג ספציפי, לעג ל-"100% ערביקה", "איכות פרימיום", "קלייה איטלקית" מבייש קונים שקנו שקיות כאלה ושולח אותם להגן על הבחירה במקום להקשיב.
   ✗ אסור: "'100% ערביקה' נהדר, גם פול שנקלה לפני שנה הוא ערביקה"
   ✗ אסור: "'איכות פרימיום' לא אומר כלום"
   ✓ מותר: ספר ישירות מה כן חשוב ("מה חשוב באמת בשקית קפה: תאריך קלייה.") בלי לפסול את ההבטחות של אחרים.

9. **כתוב בעברית, לא Hebrew-English mix**. אם מילה אנגלית התגנבה ("ה-ingredient", "ה-flavor", "ה-process"), החלף לעברית ("המרכיב", "הטעם", "התהליך"). יוצאים מן הכלל: שמות מותג Minuto, מילות מפתח SEO ספציפיות שמופיעות כפי שהן בעולם (V60, Airscape, latte art). תפקיד ה-caption הוא לזרום כעברית.
   ✗ אסור: "תאריך קלייה הוא ה-ingredient הכי חשוב"
   ✓ מותר: "תאריך קלייה הוא המרכיב הכי חשוב"

⛔ לפני שאתה מחזיר caption, בצע סריקה עצמית של 5 שניות: יש לי em-dash או " - " איפשהו? יש לי אתה/שתית/חזרת? יש לי "כל מי ש..."? יש לי התאמת מין שבורה? יש לי "בדקו את השקית שלכם"? יש לי לעג להבטחות של מתחרים? יש לי מילה אנגלית אמצע משפט עברי? אם כן, חזור ותקן.`;

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
עוקבים: ${followerStr}
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

=== היסטוריית המלצות תוכן קודמות — למד מהן ===
${pastReportsOrganic}
בדוק: איזה תוכן המלצת בעבר → מה הביצועים בפועל (reach, saves, likes בנתוני הפוסטים). תוכן שעבד — חזור לנוסחה. תוכן שלא עבד — נסה זווית אחרת.
${completedActions}

=== 📚 פוסטים שכבר פורסמו ב-minuto.co.il/blog (${(existingBlogPosts ?? []).length} פוסטים) ===
${(existingBlogPosts ?? []).length > 0
  ? (existingBlogPosts ?? []).map((p: any) => {
      const when = p.published_at ? new Date(p.published_at).toISOString().split("T")[0] : "";
      return `  • ${p.title}${when ? ` (${when})` : ""}\n    ${p.url}`;
    }).join("\n")
  : "  (אין רשימה זמינה — ייתכן שה-RSS לא הצליח לטעון)"}

🚫 **אסור לחלוטין להמליץ על פוסט עם נושא שכבר פורסם**. לפני שאתה מחזיר google_organic_recommendations, בדוק את הרשימה למעלה. אם הנושא שאתה עומד להמליץ עליו כבר שם (אפילו בזווית דומה) — אל תחזיר אותו. במקום זאת:
  ✓ בחר נושא שונה מהותית שלא פורסם
  ✓ או הצע עדכון/הרחבה של פוסט קיים ("update X with 2026 data") — אבל רק אם יש סיבה אמיתית (מידע שהשתנה, לא סתם בדיוק אותו דבר)
  ✗ **לעולם לא** להחזיר כותרת זהה או כמעט-זהה לפוסט שכבר מופיע ברשימה.

🚫 **אסור להחזיר שאילתה גולמית כ-suggested_title**. נתוני Serper מספקים שאילתות חיפוש גולמיות (לדוגמה "האם פולים ישנים בטוחים לשתייה" או "ריח כימי בקפה מחדש שקניתי") — אלה לא כותרות מאמר. כותרת מאמר טובה היא:
  ✓ מנוסחת כהבטחה לקורא, לא כשאלה גולמית
  ✓ ספציפית ומכילה מספר/רשימה כשרלוונטי
  ✓ כוללת ערך מוסף שלא קיים בשאילתה (זווית מומחה, השוואה, מדריך)

  גרוע: "האם פולים ישנים בטוחים לשתייה או מסוכנים"
  טוב:  "פולים בני 6 חודשים — לזרוק או לשמור? המדריך המלא לטריות קפה"

  גרוע: "קפה מטחון נראה חום מדי זה בסדר"
  טוב:  "מדוע קפה טחון נראה כהה מדי? מדריך לזיהוי קלייה איכותית VS שרופה"

  גרוע: "ריח כימי בקפה מחדש שקניתי"
  טוב:  "ריח כימי בקפה: 3 סיבות אפשריות וכיצד לזהות בעיה אמיתית מול קלייה צעירה"

השאילתה הגולמית = הכוונה. הכותרת = הניסוח שלך כעורך.

🌉 **גשר ציוד ↔ פולים — עיקרון אסטרטגי כללי לכל המלצות התוכן**:

נושאים על ציוד (מכונות אספרסו, מטחנות, שיטות חליטה, פילטרים, ניקיון, תחזוקה) הם מהמילות המפתח עם הנפח הכי גבוה והכוונה הכי גבוהה — אבל הקונה הוא חד-פעמי (קנה מכונה = לא יחזור לקנות עוד אחת). **קונה פולים הוא חוזר לכל החיים**. כל הזדמנות תוכן שמגיעה לקהל ציוד חייבת לארוג חוט של פולים — אחרת LTV מבוזבז.

**העיקרון חל על כל שדה תוכן** — לא רק blog (google_organic_recommendations) אלא גם:
  • content_recommendations (אינסטגרם reels / posts / stories)
  • posts_to_publish (פוסטים שאמורים להתפרסם)
  • products_to_feature (מוצרים להבליט)

⚡ **דרישה קשיחה — לפחות פריט גשר אחד בכל ריצה, ללא יוצא מן הכלל**:

בכל ריצה של organic_content, **חובה** לכלול לפחות:
  ✓ פריט אחד ב-google_organic_recommendations שהוא נושא ציוד עם חוט פולים
  ✓ פריט אחד ב-content_recommendations עם זווית ציוד↔פולים (reel/post/story)

זה לא "מומלץ", זה "חובה". גם אם אין מילת מפתח ציוד בנתוני GSC השבוע. גם אם הנתונים מצביעים על נושאים אחרים. הסיבה: ציוד = LTV מולטיפלייר, ובלי דחיפה אסטרטגית הסוכן יבחר תמיד בלונג-טייל הקל. תפקידך לאזן — תמיד לפחות פריט ציוד אחד.

נושאי ציוד שתמיד רלוונטיים גם בלי GSC signal: מכונות אספרסו ביתיות, מטחנות (ידניות/חשמליות), V60/אירופרס/צרפתי, WDT tools, ניקיון מכונות, טמפרים, פילטרים, סקיילים, תרמומטרים. קח אחד מאלה אם הנתונים שותקים.

**כשנושא ציוד עולה אורגנית** (במילת מפתח GSC, בשאלה ב-DM, בעניין של עוקבים, בטרנד עונתי), **חובה** לכלול אותו. הזווית לא מכירתית — היא **הגנת ההשקעה** או **פתיחת הפוטנציאל**:

  ✓ "המכונה לא תפצה על פולים גרועים" (הגנת ההשקעה)
  ✓ "מטחנה איכותית פלוס פולים סטיילים = מה שהמכונה יכלה תמיד לעשות" (פתיחת פוטנציאל)
  ✓ "פילטר V60 חושף איכות של פולים שאספרסו מסתיר" (חיבור שיטה-פולים)
  ✗ לא: "קנה את הפולים שלנו!" (מכירה ישירה)
  ✗ לא: תוכן ציוד בלי שום אזכור של פולים (LTV מבוזבז)

חלוקה: 70-80% מענה לשאלה הציודית של הגולש + 20-30% חוט שמסביר למה פולים ספשלטי הם החצי השני של המשוואה. סיום עם CTA לקטלוג הפולים שלנו.

**דוגמאות מסוגי תוכן שונים — לפחות אחד מהם בכל ריצה:**

Blog (google_organic_recommendations):
  • "מדריך מכונת אספרסו ביתית: מה לקנות + איך להוציא ממנה את המקסימום"
  • "מטחנת קפה ידנית VS חשמלית — מה באמת משנה?" (השוואה בין סוגי ציוד = OK; השוואה למתחרה / לסופרמרקט = אסור)
  • "V60 VS אירופרס VS צרפתי + איזה פולים לכל שיטה"

Instagram (content_recommendations / posts_to_publish):
  • Reel: "5 טעויות שמורידות את איכות האספרסו שלך" — נסח כל טעות כעצה חיובית, לא כביקורת. למשל: "טעות 1 — חלב רותח: בעצם מספיק 60-65 מעלות". לא: "1. חלב מהסופר זה הבעיה".
  • Post: "ככה נראה אספרסו עם פולים שנקלו השבוע" — תכל'ס חיובי, ללא השוואה.
  • Story: זום אקסטרים על תאריך הקלייה של מינוטו, פולים מבריקים בצד. ללא לפני/אחרי, ללא "השקית הקודמת שלכם".
  • BTS: "ככה נראים פולים ביום הקלייה" — ללא ההשוואה ל"אחרי חודש פתוחים".

⛔ אסור מוחלט (משתי סיבות: brand voice + Haiku מסרב):
  ✗ "המכונה שלך + פולים מהסופר = …" — השוואה לסופר, גם בלי שם מתחרה
  ✗ "השקית שלכם vs השקית שלנו" — מציב את הקונה במקום לא נעים
  ✗ "טעות #1: אתם משתמשים ב-X מהסופר" — מאשים את הצרכן
  ✗ "מכונה מלוכלכת" כמסר ראשי — נשמע כביקורת על תחזוקה של הקונה
  ✗ Lavazza / Illy / Nespresso / Starbucks / נחת / Jera / אגרו / Origem בכותרת או בויז'ואל
  ✓ במקום: empowerment ("ככה נראה הדבר האמיתי", "נהדר ל-V60", "מה שהמכונה שלך יודעת לעשות עם פולים טריים")

Products (products_to_feature):
  • כשמרגישים שעוקבים מתחילים לדבר על ציוד — להבליט מארז שמתאים למכונת אספרסו ספציפית
  • לקשר תיאור פולים לשיטת חליטה ("נהדר ל-V60", "אופטימלי לאספרסו")

🔗 **products_to_mention — חובה לכל המלצת בלוג, מינימום 2 פריטים**:

לכל פריט ב-google_organic_recommendations חובה לבחור **לפחות 2 (ועד 4)** מוצרים מהקטלוג של Minuto. ה-pipeline משתמש בשמות האלה לשני דברים:
  1. כתב הבלוג שולף את ה-permalink מ-woo_products ויוצר לינקים markdown לחנות
  2. יוצר הבאנר טוען את תמונת המוצר → הבאנר מציג את הציוד/השקית הרלוונטיים, לא דיפולט גנרי

⛔ **רשימה ריקה אסורה. אין תוכן בלוג בלי לינקים למוצרים.** גם נושאים כלליים ("חנות קפה", "טריות", "ספשלטי") חייבים להזכיר מוצרים — כל בלוג בלי לינקים = בלוג מבוזבז.

**כללים קשיחים**:
  ✓ השמות חייבים להיות מילה במילה כפי שמופיעים בקטלוג Minuto למעלה (מלאי + קטלוג ציוד) — אחרת השאילתה WHERE name IN (...) תחזיר ריק והלינק יושמט
  ✓ נושא ציוד עם חוט פולים: כלול **גם** את שם הציוד **וגם** 2-3 שמות פולים
  ✓ נושא פולים בלבד: 2-4 שמות פולים מהמלאי. עדיפות למלאי נמוך (push לפני שאוזל) ולפולים שמתאימים לזווית הפוסט (V60 → איכויות עדינות; אספרסו → גוף עשיר)
  ✓ נושא כללי (חנות, טריות, איכות, יבוא, ספשלטי) — בחר 2-3 פולים בולטים מהמלאי כדוגמאות קונקרטיות לתמוך בטיעון של המאמר
  ✗ אל תמציא שמות שלא בקטלוג. אם שם לא מופיע מילה-במילה ברשימת המלאי או בקטלוג הציוד למעלה — אל תכתוב אותו

החזר JSON בדיוק מבנה זה (ללא שדות נוספים):
{
  "summary": "2 משפטים בלבד",
  "account_health": {
    "avg_reach_30d": ${avgReach(posts)},
    "follower_count": ${followerCount},
    "best_post_type": "reel|post|story",
    "engagement_rate_pct": ${avgEng(posts)}
  },
  "google_organic_recommendations": [
    {
      "keyword": "מילת מפתח מ-GSC",
      "current_position": 8.5,
      "search_volume_signal": "X חשיפות ב-GSC / נפח גבוה|בינוני|נמוך",
      "content_type": "blog_post|landing_page|product_page|faq_page",
      "suggested_title": "כותרת H1 מוצעת",
      "key_points": ["נקודה 1", "נקודה 2"],
      "why_now": "למה לכתוב את זה עכשיו — משפט אחד",
      "estimated_difficulty": "קל|בינוני|קשה",
      "products_to_mention": ["שם מוצר מילה-במילה מהקטלוג", "..."]
    }
  ],
  "content_recommendations": [
    {
      "priority": 1,
      "content_type": "reel|post|story",
      "topic": "נושא ספציפי",
      "reason": "למה עכשיו — משפט קצר",
      "best_day": "ראשון|שני|שלישי|רביעי|חמישי|שישי",
      "best_time": "09:00"
    }
  ],
  "products_to_feature": [
    {
      "product": "שם מוצר",
      "reason": "low_stock_urgency|new_batch|bestseller",
      "content_angle": "זווית קצרה"
    }
  ],
  "posts_to_publish": [
    {
      "type": "post",
      "intent": "save|share|behind_the_scenes",
      "topic": "נושא הפוסט",
      "best_day": "ראשון",
      "best_time": "09:00",
      "caption": "כיתוב מלא 300–800 תווים (BTS יכול 150–300). חייב לקיים את הבטחת ה-hook/topic — אם נאמר '3 סיבות', פרט את 3 הסיבות. ⛔ ללא האשטגים בתוך הטקסט (שדה hashtags נפרד מאוחה אוטומטית). ראה כללי כתיבת CAPTION למעלה.",
      "hashtags": ["#קפה", "#מינוטו", "#ספשלטי", "#קפה_טרי", "#פולי_קפה", "#קפהבבית"],
      "hook": "משפט פתיחה קצר — רעיון פנימי לכותרת/וויז'ואל, לא יפורסם",
      "visual_direction": "הנחיה קצרה למצלם (single hero frame; NO multi-slide carousels, NO reels, NO stories)",
      "why_this_intent": "למה זה save/share/BTS — משפט אחד"
    }
  ],
  /* TEMPORARY: type is LOCKED to "post" for every post in posts_to_publish.
     Carousels and reels are temporarily disabled pending visual-pipeline
     quality work (bag compositing in progress, machine rendering needs
     more iteration). Until further notice, every entry in posts_to_publish
     MUST be a single-image feed post (type:"post"). Do NOT emit
     type:"carousel", type:"reel", or type:"story" here — those will be
     filtered out downstream and the run will be short on content.
     content_recommendations may still suggest reels/stories as ideas,
     but posts_to_publish is single-image only for now. */
  "key_insights": ["תובנה 1", "תובנה 2"]
}`;

  const finalMessage = focus
    ? userMessage // Focus is already injected at the TOP of the system prompt
    : userMessage;

  console.log(`[organic] Calling Claude (${MODEL_ORGANIC})...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ORGANIC, systemPrompt, finalMessage);
  const parsed = parseClaudeJson(text) as any;
  console.log(`[organic] Done. Tokens: ${inputTokens + outputTokens}`);

  // Normalize posts_to_publish intents. Model likes to return its own
  // categorization ("promote_product", "educate", "engage") even when the
  // prompt demands save|share|behind_the_scenes. Map them, then enforce
  // exactly one post per canonical intent.
  if (parsed && Array.isArray(parsed.posts_to_publish)) {
    const canonicals = new Set(["save", "share", "behind_the_scenes"]);
    const legacyMap: Record<string, "save" | "share" | "behind_the_scenes"> = {
      educate:         "save",
      tutorial:        "save",
      how_to:          "save",
      guide:           "save",
      promote_product: "share",
      promotion:       "share",
      engage:          "share",
      announcement:    "share",
      behind_scenes:   "behind_the_scenes",
      bts:             "behind_the_scenes",
      story:           "behind_the_scenes",
    };
    for (const p of parsed.posts_to_publish) {
      const cur = String(p.intent ?? "").toLowerCase().trim();
      if (canonicals.has(cur)) continue;
      const mapped = legacyMap[cur];
      if (mapped) {
        console.log(`[organic] remapped intent "${cur}" → "${mapped}"`);
        p.intent = mapped;
      } else {
        // Unknown intent — default to behind_the_scenes so something shows
        console.log(`[organic] unknown intent "${cur}" → default "behind_the_scenes"`);
        p.intent = "behind_the_scenes";
      }
    }
    // De-duplicate by intent — keep first occurrence of each canonical intent
    const seen = new Set<string>();
    parsed.posts_to_publish = parsed.posts_to_publish.filter((p: any) => {
      if (seen.has(p.intent)) return false;
      seen.add(p.intent);
      return true;
    });
    // TEMPORARY: lock posts_to_publish to single-image feed posts only.
    // Carousels and reels are disabled pending visual-pipeline quality
    // work (bag compositing under iteration). Defense-in-depth — if the
    // strategist's prompt change doesn't fully hold and a carousel/reel
    // slips through, coerce it to a single-image post here. Caption +
    // visual_direction stay; downstream enrichment writes one scene_brief.
    for (const p of parsed.posts_to_publish) {
      if (p.type && p.type !== 'post') {
        console.log(`[organic] forcing type "${p.type}" → "post" (carousels/reels temporarily disabled)`);
        p.type = 'post';
      }
    }

    // Hebrew caption sanitizer — deterministic regex strip. The prompt
    // rule against em-dashes / " - " keeps failing in the wild (model
    // emits them anyway, especially after parentheticals), so we belt-
    // and-suspenders here exactly like runBlogWriterAgent does for the
    // blog body. Caption ships to IG; bad dashes are unrecoverable post-
    // publish. Same character class as the blog writer (kept in sync).
    // PRESERVED: Hebrew prefix hyphens (ב-/ל-/מ-) and standalone "- "
    // bullets (no leading space).
    for (const p of parsed.posts_to_publish) {
      if (typeof p.caption !== 'string' || p.caption.length === 0) continue;
      const before = p.caption;
      p.caption = before
        .replace(/—/g, ',')   // em-dash
        .replace(/–/g, ',')   // en-dash
        .replace(/‒/g, ',')   // figure dash
        .replace(/―/g, ',')   // horizontal bar
        .replace(/‐/g, '-')   // unicode hyphen → ASCII hyphen
        .replace(/‑/g, '-')   // non-breaking hyphen → ASCII hyphen
        .replace(/ -- /g, ', ')    // " -- "
        .replace(/ - /g, ', ');    // " - " (the big AI tell)
      if (p.caption !== before) {
        console.log(`[organic] caption dash-cleanup applied (intent=${p.intent})`);
      }
    }
  }

  // ── Post-process: filter out recommendations too similar to existing posts ──
  // The in-prompt self-check is too soft — agent's "nearly-identical" threshold
  // differs from ours. Deterministic filter: for each recommendation, if its
  // suggested_title OR keyword overlaps heavily with any existing post, drop it.
  if (parsed && Array.isArray(parsed.google_organic_recommendations) && existingBlogPosts) {
    const original = parsed.google_organic_recommendations;
    const filtered = filterDuplicateRecommendations(original, existingBlogPosts);
    if (filtered.length < original.length) {
      console.log(`[organic] Filtered ${original.length - filtered.length} duplicate recs`);
    }

    // If the filter killed everything (or agent had nothing to begin with),
    // fall back to novel_keywords from the research phase. Those are problem/
    // question/pain-based long-tail queries — very unlikely to overlap with
    // existing broad SEO posts, and they already validated commercial demand.
    if (filtered.length === 0) {
      console.log(`[organic] No GSC recs survived filter — falling back to novel_keywords`);
      const { data: novelRow } = await supabase
        .from("market_research")
        .select("raw_data, research_date")
        .eq("source", "novel_keywords")
        .order("research_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Pull done/skipped actions so we don't re-suggest things the owner
      // already acted on. The prompt-level check doesn't catch this because
      // the fallback is a deterministic post-processor that bypasses Claude.
      const doneRows = await fetchCompletedActionRows(supabase);
      const doneKeywordFragments = doneRows
        .map(r => {
          // action_id format: "org::seo::<keyword>" or similar
          const idKeyword = (r.action_id || "").split("::").pop() ?? "";
          // action_label format: 'כתוב תוכן ל-"<keyword>"' or the headline
          const labelMatch = (r.action_label || "").match(/"([^"]+)"/);
          const labelKeyword = labelMatch ? labelMatch[1] : "";
          return [idKeyword, labelKeyword, r.action_label || ""].filter(Boolean);
        })
        .flat()
        .map(s => s.trim().toLowerCase())
        .filter(s => s.length >= 5);

      const isAlreadyHandled = (keyword: string): boolean => {
        const lc = (keyword || "").trim().toLowerCase();
        if (!lc) return false;
        // Exact match or substring match either direction
        return doneKeywordFragments.some(frag =>
          frag.includes(lc) || lc.includes(frag)
        );
      };

      const novelList = ((novelRow as any)?.raw_data?.with_paid_demand ?? []) as Array<{ keyword: string; shopping_count: number; top_advertiser?: string }>;

      // Drop novel keywords that were already marked done/skipped before
      // we even build the synthetic recs. Logs each drop for visibility.
      const usable = novelList.filter(n => {
        // Drop any novel keyword with replacement chars — legacy rows from
        // before the encoding-damage filter was in place may still contain
        // "ksp ??? ????"-style broken Hebrew that we don't want to recommend.
        if (hasEncodingDamage(n.keyword ?? "")) {
          console.log(`[organic] skipping encoding-damaged keyword: ${JSON.stringify(n.keyword)}`);
          return false;
        }
        if (isAlreadyHandled(n.keyword)) {
          console.log(`[organic] skipping already-handled novel keyword: "${n.keyword}"`);
          return false;
        }
        return true;
      });

      // Take top candidates BEFORE constructing recs — we'll send these
      // to Claude to reformulate as proper article titles. Without this
      // step the raw Serper query was being stuffed directly into
      // suggested_title (e.g. "קפה מטחון נראה חום מדי זה בסדר" — a
      // search query, not a headline) and every rec got identical
      // boilerplate key_points. Owner caught all 3 fallback recs with
      // raw queries on a single run after PR #50; that fix never fired
      // because Claude wasn't being called at all on the fallback path.
      const topCandidates = usable.slice(0, 5);

      // Reformulate via a focused Claude call: raw query → article
      // title + 3 custom key_points per query. Small/cheap call,
      // typically 1-2k tokens total. If it fails, fall back to the
      // raw-keyword-as-title behavior so the agent never returns empty.
      let reformulated: Record<string, { title: string; key_points: string[] }> = {};
      try {
        const refinePrompt = `אתה עורך תוכן של בית קלייה ספשלטי בישראל. קיבלת רשימה של שאילתות חיפוש גולמיות מ-Serper. עבור כל שאילתה — נסח אותה מחדש ככותרת מאמר טובה (לא כשאלה גולמית!) וכתוב 3 נקודות מפתח ספציפיות לתוכן.

כללים לכותרת:
✓ מנוסחת כהבטחה לקורא, לא כשאלה גולמית
✓ ספציפית, מכילה מספר/רשימה כשרלוונטי
✓ מוסיפה ערך מומחה שלא קיים בשאילתה הגולמית

דוגמאות:
שאילתה: "האם פולים ישנים בטוחים לשתייה או מסוכנים"
כותרת: "פולים בני 6 חודשים — לזרוק או לשמור? המדריך המלא לטריות קפה"

שאילתה: "קפה מטחון נראה חום מדי זה בסדר"
כותרת: "מדוע קפה טחון נראה כהה מדי? מדריך לזיהוי קלייה איכותית VS שרופה"

שאילתות לעיבוד:
${topCandidates.map((c, i) => `${i + 1}. ${c.keyword}`).join("\n")}

החזר JSON בדיוק במבנה הזה (ללא טקסט נוסף):
{
  "items": [
    {
      "original_query": "השאילתה הגולמית",
      "title": "כותרת מאמר ראויה",
      "key_points": ["נקודה ספציפית 1", "נקודה ספציפית 2", "נקודה ספציפית 3"]
    }
  ]
}`;
        const { text: refineText } = await callClaude(MODEL_ORGANIC, "אתה עורך תוכן מקצועי. החזר JSON תקף בלבד.", refinePrompt);
        const refineParsed = JSON.parse(refineText.replace(/^```(json)?|```$/gm, "").trim());
        for (const item of (refineParsed.items ?? [])) {
          reformulated[item.original_query] = {
            title: item.title,
            key_points: item.key_points,
          };
        }
        console.log(`[organic] Reformulated ${Object.keys(reformulated).length}/${topCandidates.length} fallback queries via Claude`);
      } catch (e) {
        console.warn(`[organic] Reformulation call failed, using raw queries:`, (e as Error).message);
      }

      const candidateRecs = topCandidates.map(n => {
        const refined = reformulated[n.keyword];
        return {
          keyword:              n.keyword,
          suggested_title:      refined?.title ?? n.keyword,
          content_type:         "blog_post",
          current_position:     0,
          estimated_difficulty: "קל",
          why_now:              `שאילתה עם ${n.shopping_count} מפרסמי שופינג ב-Serper — ביקוש מסחרי אמיתי שמינוטו לא מכסה עדיין. long-tail, תחרות נמוכה.`,
          key_points: refined?.key_points ?? [
            `תן תשובה ישירה וברורה לשאלה "${n.keyword}" במשפט הראשון`,
            "הבא חוויה אישית מבית הקלייה — לא רק מידע מילוני",
            "קישור פנימי לפולי קפה רלוונטיים שעונים על הצורך",
          ],
          search_volume_signal: `${n.shopping_count} מפרסמי שופינג פעילים`,
        };
      });
      // Apply the dup filter to the fallback (belt and suspenders against blog posts)
      const cleanFallback = filterDuplicateRecommendations(candidateRecs, existingBlogPosts).slice(0, 3);
      parsed.google_organic_recommendations = cleanFallback;
      parsed._fallback_source = "novel_keywords";
      console.log(`[organic] Fallback added ${cleanFallback.length} novel-keyword recs (${novelList.length - usable.length} dropped for prior completion)`);
    } else {
      // Even when GSC recs survive, cross-check against done actions
      const doneRows = await fetchCompletedActionRows(supabase);
      const doneText = doneRows.map(r => `${r.action_id} ${r.action_label || ""}`).join(" ").toLowerCase();
      const stillFresh = filtered.filter((rec: any) => {
        const kw = (rec.keyword || "").trim().toLowerCase();
        if (kw && doneText.includes(kw)) {
          console.log(`[organic] dropping GSC rec already completed: "${rec.keyword}"`);
          return false;
        }
        return true;
      });
      parsed.google_organic_recommendations = stillFresh;
    }
  }

  // ── Brand-voice preflight (deterministic regex, no LLM) ────────────────
  // The strategist sometimes emits posts that violate brand-voice rules
  // (competitor disparagement, supermarket comparison, customer mockery)
  // despite the prompt forbidding them. We catch those here, BEFORE the
  // expensive enrichment + visual-test pipeline runs on doomed content.
  // Single source of truth — Haiku no longer rejects (see enrichment.ts);
  // any rule that needs to be enforced lives here as a regex.
  if (parsed && Array.isArray(parsed.posts_to_publish) && parsed.posts_to_publish.length > 0) {
    const COMPETITOR_BRANDS = /\b(lavazza|illy|hausbrandt|nespresso|starbucks|costa coffee|mauro|bristot|kimbo|segafredo|jera|origem|kilimanjaro|nahat|נחת|ג'רה|אגרו|אוריג'ם)\b/i;
    const COMPARISON_KEYWORDS = /(\bvs\b|\blעומת\b|נגד|במקום|better than|לעומת|טוב מ|חזק מ)/i;
    const SUPERMARKET_DISPARAGE = /(שקית מהסופר|פולים מהסופר|קפה מהסופר|מהמדף של|בסופר[\-\s]?פארם|רמי\s*לוי|שופרסל|טיב\s*טעם|המקור הזול|השקית הקודמת)/i;
    const CUSTOMER_MOCKERY = /(אתם לא יודעים|אתם לא בטוחים|הבעיה (?:היא )?(?:אצלכם|שלכם)|אתם משתמשים ב|השקית שלכם.*?לא|המכונה שלכם.*?לא|אתם טועים)/i;
    const filteredPosts: any[] = [];
    const droppedPosts: Array<{ topic: string; reason: string }> = [];
    for (const p of parsed.posts_to_publish) {
      const blob = `${p.topic ?? ''} ${p.hook ?? ''} ${p.caption ?? ''} ${p.visual_direction ?? ''} ${p.why_this_intent ?? ''}`.toLowerCase();
      let dropReason: string | null = null;
      if (COMPETITOR_BRANDS.test(blob) && COMPARISON_KEYWORDS.test(blob)) {
        dropReason = 'competitor brand + comparison keyword';
      } else if (SUPERMARKET_DISPARAGE.test(blob)) {
        dropReason = 'supermarket disparagement framing';
      } else if (CUSTOMER_MOCKERY.test(blob)) {
        dropReason = 'customer mockery pattern';
      }
      if (dropReason) {
        console.warn(`[organic preflight] dropped "${p.topic ?? '(untitled)'}" — ${dropReason}`);
        droppedPosts.push({ topic: String(p.topic ?? ''), reason: dropReason });
      } else {
        filteredPosts.push(p);
      }
    }
    if (droppedPosts.length > 0) {
      console.log(`[organic preflight] ${droppedPosts.length}/${parsed.posts_to_publish.length} posts dropped for brand-voice violations`);
      // Stamp on the report so we have a record without surfacing the bad
      // posts to the user. The dashboard ignores this field; it's for debug.
      (parsed as any).preflight_dropped = droppedPosts;
    }
    parsed.posts_to_publish = filteredPosts;
  }

  // ── Enrich posts_to_publish with publish-pipeline fields ────────────────
  // Adds `enriched_posts[3]` to the report, where each entry has the
  // photographer-brief, calendar_hook, post_type (SCENE_PRESET key),
  // optional Hebrew overlay_text, and ISO scheduled_for. This is what the
  // IG generation pipeline (visual-test → meta-publish prepare/publish)
  // actually consumes — the existing posts_to_publish[] shape stays
  // untouched so the dashboard renderer is unaffected.
  if (parsed && Array.isArray(parsed.posts_to_publish) && parsed.posts_to_publish.length > 0) {
    try {
      const enriched = await enrichPostsForPublishing(parsed.posts_to_publish, seasonalContext, callClaude);

      // Per-post product reference: when Haiku identified a specific Minuto
      // product in the post (e.g. "Dark Chocolate"), look it up in
      // woo_products and stamp the bag image URL so visual-test renders the
      // RIGHT bag instead of always falling back to the default reference.
      // Same pattern blog-banner uses (PR #77).
      //
      // Compound product references like "Velvet Star + Fazenda Sertão" are
      // split into individual candidates — we try each and use the first
      // match. Picking the first is a deliberate choice over picking nothing;
      // the user can manually override later via a per-post bag picker if
      // they want a different product highlighted.
      for (const ep of enriched) {
        if (!ep.product_reference) continue;
        const candidates = ep.product_reference
          .split(/[+,&]|\s+ו(?=\s)|\s+and\s+/gi)
          .map(s => s.trim())
          .filter(s => s.length >= 3);
        let matched: { name: string; image_url: string } | null = null;
        for (const candidate of candidates) {
          try {
            const { data: rows } = await supabase
              .from("woo_products")
              .select("name, image_url")
              .ilike("name", `%${candidate}%`)
              .not("image_url", "is", null)
              .limit(1);
            const m = (rows ?? [])[0];
            if (m?.image_url) {
              matched = { name: m.name as string, image_url: m.image_url as string };
              break;
            }
          } catch (e: any) {
            console.warn(`[organic] product lookup failed for "${candidate}":`, e?.message);
          }
        }
        if (matched) {
          ep.reference_image_url = matched.image_url;
          console.log(`[organic] post ${ep.post_index} → matched "${ep.product_reference}" → ${matched.name}`);
        } else {
          console.log(`[organic] post ${ep.post_index} → no woo_products match for "${ep.product_reference}" (tried: ${candidates.join(' | ')})`);
        }
      }

      // Bag rotation fallback for bag_hero posts (carousels + single posts).
      // Any bag_hero post needs SOME bag — both visual-test (Gemini) and
      // vertex-imagen-edit (bag_hero mode) 400 without a reference. The LLM
      // can emit bag_hero with product_reference=null (a generic brand/
      // "fresh batch" post — no specific SKU but still wants a bag in
      // shot). no_bag posts naturally skip this (no bag wanted; dashboard
      // drops the ref anyway).
      //
      // History: was originally carousel-only; extended 2026-05-23 to
      // bag_hero singles; static flagship default re-replaced with pool
      // rotation 2026-05-24 because the static default produced a feed of
      // 90%+ Yirgacheffe (most LLM-emitted bag_hero posts lack a product
      // match). Rotation seed = sum of weekStart char codes so the same
      // week reproduces; in-run counter advances per fallback so each
      // post in one report gets a distinct bag.
      let bagSeed = 0;
      for (let i = 0; i < weekStart.length; i++) bagSeed += weekStart.charCodeAt(i);
      let bagFallbackIdx = bagSeed;
      for (const ep of enriched) {
        if (ep.render_mode === 'no_bag') continue;
        if (!ep.reference_image_url) {
          const bagUrl = MINUTO_BAG_REFERENCE_POOL[bagFallbackIdx % MINUTO_BAG_REFERENCE_POOL.length];
          bagFallbackIdx++;
          ep.reference_image_url = bagUrl;
          console.log(`[organic] post ${ep.post_index} (${ep.upstream_type}, bag_hero, no product match) → bag rotation: ${bagUrl}`);
        }
      }

      parsed.enriched_posts = enriched;
      console.log(`[organic] enriched ${enriched.length}/${parsed.posts_to_publish.length} posts for publishing`);
    } catch (e: any) {
      // Non-fatal — the rest of the report still renders, we just lose the
      // publish-ready fields for this run. Log and move on.
      console.error("[organic] enrichment failed:", e?.message);
      parsed.enriched_posts = [];
    }
  }

  // NOTE: blog auto-draft + WP push lives in a SEPARATE edge function
  // (`blog-auto-publish`). It reads this report row, calls blog_writer +
  // blog_banner + blog-publish, and PATCHes report.blog_drafted back.
  // Split because the full chain exceeds the 150s edge-runtime cap on a
  // single invocation (research + 3 enrichments + Sonnet blog draft +
  // banner + WP POST). Scheduled by pg_cron ~90min after organic runs.

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ──────────────────────────────────────────────────────────────────────
// PART 2 — generateSceneDescription (extracted from index.ts:5922-5984)
// ──────────────────────────────────────────────────────────────────────

async function generateSceneDescription(title: string, keyword: string): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  // Pick one variation hint at random so the same topic produces different
  // shots across runs — no two Minuto banners look identical.
  const styleHints = [
    "morning window light, warm tones, Scandinavian aesthetic",
    "dramatic side lighting, deep shadows, moody editorial feel",
    "soft overhead light, minimal styling, clean magazine look",
    "close-up macro shot, 100mm lens feel, shallow depth of field",
    "wider establishing shot showing cafe context, 35mm lens feel",
    "steam catching backlight, golden hour warmth",
    "overhead flat-lay composition, wooden board props, artisanal",
    "tight cinematic close-up, restaurant photography style",
  ];
  const pickedStyle = styleHints[Math.floor(Math.random() * styleHints.length)];

  const systemPrompt = `You are a food photographer who shoots for specialty coffee brands. Given a Hebrew blog post title about coffee, write a ONE-paragraph photo brief in English describing a single specific, photographable scene.

Rules:
✓ Be SPECIFIC — exact objects, exact positions, exact lighting. Not "coffee stuff" — "Bialetti Moka pot on induction stove, steam rising from spout, small ceramic cup beside it on wooden board".
✓ Every brief should feel DIFFERENT from other briefs — vary the subject matter, angle, framing. If the post is about brewing → show brewing. About storage → show a coffee bag with date stamp. About machines → show a machine detail. About crema → show crema texture. About problems → show a diagnostic shot.
✓ Apply this style hint: "${pickedStyle}"
✓ Always end with "Shallow depth of field. Photorealistic."

Forbidden:
✗ People, faces, hands, human figures
✗ Text, letters, numbers, logos, watermarks
✗ Vehicles, outdoor scenery, mountains, roads, sky
✗ Generic "coffee beans on wooden table" shots — be topic-specific
✗ AI illustration style — aim for real photography

Return only the brief paragraph, no intro, no explanation.`;

  const userMsg = `Blog post title (Hebrew): "${title}"
Primary keyword: "${keyword}"

Write the photo brief.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? "claude error");
    const brief = (json.content?.[0]?.text ?? "").trim();
    if (brief.length < 40) return null;
    console.log(`[banner] Generated brief (${brief.length} chars) for: "${title.slice(0, 50)}"`);
    return brief;
  } catch (e: any) {
    console.warn("[banner] scene brief generation failed, using fallback:", e?.message);
    return null;
  }
}
