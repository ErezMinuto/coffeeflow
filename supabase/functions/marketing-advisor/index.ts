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

// Haiku: fast enough (15-25s), same model used by generate-campaign
const MODEL_ADS     = "claude-haiku-4-5-20251001";
const MODEL_ORGANIC = "claude-haiku-4-5-20251001";

// ── Business Brief (injected into every agent prompt) ─────────────────────────
const BUSINESS_BRIEF = `
=== העסק: Minuto Coffee ===
מה אנחנו: בית קלייה ספשלטי ברחובות, פעיל מעל 10 שנים. קולים קפה בעצמנו ומוכרים ישירות.

מקור הרווח הראשי — פולי קפה:
• מייצרים ומוכרים פולי קפה קלויים טרי — טריות אמיתית, לא מדף ולא מחסן.
• מכירה online (משלוח לכל הארץ) + איסוף עצמי מהקלייה.
• מגוון: חד-זניים (Ethiopia Yirgacheffe, Kenya AA, Brazil Natural וכו') + בלנדים.

פעילות משנית — בית קפה ברחובות: משמש כמקום תוכן לאינסטגרם + חיזוק מותג.

פריוריטי לפרסום ממומן: מכירת פולי קפה — ביטויי כוונת קנייה.
פריוריטי לתוכן אורגני: הקלייה, הטריות, המגוון, חוויית בית הקפה.
=== סוף תיאור העסק ===`;

// ── Deep Market Expertise (injected into ads agents) ──────────────────────────
const ADS_EXPERTISE = `
=== ידע מקצועי עמוק: שוק הקפה הישראלי ופרסום דיגיטלי ===
(מחקר שוק מעמיק — נתונים אמיתיים, לא הנחות)

--- פסיכולוגיית הצרכן הישראלי ---
ישראלים שותים כ-3 מיליארד כוסות קפה בשנה — כרבע מהאוכלוסייה שותה 4-8 כוסות ביום. צריכה לנפש: ~4.4 ק"ג לשנה. ישראל בטופ-10 בעולם.
המתחרה האמיתי של Minuto הוא לא בית קלייה אחר — הוא Nespresso. מכונות קפסולות שולטות בבית הישראלי. הסיפור של טריות הוא הנשק הכי חד נגד הקפסולה.
מעבר לאיכות: נסקפה/אליט → אספרסו → ספשלטי. המעבר מואץ אחרי קורונה (home brewing זינק).
"ספשלטי" — מוכרת בתל אביב ובקרב coffee geeks, חלשה בפריפריה. מה שעובד לכולם: "קלוי טרי", "ישירות מהקלייה", "קפה אמיתי".
ביטוי שמנצח: "נקלה אצלנו, מגיע אליך ב-24 שעות" — זה מכה את כל הנספרסו בעולם.
הצרכן הישראלי חשוד מטבעו — לא מאמין לשיווק, מאמין לחברים + ביקורות + עובדות ספציפיות.
WhatsApp: 83% מישראלי האינטרנט שם. ישראלים 75% מעל ממוצע עולמי בשימוש. ממליצים בקבוצות וואטסאפ משפחה/שכונה — זה הגורם הויראלי הגדול ביותר. קוד הפניה שניתן לשלוח בוואטסאפ = ROI הכי גבוה.

--- מה מניע רכישה ---
1. "נגמר לי הקפה" — דחיפות מיידית. הקונה קונה מה שמופיע ראשון בגוגל.
2. "מחפש מתנה" — ראש השנה (פיק!), חנוכה, פסח, פורים. קפה = מתנה פרמיום מקורית. B2B: חברה שקונה 50 מתנות = 50 לקוחות DTC בהזמנה אחת.
3. "ראיתי ואמרתי 'וואו'" — תוכן ריילס שמראה קלייה/מקור. המרה בעוד 3-7 ימים.
4. "מישהו המליץ לי" — WhatsApp/פה לאוזן. הקונה מגיע ישיר, לא דרך גוגל.

--- תשלומים ו-e-commerce ישראלי (נתונים אמיתיים) ---
• תרבות "תשלומים": ישראלים מצפים ל-3-6 תשלומים. כרטיסי אשראי = 74% מהעסקאות. הצג "3 תשלומים ב-XX ₪" — חובה מעל ₪200.
• משלוח חינם: גורם המרה #1. סף אופטימלי ₪180-200 — מגדיל AOV כי אנשים מוסיפים שקיות להגיע לסף.
• עגלה נטושה: 79% שיעור נטישה — תקיפות retargeting עם קופון קטן חובה.
• ביקורות גוגל: קריטיות. ישראלי שמחפש = בודק ביקורות לפני לחיצה.
• קונה ראשון קונה 250g. אם אהב → 500g/1kg. מנוי = 4-5x LTV.

--- Google Ads — מה עובד בישראל (נתוני שוק) ---
• CPC ממוצע בישראל: $1.08 (הכי גבוה ב-MENA, אבל ~55% פחות מארה"ב). לקפה ספשלטי: ₪2-8 לקליק.
• תמהיל אפקטיבי: Search (60%) + Shopping/PMax (30%) + Retargeting (10%)
• ROAS ריאלי לקפה ספשלטי ישראלי: 3x-5x. מתחת ל-2x = בעיה. מעל 6x = סקייל מיידי.
• כוונת קנייה גבוהה (Exact/Phrase): "פולי קפה", "קפה לאספרסו", "קפה ספשלטי", "קנה קפה אונליין", "פולי קפה איכותיים", "קפה קלוי טרי"
• כוונת מידע (אל תפרסם): "מה זה ספשלטי", "איך מכינים קפה", "הבדל espresso filter"
• Negative keywords חובה (רשימה מלאה): "קפה נמס", "נספרסו", "נספרסו תואם", "קפסולות", "קפה טורקי", "קפה ג'ירי", "מכונת קפה", "סטארבקס", "קפה עלית", "קפה עלמה", "זול", "מתכון", "קפה בקרבתי", "קפה ערבי", "בוץ"
• שעות שיא: ראשון בבוקר 9-11 (תחילת שבוע עבודה), ימי חמישי-שישי, ערבים 19-22. שישי בוקר = פיק.
• ימי שכר (5-12 לחודש): +20-30% המרות. הגדל תקציב בימים אלה.
• קמפיין מתנות: התחל 4-6 שבועות לפני ראש השנה/פסח. B2B corporate gifting = ROI מדהים.
• ישראל = bilingual search: עברית = רכישה, אנגלית = מחקר. פרסם בעברית לכוונות קנייה.

--- ניתוח ביצועים — אבחנה נכונה ---
• CTR נמוך (<2%): בעיית קריאייטיב — שכתב כותרות. ישראלים קונים על: "קלוי טרי", "₪XX" גלוי, "משלוח חינם".
• CTR גבוה + המרות נמוכות: בעיית landing page — מהירות/UX/מחיר. לא בעיית מודעות.
• ROAS=0: בדוק conversion tracking לפני הכל. לעיתים בעיה טכנית, לא שיווקית.
• CPC עולה ו-ROAS יורד: מתחרה חדש (Kilimanjaro, Nahat, Origem) נכנס, או קריאייטיב התיישן.
• קמפיין ללא המרות 14+ ימים: עצור.
• קמפיין עם ROAS>4: הגדל תקציב 25-30% בשבוע — לא יותר.

--- מתחרים עיקריים שיש להכיר ---
• Kilimanjaro Coffee (kilimancoffee.com) — בית קלייה ותיק, אינפרסטרקטורה חזקה, גם שולח לחו"ל. חלש: פחות זהות ישראלית מקומית, generic.
• Nahat Coffee (nahatcoffee.com) — Tel Aviv, מאוד מוקפד, credential חזק. חלש: מחיר גבוה, פחות gift market.
• Origem specialty coffee — קטן יותר, נוכחות דיגיטלית פחות חזקה.
• כולם חלשים ב: WhatsApp-native UX, שוק המתנות, סיפור מקומי (Minuto-רחובות = יתרון ייחודי), טריות ברמת המוצר.

--- LTV ו-CAC — המספרים ---
• AOV ממוצע לקפה ספשלטי ישראלי: ₪150-280
• CAC ריאלי: ₪80-180 ללקוח חדש
• LTV לקוח חוזר: ₪1,500-2,800 ב-18 חודשים (קנייה כל 3-6 שבועות)
• שווה לשלם עד ₪200 על לקוח ראשון. אל תחשב ROAS על רכישה ראשונה בלבד.
• ריטנשיין: מזמין פעם שנייה תוך 60 יום → לקוח קבוע ב-70% מהמקרים.

--- 10 תבניות מודעות אפקטיביות לקפה ספשלטי (השתמש כהשראה, לא העתקה) ---

[1] זווית איכות/ציון:
  כותרת 1: "קפה ספשלטי בציון 85+"   [21]
  כותרת 2: "פולי קפה באיכות פרימיום" [23]
  תיאור: "חוויית טעמים עשירה ומדויקת בכל כוס. פולי קפה מובחרים מחוות הגידול הטובות בעולם."

[2] זווית טריות/קלייה:
  כותרת 1: "קפה טרי בקלייה מקומית"  [21]
  כותרת 2: "נקלה ונשלח אליכם היום"  [21]
  תיאור: "אל תתפשרו על פחות משיא הטריות. קפה ספשלטי שנקלה בקפידה ובהתאמה אישית. הזמינו עכשיו!"

[3] זווית בריסטה ביתי:
  כותרת 1: "שדרגו את הקפה הביתי שלכם" [24]
  כותרת 2: "פולי קפה ספשלטי למכונה"   [22]
  תיאור: "הטעם של בית הקפה האהוב עליכם, אצלכם במטבח. מגוון זנים וטעמים עם משלוח מהיר עד הבית."

[4] זווית פרופיל טעמים:
  כותרת 1: "תווים של שוקולד ופירות הדר" [26]
  כותרת 2: "קפה עם פרופיל טעמים ייחודי" [26]
  תיאור: "גלו עולם של ארומות וטעמים שלא הכרתם. פולי קפה ספשלטי מזנים נדירים. קנו עכשיו."

[5] זווית משלוח חינם:
  כותרת 1: "קפה ספשלטי עם משלוח חינם" [24]
  כותרת 2: "פולי קפה טריים עד הבית"   [22]
  תיאור: "נגמר הקפה? אנחנו בדרך אליכם. הזמינו פולי קפה איכותיים וקבלו משלוח מהיר לכל הארץ."

[6] זווית סקרנות/שאלה:
  כותרת 1: "מה זה קפה ספשלטי באמת?" [22]
  כותרת 2: "גלו את הטעם האמיתי של קפה" [25]
  תיאור: "בלי פשרות, בלי פגמים – רק פולי קפה מובחרים בציון הגבוה ביותר. חוויה לכל החושים."

[7] זווית Single Origin/עונתי:
  כותרת 1: "קפה חד-זני (Single Origin)" [26]
  כותרת 2: "היישר מחוות קטנות באתיופיה" [26]
  תיאור: "מהדורה מוגבלת של פולי קפה ייחודיים. טעמים נקיים ומקוריות מובטחת בכל לגימה."

[8] זווית מבצע/הנחה:
  כותרת 1: "15% הנחה על הזמנה ראשונה" [24]
  כותרת 2: "קפה ספשלטי במחיר משתלם"  [22]
  תיאור: "הצטרפו למועדון חובבי הקפה שלנו ותיהנו מהנחה מיוחדת ומהקפה הכי טרי שיש. קוד: COFFEE15."

[9] זווית מקצועי/ייעוץ:
  כותרת 1: "מומחים לקפה ספשלטי"        [18]
  כותרת 2: "ייעוץ והתאמה לשיטת המיצוי" [25]
  תיאור: "מאספרסו ועד דריפ – יש לנו את הפולים המושלמים עבורכם. שירות אישי לכל חובב קפה."

[10] זווית קצר וקולע:
  כותרת 1: "פשוט קפה מעולה"          [14]
  כותרת 2: "Specialty Coffee Online"  [23]
  תיאור: "הקפה שחיכיתם לו נמצא במרחק קליק. איכות, טריות וטעם ללא פשרות. הזמינו כעת."

עקרונות שעולים מהדוגמאות:
• עובדות ספציפיות > תכונות כלליות: "ציון 85+", "נקלה ונשלח היום", "15% הנחה" > "קפה טוב"
• כל זווית עם CTA שלה: "הזמינו עכשיו", "קנו עכשיו", "הצטרפו" — מותר וצריך
• שאלות שפותחות סקרנות עובדות: "מה זה קפה ספשלטי באמת?"
• פרופיל טעמים ספציפי: "שוקולד ופירות הדר" > "טעם מעולה"
• "Single Origin" / "חד-זני" — מילות מפתח שפועלות עם coffee geeks
• A/B: הרץ 2-3 זוויות שונות במקביל — לא כולם מגיבים לאותו angle
=== סוף ידע מקצועי פרסום ===`;

// ── Deep Organic/Instagram Expertise ─────────────────────────────────────────
const ORGANIC_EXPERTISE = `
=== ידע מקצועי עמוק: תוכן אורגני, Instagram ו-SEO לקפה ישראלי ===
(מחקר שוק מעמיק — נתונים אמיתיים)

--- פסיכולוגיית קהל הקפה באינסטגרם ---
הקהל הישראלי: 25-45, אורבני, גולל בטלפון בדרך לעבודה ולפני שינה.
קפה באינסטגרם = LIFESTYLE. מה שגורם לשמור (save): תוכן שגורם לו לרצות את החיים האלה.
מה שגורם לרכוש: תוכן + ביקורות + הצעה ברורה + קישור קל.
ישראלים שותפים תוכן בוואטסאפ — פוסט שעובר לקבוצת "בוקר טוב" משפחתית = הגדלה אורגנית עצומה.

נתוני Meta ישראל (חשוב!): CPC מטא לחברות ישראליות עלה 155% בין 2023-2025 — מ-$0.094 ל-$0.24 לקליק. פרסום מטא יקר יותר. זה מדגיש את החשיבות של אורגני חזק + WhatsApp.

--- תוכן שמביא תוצאות (מה שעובד לקפה בישראל) ---
TOP TIER (saves גבוה, שיתופים, המרות):
  • "behind the scenes" קלייה — האש, צבע הפולים שמשתנה, הריח שאפשר כמעט להרגיש
  • Origin story עם וידאו — "הפולים האלה גדלו בגובה 2,000 מטר באתיופיה. כך הם הגיעו אליך"
  • Comparison — "ניסית לשתות Ethiopia לצד Brazil? זה מה שקורה לחיך שלך"
  • לקוח מרוצה + ציטוט אמיתי — שם אמיתי, לא שחקן
  • תהליך ההכנה — קפה נשפך, קרם אספרסו, לחץ מים. חושני.
  • "קלינו ב-6 בבוקר, יוצא אליך ב-8" — freshness story = הכי חד נגד נספרסו

MIDDLE TIER (reach טוב, saves בינוני):
  • "פולי השבוע" — מה קלינו היום ולמה זה מיוחד
  • טיפ קצר — "למה הקפה שלך מר? כנראה..." 30 שניות ריילס
  • הצצה למחסן/קלייה — לא מושלם, אמיתי
  • מתנות לחגים — "סל קפה לראש השנה, הזמן עד שישי"

BOTTOM TIER (לא להשקיע בו):
  • תמונת מוצר על רקע לבן + מחיר בלי סיפור
  • פוסט "קנו עכשיו" ישיר ללא הקשר
  • תוכן כללי על "איך להכין קפה" — כולם עושים את זה

--- פורמטים ועיתוי (נתוני שוק אמיתיים) ---
• ריילס: 3-5x יותר reach מפוסט. תמיד עדיפות. משך: 8-15 שניות (לא 45 — ישראלים מהירים).
• קאפשן: בעברית. השורה הראשונה עוצרת גלילה. האשטגים בסוף.
• שעות פרסום אופטימליות:
  - ראשון 9-11 (תחילת שבוע עבודה — גבוה!)
  - שלישי-חמישי 12-14 (צהריים)
  - ימי חול 19-21 (אחרי ארוחת ערב)
  - שישי 8-10 (ערב שבת — פיק גבוה מאוד — קפה + שבת = שילוב מושלם)
  - אל תפרסם שישי אחה"צ עד מוצאי שבת — ישראלים לא גוללים.
  - מוצאי שבת: back online, מצב רוח טוב, חזרה לרשת — הזדמנות לפרסום ממומן.
• תדירות: 4-5 פוסטים בשבוע. Stories כל יום.
• האשטגים: 5-10 ממוקדים. #קפה #קפהטרי #קפהבוטיק #קפהביתי #קלייתקפה #קפהישראלי #בוקרטוב + #specialtycoffee #freshroasted #singleorigin
• Engagement rate ממוצע לאוכל בישראל: 4.02%. מעל 4.8% = מעולה.

--- מה מעביר מ-follow לרכישה ---
1. Stories עם link — "השבוע קלינו Ethiopia Guji. לינק בביו לפני שייגמר"
2. Urgency אמיתי — "נשארו 8 שקיות" (רק אם נכון)
3. CTA ישיר לוואטסאפ: "להזמנה שלחו הודעה" — ממיר טוב יותר מ"link in bio" לקהל ישראלי. הם סומכים על שיחה לפני קנייה.
4. DM → מכירה: מי שכותב DM על מוצר — ענה תוך שעה עם קישור ישיר.
5. User-generated content: שתף תמונות של לקוחות (עם אישור + תיוג) — social proof אמיתי.
6. Micro-influencers בנישת קפה/אוכל (5K-50K עוקבים) עם קוד הנחה — ₪300-1,500 לפוסט, ROI מדיד.

--- שוק המתנות — הזדמנות ענקית שהמתחרים פספסו ---
ראש השנה: פיק מתנות #1. חברות קונות מתנות לעובדים, משפחות מחליפות סלים. קפה = מתנה פרמיום מקורית.
פסח: פיק #2. שבוע חופש, סדרים משפחתיים. קפה לא חמץ.
פורים: משלוח מנות — תוכן שניתן לשיתוף, נפח גבוה.
B2B corporate gifting: חברה שקונה 50 מתנות = 50 לקוחות DTC בהזמנה אחת. ROI מדהים.
מחיר מתנות: ₪150-400. Sweet spot: ₪200-280 עם כרטיס ברכה וכרטיס תאריך קלייה.
מה המתחרים לא עושים: דף נחיתה ייעודי לחגים עם B2B gifting option. Minuto יכולה לבעלות על זה.

--- SEO — מצב השוק ואסטרטגיה ---
הזדמנות: רוב בתי הקלייה הישראלים לא משקיעים ב-SEO. Minuto — 10+ שנים = Domain Authority חזק.
מילות מפתח לדרג (תחרות נמוכה, כוונת קנייה): "קפה ספשלטי", "פולי קפה טרי", "בית קלייה ישראל", "קפה מקור יחיד", "בית קלייה רחובות" (תחרות כמעט אפסית).
מה לכתוב (בלוג):
  • "מה ההבדל בין Ethiopia Yirgacheffe ל-Kenya AA?" — שאלה שאנשים מחפשים, אתה הסמכות
  • "איך בוחרים קפה לפי שיטת הכנה" — SEO + conversion גבוה
  • "מתנות קפה לחגים" — שאילתות עונתיות עם כוונת קנייה גבוהה
  • E-E-A-T: כתוב כמי שקולה קפה 10 שנים — לא כמי שקרא עליו.
=== סוף ידע מקצועי תוכן ===`;

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

/**
 * Try to parse JSON from Claude's response.
 * Claude sometimes produces invalid JSON (unescaped newlines / quotes inside strings).
 * Strategy:
 *   1. Direct parse — fastest path, works most of the time.
 *   2. Sanitize literal newlines/tabs inside string values, then re-parse.
 *   3. Extract the outermost {...} block and retry.
 */
function parseClaudeJson(raw: string): unknown {
  const text = stripCodeFences(raw);

  // Pass 1 — direct
  try { return JSON.parse(text); } catch (_) { /* fall through */ }

  // Pass 2 — fix unescaped control characters inside string values
  // Replace literal \n, \r, \t that appear inside "..." with their escape sequences
  const sanitized = text.replace(/"((?:[^"\\]|\\.)*)"/gs, (_match, inner: string) => {
    const fixed = inner
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `"${fixed}"`;
  });
  try { return JSON.parse(sanitized); } catch (_) { /* fall through */ }

  // Pass 3 — extract outermost { ... } block and retry both ways
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const slice = text.slice(start, end + 1);
    try { return JSON.parse(slice); } catch (_) { /* fall through */ }
    const sanitizedSlice = slice.replace(/"((?:[^"\\]|\\.)*)"/gs, (_m, inner: string) => {
      const fixed = inner.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
      return `"${fixed}"`;
    });
    try { return JSON.parse(sanitizedSlice); } catch (_) { /* fall through */ }
  }

  throw new SyntaxError(`Could not parse Claude JSON response. Preview: ${text.slice(0, 200)}`);
}

async function callClaude(
  model: string,
  system: string,
  userMessage: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100_000); // 100s — Haiku finishes in ~20s

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

  // Tiered lookahead windows — bigger events need earlier planning:
  //   national blackout days  → 14 days  (just need to know to pause ads)
  //   major holidays          → 45 days  (gift campaigns, stock, content)
  //   commercial events       → 60 days  (Black Friday needs 8 weeks prep)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const lookahead: Record<CalendarEvent['type'], number> = {
    national:      14,
    major_holiday: 45,
    commercial:    60,
  };

  const relevant = CALENDAR_EVENTS.filter(ev => {
    const end = ev.endDate ? new Date(ev.endDate) : new Date(ev.date);
    end.setHours(23, 59, 59, 0);
    if (end < today) return false; // already ended
    const windowEnd = new Date(today.getTime() + lookahead[ev.type] * dayMs);
    return new Date(ev.date) <= windowEnd;
  });

  const lines: string[] = [];
  for (const ev of relevant) {
    const evDate   = new Date(ev.date);
    const evEnd    = ev.endDate ? new Date(ev.endDate) : evDate;
    const diffDays = Math.round((evDate.getTime() - today.getTime()) / dayMs);

    // Days until the event ENDS (negative = already ending/ended today)
    const daysUntilEnd = Math.round((evEnd.getTime() - today.getTime()) / dayMs);
    const endingToday  = daysUntilEnd === 0;
    const endingSoon   = daysUntilEnd > 0 && daysUntilEnd <= 1; // ends tomorrow

    let when: string;
    if (endingToday)                        when = 'מסתיים היום';
    else if (endingSoon)                    when = 'מסתיים מחר';
    else if (evDate <= today && evEnd >= today) when = 'מתרחש עכשיו';
    else if (diffDays === 0)               when = 'מתחיל היום';
    else if (diffDays === 1)               when = 'מחר';
    else if (diffDays <= 7)                when = `בעוד ${diffDays} ימים`;
    else                                   when = `בעוד ${diffDays} ימים (${ev.date})`;

    // Planning urgency hint — NEVER recommend starting campaigns for ending/past events
    let planningNote = '';
    if (endingToday || endingSoon) {
      planningNote = ' ⛔ החג מסתיים — עצור קמפיינים ספציפיים לחג. אל תפתח חדשים.';
    } else if (diffDays > 30)  planningNote = ' 📋 התחל לתכנן קמפיינים עכשיו';
    else if (diffDays > 14)    planningNote = ' ⏰ זמן לבנות קריאייטיב ולהכין תקציב';
    else if (diffDays > 7)     planningNote = ' 🔥 עדיפות גבוהה — הפעל קמפיינים';
    else if (diffDays > 0)     planningNote = ' 🚨 דחוף';

    const urgency = ev.type === 'national' ? '⚠️' : ev.type === 'major_holiday' ? '🎉' : '📅';
    lines.push(`${urgency} ${ev.name} — ${when}${planningNote}\n   → ${ev.marketingNote}`);
  }

  const eventsBlock = lines.length > 0
    ? `\nאירועים רלוונטיים (שבוע אחורה ועד 3 שבועות קדימה):\n${lines.join('\n')}`
    : '\nאין חגים או אירועים מיוחדים בשלושת השבועות הקרובים — שגרה מלאה.';

  return `=== הקשר עונתי ואירועים ===
עונה: ${season}
${coffeeNote}${eventsBlock}

⛔ כלל קריטי: אירועים שמסומנים "מסתיים היום" או "מסתיים מחר" — אסור להמליץ על קמפיינים חדשים לאותו אירוע. הוא נגמר. תמקד את ההמלצות בפעילות הרגילה או באירוע הבא.`;
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

// ── Past Advisor Reports — builds the learning feedback loop ─────────────────
async function fetchPastReports(
  supabase: ReturnType<typeof createClient>,
  agentType: string,
  currentWeekStart: string,
  limit = 4,
): Promise<string> {
  const { data } = await supabase
    .from("advisor_reports")
    .select("week_start, report, status")
    .eq("agent_type", agentType)
    .eq("status", "done")
    .lt("week_start", currentWeekStart)
    .order("week_start", { ascending: false })
    .limit(limit);

  if (!data || data.length === 0) return "אין היסטוריית דוחות קודמים עדיין.";

  return data.map((row) => {
    const r = row.report as Record<string, unknown> | null;
    if (!r) return null;
    const summary      = (r.summary as string ?? "").slice(0, 200);
    const focus        = (r.next_week_focus as string ?? "").slice(0, 150);
    const recs         = ((r.budget_recommendations ?? []) as { campaign: string; action: string; reason: string }[])
      .slice(0, 3)
      .map(b => `    • ${b.campaign}: ${b.action} — ${b.reason}`)
      .join("\n");
    const insights     = ((r.key_insights ?? []) as string[]).slice(0, 2).map(i => `    • ${i}`).join("\n");

    return `שבוע ${row.week_start}:
  סיכום: ${summary}
  פוקוס שהומלץ: ${focus}
  המלצות תקציב שניתנו:
${recs || "    אין"}
  תובנות:
${insights || "    אין"}`;
  }).filter(Boolean).join("\n\n");
}

// ── Campaign keyword performance (from keyword_view GAQL sync) ────────────────
async function fetchKeywordIdeas(
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  const { data } = await supabase
    .from("keyword_ideas")
    .select("keyword,avg_monthly_searches,competition,competition_index,low_top_bid_micros,high_top_bid_micros")
    .gt("avg_monthly_searches", 0)
    .order("avg_monthly_searches", { ascending: false })
    .limit(60);

  if (!data || data.length === 0) {
    return "  אין נתוני ביצועי מילות מפתח עדיין — הרץ google-sync כדי לייבא נתונים.";
  }

  // Fields: avg_monthly_searches = actual impressions, competition = match type, competition_index = impression share %
  const fmt = (k: any) => {
    const cpc     = k.low_top_bid_micros ? `₪${(k.low_top_bid_micros / 1_000_000).toFixed(2)}` : "—";
    const impShare = k.competition_index ? `${k.competition_index}% impression share` : "";
    return `  "${k.keyword}" [${k.competition ?? "?"}] | חשיפות: ${k.avg_monthly_searches.toLocaleString()} | CPC: ${cpc}${impShare ? ` | ${impShare}` : ""}`;
  };

  // Group by match type
  const exact  = data.filter((k: any) => k.competition === "EXACT");
  const phrase = data.filter((k: any) => k.competition === "PHRASE");
  const broad  = data.filter((k: any) => !["EXACT", "PHRASE"].includes(k.competition ?? ""));

  const lines: string[] = [`מילות המפתח של Minuto — ביצועים בפועל (30 יום, מסודר לפי חשיפות):`];
  if (exact.length  > 0) lines.push(`התאמה מדויקת:\n${exact.slice(0, 15).map(fmt).join("\n")}`);
  if (phrase.length > 0) lines.push(`התאמת ביטוי:\n${phrase.slice(0, 15).map(fmt).join("\n")}`);
  if (broad.length  > 0) lines.push(`התאמה רחבה:\n${broad.slice(0, 10).map(fmt).join("\n")}`);

  return lines.join("\n\n");
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

  const thirtyDaysAgo = subtractDays(weekStart, 30);
  const [{ currentAgg, prevAgg }, wooSales, adCreatives, gscRes, pastReports, kwIdeas] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
    fetchAdCreatives(supabase),
    supabase
      .from("google_search_console")
      .select("keyword,clicks,impressions,position")
      .neq("keyword", "__page__")
      .gte("date", thirtyDaysAgo)
      .order("impressions", { ascending: false })
      .limit(30),
    fetchPastReports(supabase, "google_ads_growth", weekStart),
    fetchKeywordIdeas(supabase),
  ]);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  // Aggregate GSC keywords
  const gscKwMap = new Map<string, { clicks: number; impressions: number; positions: number[] }>();
  for (const r of (gscRes.data ?? [])) {
    const e = gscKwMap.get(r.keyword);
    if (e) { e.clicks += r.clicks; e.impressions += r.impressions; e.positions.push(r.position); }
    else gscKwMap.set(r.keyword, { clicks: r.clicks, impressions: r.impressions, positions: [r.position] });
  }
  const gscKeywords = Array.from(gscKwMap.entries())
    .map(([kw, v]) => ({ keyword: kw, clicks: v.clicks, impressions: v.impressions,
      position: Math.round((v.positions.reduce((a, b) => a + b, 0) / v.positions.length) * 10) / 10 }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);
  const gscBlock = gscKeywords.length > 0
    ? gscKeywords.map(k => `  "${k.keyword}" | חשיפות: ${k.impressions} | קליקים: ${k.clicks} | מיקום: ${k.position}`).join("\n")
    : "  אין נתוני GSC עדיין";

  const systemPrompt = `אתה יועץ Google Ads בכיר עם 10 שנות ניסיון ב-e-commerce קפה ספשלטי. אתה מייעץ ל-Minuto Coffee.
${BUSINESS_BRIEF}
${ADS_EXPERTISE}
הפילוסופיה שלך: צמיחה חכמה. לסקייל על קמפיינים שמראים ROAS אמיתי, לבדוק הזדמנויות חדשות מבוססות נתונים, להגדיל LTV על ידי המרת קונים ראשונים לחוזרים.
אל תמליץ על "cold brew" ואל תמציא ביטויים. כל המלצה חייבת להתבסס על נתוני GSC/Ads שניתנו לך.

=== כתיבת קופי לGoogle Ads — כללים וסגנון ===

גבולות טכניים (ספור לפני שאתה שולח — כל אות, רווח ופיסוק):
• כותרות: עד 30 תווים. בדרך כלל 3-4 מילים.
• תיאורים: עד 90 תווים.

זוויות אפקטיביות לקפה ספשלטי (ראה 10 הדוגמאות ב-ADS_EXPERTISE למעלה):
• איכות/ציון: "קפה ספשלטי בציון 85+" — ספציפי ואמין
• טריות: "נקלה ונשלח אליכם היום" — עובדה שמנצחת נספרסו
• בריסטה ביתי: "שדרגו את הקפה הביתי שלכם" — שאיפה, לא מוצר
• פרופיל טעמים: "תווים של שוקולד ופירות הדר" — חושני וספציפי
• משלוח/תועלת: "קפה ספשלטי עם משלוח חינם" — הסרת חסמים
• שאלה/סקרנות: "מה זה קפה ספשלטי באמת?" — פותח סקרנות
• Single Origin: "היישר מחוות קטנות באתיופיה" — סיפור ומקוריות
• מבצע: "15% הנחה על הזמנה ראשונה" — המרה ראשונה
• מקצועי: "מומחים לקפה ספשלטי" — סמכות
• קצר: "פשוט קפה מעולה" — לפעמים פחות זה יותר

כלל CTA: "הזמינו עכשיו", "קנו עכשיו", "גלו עכשיו", "הצטרפו" — לגיטימי ומומלץ בתיאורים.

מה אסור:
✗ "קלינו ביום X, מגיעים ביום Y" בכותרת — תמיד 36+ תווים. NEVER.
✗ שניים+ מקורות בכותרת אחת: "Ethiopia, Kenya AA, Brazil" = 46 תווים. NEVER.
✗ "טריות אמיתית" / "איכות אמיתית" — "אמיתית" אחרי שם עצם = קלישאה. NEVER.
✗ "ועם", "אשר", "הינו" — עברית פורמלית/מתורגמת. NEVER.
✗ "קלויים טרי" — שגיאת הסכמה → "קלויים טריים". NEVER.
✗ כותרת שאפשר לתלות על כל מוצר בעולם — חייבת לאמר משהו ספציפי לקפה/Minuto.
שמות מקור: באנגלית בלבד. מקור אחד בכותרת.

=== ידע שוק — חיפושי קפה בישראל (נתוני שוק כלליים, לא רק Minuto) ===
נפח חיפוש גבוה בישראל (אלפי חיפושים/חודש):
  "קפה" | "מכונת קפה" | "פולי קפה" | "קפסולות קפה" | "קפה טחון"
נפח בינוני (מאות חיפושים/חודש — פוטנציאל אמיתי לספשלטי):
  "פולי קפה איכותיים" | "קפה ספשלטי" | "קפה טרי" | "בית קלייה קפה" | "קפה מקור יחיד"
  "Ethiopia coffee" | "Kenya coffee" | "Brazil coffee beans"
נפח נמוך — לא משתלם לפרסום ממומן:
  "cold brew" | "cold brew coffee" | "קפה קר" | "nitro coffee" | "chemex" | "v60"
  הערה: ישראלים לא מחפשים "cold brew" בגוגל — זה ביטוי שמכירים ממסעדות/קפה, לא מחיפוש.

חוק קריטי לגבי מילות מפתח: העדף מילות מפתח מהרשימה עם נפח בינוני/גבוה למעלה + מה שמופיע ב-GSC של Minuto למטה. אם ביטוי לא מופיע בשתי הרשימות — אל תמליץ עליו לפרסום ממומן.
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

=== Google Search Console — נתוני Minuto בפועל (30 יום אחרונים) ===
אלה הביטויים שבהם Minuto כבר מופיעה בגוגל. השתמש בהם כבסיס להמלצות.
${gscBlock}

=== מילות מפתח — ביצועי קמפיינים Minuto בפועל (30 יום) ===
אלה מילות המפתח שפועלות בקמפיינים הנוכחיים + ביצועיהן האמיתיים. השתמש בהן כבסיס להמלצות — אל תמציא ביטויים שאינם כאן או ב-GSC.
${kwIdeas}

=== היסטוריית המלצות קודמות — למד מהן ===
${pastReports}
השווה: מה המלצת בעבר → מה קרה בפועל בנתוני הקמפיינים השבוע. אם המלצה עבדה — חזק אותה. אם לא עבדה — הסבר למה ותכנן אחרת.

השתמש בהקשר העונתי למעלה — חגים קרובים, עונה, אירועים — כדי לתזמן קמפיינים ולהמליץ על תוכן רלוונטי.
בהמלצות הקריאייטיב — התבסס על הכותרות והתיאורים הקיימים, הצבע על מה שחלש ומה שאפשר לשפר.
בהמלצות מילות מפתח — השתמש אך ורק בביטויים מ-GSC של Minuto + Keyword Planner. אל תמציא ביטויים.

הגבלות פלט קפדניות: budget_recommendations עד 3, growth_opportunities עד 2, campaigns_to_create עד 1, key_insights עד 2.

החזר JSON בפורמט (בדיוק מבנה זה):
{
  "agent_philosophy": "צמיחה אגרסיבית",
  "summary": "2 משפטים בלבד",
  "google": {
    "total_cost": ${Math.round(totalCost * 100) / 100},
    "total_clicks": ${totalClicks},
    "total_impressions": ${totalImpressions},
    "total_conversions": ${Math.round(totalConversions * 10) / 10},
    "roas": ${Math.round(overallRoas * 100) / 100},
    "top_campaign": "שם הקמפיין",
    "worst_campaign": "שם הקמפיין"
  },
  "budget_recommendations": [
    { "platform": "google", "campaign": "שם", "action": "increase|decrease|pause|keep|test_new", "reason": "הסבר קצר", "suggested_budget_change_pct": 30 }
  ],
  "growth_opportunities": [
    { "opportunity": "הזדמנות", "action": "מה לעשות", "expected_impact": "תוצאה צפויה" }
  ],
  "campaigns_to_create": [
    {
      "campaign_name": "שם",
      "campaign_type": "Search|Performance Max|Shopping",
      "target_audience": "קהל יעד",
      "keywords": ["מילה 1", "מילה 2", "מילה 3"],
      "headlines": ["כותרת 1", "כותרת 2", "כותרת 3"],
      "descriptions": ["תיאור 1"],
      "daily_budget_ils": 50,
      "rationale": "הסבר קצר"
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2"],
  "next_week_focus": "משפט אחד — המהלך העיקרי"
}`;

  const finalMessage = focus
    ? `${userMessage}\n\n=== הוראות מיוחדות מהצוות ===\n${focus}\nהתמקד בהוראות אלו בניתוח שלך ובהמלצות.`
    : userMessage;

  console.log(`[growth] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ADS, systemPrompt, finalMessage);
  const parsed = parseClaudeJson(text);
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

  const thirtyDaysAgoEff = subtractDays(weekStart, 30);
  const [{ currentAgg, prevAgg }, wooSales, adCreatives, gscResEff, pastReportsEff, kwIdeasEff] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
    fetchAdCreatives(supabase),
    supabase
      .from("google_search_console")
      .select("keyword,clicks,impressions,position")
      .neq("keyword", "__page__")
      .gte("date", thirtyDaysAgoEff)
      .order("impressions", { ascending: false })
      .limit(30),
    fetchPastReports(supabase, "google_ads_efficiency", weekStart),
    fetchKeywordIdeas(supabase),
  ]);
  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const gscKwMapEff = new Map<string, { clicks: number; impressions: number; positions: number[] }>();
  for (const r of (gscResEff.data ?? [])) {
    const e = gscKwMapEff.get(r.keyword);
    if (e) { e.clicks += r.clicks; e.impressions += r.impressions; e.positions.push(r.position); }
    else gscKwMapEff.set(r.keyword, { clicks: r.clicks, impressions: r.impressions, positions: [r.position] });
  }
  const gscBlockEff = Array.from(gscKwMapEff.entries())
    .map(([kw, v]) => ({ keyword: kw, clicks: v.clicks, impressions: v.impressions,
      position: Math.round((v.positions.reduce((a, b) => a + b, 0) / v.positions.length) * 10) / 10 }))
    .sort((a, b) => b.impressions - a.impressions).slice(0, 20)
    .map(k => `  "${k.keyword}" | חשיפות: ${k.impressions} | קליקים: ${k.clicks} | מיקום: ${k.position}`)
    .join("\n") || "  אין נתוני GSC עדיין";

  const systemPrompt = `אתה יועץ Google Ads בכיר המתמחה ב-ROAS optimization לעסקי e-commerce קפה. אתה מייעץ ל-Minuto Coffee.
${BUSINESS_BRIEF}
${ADS_EXPERTISE}
הפילוסופיה שלך: יעילות ורווחיות. כל שקל חייב לייצר החזר מדיד. אתה מזהה בזבוז לפני שמישהו אחר רואה אותו — CTR נמוך, Quality Score גרוע, קמפיין שמקבל קליקים ולא המרות.
בנוסף לניתוח, תכתוב מודעות משופרות אמיתיות — כותרות ותיאורים מבוססי נתוני GSC וביצועי הקמפיין.

=== כתיבת קופי לGoogle Ads — כללים וסגנון ===

גבולות טכניים (ספור לפני שאתה שולח — כל אות, רווח ופיסוק):
• כותרות: עד 30 תווים. בדרך כלל 3-4 מילים.
• תיאורים: עד 90 תווים.

זוויות אפקטיביות לקפה ספשלטי (ראה 10 הדוגמאות ב-ADS_EXPERTISE למעלה):
• איכות/ציון: "קפה ספשלטי בציון 85+" — ספציפי ואמין
• טריות: "נקלה ונשלח אליכם היום" — עובדה שמנצחת נספרסו
• בריסטה ביתי: "שדרגו את הקפה הביתי שלכם" — שאיפה, לא מוצר
• פרופיל טעמים: "תווים של שוקולד ופירות הדר" — חושני וספציפי
• משלוח/תועלת: "קפה ספשלטי עם משלוח חינם" — הסרת חסמים
• שאלה/סקרנות: "מה זה קפה ספשלטי באמת?" — פותח סקרנות
• Single Origin: "היישר מחוות קטנות באתיופיה" — סיפור ומקוריות
• מבצע: "15% הנחה על הזמנה ראשונה" — המרה ראשונה
• מקצועי: "מומחים לקפה ספשלטי" — סמכות
• קצר: "פשוט קפה מעולה" — לפעמים פחות זה יותר

כלל CTA: "הזמינו עכשיו", "קנו עכשיו", "גלו עכשיו", "הצטרפו" — לגיטימי ומומלץ בתיאורים.

מה אסור:
✗ "קלינו ביום X, מגיעים ביום Y" בכותרת — תמיד 36+ תווים. NEVER.
✗ שניים+ מקורות בכותרת אחת: "Ethiopia, Kenya AA, Brazil" = 46 תווים. NEVER.
✗ "טריות אמיתית" / "איכות אמיתית" — "אמיתית" אחרי שם עצם = קלישאה. NEVER.
✗ "ועם", "אשר", "הינו" — עברית פורמלית/מתורגמת. NEVER.
✗ "קלויים טרי" — שגיאת הסכמה → "קלויים טריים". NEVER.
✗ כותרת שאפשר לתלות על כל מוצר בעולם — חייבת לאמר משהו ספציפי לקפה/Minuto.
שמות מקור: באנגלית בלבד. מקור אחד בכותרת.

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

=== Google Search Console — נתוני Minuto בפועל (30 יום אחרונים) ===
${gscBlockEff}

=== מילות מפתח — ביצועי קמפיינים Minuto בפועל (30 יום) ===
ביצועים אמיתיים לפי מילת מפתח. בדוק: אילו ביטויים מביאים קליקים יקרים עם המרות נמוכות? אילו ביטויים יש להם CPC גבוה בלי תוצאות? אלה מועמדים להסרה. ביטויים עם impression share נמוך = שווה להגדיל תקציב.
${kwIdeasEff}

השתמש בהקשר העונתי — חגים ואירועים — בניתוח תזמון הקמפיינים והמלצות התקציב.
נתח את הכותרות והתיאורים הקיימים: האם הם חזקים? רלוונטיים? האם חוזק המודעה (Ad Strength) נמוך? ה-ads_to_rewrite צריך להתבסס על הקריאייטיב האמיתי שמוצג למעלה.
בהמלצות מילות מפתח — השתמש אך ורק בביטויים מ-GSC + Keyword Planner. אל תמציא ביטויים.

=== היסטוריית המלצות קודמות — למד מהן ===
${pastReportsEff}
השווה: מה המלצת בעבר → מה קרה בפועל. המלצות שעבדו — חזק. שלא עבדו — נתח למה.

הגבלות פלט קפדניות: budget_recommendations עד 3, waste_identified עד 2, ads_to_rewrite עד 1, key_insights עד 2.

החזר JSON בפורמט (בדיוק מבנה זה):
{
  "agent_philosophy": "יעילות ו-ROAS",
  "summary": "2 משפטים בלבד",
  "google": {
    "total_cost": ${Math.round(totalCost * 100) / 100},
    "total_clicks": ${totalClicks},
    "total_impressions": ${totalImpressions},
    "total_conversions": ${Math.round(totalConversions * 10) / 10},
    "roas": ${Math.round(overallRoas * 100) / 100},
    "top_campaign": "שם הקמפיין",
    "worst_campaign": "שם הקמפיין"
  },
  "budget_recommendations": [
    { "platform": "google", "campaign": "שם", "action": "increase|decrease|pause|keep", "reason": "הסבר קצר", "suggested_budget_change_pct": -20 }
  ],
  "waste_identified": [
    { "campaign": "שם", "issue": "בעיה", "estimated_waste": "₪X בשבוע", "fix": "פתרון קצר" }
  ],
  "ads_to_rewrite": [
    {
      "campaign": "שם הקמפיין",
      "problem": "בעיה קצרה",
      "new_headlines": ["כותרת 1", "כותרת 2", "כותרת 3"],
      "new_descriptions": ["תיאור 1"],
      "expected_improvement": "מה ישתפר"
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2"],
  "next_week_focus": "משפט אחד — המהלך העיקרי"
}`;

  const finalMessage = focus
    ? `${userMessage}\n\n=== הוראות מיוחדות מהצוות ===\n${focus}\nהתמקד בהוראות אלו בניתוח שלך ובהמלצות.`
    : userMessage;

  console.log(`[efficiency] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ADS, systemPrompt, finalMessage);
  const parsed = parseClaudeJson(text);
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

  const [postsRes, insightsRes, productsRes, originsRes, gscRes, wooSalesOrganic, pastReportsOrganic] = await Promise.all([
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
  ]);

  const posts    = postsRes.data    ?? [];
  const insights = insightsRes.data ?? [];
  const products = productsRes.data ?? [];
  const origins  = originsRes.data  ?? [];
  const gscRows  = gscRes.data      ?? [];

  // ── Fetch live Instagram follower count ──────────────────────────────────
  let liveFollowerCount = 0;
  try {
    const { data: tokenRow } = await supabase
      .from("oauth_tokens").select("access_token").eq("platform", "meta").single();
    if (tokenRow?.access_token) {
      const pagesRes = await fetch(
        `https://graph.facebook.com/v18.0/me/accounts?access_token=${tokenRow.access_token}`
      );
      const pages = await pagesRes.json();
      if (pages.data?.length) {
        const pageToken = pages.data[0].access_token;
        const pageId    = pages.data[0].id;
        const igRes = await fetch(
          `https://graph.facebook.com/v18.0/${pageId}?fields=instagram_business_account&access_token=${pageToken}`
        );
        const igData = await igRes.json();
        const igId   = igData.instagram_business_account?.id;
        if (igId) {
          const acctRes = await fetch(
            `https://graph.facebook.com/v18.0/${igId}?fields=followers_count&access_token=${pageToken}`
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

  const systemPrompt = `אתה מנהל שיווק דיגיטלי בכיר עם ניסיון בתוכן ו-SEO לעסקי מזון/קפה. אתה מייעץ ל-Minuto Coffee.
${BUSINESS_BRIEF}
${ORGANIC_EXPERTISE}
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

הגבלות פלט קפדניות — חרוג מהן = שגיאה:
• google_organic_recommendations — פריט אחד בלבד
• content_recommendations — עד 2 פריטים
• products_to_feature — פריט אחד בלבד
• posts_to_publish — פוסט אחד בלבד; caption — עד 120 תווים; hashtags — עד 5
• key_insights — עד 2
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

החזר JSON (בדיוק מבנה זה, ללא שדות נוספים):
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
      "estimated_difficulty": "קל|בינוני|קשה"
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
      "type": "reel|post|story",
      "topic": "נושא הפוסט",
      "best_day": "ראשון",
      "best_time": "09:00",
      "caption": "כיתוב עד 120 תווים כולל אמוג'ים",
      "hashtags": ["#קפה", "#מינוטו"],
      "hook": "משפט פתיחה קצר",
      "visual_direction": "הנחיה קצרה"
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2"]
}`;

  const finalMessage = focus
    ? `${userMessage}\n\n=== הוראות מיוחדות מהצוות ===\n${focus}\nהתמקד בהוראות אלו בניתוח שלך ובהמלצות.`
    : userMessage;

  console.log(`[organic] Calling Claude (${MODEL_ORGANIC})...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ORGANIC, systemPrompt, finalMessage);
  const parsed = parseClaudeJson(text);
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

// ── Blog Writer Agent ─────────────────────────────────────────────────────────

async function runBlogWriterAgent(params: {
  keyword: string;
  title: string;
  key_points: string[];
  position?: number;
  search_volume_signal?: string;
}): Promise<{ title: string; meta_description: string; slug: string; body: string }> {
  const { keyword, title, key_points, position, search_volume_signal } = params;

  const systemPrompt = `אתה כותב תוכן מקצועי ומומחה SEO לבלוג של Minuto Coffee — בית קלייה ספשלטי ברחובות.
${BUSINESS_BRIEF}
${ORGANIC_EXPERTISE}

המשימה שלך: לכתוב פוסט בלוג מלא בעברית, מקצועי, מעניין ומאופטם לגוגל.

חוקי כתיבת תוכן SEO:
• מילת המפתח הראשית חייבת להופיע: בכותרת H1, בפסקה הראשונה, ב-2-3 כותרות H2, וטבעי לאורך הטקסט (צפיפות 1-2%).
• כותרות H2 — מינימום 4 כותרות H2, כל אחת עם זווית שונה.
• אורך: 700-1000 מילים. לא קצר יותר — גוגל מעדיף תוכן מקיף.
• כתוב כמו מומחה קפה, לא כמו משווק. עובדות, הסברים, טיפים שימושיים.
• כלול המלצה ספציפית על מוצר Minuto (פולי קפה/בית הקלייה) באופן טבעי — לא בצורה של "קנו עכשיו".
• בסוף — CTA עדין: "אפשר להזמין ישירות מהאתר עם משלוח לכל הארץ".
• שפה: עברית ישראלית מדוברת. לא פורמלית. לא תרגום מאנגלית.
• פורמט תשובה: JSON בלבד (ללא טקסט לפניו/אחריו).`;

  const userMessage = `כתוב פוסט בלוג מלא לפי הפרמטרים הבאים:

מילת מפתח ראשית: "${keyword}"
${position ? `מיקום נוכחי בגוגל: ${position} (יש לנו דריסת רגל — כדאי לחזק)` : ''}
${search_volume_signal ? `נפח חיפוש: ${search_volume_signal}` : ''}
כותרת מוצעת (H1): "${title}"

נקודות חובה לכלול בתוכן:
${key_points.map((p, i) => `${i + 1}. ${p}`).join('\n')}

החזר JSON בפורמט הזה בדיוק:
{
  "title": "כותרת H1 סופית (מכילה את מילת המפתח)",
  "meta_description": "תיאור מטא לגוגל — עד 155 תווים, מכיל את מילת המפתח, מניע לקליק",
  "slug": "כתובת-url-בעברית-עם-מקפים",
  "body": "טקסט המאמר המלא בפורמט Markdown. H1 בראש, אחריו H2 לכל פרק, פסקאות, bullet points איפה שמתאים. 700-1000 מילים."
}`;

  console.log(`[blog_writer] Writing post for keyword: "${keyword}"`);
  const { text, inputTokens, outputTokens } = await callClaude("claude-sonnet-4-5", systemPrompt, userMessage);
  console.log(`[blog_writer] Done. Tokens: ${inputTokens + outputTokens}`);

  const parsed = parseClaudeJson(text);
  return parsed as { title: string; meta_description: string; slug: string; body: string };
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(SUPA_URL, SUPA_KEY);
  const weekStart = getPreviousWeekStart();
  console.log(`[marketing-advisor] weekStart: ${weekStart}`);

  let body: {
    trigger?: string; agent?: string; focus?: string;
    keyword?: string; title?: string; key_points?: string[];
    position?: number; search_volume_signal?: string;
  } = {};
  try { body = await req.json() } catch { /* default to all */ }

  // ── BLOG WRITER — instant response, not stored in DB ──────────────────────
  if (body.agent === "blog_writer") {
    if (!body.keyword || !body.title) {
      return new Response(JSON.stringify({ error: "keyword and title are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    try {
      const post = await runBlogWriterAgent({
        keyword: body.keyword,
        title: body.title,
        key_points: body.key_points ?? [],
        position: body.position,
        search_volume_signal: body.search_volume_signal,
      });
      return new Response(JSON.stringify(post),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }

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
