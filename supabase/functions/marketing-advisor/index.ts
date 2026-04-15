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
const GEMINI_KEY    = Deno.env.get("GEMINI_API_KEY") ?? "";
const SERPER_KEY    = Deno.env.get("SERPER_API_KEY") ?? "";

// Haiku: fast enough (15-25s), same model used by generate-campaign
const MODEL_ADS     = "claude-sonnet-4-5";
const MODEL_ORGANIC = "claude-sonnet-4-5";
// Strategist agents need to respond within the 150s edge function gateway
// timeout. Sonnet 4.5 is too slow with the large prompt. Sonnet 4 is
// fast enough and still excellent for Hebrew marketing strategy.
// Reverted to Sonnet 4 after 4.5 consistently timed out on the strategist
// prompts against Supabase's 150s gateway — even with 145s timeout and
// 7000 max_tokens. Sonnet 4 is ~20% faster and fits the window.
//
// ⚠️ TODO before May 14, 2026 (Sonnet 4 degradation starts):
// Split the strategist into two smaller Claude calls OR trim the research
// block before handing to Sonnet 4.5. Leaving on `claude-sonnet-4-20250514`
// is a temporary measure until then.
const MODEL_STRATEGIST = "claude-sonnet-4-20250514";

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

=== אסטרטגיית קהלים: שני קהלי יעד ===

⚠️ כלל קריטי: שני הקהלים כבר קונים פולי קפה. אנחנו לא מנסים לשכנע אנשים לקנות פולים לראשונה — אנחנו מנסים לגרום לאנשים שכבר קונים פולים לקנות פולים טובים יותר, מאיתנו.

מי שיש לו מכונת נספרסו ושותה רק קפסולות = לא קהל יעד. הוא לא יקנה פולים. לא לפנות אליו. לא לבנות קמפיין "חלופה לקפסולות". זה קהל אחר לגמרי.

קהל 1 — חובבי ספשלטי (קטן, LTV גבוה):
כבר קונים פולי קפה ספשלטי ממתחרים — נחת, Jera, אגרו, נגרו, או מייבאים מחו"ל.
יש להם מטחנה ומכונת אספרסו ביתית. הם מחפשים פולים חד-זניים, ציוני SCA, מקורות ספציפיים.
ביטויי חיפוש: "קפה ספשלטי", "פולי קפה חד זני", "Ethiopia Yirgacheffe", "קפה ספשלטי אונליין"
אסטרטגיה: הראה שמינוטו יותר טרי (קלייה ביום ההזמנה), מומחים (10+ שנים), ומגוון יותר מכל מתחרה.

קהל 2 — קונים פולי קפה מסחרי (גדול, פוטנציאל צמיחה עצום):
כבר קונים פולי קפה — אבל מהסופר. קונים Lavazza, Illy, Mauro, Bristot, Hausbrandt, Kimbo, Segafredo. משלמים ₪60-120 לק"ג על פולים שנקלו חודשים לפני כן.
יש להם מכונת אספרסו ביתית או מטחנה — הם כבר בעולם הפולים. הם פשוט לא יודעים שיש משהו טוב יותר.
ביטויי חיפוש: "פולי קפה", "פולי קפה טריים", "קפה טרי לבית", "פולי קפה למכונת אספרסו", "שדרוג קפה ביתי", "פולי קפה איטלקי", "קפה טרי משלוח"
אסטרטגיה: הראה את ההבדל בין פולים מהסופר (נקלו לפני 4 חודשים) לפולים טריים (נקלו היום). טריות = טעם אחר לגמרי. אנחנו מוצר פרימיום — לא מתחרים על מחיר.

מותגים שקהל 2 קונה (ואנחנו מתחרים עליהם ישירות):
• Lavazza (הכי נמכר בסופרים), Illy, Mauro, Bristot, Hausbrandt, Kimbo, Segafredo
• עלית פולים, Landwer פולים
• פולים מרשתות: Aldo, AM:PM, רמי לוי

חשוב מאוד: קהל 2 הוא הרבה יותר גדול מקהל 1. רוב הגידול יבוא משם. אבל צריך לפנות אליהם בשפה שהם מבינים — "טריות", "טעם אחר", "קלייה מקומית", לא "ציון SCA 85+". הם לא יודעים מה זה SCA.

⚠️ מינוטו הוא מוצר פרימיום. כללים קריטיים:
• לעולם לא להתחרות על מחיר. לא "אותו מחיר", לא "זול יותר", לא "במחיר הסופר".
• לעולם לא לתת הנחות או מבצעים בקופי המודעות. לא "15% הנחה", לא "משלוח חינם".
• המסר הוא תמיד איכות, טריות, מומחיות, חוויה. "נקלה היום", "מבית קלייה ברחובות", "ספשלטי אמיתי".
• אם לקוח רוצה זול — הוא לא הלקוח שלנו. אנחנו רוצים לקוחות שמוכנים לשלם על איכות.
=== סוף תיאור העסק ===`;

// ── Competitive Intelligence ─────────────────────────────────────────────────
// Real data from competitor websites, updated periodically. Injected into all
// 3 agents so they can position Minuto strategically against real alternatives.
const COMPETITIVE_INTELLIGENCE = `
=== מודיעין תחרותי ===

⚠️ חשוב: אל תתבסס רק על השמות למטה. השתמש במחקר השוק היומי (google_search_results + google_suggest) כדי לגלות מי באמת מתחרה על המילים שלנו. המתחרים משתנים — תמיד תבדוק מי מופיע בתוצאות החיפוש היום.

=== היתרונות של Minuto שאף מתחרה לא יכול להעתיק ===
1. טריות: קולים ביום ההזמנה. אף בית קלייה לא מבטיח את זה — רוב קולים למלאי.
2. מומחיות: 10+ שנים, 13 יצרנים, 88+ בלנדים — ניסיון שקשה להתחרות בו.
3. משלוח ארצי: לכל ישראל, לא רק TLV או מרכז.
4. 10+ שנים ניסיון, 88+ בלנדים, 13 יצרנים — מגוון שקשה להתחרות בו.

=== סוגי מתחרים (גלה מי הם מהמחקר) ===
• בתי קלייה ספשלטי: גלה מהמחקר מי מדורג ומפרסם על "פולי קפה ספשלטי" ו"בית קלייה". מה הם מציעים? מה המחירים? מה היתרון שלנו?
• מותגי סופר: Lavazza, Illy, Mauro, Bristot, Hausbrandt — פולים שנקלו חודשים לפני. ₪60-120/ק"ג. הם הקהל הכי גדול לגנוב ממנו.
• קפסולות: Nespresso, Dolce Gusto — לא קהל יעד (לא קונים פולים). אל תפנה אליהם.
=== סוף מודיעין תחרותי ===`;

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

[8] זווית חוויה/שדרוג:
  כותרת 1: "הקפה שישנה לכם את הבוקר" [24]
  כותרת 2: "שדרגו את הקפה הביתי שלכם"  [24]
  תיאור: "גלו איך קפה שנקלה השבוע טועם אחרת לגמרי מקפה מהמדף. קלייה מקומית ברחובות, משלוח לכל הארץ."

[9] זווית מקצועי/ייעוץ:
  כותרת 1: "מומחים לקפה ספשלטי"        [18]
  כותרת 2: "ייעוץ והתאמה לשיטת המיצוי" [25]
  תיאור: "מאספרסו ועד דריפ – יש לנו את הפולים המושלמים עבורכם. שירות אישי לכל חובב קפה."

[10] זווית קצר וקולע:
  כותרת 1: "פשוט קפה מעולה"          [14]
  כותרת 2: "Specialty Coffee Online"  [23]
  תיאור: "הקפה שחיכיתם לו נמצא במרחק קליק. איכות, טריות וטעם ללא פשרות. הזמינו כעת."

עקרונות שעולים מהדוגמאות:
• עובדות ספציפיות > תכונות כלליות: "ציון 85+", "נקלה ונשלח היום", "קלייה מקומית ברחובות" > "קפה טוב"
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

// ── Meta Ads (Facebook + Instagram) build expertise ───────────────────────────
// Used by both strategist agents when they output meta_campaigns_to_create[].
// Structured so every campaign recommendation has: objective, audience,
// placements, creative, budget — everything the owner needs to open Ads
// Manager and set it up without guessing.
const META_ADS_EXPERTISE = `
=== בניית קמפיין Meta Ads (Facebook + Instagram) — מדריך מלא ===

--- בחירת Objective (יעד הקמפיין) ---
• Sales (Conversions): ברירת המחדל למינוטו. ההמרה היא רכישה/הוספה לעגלה. דרוש Pixel פעיל.
• Traffic: רק לשלבי awareness מוקדמים של מוצר חדש או לבלוג פוסט. כמעט תמיד פחות יעיל מ-Sales.
• Engagement: מתאים לפוסטים אורגניים כבדים שרוצים להדחיף (Boosted Post). לא קמפיין חדש.
• Leads: רק אם יש lead magnet אמיתי (eBook, מדריך). למינוטו — משני.
• Catalog Sales (Advantage+ Shopping): המלצה חמה אם יש Pixel + פיד WooCommerce מחובר ל-Meta Commerce. מייצר דינמית רטרגטינג ומוצרים רלוונטיים.

--- בחירת Audience (קהל) ---
שכבות המלצה (מהחזק לחלש):

[1] Custom Audiences (קהל חם — הכי ממיר):
  • "Website Visitors 90d" — כל מי שביקר באתר ב-90 הימים האחרונים (דרך Pixel)
  • "Cart Abandoners 30d" — הוסיפו לעגלה, לא קנו
  • "Past Purchasers" — מהרשימת email/CRM
  • "Video viewers 75%+ 180d" — צפו ברוב הריילס האורגניים
  • "IG engagers 365d" — התעסקו עם הפרופיל בשנה האחרונה
  שימוש: רטרגטינג עם תקציב נמוך (₪30-50/יום). ROAS גבוה.

[2] Lookalike Audiences (קהל דומה — הכי טוב לסקיילינג):
  • 1% LAL of Past Purchasers — קהל הכי קרוב ללקוחות הקיימים. 100-200K אנשים בישראל.
  • 1% LAL of High-AOV customers — מי שהוציאו מעל ₪250 (אם יש מינימום 100 לקוחות כאלה)
  • 2-3% LAL of Website Visitors — קהל רחב יותר לשלב scaling

[3] Advantage+ Audience (המלצת Meta — לנסות לפני detailed):
  לאקאונטים חדשים או בשלב scaling: לתת למטא ללמוד. מוגדר רק גבולות: גיל/מיקום/שפה.
  Meta מוצאת את הקהל דרך ה-AI. לרוב עולה על detailed במודעות חדשות.

[4] Detailed Targeting (קהל קר — רק כשאין data למודל ללמוד ממנו):
  תחומי עניין רלוונטיים לקפה ספשלטי בישראל:
    • Specialty coffee, Third wave coffee, Coffee roasting, Espresso
    • Home barista, Coffee brewing, V60, Aeropress, French press
    • De'Longhi, Nespresso (כן — הלקוחות של נספרסו הם קהל מטרה לשדרוג!)
    • Coffee shop, Coffee culture, Coffee geek
  תחומי עניין לקהל מסחרי (אודיינס של לוואצה/איליי):
    • Coffee machine (home), Bialetti, Moka pot, Stovetop espresso
    • Italian coffee, Illycaffè, Lavazza (תיחקרו אם זה interest גלוי)
    • Home coffee, Coffee at home
  התנהגויות: "Engaged shoppers" + "Online shoppers". אל תבחר "High net worth" — מטה מדי.
  גיל: 28-55 (מי שקונים פולים לבית). מיקום: ישראל. שפה: עברית + אנגלית.

[5] חריגים — אל תטרגט:
  • גיל 18-24 — סטודנטים, קונים קפסולות של נספרסו בסופר, לא פולים ב-₪80
  • גיל 65+ — לא קונים אונליין פולי קפה
  • "Low income" geo clusters בפריפריה — יקר להמיר

--- בחירת Placements (מיקומי פרסום) ---
• ברירת מחדל: Advantage+ Placements (Meta בוחרת אוטומטית — Feed, Reels, Stories, Audience Network).
• אם אתה חייב לבחור ידנית — הקפד: Instagram Feed + Instagram Reels + Facebook Feed + Instagram Stories. לא Audience Network (איכות נמוכה).
• לקהל B2C ישראלי — Instagram הוא הערוץ העיקרי. Facebook יותר חלש ל-DTC בגילאי 25-45 בישראל (השתנה ב-2023-2024).

--- בניית Creative (קריאייטיב) ---
גבולות טקסט:
  • Primary Text (גוף): עד 125 תווים לפני "See More". הכי חשוב — המשפט הראשון עוצר גלילה.
  • Headline: עד 27 תווים (לא 40 — מתחת לכך נחתך במובייל).
  • Description: 27 תווים — מופיע רק ב-link previews.
  • CTA Button: Shop Now | Learn More | Order Now | Get Offer (בעברית: קנו עכשיו | למידע נוסף).

פורמטים (מסודר לפי יעילות לקפה):
  [1] Reels (מומלץ #1): 8-15 שניות, תנועה, וידאו אמיתי של קלייה/אספרסו יוצק/חיים של הקפה. הכי זול CPM, הכי גבוה reach.
  [2] Single Image (מומלץ #2): תמונה חזקה, דוריא, אור טבעי. כותרת אחת + פריים ברור. פשוט, זול, יעיל.
  [3] Carousel (3-5 שקופיות): מסע לקוח — "איך בוחרים פולים", "מה ההבדל בין מקורות", "כך מגיע אליכם". טוב לסיפור.
  [4] Video (15-60 שניות): רק אם יש סיפור חזק (Origin story, בריסטה, לקוח). יותר יקר לייצר.
  לא להשתמש: תמונת מוצר על רקע לבן בלי הקשר. אף אחד לא עוצר עליה.

--- תקציבים ---
• תקציב יומי מינימלי משמעותי: ₪30/יום לקמפיין (פחות = מטא לא יכולה ללמוד)
• לרטרגטינג חם: ₪20-50/יום (קהל קטן, CPA נמוך)
• לסקיילינג (LAL): ₪80-150/יום
• Advantage+ Shopping: ₪100-200/יום — מקבל priority ממטה
• אם CPA עולה על ₪30 בתוך 3 ימים — עצור. אם יורד מתחת ₪10 — הגדל ב-20% כל יומיים.

--- מבנה מומלץ לחשבון מינוטו ---
CBO (Campaign Budget Optimization) עם 3 ad sets תחת קמפיין אחד:
  • Ad Set A: Retargeting (Website 90d + Cart 30d) — ₪40/יום
  • Ad Set B: LAL 1% of Purchasers — ₪80/יום
  • Ad Set C: Advantage+ Audience (broad) — ₪80/יום
  Meta מחלקת בין Ad Sets אוטומטית לפי ביצועים. תוך שבוע רואים איזה מנצח.

--- מתי לפרסם ---
• שעות Meta טובות לקפה: ראשון 7-10, שלישי-חמישי 12-14, שישי 7-10, שבת 20-23 (מוצ"ש)
• חגים: הגדל תקציב ב-50% שבוע לפני חג. ראש השנה + פסח = פיקים.

=== סוף Meta Ads Expertise ===`;

// Allowed origins for CORS — kept in sync with generate-campaign.
const ALLOWED_ORIGINS = [
  Deno.env.get("COFFEEFLOW_ORIGIN") || "https://coffeeflow-thaf.vercel.app",
  "https://coffeeflow-neon.vercel.app",
  "https://minuto.co.il",
  "https://www.minuto.co.il",
];

function getCorsHeaders(req?: Request): Record<string, string> {
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

// Default headers for codepaths that don't have access to the request.
const CORS = getCorsHeaders();

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

// Current-week Monday — used to let agents analyze running-week campaign
// performance in real time (the owner wants to see how this-week ads are
// trending, not wait for the week to complete).
function getCurrentWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysToThisMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysToThisMonday);
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
  { maxTokens = 5000, timeoutMs = 120_000 }: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (e) {
    clearTimeout(timeout);
    if ((e as Error).name === "AbortError") {
      throw new Error(`Claude API timeout after ${timeoutMs / 1000}s — try again later.`);
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
  { name: 'יום העצמאות', date: '2026-04-29', type: 'major_holiday', marketingNote: 'יום חגיגות — BBQ, אירועים בחוץ, ביקורי משפחה. הזדמנות לקפה כמתנה (חבר מארח), חבילות מנגל מורחבות עם קפה איכותי, ותוכן פטריוטי. התחל קמפיין 2-3 שבועות לפני.' },
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
    national:      30,  // bumped from 14 — need prep time for blackout days
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
  // Explicitly stamp updated_at — Postgres doesn't auto-bump on UPDATE
  // without a trigger, so without this the column stays at the original
  // insert time. That made it look like reruns weren't producing new
  // reports when in fact they were (the report JSON updated, the
  // timestamp didn't).
  const { error } = await supabase
    .from("advisor_reports")
    .upsert(
      { agent_type: agentType, week_start: weekStart, updated_at: new Date().toISOString(), ...fields },
      { onConflict: "agent_type,week_start" },
    );
  if (error) {
    console.error(`[upsertReport] FAILED for ${agentType}/${weekStart}:`, JSON.stringify(error));
  } else {
    console.log(`[upsertReport] OK ${agentType}/${weekStart} status=${fields.status ?? '?'}`);
  }
}

// ── Market Research Module ────────────────────────────────────────────────────
// Uses Serper.dev API for REAL Google search data — who's advertising, who's
// ranking, what people ask, what's trending. Plus competitor page scraping
// for pricing and Google Suggest for real-time search intent.

// Serper.dev search queries — each one returns ads, organic results, People
// Also Ask, and related searches from Israeli Google. This is what a real
// marketing researcher would search.
// Serper search queries — structured by research purpose
const SERPER_SEARCHES = [
  // Core purchase-intent — who's advertising and ranking?
  { q: "פולי קפה", gl: "il", hl: "he", type: "search" },
  { q: "קפה טרי", gl: "il", hl: "he", type: "search" },
  { q: "קפה ספשלטי", gl: "il", hl: "he", type: "search" },
  { q: "פולי קפה אונליין", gl: "il", hl: "he", type: "search" },
  { q: "בית קלייה קפה", gl: "il", hl: "he", type: "search" },
  { q: "פולי קפה טריים משלוח", gl: "il", hl: "he", type: "search" },
  { q: "קפה לאספרסו", gl: "il", hl: "he", type: "search" },
  // Competitor brand searches — what shows when people search for competitors?
  { q: "נחת קפה פולים", gl: "il", hl: "he", type: "search" },
  { q: "jera coffee פולי קפה", gl: "il", hl: "he", type: "search" },
  { q: "blooms coffee roastery", gl: "il", hl: "he", type: "search" },
];

// Serper Places queries — Google Business reviews of coffee roasters
// Shows what customers love/hate about competitors
const SERPER_PLACES = [
  { q: "בית קלייה קפה ספשלטי", gl: "il", hl: "he" },
  { q: "חנות פולי קפה", gl: "il", hl: "he" },
];

// Google Suggest for real-time autocomplete
const SUGGEST_QUERIES = [
  "פולי קפה", "קפה ספשלטי", "קפה טרי", "פולי קפה טריים",
  "פולי קפה אונליין", "פולי קפה משלוח", "פולי קפה למכונת אספרסו",
  "שדרוג קפה ביתי", "בית קלייה", "פולי קפה איכותיים",
  "לקנות פולי קפה", "הזמנת פולי קפה",
];

// Competitor pages to scrape for pricing and product changes.
// This list grows as we discover new competitors.
const COMPETITOR_PAGES = [
  { source: "competitor_nahat", url: "https://www.nahatcoffee.com/shop-coffee-beans/", name: "נחת" },
  { source: "competitor_agro", url: "https://agrocafe.co.il/", name: "אגרו" },
  { source: "competitor_jera", url: "https://www.jera-coffee.co.il/product-category/coffee/", name: "Jera" },
  { source: "competitor_negro", url: "https://negro.co.il/product-category/espresso/", name: "נגרו" },
  { source: "competitor_coffee4u", url: "https://www.coffee4u.co.il/", name: "Coffee4U" },
];

// Serper.dev API — returns structured Google search results including:
// - Paid ads (who's advertising, what ad copy they use)
// - Organic results (who's ranking, what content exists)
// - People Also Ask (what questions people have)
// - Related searches (what else people search for)
interface SerperResult {
  ads?: Array<{ title: string; link: string; snippet: string; sitelinks?: Array<{ title: string }> }>;
  organic?: Array<{ title: string; link: string; snippet: string; position: number }>;
  peopleAlsoAsk?: Array<{ question: string; snippet: string }>;
  relatedSearches?: Array<{ query: string }>;
  searchParameters?: { q: string };
}

// Serper Shopping — Google Shopping product listings with prices
async function searchSerperShopping(query: string): Promise<any[] | null> {
  if (!SERPER_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/shopping", {
      method: "POST",
      headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "il", hl: "he" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.shopping ?? [];
  } catch (e: any) {
    console.log(`[serper-shopping] ${query}: ${e.message}`);
    return null;
  }
}

// Serper News — Google News results
async function searchSerperNews(query: string): Promise<any[] | null> {
  if (!SERPER_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/news", {
      method: "POST",
      headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "il", hl: "he" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.news ?? [];
  } catch (e: any) {
    console.log(`[serper-news] ${query}: ${e.message}`);
    return null;
  }
}

// Google PageSpeed Insights — free, no key needed
async function fetchPageSpeed(url: string): Promise<{ score: number; fcp: number; lcp: number } | null> {
  try {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&strategy=mobile`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    const audit = json.lighthouseResult;
    return {
      score: Math.round((audit?.categories?.performance?.score ?? 0) * 100),
      fcp: Math.round(audit?.audits?.["first-contentful-paint"]?.numericValue ?? 0),
      lcp: Math.round(audit?.audits?.["largest-contentful-paint"]?.numericValue ?? 0),
    };
  } catch (e: any) {
    console.log(`[pagespeed] ${url}: ${e.message}`);
    return null;
  }
}

async function searchSerper(query: string, gl = "il", hl = "he"): Promise<SerperResult | null> {
  if (!SERPER_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, gl, hl, num: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log(`[serper] ${query}: HTTP ${res.status}`);
      return null;
    }
    return await res.json() as SerperResult;
  } catch (e: any) {
    console.log(`[serper] ${query}: ${e.message}`);
    return null;
  }
}

// Serper Places API — returns Google Business listings with ratings and reviews
async function searchSerperPlaces(query: string, gl = "il", hl = "he"): Promise<any[] | null> {
  if (!SERPER_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/places", {
      method: "POST",
      headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl, hl }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.places ?? [];
  } catch (e: any) {
    console.log(`[serper-places] ${query}: ${e.message}`);
    return null;
  }
}

// ── Meta Ad Library ────────────────────────────────────────────────────────
// Shows every ad currently running on Meta (Facebook + Instagram) worldwide,
// filterable by country + page. For commercial ads the API returns:
// page_name, ad_creative_bodies (headlines/body text), ad_creative_link_titles,
// ad_snapshot_url, ad_delivery_start_time. Impressions + spend are political-
// ads only — commercial advertisers don't expose those fields.
//
// We query by `search_page_ids` (NOT search_terms) because keyword search
// mostly surfaces political/issue ads — commercial advertisers are only
// reliably findable by page. Pages come from the `competitor_pages` table,
// which is seeded with known competitors and auto-grows as Serper organic
// results surface new Israeli coffee brands.
//
// Requires:
//   - Meta App identity verification on the owner's personal FB account
//   - A valid access token stored in oauth_tokens (platform='meta')
// Both are confirmed as of April 2026.

async function resolveFbPageId(token: string, vanity: string): Promise<{ id: string | null; name: string | null; error: string | null }> {
  // Resolving a public Page vanity → numeric page_id has two paths:
  //   (1) Graph API /<vanity>?fields=id,name — works ONLY for pages the
  //       current user admins, because `pages_read_engagement` scopes to
  //       pages with a role. Arbitrary competitor pages need "Page Public
  //       Metadata Access" which is locked behind App Review.
  //   (2) Public HTML scrape of facebook.com/<vanity>/ — the page's numeric
  //       ID is embedded in multiple meta tags (al:android:url="fb://page/...",
  //       "pageID":"..." in inline JSON). No auth needed, no App Review.
  // Try (1) first; fall back to (2) on the common permission error.
  try {
    const gUrl = `https://graph.facebook.com/v19.0/${encodeURIComponent(vanity)}?fields=id,name&access_token=${token}`;
    const gRes = await fetch(gUrl);
    const gData = await gRes.json();
    if (!gData.error && gData.id) {
      return { id: gData.id, name: gData.name ?? null, error: null };
    }
    // Graph API failed — fall through to HTML scrape.
    const htmlRes = await fetch(`https://www.facebook.com/${encodeURIComponent(vanity)}/`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CoffeeFlow-Research/1.0)" },
    });
    if (!htmlRes.ok) {
      return { id: null, name: null, error: `HTML fetch ${htmlRes.status}; graph error: ${gData.error?.message ?? "unknown"}` };
    }
    const html = await htmlRes.text();
    // FB embeds the page ID in several places. The most reliable one is the
    // App Links meta tag `al:android:url` / `al:ios:url` which contains
    // fb://profile/<id> or fb://page/<id> — this is set server-side even on
    // login-walled HTML and doesn't depend on JS-rendered blocks.
    const pageId =
      html.match(/fb:\/\/profile\/(\d+)/)?.[1] ??
      html.match(/fb:\/\/page\/(\d+)/)?.[1] ??
      html.match(/"pageID":"(\d+)"/)?.[1] ??
      html.match(/"entity_id":"(\d+)"/)?.[1] ??
      html.match(/"page_id":"(\d+)"/)?.[1];
    if (!pageId) {
      return { id: null, name: null, error: `HTML scrape found no page ID; graph error: ${gData.error?.message ?? "unknown"}` };
    }
    const nameMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    return { id: pageId, name: nameMatch?.[1] ?? null, error: null };
  } catch (e: any) {
    return { id: null, name: null, error: e?.message ?? "resolveFbPageId threw" };
  }
}

async function searchMetaAdLibraryByPage(
  token: string,
  pageId: string,
  country = "IL",
  limit = 25,
): Promise<{ ads: any[] | null; error: string | null }> {
  const fields = [
    "id",
    "page_name",
    "ad_creative_bodies",
    "ad_creative_link_titles",
    "ad_creative_link_descriptions",
    "ad_snapshot_url",
    "ad_delivery_start_time",
    "ad_delivery_stop_time",
    "publisher_platforms",
  ].join(",");
  const url = `https://graph.facebook.com/v19.0/ads_archive?` + new URLSearchParams({
    search_page_ids:       `[${pageId}]`,
    ad_reached_countries:  `['${country}']`,
    ad_active_status:      "ACTIVE",
    ad_type:               "ALL",
    fields,
    limit:                 String(limit),
    access_token:          token,
  });
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error(`[research] Meta Ad Library error for page ${pageId}:`, data.error.message);
      return { ads: null, error: data.error.message };
    }
    return { ads: data.data ?? [], error: null };
  } catch (e: any) {
    return { ads: null, error: e?.message ?? "fetch threw" };
  }
}

// Scrape a competitor homepage for its Facebook page URL. Returns the vanity
// segment (e.g. "Nachatcafe") which can then be resolved to a numeric page_id.
// Used by the Serper auto-discovery path when a new domain appears in organic
// results — we peek at the homepage and only add it to competitor_pages if it
// actually has a public Facebook presence.
// Same idea as scrapeFbVanityFromSite but for Instagram. Most coffee brands
// link to their IG account in the footer/header. We need the @handle (not a
// numeric ID) — the IG Business Discovery API takes username strings.
async function scrapeIgHandleFromSite(domain: string): Promise<string | null> {
  const IG_SYSTEM_PATHS = new Set([
    "p", "explore", "reel", "reels", "stories", "tv", "accounts",
    "direct", "tags", "locations", "challenge",
  ]);
  try {
    const res = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "CoffeeFlow-Research/1.0" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const matches = [...html.matchAll(/instagram\.com\/([a-zA-Z0-9._]+)/g)];
    for (const m of matches) {
      const handle = m[1].replace(/\/$/, "");
      if (!IG_SYSTEM_PATHS.has(handle.toLowerCase())) return handle;
    }
    return null;
  } catch {
    return null;
  }
}

// IG Business Discovery: fetch ANY public IG Business/Creator account's
// recent media + stats, using OUR IG Business Account as the "viewer". Works
// with `instagram_basic` permission — no special access needed beyond what
// meta-sync already has.
//
// This is THE legitimate way to do competitive Instagram analysis on the
// Meta platform. Unlike the Ad Library API (which only covers paid
// political ads in Israel), this surfaces every organic post the
// competitor publishes — captions, like + comment counts, post type
// (reel/feed), timestamp, media URL.
async function fetchIgBusinessDiscovery(
  token: string,
  ourIgUserId: string,
  targetUsername: string,
): Promise<{ data: any | null; error: string | null }> {
  const subFields = "id,username,name,biography,followers_count,follows_count,media_count,media.limit(15){id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url}";
  const url = `https://graph.facebook.com/v19.0/${ourIgUserId}?` + new URLSearchParams({
    fields:       `business_discovery.username(${targetUsername}){${subFields}}`,
    access_token: token,
  });
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) return { data: null, error: data.error.message };
    return { data: data.business_discovery ?? null, error: null };
  } catch (e: any) {
    return { data: null, error: e?.message ?? "fetch threw" };
  }
}

async function scrapeFbVanityFromSite(domain: string): Promise<string | null> {
  // Facebook system paths that aren't actual page vanities — if we see these
  // it means the site linked to Groups/Profiles/other non-Page stuff. Trying
  // to resolve these as pages always fails.
  const FB_SYSTEM_PATHS = new Set([
    "tr", "sharer", "share", "plugins", "dialog", "pages", "login", "privacy",
    "groups", "profile.php", "watch", "events", "marketplace", "stories",
    "reel", "reels", "videos", "photo.php", "photos", "hashtag", "search",
    "business", "ads", "help", "policies", "settings", "messages",
    "profile", "people", "pg", "policy", "home.php",
  ]);
  try {
    const res = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "CoffeeFlow-Research/1.0" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // The homepage often has several facebook.com links (footer, og:tags,
    // tracking pixels). Iterate and pick the first that ISN'T a system path.
    const matches = [...html.matchAll(/facebook\.com\/([a-zA-Z0-9._-]+)/g)];
    for (const m of matches) {
      const vanity = m[1];
      if (!FB_SYSTEM_PATHS.has(vanity.toLowerCase())) return vanity;
    }
    return null;
  } catch {
    return null;
  }
}

async function scrapeCompetitorPage(url: string, timeout = 10000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "CoffeeFlow-Research/1.0", "Accept-Language": "he-IL,he;q=0.9" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    // Extract just the body content, strip scripts/styles
    const body = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000); // Keep first 4K chars — products/prices/promos
    return body;
  } catch (e: any) {
    console.log(`[research] Scrape failed for ${url}: ${e.message}`);
    return null;
  }
}

async function fetchGoogleSuggest(query: string): Promise<string[]> {
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}&hl=he&gl=il`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const json = await res.json();
    // Firefox suggest returns [query, [suggestions]]
    return Array.isArray(json[1]) ? json[1].slice(0, 8) : [];
  } catch {
    return [];
  }
}

// ── Tier 1: Deep Suggest Expansion ─────────────────────────────────────────
// Chains Google Suggest 2 levels deep. A single seed "פולי קפה" returns 8
// suggestions. Taking the top 5 of those as new seeds gives ~40 next-level
// candidates. Deduped + stripped of the seeds themselves, that's typically
// 30-50 NOVEL long-tail queries we never would have typed ourselves.
async function deepSuggestExpand(seeds: string[]): Promise<string[]> {
  // Single level only — level-2 chaining hits Supabase's worker resource
  // limit when combined with the rest of market_research. One level still
  // surfaces 30-50 long-tail candidates per 5 seeds, which is plenty.
  const expanded = new Set<string>();
  for (const seed of seeds) {
    const sug = await fetchGoogleSuggest(seed);
    for (const s of sug) if (s && s !== seed) expanded.add(s);
  }
  return [...expanded];
}

// ── Tier 2: LLM-powered novel keyword brainstorm ───────────────────────────
// Haiku generates 50 novel long-tail Hebrew coffee queries that a real
// Israeli might type — problem-based, question-based, journey-stage-based.
// Explicitly excludes the obvious seed terms we already research so the
// output is genuinely additive, not a rehash.
async function llmBrainstormKeywords(existingSeeds: string[]): Promise<string[]> {
  if (!ANTHROPIC_KEY) return [];
  const systemPrompt = `אתה מומחה למחקר מילות מפתח בשוק הקפה הישראלי (B2C).
המשימה: הפק 50 שאילתות Hebrew ארוכות-זנב שישראלי אמיתי עשוי להקליד בגוגל — אבל לא הביטויים הברורים.

כללים:
✓ שאילתות מבוססות בעיה: "למה הקפה שלי יוצא מר", "איך להפיק אספרסו חזק מפולים רגילים", "מכונת קפה לא מייצרת קרם"
✓ שאילתות מבוססות שאלה: "כמה זמן פולי קפה נשארים טריים", "מה ההבדל בין ערביקה לרובוסטה", "האם פולים ישנים בטוחים לשתייה"
✓ שאילתות משלב-מסע: "רוצה לשדרג את הקפה בבוקר", "עברתי ממכונת קפסולות למכונת אספרסו", "בחירת פולים למכונת דלונגי ביתית"
✓ שאילתות סביב כאב ספציפי: "קפה שעלה 100 שקל ולא טעים", "קרמה חלשה באספרסו", "ריח כימי בקפה"
✓ בעברית תקינה ומדוברת — לא תרגום ממכונה

✗ אסור: הביטויים הברורים שכבר ברשימת היציאה למטה
✗ אסור: תרגומים מאנגלית ("coffee beans fresh" → "פולי קפה טריים" — כבר יש)
✗ אסור: שאילתות של מילה אחת או שתיים

הביטויים שכבר קיימים אצלנו (אל תחזיר אותם ולא וריאציות טריוויאליות):
${existingSeeds.map(s => `- ${s}`).join("\n")}

החזר JSON בלבד במבנה: { "queries": ["שאילתה 1", "שאילתה 2", ...] } — 50 שאילתות שונות.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: "user", content: "הפק את 50 השאילתות עכשיו." }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json();
    const raw  = json.content?.[0]?.text ?? "";
    const clean = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed.queries) ? parsed.queries.filter((q: any) => typeof q === "string" && q.length > 8).slice(0, 50) : [];
  } catch (e: any) {
    console.error("[llm-brainstorm] failed:", e?.message);
    return [];
  }
}

// Batch-validate keywords by quick Serper shopping check. A keyword with
// 3+ shopping advertisers has real commercial demand and is worth feeding
// to the strategist agents. Keywords with 0 shopping are usually informational
// (or too niche) — keep a few for SEO/content strategy, drop the rest.
async function validateKeywordsViaSerper(
  keywords: string[],
  cap = 30,
): Promise<Array<{ keyword: string; shopping_count: number; top_advertiser: string | null }>> {
  const out: Array<{ keyword: string; shopping_count: number; top_advertiser: string | null }> = [];
  for (const kw of keywords.slice(0, cap)) {
    try {
      const shopping = await searchSerperShopping(kw);
      const count = shopping?.length ?? 0;
      const topAdv = count > 0 ? ((shopping?.[0] as any)?.source ?? null) : null;
      out.push({ keyword: kw, shopping_count: count, top_advertiser: topAdv });
    } catch {
      out.push({ keyword: kw, shopping_count: 0, top_advertiser: null });
    }
  }
  return out;
}

// Google Trends — shows what's trending in Israel for coffee-related topics.
// Uses the unofficial explore API which returns interest-over-time data.
async function fetchGoogleTrends(keywords: string[]): Promise<Record<string, string> | null> {
  try {
    // Google Trends daily trends API for Israel
    const dailyUrl = `https://trends.google.com/trends/api/dailytrends?hl=he&tz=-120&geo=IL&ns=15`;
    const dailyRes = await fetch(dailyUrl, { signal: AbortSignal.timeout(8000) });
    if (!dailyRes.ok) return null;
    // Google Trends prefixes response with ")]}'," — strip it
    let text = await dailyRes.text();
    text = text.replace(/^\)\]\}',?\n?/, "");
    const json = JSON.parse(text);

    // Extract trending topics
    const trends: Record<string, string> = {};
    const trendingSearches = json?.default?.trendingSearchesDays ?? [];
    for (const day of trendingSearches.slice(0, 2)) {
      for (const search of (day.trendingSearches ?? []).slice(0, 10)) {
        const title = search.title?.query ?? "";
        const traffic = search.formattedTraffic ?? "";
        if (title) trends[title] = traffic;
      }
    }
    return Object.keys(trends).length > 0 ? trends : null;
  } catch (e: any) {
    console.log(`[research] Google Trends error: ${e.message}`);
    return null;
  }
}

// Google "People Also Ask" — scrape related questions from Google search
// These are gold for content and long-tail keywords
async function fetchRelatedQuestions(query: string): Promise<string[]> {
  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=he&gl=il`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept-Language": "he-IL,he;q=0.9",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    // Extract "People Also Ask" questions — they're in data-q attributes or specific divs
    const questions: string[] = [];
    const regex = /data-q="([^"]+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (match[1].length > 10 && match[1].length < 150) {
        questions.push(match[1]);
      }
    }
    return questions.slice(0, 5);
  } catch {
    return [];
  }
}

async function runMarketResearch(supabase: ReturnType<typeof createClient>): Promise<{ sources: number; errors: number }> {
  const today = new Date().toISOString().split("T")[0];
  let sources = 0, errors = 0;

  // 1. SERPER.DEV — Real Google search results (ads + organic + PAA)
  // This is the most valuable research source. Each query shows:
  // - Who's paying for ads on this keyword (competitor ad copy!)
  // - Who ranks organically (competitor content strategy)
  // - What questions people ask (content opportunities)
  // - Related searches (keyword expansion)
  if (SERPER_KEY) {
    for (const search of SERPER_SEARCHES) {
      try {
        console.log(`[research] Serper: "${search.q}"...`);
        // Text search + Shopping in parallel. Google shows SHOPPING ads
        // (product carousel) for many commercial queries instead of — or in
        // addition to — text ads. The old code only looked at text ads, so
        // queries like "פולי קפה" appeared to have "no advertisers" even
        // though competitors dominate the shopping carousel. Fetching both
        // gives the agent the complete "who's paying to appear" picture.
        const [result, shopping] = await Promise.all([
          searchSerper(search.q, search.gl, search.hl),
          searchSerperShopping(search.q),
        ]);
        if (result || (shopping && shopping.length > 0)) {
          await supabase.from("market_research").upsert(
            {
              research_date: today,
              source: `serper_${search.q.replace(/\s+/g, '_').slice(0, 40)}`,
              raw_data: {
                query: search.q,
                ads: (result?.ads ?? []).slice(0, 5).map(a => ({ title: a.title, link: a.link, snippet: a.snippet })),
                organic: (result?.organic ?? []).slice(0, 8).map(o => ({ title: o.title, link: o.link, snippet: o.snippet, position: o.position })),
                peopleAlsoAsk: (result?.peopleAlsoAsk ?? []).slice(0, 5).map(p => ({ question: p.question })),
                relatedSearches: (result?.relatedSearches ?? []).slice(0, 5).map(r => r.query),
                shopping: (shopping ?? []).slice(0, 10).map((p: any) => ({
                  title:  p.title,
                  price:  p.price,
                  source: p.source,          // advertiser / store name
                  link:   p.link,
                  rating: p.rating,
                })),
              },
            },
            { onConflict: "research_date,source" },
          );
          sources++;
        }
      } catch (e: any) {
        console.error(`[research] Serper "${search.q}": ${e.message}`);
        errors++;
      }
    }
  } else {
    console.log("[research] No SERPER_API_KEY — skipping Google search research");
  }

  // 2. Competitor page scraping — pricing/products/promotions
  for (const comp of COMPETITOR_PAGES) {
    try {
      console.log(`[research] Scraping ${comp.name}...`);
      const text = await scrapeCompetitorPage(comp.url);
      if (text) {
        await supabase.from("market_research").upsert(
          { research_date: today, source: comp.source, raw_data: { text: text.slice(0, 3000), url: comp.url, name: comp.name } },
          { onConflict: "research_date,source" },
        );
        sources++;
      }
    } catch (e: any) {
      console.error(`[research] ${comp.name}: ${e.message}`);
      errors++;
    }
  }

  // 3. Google Business Reviews — what customers say about competing roasters
  if (SERPER_KEY) {
    for (const search of SERPER_PLACES) {
      try {
        console.log(`[research] Serper Places: "${search.q}"...`);
        const places = await searchSerperPlaces(search.q, search.gl, search.hl);
        if (places && places.length > 0) {
          const cleaned = places.slice(0, 10).map((p: any) => ({
            title: p.title,
            rating: p.rating,
            reviews: p.reviews,
            address: p.address,
            category: p.category,
          }));
          await supabase.from("market_research").upsert(
            { research_date: today, source: `places_${search.q.replace(/\s+/g, '_').slice(0, 30)}`, raw_data: { query: search.q, places: cleaned } },
            { onConflict: "research_date,source" },
          );
          sources++;
        }
      } catch (e: any) {
        console.error(`[research] Places "${search.q}": ${e.message}`);
        errors++;
      }
    }
  }

  // 3.5 Novel keyword discovery — Tier 1 (deep Suggest) + Tier 2 (LLM brainstorm)
  // + Serper shopping validation. Gives agents genuinely non-obvious long-tail
  // keywords they wouldn't recommend from the 10-query hardcoded seed list.
  try {
    console.log("[research] Novel keyword discovery starting...");
    const seedTexts = SERPER_SEARCHES.map(s => s.q);

    // Tier 1: chain Google Suggest 2 levels deep (free, fast, ~100 candidates)
    const deepSuggested = await deepSuggestExpand(seedTexts.slice(0, 5));
    console.log(`[research] Deep Suggest: ${deepSuggested.length} candidates`);

    // Tier 2: Haiku brainstorm 50 novel long-tail queries (~$0.005, cheap)
    const brainstormed = await llmBrainstormKeywords(seedTexts);
    console.log(`[research] LLM brainstorm: ${brainstormed.length} candidates`);

    // Merge + dedupe, prioritizing LLM (usually more creative) over deep Suggest.
    // Cap at 15 to stay under Supabase's worker CPU limit (each validation is
    // a Serper call and the whole function is already doing ~30 API fetches).
    const candidates = [...new Set([...brainstormed, ...deepSuggested])].slice(0, 15);

    // Validate: check which have real shopping demand in Israel
    const validated = await validateKeywordsViaSerper(candidates, 15);

    // Keep the top 20 by demand signal (most advertisers = most commercial intent).
    // Also keep up to 5 zero-shopping ones as "organic content opportunities"
    // — keywords with search volume but no paid competition → pure SEO targets.
    const withDemand = validated.filter(v => v.shopping_count >= 2).sort((a, b) => b.shopping_count - a.shopping_count).slice(0, 20);
    const openField  = validated.filter(v => v.shopping_count === 0).slice(0, 5);

    await supabase.from("market_research").upsert(
      {
        research_date: today,
        source: "novel_keywords",
        raw_data: {
          with_paid_demand:     withDemand,   // real commercial intent — worth paid campaigns
          open_field_seo:       openField,    // no paid competition — pure SEO/content
          total_generated:      candidates.length,
          from_deep_suggest:    deepSuggested.length,
          from_llm_brainstorm:  brainstormed.length,
        },
      },
      { onConflict: "research_date,source" },
    );
    sources++;
    console.log(`[research] Novel keywords stored: ${withDemand.length} with demand, ${openField.length} open-field`);
  } catch (e: any) {
    console.error("[research] Novel keyword discovery failed:", e?.message);
    errors++;
  }

  // 4. Meta Ad Library — what ads competitors are running RIGHT NOW on FB+IG.
  // Uses the same Meta OAuth token as meta-sync; requires identity-verified App.
  //
  // Two sub-steps:
  //   (a) DISCOVERY: extract unique hostnames from today's Serper organic
  //       results (all queries) and for each new hostname that's not in
  //       competitor_pages, scrape its homepage for a Facebook URL and insert.
  //   (b) QUERY: resolve any unresolved fb_page_id via /<vanity>?fields=id,
  //       then query Ad Library per page_id and store ads.
  //
  // Self-growing: tomorrow's new competitor that starts ranking on any of
  // the Serper queries is automatically picked up on the next run without
  // any code change.
  try {
    const { data: tokenRow } = await supabase
      .from("oauth_tokens").select("access_token").eq("platform", "meta").single();
    const metaToken = (tokenRow as any)?.access_token;
    if (!metaToken) {
      console.log("[research] No Meta token — skipping Ad Library");
    } else {
      // ── (a) DISCOVERY from Serper organic results ──────────────────────
      // Collect every unique hostname from today's Serper rows (we just wrote
      // them above). Minuto itself + known competitors get skipped.
      const SKIP_HOSTS = new Set([
        "minuto.co.il", "www.minuto.co.il",
        "google.com", "www.google.com", "youtube.com", "www.youtube.com",
        "facebook.com", "www.facebook.com", "instagram.com", "www.instagram.com",
        "wikipedia.org", "he.wikipedia.org", "en.wikipedia.org",
        "ynet.co.il", "www.ynet.co.il", "haaretz.co.il", "www.haaretz.co.il",
        "mako.co.il", "www.mako.co.il", "walla.co.il", "www.walla.co.il",
      ]);
      const { data: todaySerper } = await supabase
        .from("market_research")
        .select("raw_data")
        .eq("research_date", today)
        .like("source", "serper_%");

      const seenDomains = new Set<string>();
      for (const row of (todaySerper ?? [])) {
        const organic = ((row.raw_data as any)?.organic ?? []) as Array<{ link?: string }>;
        for (const o of organic) {
          try {
            const host = new URL(o.link ?? "").hostname.replace(/^www\./, "");
            if (host && !SKIP_HOSTS.has(host) && !SKIP_HOSTS.has(`www.${host}`)) seenDomains.add(host);
          } catch { /* invalid URL — skip */ }
        }
      }

      // Load known competitor rows to see which domains we've already seen.
      const { data: knownRows } = await supabase
        .from("competitor_pages").select("id, domain, fb_vanity, fb_page_id, name, resolve_attempts");
      const knownByDomain = new Map((knownRows ?? []).map(r => [r.domain, r]));

      let discovered = 0;
      for (const domain of seenDomains) {
        if (knownByDomain.has(domain)) continue;
        if (discovered >= 5) break;  // cap new domains per run
        // Scrape both FB and IG in parallel to cut latency.
        const [vanity, igHandle] = await Promise.all([
          scrapeFbVanityFromSite(domain),
          scrapeIgHandleFromSite(domain),
        ]);
        const last_error = (!vanity && !igHandle) ? "no_fb_or_ig_link_on_homepage" : null;
        await supabase.from("competitor_pages").insert({
          domain,
          fb_vanity: vanity,
          ig_username: igHandle,
          discovery_source: "serper_auto",
          last_error,
        });
        console.log(`[research] Discovered: ${domain} → fb:${vanity ?? "—"} ig:${igHandle ?? "—"}`);
        discovered++;
      }

      // Also opportunistically scrape IG handles for already-known competitors
      // that don't have one yet (the schema added ig_username later than fb_vanity).
      const { data: missingIg } = await supabase
        .from("competitor_pages")
        .select("id, domain")
        .not("domain", "is", null)
        .is("ig_username", null);
      for (const row of (missingIg ?? []).slice(0, 10)) {
        const igHandle = await scrapeIgHandleFromSite(row.domain);
        if (igHandle) {
          await supabase.from("competitor_pages")
            .update({ ig_username: igHandle })
            .eq("id", row.id);
          console.log(`[research] Backfilled IG for ${row.domain}: ${igHandle}`);
        }
      }

      // ── (b) RESOLVE unresolved page IDs + QUERY Ad Library ─────────────
      const { data: allRows } = await supabase
        .from("competitor_pages")
        .select("id, domain, fb_vanity, fb_page_id, name, resolve_attempts")
        .not("fb_vanity", "is", null);

      for (const row of (allRows ?? [])) {
        // Resolve ID if we don't have one yet (and haven't already failed too many times)
        if (!row.fb_page_id) {
          if ((row.resolve_attempts ?? 0) >= 3) continue;  // give up after 3 tries — probably a private/bad vanity
          const resolved = await resolveFbPageId(metaToken, row.fb_vanity);
          if (resolved.id) {
            await supabase.from("competitor_pages")
              .update({ fb_page_id: resolved.id, name: row.name ?? resolved.name, last_error: null, last_checked: new Date().toISOString() })
              .eq("id", row.id);
            row.fb_page_id = resolved.id;
            row.name = row.name ?? resolved.name;
            console.log(`[research] Resolved ${row.fb_vanity} → page_id ${resolved.id}`);
          } else {
            await supabase.from("competitor_pages")
              .update({ resolve_attempts: (row.resolve_attempts ?? 0) + 1, last_error: resolved.error, last_checked: new Date().toISOString() })
              .eq("id", row.id);
            console.warn(`[research] Failed to resolve ${row.fb_vanity}: ${resolved.error}`);
            continue;
          }
        }

        // Query Ad Library for this page
        const pageLabel = (row.name ?? row.fb_vanity ?? row.fb_page_id ?? "").toString().slice(0, 40);
        try {
          const { ads, error: adsError } = await searchMetaAdLibraryByPage(metaToken, row.fb_page_id!);
          const n = ads?.length ?? 0;
          console.log(`[research] Meta Ad Library page=${row.fb_page_id} (${pageLabel}): ${n} ads ${adsError ? `ERR: ${adsError}` : ""}`);
          if (ads && ads.length > 0) {
            const cleaned = ads.slice(0, 15).map((a: any) => ({
              page_name:        a.page_name,
              bodies:           (a.ad_creative_bodies           ?? []).slice(0, 3),
              link_titles:      (a.ad_creative_link_titles      ?? []).slice(0, 3),
              link_descriptions:(a.ad_creative_link_descriptions ?? []).slice(0, 3),
              snapshot_url:     a.ad_snapshot_url,
              started:          a.ad_delivery_start_time,
              platforms:        a.publisher_platforms,
            }));
            await supabase.from("market_research").upsert(
              { research_date: today, source: `meta_ads_${row.fb_page_id}`, raw_data: { page_id: row.fb_page_id, competitor: row.name ?? row.fb_vanity, ads: cleaned, total: ads.length } },
              { onConflict: "research_date,source" },
            );
            // Clear any stale last_error now that the query succeeded.
            await supabase.from("competitor_pages")
              .update({ last_error: null, last_checked: new Date().toISOString() })
              .eq("id", row.id);
            sources++;
          } else if (adsError) {
            // Persist the exact Ad Library error onto the row so we can
            // diagnose by querying competitor_pages — avoids digging through
            // function logs for a per-page breakdown.
            await supabase.from("competitor_pages")
              .update({ last_error: `ad_lib: ${adsError}`, last_checked: new Date().toISOString() })
              .eq("id", row.id);
            errors++;
          } else {
            // Zero ads is legitimate — competitor isn't running ads right now.
            await supabase.from("competitor_pages")
              .update({ last_error: "ad_lib: 0 ads active", last_checked: new Date().toISOString() })
              .eq("id", row.id);
          }
        } catch (e: any) {
          console.error(`[research] Meta Ad Library page=${row.fb_page_id} threw: ${e.message}`);
          await supabase.from("competitor_pages")
            .update({ last_error: `ad_lib threw: ${e?.message ?? "unknown"}`, last_checked: new Date().toISOString() })
            .eq("id", row.id);
          errors++;
        }
      }
      // ── (c) IG BUSINESS DISCOVERY — what competitors POST organically ──
      // The Ad Library API is blind to most Israeli commercial ads (Meta
      // platform limitation). The real signal lives in organic Instagram
      // posts. Business Discovery returns recent media + engagement for
      // ANY public IG Business/Creator account, using OUR IG account as
      // the viewer. Works with the instagram_basic permission we already
      // have — no extra scopes needed.
      try {
        const { data: ourIg } = await supabase
          .from("oauth_tokens")
          .select("metadata")
          .eq("platform", "meta")
          .single();
        // Fallback: hardcoded from prior meta-sync stats. If oauth_tokens
        // doesn't store the IG ID (it doesn't today), we use the known one.
        // This will Just Work because we already verified ig_account_id =
        // 17841404082981965 earlier in this session.
        const ourIgUserId = (ourIg as any)?.metadata?.ig_user_id ?? "17841404082981965";

        const { data: igTargets } = await supabase
          .from("competitor_pages")
          .select("id, domain, ig_username, name")
          .not("ig_username", "is", null);

        for (const row of (igTargets ?? [])) {
          try {
            const { data: bd, error: bdErr } = await fetchIgBusinessDiscovery(metaToken, ourIgUserId, row.ig_username!);
            if (bdErr) {
              console.error(`[research] IG business_discovery @${row.ig_username}: ${bdErr}`);
              await supabase.from("competitor_pages")
                .update({ last_error: `ig_bd: ${bdErr}`, last_checked: new Date().toISOString() })
                .eq("id", row.id);
              errors++;
              continue;
            }
            if (!bd) continue;

            const media = (bd.media?.data ?? []).slice(0, 12).map((m: any) => ({
              type:        m.media_product_type ?? m.media_type, // FEED|REEL|STORY
              caption:     (m.caption ?? "").slice(0, 400),
              likes:       m.like_count ?? 0,
              comments:    m.comments_count ?? 0,
              timestamp:   m.timestamp,
              permalink:   m.permalink,
              thumbnail:   m.thumbnail_url ?? m.media_url,
            }));

            await supabase.from("market_research").upsert(
              {
                research_date: today,
                source: `ig_competitor_${row.ig_username}`,
                raw_data: {
                  username:        bd.username,
                  name:            bd.name,
                  bio:             bd.biography,
                  followers:       bd.followers_count,
                  following:       bd.follows_count,
                  total_posts:     bd.media_count,
                  recent_media:    media,
                  domain:          row.domain,
                },
              },
              { onConflict: "research_date,source" },
            );
            await supabase.from("competitor_pages")
              .update({ last_error: null, last_checked: new Date().toISOString() })
              .eq("id", row.id);
            console.log(`[research] IG @${row.ig_username}: ${bd.followers_count} followers, ${media.length} recent posts`);
            sources++;
          } catch (e: any) {
            console.error(`[research] IG @${row.ig_username} threw: ${e.message}`);
            errors++;
          }
        }
      } catch (e: any) {
        console.error(`[research] IG Business Discovery setup: ${e.message}`);
        errors++;
      }
    }
  } catch (e: any) {
    console.error(`[research] Meta Ad Library / IG setup: ${e.message}`);
    errors++;
  }

  // 5. Price change tracking — compare today's competitor scrape to yesterday's
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const { data: yesterdayData } = await supabase
      .from("market_research")
      .select("source, raw_data")
      .eq("research_date", yesterday)
      .like("source", "competitor_%");

    if (yesterdayData && yesterdayData.length > 0) {
      const { data: todayData } = await supabase
        .from("market_research")
        .select("source, raw_data")
        .eq("research_date", today)
        .like("source", "competitor_%");

      if (todayData) {
        const changes: string[] = [];
        for (const todayRow of todayData) {
          const yesterdayRow = yesterdayData.find((y: any) => y.source === todayRow.source);
          if (yesterdayRow) {
            const todayText = (todayRow.raw_data as any)?.text ?? "";
            const yesterdayText = (yesterdayRow.raw_data as any)?.text ?? "";
            if (todayText !== yesterdayText) {
              changes.push(`${todayRow.source}: content changed`);
            }
          }
        }
        if (changes.length > 0) {
          await supabase.from("market_research").upsert(
            { research_date: today, source: "price_changes", raw_data: { changes, note: "Competitor pages that changed since yesterday" } },
            { onConflict: "research_date,source" },
          );
          sources++;
          console.log(`[research] Price tracking: ${changes.length} competitor pages changed`);
        }
      }
    }
  } catch (e: any) {
    console.error(`[research] Price tracking error: ${e.message}`);
  }

  // 5. Google Shopping — competitor product prices
  if (SERPER_KEY) {
    try {
      console.log("[research] Serper Shopping: פולי קפה...");
      const shopping = await searchSerperShopping("פולי קפה");
      if (shopping && shopping.length > 0) {
        await supabase.from("market_research").upsert(
          {
            research_date: today, source: "google_shopping",
            raw_data: {
              query: "פולי קפה",
              products: shopping.slice(0, 15).map((p: any) => ({
                title: p.title, price: p.price, source: p.source, link: p.link, rating: p.rating, reviews: p.ratingCount,
              })),
            },
          },
          { onConflict: "research_date,source" },
        );
        sources++;
        console.log(`[research] Shopping: ${shopping.length} products found`);
      }
    } catch (e: any) { errors++; }
  }

  // 6. Google News — coffee industry news in Israel
  if (SERPER_KEY) {
    try {
      console.log("[research] Serper News: קפה ספשלטי ישראל...");
      const news = await searchSerperNews("קפה ספשלטי ישראל");
      if (news && news.length > 0) {
        await supabase.from("market_research").upsert(
          {
            research_date: today, source: "google_news",
            raw_data: news.slice(0, 8).map((n: any) => ({ title: n.title, snippet: n.snippet, source: n.source, date: n.date })),
          },
          { onConflict: "research_date,source" },
        );
        sources++;
        console.log(`[research] News: ${news.length} articles`);
      }
    } catch (e: any) { errors++; }
  }

  // 7. PageSpeed — competitor site speed (slow site = our advantage)
  try {
    console.log("[research] PageSpeed: checking competitor sites...");
    const speedResults: Record<string, any> = {};
    const sitesToCheck = [
      { name: "Minuto", url: "https://www.minuto.co.il" },
      { name: "נחת", url: "https://www.nahatcoffee.com" },
      { name: "Jera", url: "https://www.jera-coffee.co.il" },
      { name: "אגרו", url: "https://agrocafe.co.il" },
    ];
    for (const site of sitesToCheck) {
      const speed = await fetchPageSpeed(site.url);
      if (speed) speedResults[site.name] = { ...speed, url: site.url };
    }
    if (Object.keys(speedResults).length > 0) {
      await supabase.from("market_research").upsert(
        { research_date: today, source: "pagespeed", raw_data: speedResults },
        { onConflict: "research_date,source" },
      );
      sources++;
      console.log(`[research] PageSpeed: ${Object.keys(speedResults).length} sites checked`);
    }
  } catch (e: any) { errors++; }

  // 8. Google Suggest — what Israelis are ACTUALLY searching right now
  // This is the most valuable research source because it shows real intent
  try {
    console.log("[research] Fetching Google Suggest (20 queries)...");
    const allSuggestions: Record<string, string[]> = {};
    for (const q of SUGGEST_QUERIES) {
      const suggestions = await fetchGoogleSuggest(q);
      if (suggestions.length > 0) allSuggestions[q] = suggestions;
    }
    if (Object.keys(allSuggestions).length > 0) {
      await supabase.from("market_research").upsert(
        { research_date: today, source: "google_suggest", raw_data: allSuggestions },
        { onConflict: "research_date,source" },
      );
      sources++;
      console.log(`[research] Google Suggest: ${Object.keys(allSuggestions).length} queries`);
    }
  } catch (e: any) {
    console.error(`[research] Google Suggest error: ${e.message}`);
    errors++;
  }

  // 3. Google Trends — what's trending in Israel today
  try {
    console.log("[research] Fetching Google Trends (Israel)...");
    const trends = await fetchGoogleTrends(["קפה", "פולי קפה"]);
    if (trends) {
      await supabase.from("market_research").upsert(
        { research_date: today, source: "google_trends_daily", raw_data: trends },
        { onConflict: "research_date,source" },
      );
      sources++;
      console.log(`[research] Google Trends: ${Object.keys(trends).length} trending topics`);
    }
  } catch (e: any) {
    console.error(`[research] Google Trends error: ${e.message}`);
    errors++;
  }

  // 4. "People Also Ask" — what questions Israelis ask about coffee
  try {
    console.log("[research] Fetching People Also Ask...");
    const paaQueries = ["פולי קפה", "קפה ספשלטי", "בית קלייה קפה"];
    const allQuestions: Record<string, string[]> = {};
    for (const q of paaQueries) {
      const questions = await fetchRelatedQuestions(q);
      if (questions.length > 0) allQuestions[q] = questions;
    }
    if (Object.keys(allQuestions).length > 0) {
      await supabase.from("market_research").upsert(
        { research_date: today, source: "people_also_ask", raw_data: allQuestions },
        { onConflict: "research_date,source" },
      );
      sources++;
      console.log(`[research] PAA: ${Object.values(allQuestions).flat().length} questions found`);
    }
  } catch (e: any) {
    console.error(`[research] PAA error: ${e.message}`);
    errors++;
  }

  console.log(`[research] Done: ${sources} sources, ${errors} errors`);
  return { sources, errors };
}

// Format research data for injection into strategist system prompts
async function getResearchBlock(supabase: ReturnType<typeof createClient>): Promise<string> {
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  // Get today's or yesterday's research
  const { data: rows } = await supabase
    .from("market_research")
    .select("source, raw_data, research_date")
    .in("research_date", [today, yesterday])
    .order("research_date", { ascending: false });

  if (!rows || rows.length === 0) return "\nאין מחקר שוק זמין — הסוכנים רצים ללא נתוני מתחרים עדכניים.\n";

  const lines: string[] = [`\n=== מחקר שוק יומי (${rows[0].research_date}) ===`];

  // Separate Serper results from other sources for better organization
  const serperRows = rows.filter(r => r.source.startsWith("serper_"));
  const otherRows = rows.filter(r => !r.source.startsWith("serper_"));

  // Serper data first — this is the most valuable intelligence
  if (serperRows.length > 0) {
    lines.push("\n=== מי מפרסם ומדורג בגוגל ישראל (נתוני SERP אמיתיים) ===");
    lines.push("(מודעות ממומנות = מי משלם על הביטוי, תוצאות אורגניות = מי מדורג בחינם)\n");

    for (const r of serperRows) {
      const d = r.raw_data as any;
      if (!d) continue;
      lines.push(`--- חיפוש: "${d.query}" ---`);

      // Who's paying to appear on this keyword — text ads AND shopping ads.
      // Google shows shopping ads (product carousel) for many commercial
      // queries instead of text ads, so checking only `ads` misses most
      // advertisers. If neither is populated THEN nobody's paying.
      const hasTextAds  = (d.ads?.length ?? 0) > 0;
      const hasShopping = (d.shopping?.length ?? 0) > 0;
      if (hasTextAds) {
        lines.push("  💰 מודעות טקסט ממומנות (Google Ads Search — מי משלם על קליק):");
        for (const ad of d.ads) {
          lines.push(`    • ${ad.title}`);
          lines.push(`      ${ad.link}`);
          if (ad.snippet) lines.push(`      "${ad.snippet.slice(0, 100)}"`);
        }
      }
      if (hasShopping) {
        // Reframe: Shopping results ARE PAID ADS. Merchants bid via Google
        // Merchant Center + Shopping campaigns for the product carousel
        // placement. Previous wording ("מי מוכר") made the agent dismiss
        // these as organic listings and conclude "nobody advertises".
        lines.push(`  💰 מודעות Google Shopping ממומנות (${d.shopping.length} מפרסמים משלמים לגוגל להופיע בקרוסלת המוצרים):`);
        lines.push(`     זה פרסום בתשלום בדיוק כמו Search Ads — הסוחרים מציעים מחיר למיקום.`);
        for (const p of d.shopping.slice(0, 10)) {
          lines.push(`    • ${p.source} — ${p.price ?? "?"} — ${p.title}`);
        }
      }
      if (!hasTextAds && !hasShopping) {
        lines.push("  ✅ אין מודעות ממומנות (לא טקסט ולא שופינג) — אף אחד לא משלם לגוגל על הביטוי הזה!");
      } else {
        const channels = [hasTextAds && "Search", hasShopping && "Shopping"].filter(Boolean).join(" + ");
        lines.push(`  ⚠️ מסקנה: יש תחרות בתשלום על הביטוי הזה (${channels}). לא לטעון שאף אחד לא מפרסם.`);
      }

      // Organic — who's ranking
      if (d.organic?.length > 0) {
        lines.push("  תוצאות אורגניות (מי מדורג):");
        for (const o of d.organic.slice(0, 5)) {
          lines.push(`    #${o.position} ${o.title} — ${o.link}`);
        }
      }

      // People Also Ask
      if (d.peopleAlsoAsk?.length > 0) {
        lines.push("  שאלות שאנשים שואלים:");
        for (const p of d.peopleAlsoAsk) {
          lines.push(`    ? ${p.question}`);
        }
      }

      // Related searches
      if (d.relatedSearches?.length > 0) {
        lines.push(`  חיפושים קשורים: ${d.relatedSearches.join(", ")}`);
      }
      lines.push("");
    }
  }

  // Other sources
  for (const r of otherRows) {
    if (r.source === "google_suggest" && r.raw_data) {
      lines.push("\n--- Autocomplete — מה ישראלים מקלידים עכשיו ---");
      for (const [query, suggestions] of Object.entries(r.raw_data as Record<string, string[]>)) {
        lines.push(`"${query}" → ${(suggestions as string[]).join(", ")}`);
      }
    } else if (r.source.startsWith("competitor_") && r.raw_data) {
      const name = (r.raw_data as any).name ?? r.source;
      const text = (r.raw_data as any).text ?? "";
      lines.push(`\n--- אתר מתחרה: ${name} ---`);
      lines.push(text.slice(0, 400));
    } else if (r.source === "novel_keywords" && r.raw_data) {
      const d = r.raw_data as any;
      const withDemand = d.with_paid_demand ?? [];
      const openField  = d.open_field_seo   ?? [];
      if (withDemand.length > 0 || openField.length > 0) {
        lines.push(`\n--- 🔍 מילות מפתח חדשות (גילוי אוטומטי — LLM brainstorm + deep Suggest) ---`);
        lines.push(`(אלה מילות מפתח שלא היו ברשימה הקבועה. גילוי דרך שרשור Google Suggest + brainstorm של Haiku, ואומתו מול Serper Shopping.)`);
        if (withDemand.length > 0) {
          lines.push(`\n  ✅ עם ביקוש מסחרי (יש מפרסמי Shopping — מתאים לקמפיינים ממומנים):`);
          for (const k of withDemand.slice(0, 15)) {
            lines.push(`    • "${k.keyword}" — ${k.shopping_count} מפרסמים${k.top_advertiser ? ` (ראשון: ${k.top_advertiser})` : ""}`);
          }
        }
        if (openField.length > 0) {
          lines.push(`\n  🌱 שטח פתוח (אין מתחרים משלמים — הזדמנות SEO/תוכן טהורה):`);
          for (const k of openField.slice(0, 5)) {
            lines.push(`    • "${k.keyword}"`);
          }
        }
        lines.push(`  מסקנה: השתמש בביטויים האלה בהמלצות — זה לא אותן 10 מילים הרגילות. הקהל מחפש אותן, וחלק אין תחרות.`);
      }
    } else if (r.source.startsWith("ig_competitor_") && r.raw_data) {
      const d = r.raw_data as any;
      const media = d.recent_media ?? [];
      lines.push(`\n--- אינסטגרם של מתחרה: @${d.username} (${d.followers ?? "?"} עוקבים, ${d.total_posts ?? "?"} פוסטים) ---`);
      if (d.name) lines.push(`  שם: ${d.name}`);
      if (d.bio)  lines.push(`  ביו: "${(d.bio ?? "").slice(0, 200)}"`);
      if (media.length > 0) {
        lines.push(`  פוסטים אחרונים:`);
        for (const m of media.slice(0, 10)) {
          const dateStr = m.timestamp ? new Date(m.timestamp).toISOString().split("T")[0] : "?";
          const cap = (m.caption ?? "").replace(/\s+/g, " ").slice(0, 180);
          lines.push(`    [${dateStr}] ${m.type ?? "?"} — 👍${m.likes} 💬${m.comments}`);
          if (cap) lines.push(`      "${cap}"`);
        }
      }
    } else if (r.source.startsWith("meta_ads_") && r.raw_data) {
      const competitor = (r.raw_data as any).competitor ?? (r.raw_data as any).query ?? "";
      const ads   = (r.raw_data as any).ads   ?? [];
      const total = (r.raw_data as any).total ?? ads.length;
      if (ads.length > 0) {
        lines.push(`\n--- Meta Ad Library: ${competitor} (${total} מודעות פעילות בישראל) ---`);
        lines.push("(מודעות שפעילות עכשיו על פייסבוק + אינסטגרם — זה מה שהמתחרים מראים ללקוחות ברגע זה)");
        for (const a of ads.slice(0, 8)) {
          const body = (a.bodies?.[0] ?? "").slice(0, 180);
          const title = (a.link_titles?.[0] ?? "").slice(0, 100);
          const platforms = Array.isArray(a.platforms) ? a.platforms.join("+") : "";
          lines.push(`  🎯 ${a.page_name} [${platforms}] — מאז ${a.started ?? "?"}`);
          if (title) lines.push(`     כותרת: ${title}`);
          if (body)  lines.push(`     גוף:   "${body}"`);
        }
      }
    } else if (r.source.startsWith("places_") && r.raw_data) {
      const places = (r.raw_data as any).places ?? [];
      if (places.length > 0) {
        lines.push(`\n--- ביקורות גוגל: "${(r.raw_data as any).query}" ---`);
        for (const p of places) {
          lines.push(`  ⭐ ${p.title} — ${p.rating}/5 (${p.reviews} ביקורות) — ${p.address ?? ""}`);
        }
      }
    } else if (r.source === "google_shopping" && r.raw_data) {
      const products = (r.raw_data as any).products ?? [];
      if (products.length > 0) {
        lines.push("\n--- Google Shopping — מי מוכר פולי קפה ובאיזה מחיר ---");
        for (const p of products) {
          const rating = p.rating ? ` ⭐${p.rating}` : "";
          lines.push(`  ${p.price ?? "?"} — ${p.title} (${p.source})${rating}`);
        }
      }
    } else if (r.source === "google_news" && r.raw_data) {
      const news = r.raw_data as any[];
      if (news?.length > 0) {
        lines.push("\n--- חדשות קפה בישראל ---");
        for (const n of news) {
          lines.push(`  📰 ${n.title} (${n.source}, ${n.date})`);
        }
      }
    } else if (r.source === "pagespeed" && r.raw_data) {
      lines.push("\n--- מהירות אתרים (מובייל) — אתר איטי = לקוחות בורחים ---");
      for (const [name, data] of Object.entries(r.raw_data as Record<string, any>)) {
        const score = data.score;
        const emoji = score >= 90 ? "🟢" : score >= 50 ? "🟡" : "🔴";
        lines.push(`  ${emoji} ${name}: ${score}/100 (FCP: ${Math.round(data.fcp / 1000 * 10) / 10}s, LCP: ${Math.round(data.lcp / 1000 * 10) / 10}s)`);
      }
    } else if (r.source === "price_changes" && r.raw_data) {
      const changes = (r.raw_data as any).changes ?? [];
      if (changes.length > 0) {
        lines.push(`\n--- ⚠️ שינויים באתרי מתחרים (מאתמול) ---`);
        for (const c of changes) {
          lines.push(`  • ${c}`);
        }
      }
    }
  }

  lines.push("\n=== סוף מחקר שוק ===");
  return lines.join("\n");
}

// Fetch historical scores for a strategist agent
async function getScoreHistory(supabase: ReturnType<typeof createClient>, agentType: string): Promise<string> {
  const { data: scores } = await supabase
    .from("advisor_scores")
    .select("week_start, winning_agent, score, feedback_text")
    .order("week_start", { ascending: false })
    .limit(8);

  if (!scores || scores.length === 0) return "\nאין היסטוריית ציונים עדיין — זו ההרצה הראשונה.\n";

  const lines: string[] = ["\n=== היסטוריית ציונים שלך ==="];
  for (const s of scores) {
    const won = s.winning_agent === agentType;
    const emoji = won ? (s.score >= 4 ? "🏆" : "✓") : "✗";
    const status = won ? `ציון ${s.score}/5` : "לא נבחר";
    const feedback = s.feedback_text ? ` — "${s.feedback_text}"` : "";
    lines.push(`${emoji} שבוע ${s.week_start}: ${status}${feedback}`);
  }
  lines.push("למד מהפידבק — חזק מה שעבד, שנה מה שנכשל.\n");
  return lines.join("\n");
}

// Fetch what the user already DID, SKIPPED, or SNOOZED across the last few
// weeks. The agents see this so they don't re-recommend things the user
// already handled (e.g. don't suggest "write a blog post on macchiato"
// if the user already marked that done).
async function getCompletedActions(supabase: ReturnType<typeof createClient>): Promise<string> {
  // Look back 8 weeks of action history
  const eightWeeksAgo = new Date(Date.now() - 8 * 7 * 86400000).toISOString().split("T")[0];
  const { data: rows } = await supabase
    .from("advisor_completed_actions")
    .select("week_start, action_id, action_label, state")
    .gte("week_start", eightWeeksAgo)
    .order("week_start", { ascending: false });

  if (!rows || rows.length === 0) return "";

  const done    = (rows as any[]).filter(r => r.state === "done");
  const skipped = (rows as any[]).filter(r => r.state === "skipped");
  const snoozed = (rows as any[]).filter(r => r.state === "snoozed");

  const lines: string[] = ["\n=== מה כבר ביצעת / דחית (אל תמליץ שוב) ==="];
  if (done.length > 0) {
    lines.push("\n✓ כבר בוצע (אל תחזור על המלצה זו):");
    for (const r of done.slice(0, 30)) {
      lines.push(`  • [${r.week_start}] ${r.action_label || r.action_id}`);
    }
  }
  if (skipped.length > 0) {
    lines.push("\n⏭ דילגת בעבר (חזור רק אם משהו השתנה):");
    for (const r of skipped.slice(0, 15)) {
      lines.push(`  • [${r.week_start}] ${r.action_label || r.action_id}`);
    }
  }
  if (snoozed.length > 0) {
    lines.push("\n🕐 דחוי לשבוע הבא — אפשר להציע שוב:");
    for (const r of snoozed.slice(0, 15)) {
      lines.push(`  • [${r.week_start}] ${r.action_label || r.action_id}`);
    }
  }
  lines.push("\nכלל קריטי: אם המלצה דומה למשהו ב-✓ — אל תחזור עליה. הצע את הצעד הבא, לא את אותו צעד.\n");
  return lines.join("\n");
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

// ── Meta Ads Data Helper ──────────────────────────────────────────────────────
// Mirrors fetchGoogleData / buildGoogleDataBlock so agents can reason about
// Meta (Facebook + Instagram) campaign performance with the same shape as
// Google. Without this the agents had no idea how Meta was performing and
// kept recommending only Google changes.

interface MetaCampaignAgg {
  campaign_id:  string;
  name:         string;
  status:       string;
  objective:    string | null;
  spend:        number;
  impressions:  number;
  clicks:       number;
  conversions:  number;
  ctr:          number;
  cpc:          number;
  cpa:          number | null;
}

function aggregateMetaCampaigns(rows: Array<{
  campaign_id: string; name: string; status: string; objective?: string | null;
  spend: number; impressions: number; clicks: number; conversions: number;
  ctr: number; cpc: number;
}>): MetaCampaignAgg[] {
  const m = new Map<string, MetaCampaignAgg>();
  for (const r of rows) {
    const e = m.get(r.campaign_id);
    if (!e) {
      m.set(r.campaign_id, {
        campaign_id: r.campaign_id,
        name:        r.name,
        status:      r.status,
        objective:   r.objective ?? null,
        spend:       r.spend,
        impressions: r.impressions,
        clicks:      r.clicks,
        conversions: r.conversions,
        ctr:         r.ctr,
        cpc:         r.cpc,
        cpa:         r.conversions > 0 ? r.spend / r.conversions : null,
      });
    } else {
      e.spend       += r.spend;
      e.impressions += r.impressions;
      e.clicks      += r.clicks;
      e.conversions += r.conversions;
      e.cpa = e.conversions > 0 ? Math.round((e.spend / e.conversions) * 100) / 100 : null;
      // recompute weighted ctr/cpc
      e.ctr = e.impressions > 0 ? e.clicks / e.impressions : 0;
      e.cpc = e.clicks > 0 ? e.spend / e.clicks : 0;
    }
  }
  return [...m.values()].map(c => ({
    ...c,
    spend: Math.round(c.spend * 100) / 100,
    ctr:   Math.round(c.ctr * 10000) / 100, // percent
    cpc:   Math.round(c.cpc * 100) / 100,
  })).sort((a, b) => b.spend - a.spend);
}

async function fetchMetaAdData(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  weekEnd: string,
) {
  const fourWksAgo = subtractDays(weekStart, 28);
  const { data, error } = await supabase
    .from("meta_ad_campaigns")
    .select("campaign_id,name,status,objective,date,spend,impressions,clicks,ctr,cpc,conversions")
    .gte("date", fourWksAgo)
    .lte("date", weekEnd)
    .order("date", { ascending: false });
  if (error) throw new Error(`Meta fetch error: ${error.message}`);
  const all = (data ?? []) as any[];
  const currentWeek = all.filter(r => r.date >= weekStart);
  const prevWeeks   = all.filter(r => r.date < weekStart);
  return {
    metaCurrentAgg: aggregateMetaCampaigns(currentWeek),
    metaPrevAgg:    aggregateMetaCampaigns(prevWeeks),
  };
}

function buildMetaDataBlock(
  metaCurrentAgg: MetaCampaignAgg[],
  metaPrevAgg:    MetaCampaignAgg[],
) {
  const totalSpend       = metaCurrentAgg.reduce((s, c) => s + c.spend, 0);
  const totalClicks      = metaCurrentAgg.reduce((s, c) => s + c.clicks, 0);
  const totalImpressions = metaCurrentAgg.reduce((s, c) => s + c.impressions, 0);
  const totalConversions = metaCurrentAgg.reduce((s, c) => s + c.conversions, 0);
  const overallCpa       = totalConversions > 0 ? totalSpend / totalConversions : null;

  const metaCampaignBlock = metaCurrentAgg.length > 0
    ? metaCurrentAgg.map(c =>
        `  ${c.name} | מטרה: ${c.objective ?? "—"} | סטטוס: ${c.status} | עלות: ₪${c.spend} | קליקים: ${c.clicks} | המרות: ${c.conversions} | CPA: ${c.cpa != null ? `₪${c.cpa}` : "אין"} | CTR: ${c.ctr}%`
      ).join("\n")
    : "  אין נתוני קמפיין מטא השבוע";

  const metaPrevBlock = metaPrevAgg.length > 0
    ? metaPrevAgg.map(c =>
        `  ${c.name} | עלות: ₪${c.spend} | המרות: ${c.conversions} | CPA: ${c.cpa != null ? `₪${c.cpa}` : "אין"}`
      ).join("\n")
    : "  אין נתוני השוואה לתקופה הקודמת במטא";

  return {
    metaTotalSpend:       Math.round(totalSpend * 100) / 100,
    metaTotalClicks:      totalClicks,
    metaTotalImpressions: totalImpressions,
    metaTotalConversions: totalConversions,
    metaOverallCpa:       overallCpa != null ? Math.round(overallCpa * 100) / 100 : null,
    metaCampaignBlock,
    metaPrevBlock,
  };
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
  // Growth agent gets: campaign metrics (for context), GSC opportunities,
  // Keyword Planner, WooCommerce trends, and product inventory — but NOT
  // ad creatives (that's Efficiency's job). This ensures Growth focuses on
  // "what new campaigns should we create" instead of "how to fix existing ads".
  const [{ currentAgg, prevAgg }, wooSales, gscRes, pastReports, kwIdeas, productsRes] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
    supabase
      .from("google_search_console")
      .select("keyword,clicks,impressions,position")
      .neq("keyword", "__page__")
      .gte("date", thirtyDaysAgo)
      .order("impressions", { ascending: false })
      .limit(30),
    fetchPastReports(supabase, "google_ads_growth", weekStart),
    fetchKeywordIdeas(supabase),
    supabase.from("woo_products").select("name,price,packed_stock").order("name"),
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

  // Focus override — injected at the TOP of the system prompt so it takes
  // precedence over data-driven recommendations. If the user says "don't
  // promote grinders", the agent must respect that even if GSC shows an
  // opportunity for "מטחנת קפה".
  const focusOverride = focus
    ? `=== הוראות מנהל — עדיפות עליונה ===
${focus}
התעלם מכל נתון שסותר הוראות אלה. אם GSC מראה הזדמנות שמנהל ביקש לא לקדם — דלג עליה. אם המנהל ביקש להתמקד בנושא מסוים — כל ההמלצות שלך חייבות להיות על הנושא הזה.\n\n`
    : '';

  // Product inventory for Growth to know what's sellable
  const productsBlock = (productsRes.data ?? [])
    .filter((p: any) => p.packed_stock > 0)
    .map((p: any) => `  ${p.name} | ₪${p.price} | מלאי: ${p.packed_stock}`)
    .join("\n") || "  אין נתוני מוצרים";

  const systemPrompt = `${focusOverride}אתה אסטרטג שיווק דיגיטלי בכיר המתמחה בגילוי הזדמנויות צמיחה חדשות בשוק הקפה הישראלי. אתה מייעץ ל-Minuto Coffee.
${BUSINESS_BRIEF}
${COMPETITIVE_INTELLIGENCE}
${ADS_EXPERTISE}

=== התפקיד שלך: מציאת הזדמנויות חדשות בלבד ===
אתה אחראי אך ורק על מציאת הזדמנויות חדשות. אתה לא נוגע בקמפיינים קיימים.
❌ אסור לך: להמליץ על שינויי תקציב לקמפיינים פעילים, לשכתב מודעות קיימות, להשהות/לעצור קמפיינים.
✅ התפקיד שלך: לגלות מילות מפתח חדשות, להמליץ על קמפיינים חדשים ליצירה, לזהות הזדמנויות עונתיות, לנתח מה הישראלים מחפשים.

אל תמליץ על "cold brew" ואל תמציא ביטויים. כל המלצה חייבת להתבסס על נתוני GSC/Keyword Planner שניתנו לך.

=== מודיעין שוק ישראלי ===
כללי כתיבה:
- עברית שיווקית מדוברת. "קפה טרי" ולא "משקה חם מרענן".
- מילות מפתח בעברית: "פולי קפה", "קפה טרי", "קפה ספשלטי", "קפה חד זני", "קפה אתיופי", "שקית קפה", "קפה לבית"
- ביטויי חיפוש ישראליים: "איפה קונים פולי קפה", "קפה טרי משלוח", "פולי קפה אונליין", "קפה ספשלטי ישראל"
- מתחרים: עלית (mass market), לנדוור/ארומה (chains), נספרסו/דולצ'ה גוסטו (קפסולות). Minuto מתחרה על "ספשלטי" — לא על "קפה" הכללי.
- חגים: ראש השנה (ספט — מתנות), סוכות (אוקט), חנוכה (דצמ — מתנות), פורים (מרץ — משלוחי מנות), פסח (אפריל), שבועות (יוני — חלבי + לילות לבנים)
- תרבות רכישה: תשלומים (3-6), סף משלוח חינם, תמיכה בWhatsApp

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
• חוויה: "הקפה שישנה לכם את הבוקר" — רגשי, לא מחירי
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

⚠️ חוק קריטי — שמות מתחרים בטקסט מודעות (TRADEMARK POLICY):
✗ אסור להשתמש בשמות מתחרים בכותרות או תיאורים: Lavazza, Illy, Nespresso, נחת, Jera, אגרו, Mauro, Bristot, Hausbrandt, Kimbo. NEVER.
✗ Google Ads ידחה מודעות שמכילות סימנים מסחריים רשומים בטקסט. המתחרים מגישים תלונות trademark.
✓ מותר לטרגט מילות מפתח של מתחרים (bidding on competitor keywords) — המשתמש מחפש "Lavazza", רואה את המודעה שלנו.
✓ במקום לנקוב בשם — תקוף את הקטגוריה: "לא מהמדף", "לא מהסופר", "לא קפה ישן", "תאריך קלייה על כל שקית".
דוגמאות נכונות:
  ✓ "פולי קפה טריים, לא מהמדף" — תוקף Lavazza בלי לנקוב בשם
  ✓ "למה לקנות פולים מהסופר?" — מעלה ספק בלי trademark
  ✓ "נקלה היום, אצלכם מחר" — הבטחה שאף מותג מדף לא יכול לתת
  ✓ "פולים עם תאריך קלייה" — עובדה שמפילה כל מותג סופר

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
חשוב: הנתונים כוללים רק הזמנות B2C — B2B (mflow) סוננו. אל תציין B2B.
חשוב: המילה הנכונה היא "ספשלטי" — לא "ספשיאלטי".
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו.

דוגמאות לסגנון עברית נכון לשדות הטקסט:
✓ "ה-CTR של Coffee_beans_oam נפל — הקופי גנרי ולא מדבר לאף אחד. עוצרים."
✓ "ה-ROAS של MM|SRC ירד ב-40% למרות CTR גבוה — בעיה ב-landing page, לא במודעה."
✓ "קמפיין טריות עם הכותרת 'נקלה ונשלח היום' יכול להכפיל את ה-CTR הנוכחי."
✗ "הקמפיין הינו בעל ביצועים שאינם מספקים" — עברית מתה. NEVER.
✗ "מומלץ לבחון אפשרות של שיפור" — ריק ולא אומר כלום. NEVER.
✗ "יש לציין כי" / "יש לקחת בחשבון" / "כמו כן" — לא כותבים ככה. NEVER.`;

  const seasonalContext = getSeasonalContext(weekStart);

  const userMessage = `${seasonalContext}

נתוני Google Ads שבוע ${weekStart}–${weekEnd} (לידיעה כללית — אתה לא נוגע בקמפיינים האלה):

=== קמפיינים פעילים ===
${campaignBlock}

=== סיכום ===
עלות כוללת: ₪${Math.round(totalCost * 100) / 100} | קליקים: ${totalClicks} | חשיפות: ${totalImpressions} | המרות: ${Math.round(totalConversions * 10) / 10} | ROAS: ${Math.round(overallRoas * 100) / 100}x

=== מכירות WooCommerce השבוע ===
${wooSales}

=== מוצרים עם מלאי (ניתן לקדם) ===
${productsBlock}

=== Google Search Console — הביטויים שבהם Minuto כבר מופיעה (30 יום) ===
חפש הזדמנויות: ביטויים עם חשיפות גבוהות אך מיקום 5+ = אפשר לחזק עם קמפיין ממומן.
${gscBlock}

=== Keyword Planner — ביטויי חיפוש בשוק הישראלי ===
${kwIdeas}

=== היסטוריית המלצות קודמות ===
${pastReports}
השווה: מה המלצת בעבר → מה קרה בפועל. אם קמפיין חדש שהמלצת כבר קיים (בקמפיינים הפעילים למעלה) — אל תמליץ עליו שוב.

המלצות מילות מפתח — השתמש אך ורק בביטויים מ-GSC + Keyword Planner. אל תמציא ביטויים.

הגבלות פלט: growth_opportunities עד 3, campaigns_to_create עד 2, market_insights עד 2, key_insights עד 2.

לכל קמפיין חדש (campaigns_to_create):
- צור landing_page_url מלא עם UTM: https://www.minuto.co.il/product/SLUG?utm_source=google&utm_medium=cpc&utm_campaign=CAMPAIGN_NAME
  אם אין מוצר ספציפי: https://www.minuto.co.il?utm_source=google&utm_medium=cpc&utm_campaign=CAMPAIGN_NAME
- הוסף negative_keywords: מילים שליליות שימנעו תנועה לא רלוונטית ("חינם", "מתכון", "נמס", "קפסולות")
- הוסף creation_steps: הוראות צעד-אחר-צעד ליצירת הקמפיין בGoogle Ads (איפה ללחוץ, מה לבחור)

החזר JSON בפורמט הזה בדיוק:
{
  "agent_philosophy": "משפט אחד",
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
  "growth_opportunities": [
    { "opportunity": "הזדמנות", "action": "מה לעשות", "expected_impact": "תוצאה צפויה" }
  ],
  "market_insights": [
    { "insight": "תובנה שוקית", "relevance": "למה זה רלוונטי ל-Minuto", "action": "מה לעשות" }
  ],
  "campaigns_to_create": [
    {
      "campaign_name": "שם",
      "campaign_type": "Search|Performance Max|Shopping",
      "target_audience": "קהל יעד",
      "keywords": ["מילה 1", "מילה 2"],
      "negative_keywords": ["מילה שלילית 1", "מילה שלילית 2"],
      "headlines": ["כותרת 1 (עד 30 תווים)", "כותרת 2", "כותרת 3"],
      "descriptions": ["תיאור 1 (עד 90 תווים)"],
      "daily_budget_ils": 50,
      "rationale": "הסבר קצר",
      "landing_page_url": "https://www.minuto.co.il/product/xxx?utm_source=google&utm_medium=cpc&utm_campaign=campaign_name",
      "creation_steps": ["צעד 1", "צעד 2"]
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2"],
  "next_week_focus": "משפט אחד — המהלך העיקרי"
}`;

  // Focus is already injected at the TOP of the system prompt as an override,
  // so we don't append it again to the user message.
  const finalMessage = userMessage;

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

  const focusOverride = focus
    ? `=== הוראות מנהל — עדיפות עליונה ===
${focus}
התעלם מכל נתון שסותר הוראות אלה. אם המנהל ביקש להתמקד בנושא מסוים — כל ההמלצות שלך חייבות להיות על הנושא הזה.\n\n`
    : '';

  const systemPrompt = `${focusOverride}אתה יועץ Google Ads בכיר המתמחה באופטימיזציה של קמפיינים קיימים. אתה מייעץ ל-Minuto Coffee.
${BUSINESS_BRIEF}
${COMPETITIVE_INTELLIGENCE}
${ADS_EXPERTISE}

=== התפקיד שלך: שיפור קמפיינים קיימים בלבד ===
אתה אחראי אך ורק על אופטימיזציה של מה שכבר רץ.
❌ אסור לך: להמליץ על קמפיינים חדשים, להציע מילות מפתח שלא קיימות בקמפיינים הנוכחיים, להמליץ על הגדלת תקציב כללית.
✅ התפקיד שלך: לזהות בזבוז, לשפר קופי מודעות, לתקן מילות מפתח שליליות, להמליץ על שינויי תקציב בין קמפיינים קיימים, לשכתב מודעות חלשות.

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
• חוויה: "הקפה שישנה לכם את הבוקר" — רגשי, לא מחירי
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

⚠️ חוק קריטי — שמות מתחרים בטקסט מודעות (TRADEMARK POLICY):
✗ אסור להשתמש בשמות מתחרים בכותרות או תיאורים: Lavazza, Illy, Nespresso, נחת, Jera, אגרו, Mauro, Bristot, Hausbrandt, Kimbo. NEVER.
✗ Google Ads ידחה מודעות שמכילות סימנים מסחריים רשומים בטקסט. המתחרים מגישים תלונות trademark.
✓ מותר לטרגט מילות מפתח של מתחרים (bidding on competitor keywords) — המשתמש מחפש "Lavazza", רואה את המודעה שלנו.
✓ במקום לנקוב בשם — תקוף את הקטגוריה: "לא מהמדף", "לא מהסופר", "לא קפה ישן", "תאריך קלייה על כל שקית".
דוגמאות נכונות:
  ✓ "פולי קפה טריים, לא מהמדף" — תוקף Lavazza בלי לנקוב בשם
  ✓ "למה לקנות פולים מהסופר?" — מעלה ספק בלי trademark
  ✓ "נקלה היום, אצלכם מחר" — הבטחה שאף מותג מדף לא יכול לתת
  ✓ "פולים עם תאריך קלייה" — עובדה שמפילה כל מותג סופר

חשוב: הנתונים כוללים רק הזמנות B2C — B2B (mflow) סוננו. אל תציין B2B.
חשוב: המילה הנכונה היא "ספשלטי" — לא "ספשיאלטי".
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו.

דוגמאות לסגנון עברית נכון לשדות הטקסט:
✓ "ה-CTR של Coffee_beans_oam נפל — הקופי גנרי ולא מדבר לאף אחד. עוצרים."
✓ "ה-ROAS של MM|SRC ירד ב-40% למרות CTR גבוה — בעיה ב-landing page, לא במודעה."
✓ "קמפיין טריות עם הכותרת 'נקלה ונשלח היום' יכול להכפיל את ה-CTR הנוכחי."
✗ "הקמפיין הינו בעל ביצועים שאינם מספקים" — עברית מתה. NEVER.
✗ "מומלץ לבחון אפשרות של שיפור" — ריק ולא אומר כלום. NEVER.
✗ "יש לציין כי" / "יש לקחת בחשבון" / "כמו כן" — לא כותבים ככה. NEVER.`;

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
נתח את הכותרות והתיאורים הקיימים שורה-שורה: עבור כל כותרת/תיאור חלש — ציין את הטקסט המקורי בדיוק (original), הסבר מה לא בסדר (problem), והצע החלפה ספציפית (replacement). ה-ads_to_rewrite חייב להשתמש בטקסט האמיתי מהקריאייטיב שמוצג למעלה — לא להמציא כותרות שלא קיימות.
בהמלצות מילות מפתח — השתמש אך ורק בביטויים מ-GSC + Keyword Planner. אל תמציא ביטויים.

=== היסטוריית המלצות קודמות — למד מהן ===
${pastReportsEff}
השווה: מה המלצת בעבר → מה קרה בפועל. המלצות שעבדו — חזק. שלא עבדו — נתח למה.

הגבלות פלט קפדניות: budget_recommendations עד 3, waste_identified עד 2, key_insights עד 2.
חובה: ads_to_rewrite חייב תמיד להכיל לפחות פריט אחד — בחר את הקמפיין עם הקריאייטיב החלש ביותר (Ad Strength נמוך, CTR נמוך, או כותרות גנריות). אם כל הקמפיינים נראים טובים — בחר אחד ושפר את הכותרות לפי הכללים. אל תחזיר ads_to_rewrite ריק.

מילות מפתח שליליות (negative_keywords_to_add): נתח את הביטויים שהביאו תנועה יקרה ללא המרות ואת נתוני GSC. המלץ על מילים שליליות שחייבים להוסיף כדי לחסום תנועה לא רלוונטית. לכל פריט waste — הוסף negative_keywords עם מילים ספציפיות לחסימה. בנוסף, הוסף negative_keywords_to_add עם המלצות ברמת החשבון/קמפיין.

החזר JSON בפורמט הזה בדיוק:
{
  "agent_philosophy": "משפט אחד",
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
    { "campaign": "שם", "issue": "תיאור הבעיה", "estimated_waste": "₪X בשבוע", "fix": "פתרון קצר", "negative_keywords": ["מילה שלילית רלוונטית"] }
  ],
  "negative_keywords_to_add": [
    { "campaign": "שם הקמפיין או account-level", "keywords": ["חינם", "נמס", "קפסולות"], "reason": "הסבר למה לחסום מילים אלו" }
  ],
  "ads_to_rewrite": [
    {
      "campaign": "שם הקמפיין",
      "ad_strength": "POOR|AVERAGE|GOOD",
      "headline_fixes": [
        {
          "original": "הכותרת הקיימת בדיוק כמו שהיא",
          "problem": "למה זו כותרת חלשה — ספציפי",
          "replacement": "הכותרת החדשה המוצעת"
        }
      ],
      "description_fixes": [
        {
          "original": "התיאור הקיים בדיוק כמו שהוא",
          "problem": "למה זה תיאור חלש",
          "replacement": "התיאור החדש המוצע"
        }
      ],
      "expected_improvement": "מה ישתפר"
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2"],
  "next_week_focus": "משפט אחד — המהלך העיקרי"
}`;

  // Focus is already injected at the TOP of the system prompt as an override.
  const finalMessage = userMessage;

  console.log(`[efficiency] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_ADS, systemPrompt, finalMessage, { maxTokens: 7000, timeoutMs: 180_000 });
  const parsed = parseClaudeJson(text);
  console.log(`[efficiency] Done. Tokens: ${inputTokens + outputTokens}`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

// ── Competing Strategist Agents ──────────────────────────────────────────────
// Both agents receive identical data (Google Ads + GSC + WooCommerce + market
// research + ad creatives) but have fundamentally different philosophies.
// They produce the same JSON output format so the frontend can render them
// side-by-side for comparison.

async function fetchStrategistData(supabase: ReturnType<typeof createClient>, weekStart: string) {
  const weekEnd = addDays(weekStart, 6);
  const thirtyDaysAgo = subtractDays(weekStart, 30);

  const [{ currentAgg, prevAgg }, { metaCurrentAgg, metaPrevAgg }, wooSales, adCreatives, gscRes, kwIdeas, productsRes] = await Promise.all([
    fetchGoogleData(supabase, weekStart, weekEnd),
    fetchMetaAdData(supabase, weekStart, weekEnd),
    fetchWooSales(supabase, weekStart, weekEnd),
    fetchAdCreatives(supabase),
    supabase.from("google_search_console").select("keyword,clicks,impressions,position")
      .neq("keyword", "__page__").gte("date", thirtyDaysAgo)
      .order("impressions", { ascending: false }).limit(30),
    fetchKeywordIdeas(supabase),
    supabase.from("woo_products").select("name,price,packed_stock").order("name"),
  ]);

  const { totalCost, totalClicks, totalImpressions, totalConversions, overallRoas, campaignBlock, prevBlock }
    = buildGoogleDataBlock(currentAgg, prevAgg, weekStart, weekEnd);

  const { metaTotalSpend, metaTotalClicks, metaTotalImpressions, metaTotalConversions, metaOverallCpa, metaCampaignBlock, metaPrevBlock }
    = buildMetaDataBlock(metaCurrentAgg, metaPrevAgg);

  const gscKwMap = new Map<string, { clicks: number; impressions: number; positions: number[] }>();
  for (const r of (gscRes.data ?? [])) {
    const e = gscKwMap.get(r.keyword);
    if (e) { e.clicks += r.clicks; e.impressions += r.impressions; e.positions.push(r.position); }
    else gscKwMap.set(r.keyword, { clicks: r.clicks, impressions: r.impressions, positions: [r.position] });
  }
  const gscBlock = Array.from(gscKwMap.entries())
    .map(([kw, v]) => ({ keyword: kw, clicks: v.clicks, impressions: v.impressions,
      position: Math.round((v.positions.reduce((a, b) => a + b, 0) / v.positions.length) * 10) / 10 }))
    .sort((a, b) => b.impressions - a.impressions).slice(0, 20)
    .map(k => `  "${k.keyword}" | חשיפות: ${k.impressions} | קליקים: ${k.clicks} | מיקום: ${k.position}`)
    .join("\n") || "  אין נתוני GSC עדיין";

  const productsBlock = (productsRes.data ?? [])
    .filter((p: any) => p.packed_stock > 0)
    .map((p: any) => `  ${p.name} | ₪${p.price} | מלאי: ${p.packed_stock}`)
    .join("\n") || "  אין נתוני מוצרים";

  const seasonalContext = getSeasonalContext(weekStart);
  const researchBlock = await getResearchBlock(supabase);

  return {
    weekEnd, totalCost, totalClicks, totalImpressions, totalConversions, overallRoas,
    campaignBlock, prevBlock, wooSales, adCreatives, gscBlock, kwIdeas, productsBlock,
    seasonalContext, researchBlock,
    metaTotalSpend, metaTotalClicks, metaTotalImpressions, metaTotalConversions,
    metaOverallCpa, metaCampaignBlock, metaPrevBlock,
  };
}

// Unified JSON schema instruction for both strategists
// TACTICAL agent schema — hyper-specific, ready to execute THIS WEEK
function getTacticalJsonSchema(d: any) {
  return `
החזר JSON בפורמט הזה בדיוק. כל שדה חייב להיות מלא ומפורט:
{
  "agent_philosophy": "משפט אחד — חובה להזכיר שהקהל הוא חובבי ספשלטי",
  "summary": "2-3 משפטים — מה לעשות השבוע, כולל הרעיון הפרוע שבחרת",
  "confidence_level": "low|medium|high",
  "wild_ideas": {
    "audiences_untapped":      ["קהל 1 שמינוטו לא מטרגטת", "קהל 2"],
    "messaging_angles_unused": ["זווית 1 שאף קלייה לא משתמשת", "זווית 2"],
    "formats_or_channels":     ["ערוץ/פורמט 1 שאף מתחרה לא נוכח", "ערוץ/פורמט 2"],
    "product_or_bundle":       ["רעיון חבילה 1", "רעיון חבילה 2"],
    "cross_industry_analogy":  "הסבר: כמו שמותג X בתעשיה Y עשה, נעשה בקפה. חובה — בלי זה הרעיון נדחה.",
    "picked_for_this_week":    ["שני-שלושה רעיונות מהרשימה למעלה — הכי נועזים + ניתנים לביצוע"]
  },
  "google": {
    "total_cost": ${Math.round(d.totalCost * 100) / 100},
    "total_clicks": ${d.totalClicks},
    "total_impressions": ${d.totalImpressions},
    "total_conversions": ${Math.round(d.totalConversions * 10) / 10},
    "roas": ${Math.round(d.overallRoas * 100) / 100},
    "top_campaign": "שם",
    "worst_campaign": "שם"
  },
  "devils_advocate": {
    "strongest_counterargument": "למה התכנית שלך עלולה להיכשל — חייב להיות משכנע",
    "what_would_change_my_mind": "איזה אות/נתון אם הייתי רואה הייתי נוטש את התכנית ועובר לX"
  },
  "weekly_action_plan": [
    {
      "day": "ראשון|שני|שלישי|רביעי|חמישי",
      "action": "מה בדיוק לעשות",
      "expected_result": "מה צפוי לקרות",
      "how_to_measure": "איך נדע שעבד"
    }
  ],
  "campaigns_to_create": [
    {
      "campaign_name": "שם",
      "campaign_type": "Search",
      "launch_day": "ראשון|שני|שלישי",
      "daily_budget_ils": 60,
      "bid_strategy": "Maximize Conversions|Manual CPC|Target ROAS",
      "target_audience": "תיאור מדויק של הקהל",
      "keywords": [
        { "keyword": "פולי קפה", "match_type": "phrase", "expected_cpc": 2.5 },
        { "keyword": "קפה טרי", "match_type": "broad", "expected_cpc": 1.8 }
      ],
      "negative_keywords": ["מטחנ", "מכונ", "cold brew", "קפסול", "נמס", "חינם", "מתכון"],
      "headlines": ["כותרת 1 (30 תווים מקס)", "כותרת 2", "כותרת 3", "כותרת 4", "כותרת 5", "כותרת 6", "כותרת 7", "כותרת 8", "כותרת 9", "כותרת 10", "כותרת 11", "כותרת 12", "כותרת 13", "כותרת 14", "כותרת 15"],
      "descriptions": ["תיאור 1 (90 תווים מקס)", "תיאור 2", "תיאור 3", "תיאור 4"],
      "landing_page_url": "https://www.minuto.co.il/...",
      "rationale": "למה דווקא הקמפיין הזה, למה עכשיו, למה התקציב הזה",
      "expected_results_7_days": "כמה קליקים, המרות, ועלות צפויים ב-7 ימים"
    }
  ],
  "channel_allocation": {
    "summary": "המלצה ברורה על איך לחלק תקציב בין Google ו-Meta השבוע — חובה לענות!",
    "google_change_pct": 0,
    "meta_change_pct": 0,
    "reasoning": "למה — CPA/ROAS/נפח לפי הנתונים שראית למעלה"
  },
  "meta_campaigns_to_create": [
    {
      "campaign_name": "שם קמפיין ברור",
      "objective": "Sales|Traffic|Engagement|Leads|Catalog Sales",
      "launch_day": "ראשון|שני|שלישי",
      "daily_budget_ils": 80,
      "duration_days": 14,
      "audience": {
        "type": "advantage_plus|detailed|custom|lookalike|retargeting",
        "definition": "הגדרה מדויקת — איזה Custom/Lookalike source? איזה interests? גיל/מיקום/מגדר",
        "age_range": "28-55",
        "geo": "ישראל",
        "interests_or_behaviors": ["Specialty coffee", "De'Longhi", "Home barista"],
        "exclude": ["קונים קיימים ב-30 ימים האחרונים", "כל מי ש-unsubscribed"],
        "why_this_audience": "למה דווקא הקהל הזה עכשיו — בהקשר של wild_ideas שלך למעלה"
      },
      "placements": "Advantage+ Placements|Instagram Feed+Reels בלבד",
      "creative": {
        "format": "reel|single_image|carousel|video",
        "visual_description": "מה רואים בתמונה/וידאו — תיאור מפורט מספיק כדי לצלם/לעצב",
        "primary_text": "גוף המודעה — עד 125 תווים, המשפט הראשון חייב לעצור גלילה",
        "headline": "כותרת — עד 27 תווים",
        "description": "תיאור — עד 27 תווים (link preview)",
        "cta_button": "Shop Now|Learn More|Order Now"
      },
      "landing_page_url": "https://www.minuto.co.il/...",
      "rationale": "למה הקמפיין הזה עכשיו — קישור לוויילד-איידיאה שבחרת",
      "expected_cpa_ils": 15,
      "expected_results_14_days": "כמה המרות, הוצאה, CPA צפויים"
    }
  ],
  "budget_recommendations": [
    { "channel": "google|meta", "campaign": "שם קמפיין קיים", "action": "increase|decrease|pause|keep", "reason": "הסבר קצר", "suggested_budget_change_pct": 30 }
  ],
  "ads_to_rewrite": [
    {
      "channel": "google|meta",
      "campaign": "שם",
      "headline_fixes": [{ "original": "קיים", "problem": "למה חלש", "replacement": "חדש" }],
      "description_fixes": [{ "original": "קיים", "problem": "למה חלש", "replacement": "חדש" }]
    }
  ],
  "wednesday_check": "מה לבדוק ביום רביעי — אילו מדדים, מה סף ההצלחה, מה לעשות אם לא עובד",
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"]
}`;
}

// STRATEGIC agent schema — 90-day roadmap with monthly milestones
function getStrategicJsonSchema(d: any) {
  return `
החזר JSON בפורמט הזה בדיוק. כל שדה חייב להיות מלא ומפורט:
{
  "agent_philosophy": "משפט אחד — חובה להזכיר שהקהל הוא הקונה המסחרי (לוואצה/איליי/סופר)",
  "summary": "2-3 משפטים — האסטרטגיה ל-90 ימים, כולל הרעיון הפרוע שבחרת",
  "confidence_level": "low|medium|high",
  "wild_ideas": {
    "audiences_untapped":      ["תת-קהל מסחרי 1 לא מטורגט (ספציפי, לא 'קונים לוואצה' כללי)", "תת-קהל 2"],
    "messaging_angles_unused": ["זווית מסר 1 שאף קלייה לא משתמשת כלפי הקהל המסחרי", "זווית 2"],
    "channels_or_partnerships": ["ערוץ/שותפות 1 שאף מתחרה לא מנצל", "ערוץ/שותפות 2"],
    "bundle_or_pricing":       ["חבילה/תמחור 1 שמסיר את מחסום ה'יקר מדי'", "חבילה 2"],
    "cross_industry_analogy":  "הסבר: כמו שמותג X בתעשיה Y עשה, נעשה בקפה. חובה — בלי זה הרעיון נדחה.",
    "picked_for_roadmap":      ["שני-שלושה רעיונות שיגדירו את חודש 1, 2, 3"]
  },
  "devils_advocate": {
    "strongest_counterargument": "למה התכנית ל-90 ימים עלולה להיכשל — חייב להיות משכנע",
    "what_would_change_my_mind": "איזה אות/נתון ב-30 הימים הראשונים יגרום לי לבטל ולעבור לתכנית ב'"
  },
  "google": {
    "total_cost": ${Math.round(d.totalCost * 100) / 100},
    "total_clicks": ${d.totalClicks},
    "total_impressions": ${d.totalImpressions},
    "total_conversions": ${Math.round(d.totalConversions * 10) / 10},
    "roas": ${Math.round(d.overallRoas * 100) / 100},
    "top_campaign": "שם",
    "worst_campaign": "שם"
  },
  "meta": {
    "total_spend": ${d.metaTotalSpend ?? 0},
    "total_clicks": ${d.metaTotalClicks ?? 0},
    "total_impressions": ${d.metaTotalImpressions ?? 0},
    "total_conversions": ${d.metaTotalConversions ?? 0},
    "cpa": ${d.metaOverallCpa ?? 0}
  },
  "meta_campaigns_for_roadmap": [
    {
      "campaign_name": "שם קמפיין",
      "launch_month": 1,
      "objective": "Sales|Traffic|Engagement|Leads|Catalog Sales",
      "audience_strategy": "מסלול קהלים ב-90 ימים: חודש 1 רטרגטינג חם, חודש 2 LAL 1%, חודש 3 Advantage+ broad — או מסלול אחר שמתאים",
      "primary_audience_type": "advantage_plus|detailed|custom|lookalike|retargeting",
      "audience_definition": "תיאור הקהל הראשי — איזה Custom/LAL source? איזה interests? מי לא כולל?",
      "creative_direction": "כיוון קריאייטיב (אל תפרט פוסט בודד — תן את הכיוון האסטרטגי: ראיונות בריסטות, סדרת ריילס על מקורות, UGC של לקוחות)",
      "monthly_budget_ils": 2400,
      "why_this_campaign": "קישור לרעיון הפרוע שבחרת ב-wild_ideas"
    }
  ],
  "channel_allocation_90d": {
    "summary": "איך לחלק תקציב בין Google ו-Meta ב-90 הימים הבאים — חובה!",
    "google_pct_of_total": 50,
    "meta_pct_of_total": 50,
    "reasoning": "למה החלוקה הזו — לפי CPA/ROAS/שלב המשפך/היתרון היחסי של כל ערוץ"
  },
  "current_diagnosis": "מה המצב עכשיו — בשני משפטים חריפים",
  "target_90_days": "איפה רוצים להיות בעוד 90 ימים — מספרים ספציפיים (הכנסות, ROAS, לקוחות)",
  "monthly_roadmap": [
    {
      "month": "חודש 1 (אפריל-מאי)",
      "theme": "נושא מרכזי לחודש",
      "budget_total": 3000,
      "audience_focus": "על מי מתמקדים",
      "content_strategy": "מה מפרסמים באינסטגרם/בלוג",
      "kpi_targets": { "roas": 2.5, "conversions_per_week": 15, "new_customers": 40 },
      "seasonal_events": "חגים/אירועים",
      "implementation": [
        {
          "campaign_name": "שם הקמפיין",
          "campaign_type": "Search",
          "daily_budget_ils": 60,
          "keywords": ["מילה 1 [match_type]", "מילה 2 [match_type]"],
          "headlines": ["כותרת 1 (30 תווים)", "כותרת 2", "כותרת 3"],
          "descriptions": ["תיאור 1 (90 תווים)", "תיאור 2"],
          "landing_page_url": "https://www.minuto.co.il/...",
          "negative_keywords": ["מילה שלילית 1"],
          "launch_when": "מתי להשיק (באיזה שבוע בחודש)",
          "success_criteria": "מה הסף — מתחת לזה עוצרים/משנים"
        }
      ]
    },
    {
      "month": "חודש 2",
      "theme": "...",
      "budget_total": 4000,
      "audience_focus": "",
      "content_strategy": "",
      "kpi_targets": {},
      "seasonal_events": "",
      "implementation": []
    },
    {
      "month": "חודש 3",
      "theme": "...",
      "budget_total": 5000,
      "audience_focus": "",
      "content_strategy": "",
      "kpi_targets": {},
      "seasonal_events": "",
      "implementation": []
    }
  ],
  "competitor_strategy": [
    { "competitor": "שם", "their_weakness": "חולשה שלהם", "our_attack": "איך ננצל את זה לאורך 90 ימים" }
  ],
  "audience_build_plan": [
    { "phase": "שבועות 1-4", "audience": "מי מטרגטים", "message": "מה המסר", "budget_pct": 50 },
    { "phase": "שבועות 5-8", "audience": "", "message": "", "budget_pct": 30 },
    { "phase": "שבועות 9-12", "audience": "", "message": "", "budget_pct": 20 }
  ],
  "risk_and_pivot": "מה הסיכון הגדול ומתי וכיצד לשנות כיוון אם לא עובד",
  "key_insights": ["תובנה 1", "תובנה 2", "תובנה 3"]
}`;
}

function buildStrategistUserMessage(d: any, weekStart: string) {
  // STRATEGY-FIRST structure: the agent thinks about the market and strategy
  // BEFORE seeing our internal data. This prevents "data commentary" mode
  // where the agent just reacts to campaign metrics instead of thinking
  // strategically about what we should be doing.
  return `=== שלב 1: חשוב על השוק (לפני שתסתכל על הנתונים שלנו) ===

⚠️ חשוב מאוד לפני שאתה קורא את המחקר: "Google Shopping" הוא פרסום בתשלום בדיוק כמו Google Search Ads. סוחרים מגישים הצעות דרך Google Merchant Center כדי להופיע בקרוסלת המוצרים — זה ערוץ פרסום נפרד של גוגל, לא רשימה אורגנית. אם מופיעים 10 מפרסמים ב-Google Shopping על ביטוי מסוים — זה אומר שיש תחרות בתשלום של 10 מתחרים על הביטוי הזה. אסור לומר "אף אחד לא מפרסם" כשיש תוצאות Shopping. אסור להסיק "השוק פתוח" מהעדר Text Ads כשיש 10 מודעות Shopping.

${d.seasonalContext}

${d.researchBlock}

בהתבסס על מחקר השוק למעלה, חשוב:
• מי קונה פולי קפה בישראל עכשיו? מה הם מחפשים?
• מה המתחרים מציעים (גם ב-Search וגם ב-Shopping)? מה היתרון שלנו עליהם?
• איפה ההזדמנות הכי גדולה — איזה קהל עדיין לא מגיעים אליו?
• מה האסטרטגיה שתביא את ההחזר הכי גבוה ב-30 הימים הקרובים?

קח דקה לחשוב על זה לפני שתמשיך לנתונים.

=== שלב 2: המוצרים שלנו (מה אנחנו יכולים למכור) ===
${d.productsBlock}

=== שלב 3: מה ישראלים מחפשים בגוגל (GSC + Keyword Planner) ===
${d.gscBlock}

${d.kwIdeas}

=== שלב 4: הנתונים הקיימים שלנו (רק לרפרנס — אל תתבסס רק על זה) ===
שים לב: הנתונים למטה הם מה שרץ עכשיו. אתה לא חייב להמשיך עם מה שיש — אם האסטרטגיה שלך אומרת לעצור הכל ולהתחיל מחדש, זה בסדר.

סיכום Google Ads שבוע ${weekStart}–${d.weekEnd}:
עלות כוללת: ₪${Math.round(d.totalCost * 100) / 100} | קליקים: ${d.totalClicks} | המרות: ${Math.round(d.totalConversions * 10) / 10} | ROAS: ${Math.round(d.overallRoas * 100) / 100}x

קמפיינים Google:
${d.campaignBlock}

קריאייטיב Google:
${d.adCreatives}

=== שלב 4ב: Meta (Facebook + Instagram) Ads — הקמפיינים שלנו ===
סיכום Meta שבוע ${weekStart}–${d.weekEnd}:
עלות כוללת: ₪${d.metaTotalSpend} | חשיפות: ${d.metaTotalImpressions} | קליקים: ${d.metaTotalClicks} | המרות: ${d.metaTotalConversions} | CPA: ${d.metaOverallCpa != null ? `₪${d.metaOverallCpa}` : "אין"}

קמפיינים Meta פעילים:
${d.metaCampaignBlock}

השוואה לתקופה הקודמת (Meta):
${d.metaPrevBlock}

=== שלב 4ג: הקצאת תקציב בין ערוצים (חובה — לא רק Google!) ===
אתה מנהל את שני הערוצים — Google ו-Meta. אסור להמליץ רק על אחד מהם.
כללי הקצאה:
• השווה CPA בין Google ו-Meta — מי יותר זול ל-המרה?
• השווה ROAS אם זמין — איפה הכסף עובד יותר טוב?
• Google מתאים ל-intent (אנשים שמחפשים "פולי קפה ספשלטי")
• Meta/IG מתאים ל-discovery (אנשים שלא ידעו שהם רוצים אותנו) + רימרקטינג
• אם ערוץ אחד לא רץ בכלל — שאל למה. אולי צריך להפעיל אותו.
• אם ערוץ אחד מוציא הרבה כסף עם CPA גרוע — קצץ והעבר לערוץ השני.
חובה לתת המלצה ספציפית: "להעביר ₪X מ-Google ל-Meta" או "להגדיל את Meta ב-Y%" או "Google עובד מצוין, להגדיל ב-Z%". אל תתחמק מהשאלה.

מכירות:
${d.wooSales}`;
}

async function runAggressiveStrategist(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  focus?: string,
) {
  console.log(`[aggressive] Fetching data...`);
  const d = await fetchStrategistData(supabase, weekStart);
  const scoreHistory = await getScoreHistory(supabase, "strategist_aggressive");
  const pastReports = await fetchPastReports(supabase, "strategist_aggressive", weekStart);
  const completedActions = await getCompletedActions(supabase);

  const focusOverride = focus
    ? `=== הוראות מנהל — עדיפות עליונה ===\n${focus}\nהתעלם מכל נתון שסותר הוראות אלה.\n\n`
    : '';

  const systemPrompt = `${focusOverride}אתה "האוונגליסט של הספשלטי" — מנהל הקמפיינים של מינוטו לשבוע הקרוב, עם אובססיה לחובבי קפה איכותי.
${BUSINESS_BRIEF}
${ADS_EXPERTISE}
${META_ADS_EXPERTISE}

=== העדשה שלך: חובבי ספשלטי (Specialty Enthusiasts) ===
אתה מדבר אל הקהל שמזהה קפה טוב, מסוגל להבחין בין אתיופיה לקניה, מכין קפה בבית עם V60/Aeropress/French Press, רוצה לדעת מאיפה הפולים, באיזו גובה גדלו, מי הקלאי.
• לא אל קהל הסופרמרקט. אל תציע "קפה טרי vs לוואצה" — זה לא שלך. האח שלך (האסטרטג השני) מטפל בקהל המסחרי.
• אתה מוצא אנשים שעוד לא יודעים שמינוטו קיים אבל יתאהבו ברגע שיגלו: חובבי ספיישלטי שקונים בחו"ל, ברריסטות ביתיים מתחילים, אנשי high-end שעדיין במכונות קפסולות.

=== אתה מנהל הקמפיינים של השבוע הקרוב — 7 ימים בלבד ===
התפקיד שלך: תכנית פעולה שבועית מדויקת שאפשר לבצע מחר בבוקר. יום-יום.

🎯 האילוץ שלך השבוע (חובה): **אסור להמליץ על הגדלת תקציב כולל**. מצא פתרונות יצירתיים בלי להוסיף שקל — שיפור קריאייטיב, פורמטים חדשים, הפצה מחדש בין קמפיינים קיימים, רימרקטינג, שילובי ערוצים. אם ההמלצה היחידה שלך היא "תוציאו יותר" — נכשלת.

=== שלב 0: רעיונות פרועים (חובה — לפני שאתה ניגש לנתונים) ===
לפני שקראת שורה אחת של מחקר שוק או קמפיין, תן לעצמך 90 שניות לחשוב מחוץ לקופסה. הפק 8 רעיונות שמינוטו לא ניסתה:
  A. 2 קהלי חובבי ספשלטי שעוד לא מתייגים: מי? איפה מוצאים אותם?
  B. 2 זוויות מסרים שאף קלייה ישראלית לא משתמשת בהן (לא "טריות", לא "איכות", לא "ספשלטי" — משהו חדש)
  C. 2 פורמטי תוכן/ערוצים שאף מתחרה בישראל לא נוכח בהם (חשוב: לא רק IG/Google — פודקאסטים? סאבסטק? Twitch? טלגרם? דיסקורד?)
  D. 2 רעיונות מוצר/חבילה שלא קיימים בשוק הישראלי (לא מוצר חדש שצריך לייצר — דרך חדשה להגיש את הקיים)

כללים לרעיונות פרועים:
  ✓ חייב לצטט אנלוגיה מתעשייה אחרת: "כמו שליקווידת' מוות עשה למים ב-X, נעשה לקפה ב-Y"
  ✓ חייב להיות כזה שאם תספר לעצמך לפני שנה הייתה שוחקת ראש
  ✗ אסור: "להגדיל תקציב", "לשפר מודעות", "ROAS יותר טוב", "A/B test" — אלה לא רעיונות, אלה משימות.

**בחר 2-3 רעיונות הכי חזקים (לא מובן מאליו + ניתן לביצוע) והם יהיו הלב של התכנית השבועית שלך.**

=== שלב 1: כללי אנטי-בנאליות ===
❌ אסור שההמלצה העיקרית תהיה רק "להעביר תקציב בין קמפיינים". זה לא אסטרטגיה, זה טיפול שוטף.
❌ אסור להמליץ על קמפיינים/מילות מפתח שכבר רצים. תסתכל ברשימת הקמפיינים הפעילים — אל תמליץ עליהם שוב.
✓ חובה להציע לפחות קהל אחד / זווית אחת שמינוטו לא מטרגטת היום.
✓ חובה לצטט אנלוגיה חוצת-תעשיות אחת לפחות בסעיף ה-key_insights.

=== כללי טכניים ===
• פולי קפה בלבד. אם ביטוי מכיל "מטחנ", "מכונ", "cold brew", "קפה קר", "אביזר" — דלג.
• PAUSED קמפיינים — אל תזכיר.
• אל תשתמש בשמות מתחרים בכותרות מודעות (trademark policy).
• כותרות: עד 30 תווים. תיאורים: עד 90 תווים. עברית שיווקית מדוברת.
• ספק בדיוק 15 כותרות ו-4 תיאורים לכל קמפיין חדש — מוכן להעתקה ישירה לGoogle Ads.
• לכל מילת מפתח: ציין match type (broad/phrase/exact) ו-CPC צפוי.

${scoreHistory}
${completedActions}

=== היסטוריית המלצות קודמות ===
${pastReports}

הגבלות: budget_recommendations עד 3, campaigns_to_create עד 2, ads_to_rewrite עד 1, competitor_insights עד 3, market_opportunities עד 2, key_insights עד 3.
${getTacticalJsonSchema(d)}
ענה אך ורק ב-JSON תקין. חובה למלא את שדה wild_ideas ואת devils_advocate.`;

  const userMessage = buildStrategistUserMessage(d, weekStart);

  console.log(`[aggressive] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_STRATEGIST, systemPrompt, userMessage, { maxTokens: 7000, timeoutMs: 145_000 });
  const parsed = parseClaudeJson(text);
  console.log(`[aggressive] Done. Tokens: ${inputTokens + outputTokens}`);

  return { report: parsed, tokensUsed: inputTokens + outputTokens };
}

async function runPreciseStrategist(
  supabase: ReturnType<typeof createClient>,
  weekStart: string,
  focus?: string,
) {
  console.log(`[precise] Fetching data...`);
  const d = await fetchStrategistData(supabase, weekStart);
  const scoreHistory = await getScoreHistory(supabase, "strategist_precise");
  const pastReports = await fetchPastReports(supabase, "strategist_precise", weekStart);
  const completedActions = await getCompletedActions(supabase);

  const focusOverride = focus
    ? `=== הוראות מנהל — עדיפות עליונה ===\n${focus}\nהתעלם מכל נתון שסותר הוראות אלה.\n\n`
    : '';

  const systemPrompt = `${focusOverride}אתה "הגשר למיינסטרים" — אסטרטג 90 ימים שמתמחה בגיוס קונים שקונים היום את לוואצה/איליי/ברוסטוט מהסופר ומעבירים אותם לקפה אמיתי.
${BUSINESS_BRIEF}
${ADS_EXPERTISE}
${META_ADS_EXPERTISE}

=== העדשה שלך: הקונה המסחרי (Commercial Coffee Buyer) ===
אתה מדבר אל הקהל הגדול והקשה — זה שהיום קונה פולים או קפה טחון מסופר (לוואצה, איליי, הוזברנד, סגפרדו, קימבו, ברוסטוט, מאורו). הם אוהבים קפה טוב, יש להם מכונת אספרסו ביתית, הם מוציאים ₪30-60 על קילו אחד לחודש. הם לא חובבי ספיישלטי, הם *עדיין לא יודעים* שספיישלטי יותר טעים ולא יקר בהרבה.
• אל תדבר איתם בשפת ה-nerds. "Single Origin Sidamo" — לא. "פולי קפה מאתיופיה בטעם עדין של שוקולד ופירות" — כן.
• האח שלך (האסטרטג השני, 7-day) מטפל בחובבי הספיישלטי. אתה מטפל ב-90% מהשוק שעדיין לא שם.
• המטרה שלך: 90 ימים לגרום לקבוצה הזו להתחיל להעדיף מינוטו על פני המיינסטרים.

=== אתה בונה תכנית 90 ימים ===
לא "מה עושים מחר" — אלא "איפה אנחנו צריכים להיות בעוד 3 חודשים ואיך מגיעים לשם".

🎯 האילוץ שלך השבוע (חובה): **בנה תכנית שעובדת בלי Google Ads**. דמיין שגוגל הושבת. מה אז? איך מגיעים לקהל המסחרי? התשובה הקלה (להוציא יותר בגוגל) לא זמינה — אתה חייב לחשוב בכל ערוץ אחר. אחרי שיש לך תכנית בלי גוגל — הוסף בסוף גוגל כבונוס אם הגיוני, לא כמרכז.

=== שלב 0: רעיונות פרועים (חובה — לפני שאתה ניגש לנתונים) ===
תן לעצמך 90 שניות לחשוב מחוץ לקופסה. הפק 8 רעיונות שמינוטו לא ניסתה:
  A. 2 תתי-קהלים מסחריים לא מטורגטים (לא "קונים לוואצה" הכללי — תת-קבוצה ספציפית: אמהות שמכינות קפה בבוקר? עובדי הייטק שמכינים שני אספרסו ליום? דיירי בניינים עם מכונת קפסולות משותפת שרוצים לשדרג?)
  B. 2 זוויות מסרים שאף קלייה ישראלית לא משתמשת בהן כלפי הקהל המסחרי (לא "טריות", לא "איכות", לא "ספשלטי" — משהו שמדבר ישירות לפחד או לרצון שלהם)
  C. 2 ערוצים/שותפויות שאף מתחרה לא מנצל כלפי הקהל המסחרי (שותפויות עם מותגי מכונות אספרסו ביתיות? חלוקה ביוגוב? מבצעים במועדוני עובדים של חברות הייטק? סאמפלרים במאפיות בוטיק?)
  D. 2 רעיונות חבילה/מחיר שמסירים את החסם הפסיכולוגי של "יקר מדי" (חבילת ניסיון? subscription? refill?)

כללים לרעיונות פרועים:
  ✓ חייב לצטט אנלוגיה חוצת-תעשיות: "כמו ש-X בתעשיית Y עשו, נעשה בקפה"
  ✓ חייב להרגיש נועז — אם זה נשמע בטוח ורציונלי, זה כנראה לא מספיק פרוע
  ✗ אסור: "להגדיל תקציב", "לפתוח קמפיין", "A/B test" — אלה משימות, לא אסטרטגיה

**בחר 2-3 רעיונות שיגדירו את חודש 1, 2, 3 של מפת הדרכים.**

=== כללי אנטי-בנאליות ===
❌ אסור שהתכנית תהיה עיבוד של הקמפיינים הקיימים. אם חודש 1 זה "תמשיך לרוץ קמפיינים ותוסיף תקציב" — זה לא תכנית, זה סטטוס קוו.
❌ אסור שהקמפיין/קהל יהיה מה שכבר רץ או שהוצע בעבר.
✓ חובה שלפחות חודש אחד מתוך השלושה מכיל מהלך שמינוטו לא עשתה.
✓ חובה לצטט אנלוגיה חוצת-תעשיות אחת לפחות בסעיף key_insights.

=== כללים טכניים ===
• פולי קפה בלבד. לא מכונות/מטחנות/קר/cold brew/אביזרים.
• שמות מתחרים: מותר ב-competitor_strategy, אסור בקמפיינים/מודעות (trademark).
• מותר "קונים פולים מהסופר", אסור "קונים לוואצה".

${scoreHistory}
${completedActions}

=== היסטוריית המלצות קודמות ===
${pastReports}

הגבלות: budget_recommendations עד 3, campaigns_to_create עד 1, ads_to_rewrite עד 2, competitor_insights עד 3, market_opportunities עד 2, key_insights עד 3.
${getStrategicJsonSchema(d)}
ענה אך ורק ב-JSON תקין. חובה למלא את שדה wild_ideas ואת devils_advocate.`;

  const userMessage = buildStrategistUserMessage(d, weekStart);

  console.log(`[precise] Calling Claude...`);
  const { text, inputTokens, outputTokens } = await callClaude(MODEL_STRATEGIST, systemPrompt, userMessage, { maxTokens: 7000, timeoutMs: 145_000 });
  const parsed = parseClaudeJson(text);
  console.log(`[precise] Done. Tokens: ${inputTokens + outputTokens}`);

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
  const completedActions = await getCompletedActions(supabase);

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

  const focusOverride = focus
    ? `=== הוראות מנהל — עדיפות עליונה ===
${focus}
התעלם מכל נתון שסותר הוראות אלה. אם GSC מראה הזדמנות שמנהל ביקש לא לקדם — דלג עליה ואל תזכיר אותה. אם המנהל ביקש להתמקד בנושא מסוים — כל ההמלצות שלך חייבות להיות על הנושא הזה.\n\n`
    : '';

  const systemPrompt = `${focusOverride}אתה מנהל שיווק דיגיטלי בכיר עם ניסיון בתוכן ו-SEO לעסקי מזון/קפה. אתה מייעץ ל-Minuto Coffee.
${BUSINESS_BRIEF}
${COMPETITIVE_INTELLIGENCE}
${ORGANIC_EXPERTISE}

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

הגבלות פלט קפדניות — חרוג מהן = שגיאה:
• google_organic_recommendations — פריט אחד בלבד
• content_recommendations — עד 2 פריטים
• products_to_feature — פריט אחד בלבד
• posts_to_publish — פוסט אחד בלבד; caption — עד 120 תווים; hashtags — עד 5
• key_insights — עד 2
ענה אך ורק ב-JSON תקין — ללא טקסט לפניו או אחריו.

דוגמאות לסגנון עברית נכון לשדות הטקסט:
✓ "ה-CTR של Coffee_beans_oam נפל — הקופי גנרי ולא מדבר לאף אחד. עוצרים."
✓ "ה-ROAS של MM|SRC ירד ב-40% למרות CTR גבוה — בעיה ב-landing page, לא במודעה."
✓ "קמפיין טריות עם הכותרת 'נקלה ונשלח היום' יכול להכפיל את ה-CTR הנוכחי."
✗ "הקמפיין הינו בעל ביצועים שאינם מספקים" — עברית מתה. NEVER.
✗ "מומלץ לבחון אפשרות של שיפור" — ריק ולא אומר כלום. NEVER.
✗ "יש לציין כי" / "יש לקחת בחשבון" / "כמו כן" — לא כותבים ככה. NEVER.`;

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
      "visual_direction": "הנחיה קצרה למצלם"
    }
  ],
  "key_insights": ["תובנה 1", "תובנה 2"]
}`;

  const finalMessage = focus
    ? userMessage // Focus is already injected at the TOP of the system prompt
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

// ── Banner Image Generation (Gemini Imagen) ─────────────────────────────────
// Same model fallback chain used by generate-campaign for email banners.
// Stores the result in Supabase Storage `marketing` bucket so it gets a
// permanent public URL the user can paste into their CMS.

async function generateBlogBanner(title: string, keyword: string, supabase: ReturnType<typeof createClient>): Promise<string | null> {
  if (!GEMINI_KEY) {
    console.log("[blog_writer] No GEMINI_API_KEY, skipping banner");
    return null;
  }

  const banned = /\b(motorcycle|motorbike|bike|bicycle|car|truck|vehicle|road|highway|mountain|mountains|forest|journey|travel|ride|landscape|sunset|sunrise|sky|cloud|nature|scenic|adventure)\b/gi;
  const safeTitle = (title || "").replace(banned, "").replace(/\s+/g, " ").trim();
  const safeKeyword = (keyword || "").replace(banned, "").replace(/\s+/g, " ").trim();

  // Build the prompt like a photographer's brief for a specific shot.
  // Every image should look like it was taken at Minuto Cafe by a pro
  // photographer with a 50mm lens — not a stock photo, not a graphic.
  //
  // The key: describe ONE specific scene in detail, don't give options.
  // Bad: "show coffee beans or a cup or brewing equipment"
  // Good: "close-up of freshly roasted dark beans on a worn wooden board,
  //        warm side light catching the oily sheen, shallow depth of field"

  // Use Claude to generate a specific photographer's brief based on the topic
  // For now, use smart defaults based on topic keywords
  const titleLower = (safeTitle + " " + safeKeyword).toLowerCase();

  let sceneDescription: string;

  if (titleLower.includes("מקיאטו") || titleLower.includes("macchiato") || titleLower.includes("כתם חלב")) {
    sceneDescription = "A traditional Italian Caffè Macchiato served in a small clear glass espresso cup on a white saucer with a small spoon. The drink is a rich, dark espresso shot with thick hazelnut-colored crema, topped with ONLY a small dollop of white velvety milk foam in the center — like a tiny white spot on dark coffee. NO latte art, NO hearts, NO swirl patterns, NO large foam. The cup sits on a rustic wooden cafe table. Soft blurred background of a cozy coffee shop interior with warm lighting.";
  } else if (titleLower.includes("אספרסו") || titleLower.includes("espresso")) {
    sceneDescription = "A freshly pulled espresso shot in a small white ceramic demitasse cup on a saucer. The espresso has a thick, rich, tiger-striped crema — deep amber with darker streaks. A thin wisp of steam rises from the surface. The cup sits on a worn wooden cafe counter. Behind it, out of focus, the chrome group head of an espresso machine glistens. Warm side lighting from a cafe window.";
  } else if (titleLower.includes("פולי") || titleLower.includes("beans") || titleLower.includes("קלייה") || titleLower.includes("roast")) {
    sceneDescription = "A close-up of freshly roasted specialty coffee beans spread on a rustic worn wooden board. The beans are dark chocolate brown with a visible oily sheen. Some beans are whole, a few are cracked open showing the lighter interior. Warm side lighting from the left catches the oils and textures. A small burlap coffee sack is partially visible in the soft background. Shallow depth of field — front beans sharp, back beans soft. The image smells like fresh coffee.";
  } else if (titleLower.includes("ethiopia") || titleLower.includes("אתיופי")) {
    sceneDescription = "Medium-roasted Ethiopian coffee beans with a distinctive reddish-brown color, spread on a dark slate surface. A few green unroasted beans sit beside them for contrast. Warm overhead lighting. A small ceramic cup of brewed coffee with a light amber color sits in the background, slightly out of focus. The mood is earthy, authentic, and artisanal.";
  } else if (titleLower.includes("brazil") || titleLower.includes("ברזיל")) {
    sceneDescription = "Freshly roasted Brazilian coffee beans — uniform medium-dark roast with a smooth, chocolate-brown surface. They sit in a small ceramic bowl on a wooden cafe table. Next to the bowl, an espresso cup with thick golden crema. Warm natural light from the side. Background: soft bokeh of a roastery interior with copper and wood tones.";
  } else if (titleLower.includes("פילטר") || titleLower.includes("filter") || titleLower.includes("pour over") || titleLower.includes("chemex") || titleLower.includes("v60")) {
    sceneDescription = "A pour-over coffee setup on a wooden counter — a glass Chemex or V60 dripper with fresh coffee dripping through. The coffee stream is thin and golden. Steam rises gently. A small pile of medium-roasted beans sits on a wooden board beside it. Morning light from a window creates warm shadows. Clean, minimal, artisanal atmosphere.";
  } else if (titleLower.includes("מתנ") || titleLower.includes("gift") || titleLower.includes("חג") || titleLower.includes("שבועות")) {
    sceneDescription = "An elegant coffee gift set on a wooden surface — a kraft paper bag of specialty coffee beans with a simple string bow, next to a small ceramic espresso cup. Warm holiday lighting with soft golden bokeh in the background. The mood is thoughtful and premium — this is a gift someone would be proud to give. Clean, minimal styling.";
  } else {
    sceneDescription = "A close-up of freshly roasted specialty coffee beans on a rustic wooden cafe table at Minuto Cafe. The beans are dark and glossy with visible oils. Warm side lighting from a cafe window creates depth and shadows. A ceramic espresso cup with thick crema sits slightly behind the beans, out of focus. The atmosphere is warm, artisanal, and inviting. Shallow depth of field.";
  }

  const imagePrompt = `Create a high-quality, realistic photo. NOT an AI illustration, NOT a stock photo, NOT a graphic design. This should look like it was shot by a professional photographer with a 50mm lens at f/2.8 — shallow depth of field, natural lighting, photorealistic.

${sceneDescription}

Format: 16:9 wide landscape. Photorealistic. High resolution. Natural color grading — warm tones, no oversaturation.

STRICTLY FORBIDDEN: people, faces, hands, human figures, text, letters, words, numbers, logos, watermarks, AI artifacts, motorcycles, vehicles, outdoor scenery, animals. Do not add any text overlay or watermark.`;

  let base64: string | null = null;
  let mime = "image/png";

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
      console.log(`[blog_writer] Trying ${attempt.name}...`);
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
          console.log(`[blog_writer] Banner generated via ${attempt.name}`);
        } else {
          console.log(`[blog_writer] ${attempt.name}: no image in response`);
        }
      } else {
        const errText = await res.text().catch(() => "");
        console.log(`[blog_writer] ${attempt.name} failed: ${res.status} ${errText.slice(0, 200)}`);
      }
    } catch (e: any) {
      console.log(`[blog_writer] ${attempt.name} error: ${e.message}`);
    }
  }

  if (!base64) {
    console.log("[blog_writer] All image generation attempts failed");
    return null;
  }

  try {
    const filename = `banners/blog_${Date.now()}.${mime.includes("png") ? "png" : "jpg"}`;
    const fileBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    console.log(`[blog_writer] Uploading banner: ${filename} (${fileBytes.length} bytes)`);

    const { error: uploadErr } = await supabase.storage
      .from("marketing")
      .upload(filename, fileBytes, { contentType: mime, upsert: true });

    if (uploadErr) {
      console.error("[blog_writer] Upload error:", JSON.stringify(uploadErr));
      return null;
    }

    const { data: publicUrl } = supabase.storage
      .from("marketing")
      .getPublicUrl(filename);

    console.log("[blog_writer] Banner URL:", publicUrl?.publicUrl);
    return publicUrl?.publicUrl || null;
  } catch (e: any) {
    console.error("[blog_writer] Banner upload error:", e.message);
    return null;
  }
}

// ── Blog Writer Agent ─────────────────────────────────────────────────────────

async function runBlogWriterAgent(params: {
  keyword: string;
  title: string;
  key_points: string[];
  position?: number;
  search_volume_signal?: string;
  products_to_mention?: string[];
}): Promise<{ title: string; meta_description: string; slug: string; body: string }> {
  const { keyword, title, key_points, position, search_volume_signal, products_to_mention } = params;

  // Look up product permalinks from DB so the blog body can contain real
  // UTM-tagged links to the Minuto store. The frontend only passes product
  // names — we resolve them server-side to avoid leaking the full product
  // catalog to the client and to keep the permalink as the single source
  // of truth (if the slug changes in WooCommerce, the DB reflects it).
  let productLinks: Array<{ name: string; url: string }> = [];
  if (products_to_mention && products_to_mention.length > 0) {
    const supabase = createClient(SUPA_URL, SUPA_KEY);
    const { data: rows } = await supabase
      .from('woo_products')
      .select('name, permalink')
      .in('name', products_to_mention);
    if (rows) {
      productLinks = rows
        .filter((r: any) => r.permalink)
        .map((r: any) => ({
          name: r.name,
          url: `${r.permalink}?utm_source=blog&utm_medium=article&utm_campaign=${encodeURIComponent(keyword)}`,
        }));
    }
  }

  // Ask Claude ONLY for the blog body in plain Markdown — no JSON, no XML, no formatting wrappers.
  // The server constructs title, slug, and meta_description itself to avoid any parsing errors.
  const systemPrompt = `אתה כותב תוכן לבלוג של Minuto Coffee, בית קלייה ספשלטי ברחובות.
${BUSINESS_BRIEF}
${ORGANIC_EXPERTISE}

כתוב פוסט בלוג בעברית ישראלית מדוברת. לא תרגום מאנגלית. לא שפה פורמלית.
חובה: כתוב בלשון רבים (אתם/לכם) ולא בלשון יחיד זכר (אתה/לך). אנחנו פונים לכל הלקוחות — גברים, נשים, כולם.

חוקי SEO:
מילת המפתח חייבת להופיע בכותרת H1, בפסקה הראשונה, ב-2-3 כותרות H2, וטבעי לאורך הטקסט.
4 כותרות H2 לפחות, כל אחת עם זווית שונה.
אורך: 600-800 מילים.
בסוף: CTA עדין בסגנון "אפשר להזמין ישירות מהאתר עם משלוח לכל הארץ".

חוקי סגנון (חשוב מאוד):
כתוב כמו אדם שמסביר לחבר, לא כמו רובוט.
משפטים קצרים. ישירים. בלי הקדמות מיותרות.
אסור להשתמש בתו הזה: \u2014 (הוא נראה כך: —). במקומו תשתמש בפסיק, בנקודה, או ב"כי".
אסור לכתוב: "ללא ספק", "חשוב לציין", "כמובן", "בסופו של דבר", "ניתן לומר", "מעניין לציין", "יש לציין", "בהחלט", "בואו נדבר על", "לסיכום".
אל תפתח משפטים עם "כך" או "לכן" יותר מפעם אחת.
אל תשתמש בסימן ":" אחרי כל משפט כדי להציג רשימה. כתוב בפסקות רצופות.
המאמר צריך להישמע כאילו כתב אותו בן אדם אמיתי שמבין קפה לעומק.

החזר את המאמר בפורמט Markdown בלבד. התחל ישירות עם כותרת H1. אין JSON, אין XML, אין הסברים.`;

  const userMessage = `כתוב פוסט בלוג מלא לפי הפרמטרים הבאים:

מילת מפתח ראשית: "${keyword}"
${position ? `מיקום נוכחי בגוגל: ${position} (יש לנו דריסת רגל — כדאי לחזק)` : ''}
${search_volume_signal ? `נפח חיפוש: ${search_volume_signal}` : ''}
כותרת H1: "${title}"

נקודות חובה לכלול בתוכן:
${key_points.map((p, i) => `${i + 1}. ${p}`).join('\n')}
${productLinks.length > 0
  ? `\nמוצרים של Minuto לציין בפוסט (ציין אותם באופן טבעי, לא בצורת פרסומת).
כשאתה מזכיר מוצר, הפוך את שם המוצר ללינק Markdown עם ה-URL שניתן. חובה להשתמש בלינקים בדיוק כפי שניתנו (כולל פרמטרי UTM):
${productLinks.map(p => `- ${p.name}: ${p.url}`).join('\n')}`
  : products_to_mention && products_to_mention.length > 0
  ? `\nמוצרים של Minuto לציין בפוסט (ציין אותם באופן טבעי, לא בצורת פרסומת):\n${products_to_mention.map(p => `- ${p}`).join('\n')}`
  : ''}

כתוב את המאמר המלא. התחל ישירות עם # ${title} כ-H1 ראשון.`;

  console.log(`[blog_writer] Writing post for keyword: "${keyword}"`);
  const { text, inputTokens, outputTokens } = await callClaude("claude-sonnet-4-5", systemPrompt, userMessage, { maxTokens: 6000, timeoutMs: 135_000 });
  console.log(`[blog_writer] Done. Tokens: ${inputTokens + outputTokens}. Body length: ${text.length}`);

  // Body is the raw Markdown — strip any em-dashes Claude snuck in despite instructions
  const body = text.trim()
    .replace(/\u2014/g, ',')   // em-dash → comma
    .replace(/\u2013/g, '-');  // en-dash → regular hyphen

  // Build slug from keyword: lowercase, strip diacritics, replace spaces with hyphens
  const slug = keyword
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '') // strip Hebrew niqqud
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u0590-\u05FF-]/g, '') // keep Hebrew letters, latin, digits, hyphens
    .slice(0, 60);

  // Build meta_description: first non-header paragraph, trimmed to 155 chars
  const firstPara = body
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 30 && !l.startsWith('#') && !l.startsWith('*') && !l.startsWith('-'));
  const meta_description = (firstPara ?? `${keyword} — מדריך מקיף מ-Minuto Coffee`)
    .replace(/\*+/g, '')
    .slice(0, 155);

  return { title, meta_description, slug, body };
}

// ── Main handler ──────────────────────────────────────────────────────────────

// Wraps the handler so every response (success, error, OPTIONS) gets the right
// per-request CORS origin. Avoids touching every individual `new Response(...)`
// in the body.
function withCors(handler: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    const cors = getCorsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    let res: Response;
    try {
      res = await handler(req);
    } catch (e: any) {
      console.error("[marketing-advisor] uncaught:", e?.message, e?.stack);
      res = new Response(JSON.stringify({ error: e?.message || "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  };
}

serve(withCors(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(SUPA_URL, SUPA_KEY);

  let body: {
    trigger?: string; agent?: string; focus?: string;
    keyword?: string; title?: string; key_points?: string[];
    position?: number; search_volume_signal?: string;
    products_to_mention?: string[];
    week?: "current" | "previous";
    week_start?: string;
  } = {};
  try { body = await req.json() } catch { /* default to all */ }

  // Default to the CURRENT week so the owner can monitor running campaigns
  // as they perform. The body can still override with week:"previous" or an
  // explicit week_start=YYYY-MM-DD for backfilling analysis of a prior week.
  const weekStart = body.week_start
    ?? (body.week === "previous" ? getPreviousWeekStart() : getCurrentWeekStart());
  console.log(`[marketing-advisor] weekStart: ${weekStart}`);

  // ── BLOG WRITER — instant response, not stored in DB ──────────────────────
  if (body.agent === "blog_writer") {
    if (!body.keyword || !body.title) {
      return new Response(JSON.stringify({ error: "keyword and title are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // Always return 200 so the error message reaches the client (Supabase JS swallows 5xx bodies)
    try {
      const post = await runBlogWriterAgent({
        keyword: body.keyword,
        title: body.title,
        key_points: body.key_points ?? [],
        position: body.position,
        search_volume_signal: body.search_volume_signal,
        products_to_mention: body.products_to_mention,
      });
      return new Response(JSON.stringify(post),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[blog_writer] FAILED: ${msg}`);
      return new Response(JSON.stringify({ error: msg }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }

  // ── BLOG BANNER — separate action, generates just the hero image ──────────
  if (body.agent === "blog_banner") {
    if (!body.keyword || !body.title) {
      return new Response(JSON.stringify({ error: "keyword and title are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    try {
      console.log(`[blog_banner] Generating banner for: "${body.title}"`);
      const bannerUrl = await generateBlogBanner(body.title, body.keyword, supabase);
      return new Response(JSON.stringify({ banner_url: bannerUrl }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[blog_banner] FAILED: ${msg}`);
      return new Response(JSON.stringify({ error: msg, banner_url: null }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }

  // ── SCORE ENDPOINT — user rates which strategy won ──────────────────────────
  if (body.agent === "score") {
    const { winning_agent, score: scoreVal, feedback_text } = body as any;
    if (!winning_agent || !scoreVal) {
      return new Response(JSON.stringify({ error: "winning_agent and score are required" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const { error: scoreErr } = await supabase.from("advisor_scores").upsert(
      { week_start: weekStart, winning_agent, score: scoreVal, feedback_text: feedback_text || null },
      { onConflict: "week_start" },
    );
    if (scoreErr) console.error("[score] Upsert error:", JSON.stringify(scoreErr));
    return new Response(JSON.stringify({ ok: !scoreErr, week_start: weekStart }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const focus = body.focus?.trim() || undefined;
  if (focus) console.log(`[marketing-advisor] Focus context: ${focus.slice(0, 100)}`);

  const agentArg = body.agent ?? "all";
  const weekEnd = addDays(weekStart, 6);

  // New agent types: two competing strategists + organic (keeping old ones for backward compat)
  const NEW_AGENTS = ["strategist_aggressive", "strategist_precise", "organic_content"];
  const OLD_AGENTS = ["google_ads_growth", "google_ads_efficiency", "organic_content"];
  const ALL_VALID = [...NEW_AGENTS, ...OLD_AGENTS, "market_research"];
  const isOrchestrator = agentArg === "all" || agentArg === "both";
  const isSingleAgent  = ALL_VALID.includes(agentArg);

  // ── ORCHESTRATOR MODE ────────────────────────────────────────────────────────
  // 1. Fire market_research first
  // 2. Fire the two competing strategists + organic in parallel
  // The strategists will poll for research data — if it's not ready in 30s
  // they proceed without it.
  if (isOrchestrator) {
    // Mark new agents as running
    await Promise.all(
      NEW_AGENTS.map(type =>
        upsertReport(supabase, type, weekStart, { status: "running", error_msg: null })
      )
    );

    const selfUrl = `${SUPA_URL}/functions/v1/marketing-advisor`;
    const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${SUPA_KEY}` };

    // Fire research first (fire-and-forget — strategists will poll for it)
    fetch(selfUrl, { method: "POST", headers, body: JSON.stringify({ agent: "market_research" }) })
      .catch(e => console.error("[orchestrator] fire research error:", e.message));

    // Fire all 3 agents after a short delay to give research a head start
    setTimeout(() => {
      for (const agent of NEW_AGENTS) {
        fetch(selfUrl, { method: "POST", headers, body: JSON.stringify({ agent, focus }) })
          .catch(e => console.error(`[orchestrator] fire ${agent} error:`, e.message));
      }
    }, 2000);

    return new Response(
      JSON.stringify({ started: true, week_start: weekStart, agents: NEW_AGENTS }),
      { status: 202, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  // ── SINGLE AGENT MODE ────────────────────────────────────────────────────────
  if (!isSingleAgent) {
    return new Response(
      JSON.stringify({ error: `Unknown agent: ${agentArg}` }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  // Market research agent — runs synchronously, stores results in market_research table
  if (agentArg === "market_research") {
    console.log("[market_research] Starting...");
    try {
      const result = await runMarketResearch(supabase);
      return new Response(
        JSON.stringify({ success: true, agent: "market_research", ...result }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[market_research] Error:", msg);
      return new Response(
        JSON.stringify({ success: false, agent: "market_research", error: msg }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }
  }

  console.log(`[${agentArg}] Starting single-agent run for week ${weekStart}`);
  await upsertReport(supabase, agentArg, weekStart, { status: "running", error_msg: null });

  try {
    let result: { report: unknown; tokensUsed: number };
    let model: string;

    if (agentArg === "strategist_aggressive") {
      result = await runAggressiveStrategist(supabase, weekStart, focus);
      model  = MODEL_ADS;
    } else if (agentArg === "strategist_precise") {
      result = await runPreciseStrategist(supabase, weekStart, focus);
      model  = MODEL_ADS;
    } else if (agentArg === "google_ads_growth") {
      // Backward compat — old agent type routes to aggressive strategist
      result = await runAggressiveStrategist(supabase, weekStart, focus);
      model  = MODEL_ADS;
    } else if (agentArg === "google_ads_efficiency") {
      // Backward compat — old agent type routes to precise strategist
      result = await runPreciseStrategist(supabase, weekStart, focus);
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

    // If all 3 new agents are done → send email digest
    const { data: allRows } = await supabase
      .from("advisor_reports")
      .select("agent_type,status,report")
      .eq("week_start", weekStart)
      .in("agent_type", NEW_AGENTS);

    const doneRows = (allRows ?? []).filter((r: { status: string }) => r.status === "done");
    if (doneRows.length === NEW_AGENTS.length) {
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
}));
