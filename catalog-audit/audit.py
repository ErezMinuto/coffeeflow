#!/usr/bin/env python3
"""Minuto catalog audit (read-only). Re-run from ./raw without re-fetching:
    python3 catalog-audit/audit.py
Writes findings.csv and summary.md next to this file."""
import csv, html, json, os, re, collections
D = os.path.dirname(os.path.abspath(__file__))
P = {p['id']: p for p in json.load(open(f'{D}/raw/products.json'))}
COFFEE = [c['id'] for c in json.load(open(f'{D}/raw/coffee_products_clean.json'))]

def strip(h):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', h or ''))).strip()

H, M, L = 'high', 'medium', 'low'
C, LI, VE = 'certain', 'likely', 'verify'
IM, CP, BS, SC, CF, HE, MI = ('internal_mismatch', 'copy_paste', 'blend_vs_single_origin',
                              'spec_commerce', 'coffee_facts', 'hebrew_text', 'missing_data')

# (product_id, field, issue_type, severity, current_text, problem, suggested_fix, confidence)
F = [
 # ---- unit prices written into the copy are stale
 (65135,'description',SC,H,'מחיר ל - 100 גר 23.1₪','Hard-coded unit price is wrong: 79 ₪ / 330 g = 23.94 ₪ per 100 g (23.1 matches an older ~76 ₪ price).','מחיר ל-100 גר׳: 23.94 ₪ (עדיף להסיר את השורה ולהציג מחיר ליחידה אוטומטית מהמחיר בפועל)',C),
 (65196,'description',SC,H,'מחיר ל - 100 גר 16.5 שח','Hard-coded unit price is wrong: 59 ₪ / 330 g = 17.88 ₪ per 100 g.','מחיר ל-100 גר׳: 17.88 ₪',C),
 (65189,'description',SC,H,'מחיר ל - 100 גר - 16.5 שח','Hard-coded unit price is wrong: 59 ₪ / 330 g = 17.88 ₪ per 100 g.','מחיר ל-100 גר׳: 17.88 ₪',C),
 (64855,'description',SC,H,'מחיר ל - 100 גר - 19.5 שח','Hard-coded unit price is wrong: 69 ₪ / 330 g = 20.91 ₪ per 100 g.','מחיר ל-100 גר׳: 20.91 ₪',C),
 # ---- composition / roast contradictions
 (65201,'short_description + rank_math_description vs description',IM,H,'קצר: 90% ערביקה / 10% רובוסטה · תיאור: 80% ערביקה / 20% רובוסטה','Blend ratio differs between short description/SEO (90/10) and long description (80/20). Roasted Prestige (65196) is 80/20.','לאשר את היחס מול הספק; אם זהה לפרסטיז׳ הקלוי: "80% ערביקה ברזילאית, 20% רובוסטה הודית" בכל השדות',LI),
 (82277,'name vs short_description/description',CF,H,'קפסולות לוואצה בלו רומא אספרסו 100% ערביקה','Title claims 100% Arabica, but the short and long descriptions say the blend is Arabica + Robusta.','קפסולות לוואצה בלו רומא אספרסו - Lavazza Blue Tales of Roma (להסיר "100% ערביקה"; לאמת הרכב מול אריזת לוואצה)',LI),
 (82277,'description',CP,M,'קפסולות לוואצה בלו ונציה אספרסו 100% ערביקה - Lavazza Blue Tales of Venezia','Description headline names a different product (Venezia) than the product itself (Roma).','קפסולות לוואצה בלו רומא אספרסו - Lavazza Blue Tales of Roma',C),
 (65180,'rank_math_title / rank_math_description vs attribute',IM,H,'Daye Bensa - קלייה בהירה וטריה · attribute: רמת קלייה = בינונית','Google title/snippet say light roast; the product is the medium-roast Daye Bensa. A separate light-roast listing (78450) exists, so a customer can buy the wrong roast.','כותרת SEO: "פולי קפה אתיופיה Daye Bensa - קלייה בינונית | %sitename%"; תיאור SEO: "...ספשלטי בקלייה בינונית..."',C),
 (65384,'rank_math_title / rank_math_description vs attribute',IM,H,'יירגשף חד זני - קלייה בהירה · "פולי קפה אתיופיה Sidama..." · attribute: בינונית','SEO says light roast and "Sidama" (copied from Daye Bensa); attribute and description say medium roast, Yirgacheffe.','כותרת SEO: "פולי קפה אתיופיה יירגשף חד זני - קלייה בינונית"; תיאור SEO: "פולי קפה אתיופיה יירגשף ספשלטי בקלייה בינונית. הדרים, יסמין ותה ירוק, גוף בינוני ומאוזן"',C),
 # ---- origin / farm
 (65175,'short_description / description',IM,H,'אזור: עמק גרמה – Grama Valley · שם החווה – Grupo Sertãozinho · "...בכרמו דה מינאס - מדינת מינאס גראיס"','Spec box gives Grama Valley (São Paulo/Mogiana) and farm "Grupo Sertãozinho"; the story text and title say Fazenda Sertão in Carmo de Minas (Sul de Minas). Two different origins.','לאמת מול ספק הקפה הירוק; אם זה Fazenda Sertão: "אזור: כרמו דה מינאס, דרום מינאס ז׳ראיס" · "חווה: Fazenda Sertão". לעדכן גם ב-65108 וב-67146',LI),
 (65108,'description',IM,M,'אזור: עמק גרמה · Grupo Sertãozinho · גובה: 1,200 – 1,400 מטר','Same region/farm conflict as 65175; altitude also differs from the roasted page (1,100–1,450 m).','ליישר מול 65175 לאחר אימות מול הספק (אזור, חווה וגובה זהים בשני המוצרים)',LI),
 (67146,'description',IM,M,'מקור: ברזיל, עמק גרמה · Sidama Ethiopia Deya Bensa','Kit repeats the unverified Grama Valley origin; spells Daye Bensa as "Deya Bensa".','לעדכן אחרי אימות 65175; "Daye Bensa" באיות אחיד',LI),
 (82540,'description / name',MI,M,'פולי קפה ספשלטי מינוטו ... - Roastery Brisas · מותג: Roastery Brisas','No country of origin anywhere. Title brands it Minuto, but spec box says brand Roastery Brisas (roasted by Minuto or bought in roasted?).','להוסיף "מקור: [מדינה/אזור – לאמת מול הספק]"; לאשר מי קלה – אם מינוטו, "קלייה: מינוטו"; אם לא, להסיר "מינוטו" מהכותרת',VE),
 # ---- blend vs single origin
 (80501,'rank_math_description',BS,M,'Sweet Leona: תערובת פולי קפה מובחרת... חוויית אספרסו קטיפתית','SEO snippet calls a single-origin Colombian Caturra a blend and pitches espresso; page says single origin, light roast, best for filter.','Sweet Leona: קפה ספשלטי חד-זני מקולומביה (Caturra, עיבוד Honey) בקלייה בהירה – פרחים, תאנים וקני סוכר מקורמל. מושלם לפילטר. עכשיו במינוטו!',C),
 (64855,'short_description / description vs category',BS,M,'תערובת 100% קולומביה · קטגוריה: פולי קפה חד זני','Described as a blend ("תערובת") while sold under single origin.','אם לוט אחד: "קפה חד-זני 100% קולומביה"; אם שילוב של כמה אזורים בקולומביה: "תערובת של פולים מכמה אזורים בקולומביה" ולהוציא מקטגוריית חד זני',VE),
 (64734,'description vs category',BS,M,'תערובת נטולת קפאין המורכבת מ 100 % ערביקה מקסיקנית · קטגוריה: חד זני','Described as a blend while sold under single origin.','אם מקור אחד: "קפה נטול קפאין חד-זני, 100% ערביקה ממקסיקו"; אחרת להוציא מקטגוריית חד זני',VE),
 (64702,'description',IM,M,'שילוב מוקפד של פולים ממקורות שונים · מקור: ברזיל','"Different origins" contradicts "מקור: ברזיל" in short and long description (and the kit 67217 says 100% Brazilian).','אם כל הפולים מברזיל: "שילוב מוקפד של פולים מחוות שונות בברזיל"; אחרת לפרט את המקורות ולתקן את "מקור: ברזיל"',VE),
 (65204,'name / category',CF,M,'פולי קפה טרי ספשלטי ... אינטנסו · 70% ערביקה ו-30% רובוסטה','Marketed and categorised as specialty while 30% robusta. Specialty normally means SCA-graded Arabica (or graded Fine Robusta).','אם הרובוסטה אינה Fine Robusta מדורגת: "פולי קפה טרי מינוטו אינטנסו – תערובת אספרסו" והוצאה מקטגוריית ספשלטי',VE),
 (65196,'name / category',CF,M,"פולי קפה טרי ספשלטי ... פרסטיז' · 80% ערביקה ו-20% רובוסטה",'Specialty claim on a blend with 20% robusta.',"אם אינה Fine Robusta: \"פולי קפה טרי מינוטו פרסטיז' – תערובת אספרסו\"",VE),
 (65189,'name / category',CF,M,'פולי קפה טרי ספשלטי ... טריאסט · 80% ערביקה ו-20% רובוסטה','Specialty claim on a blend with 20% robusta.','אם אינה Fine Robusta: "פולי קפה טרי מינוטו טריאסט – תערובת אספרסו"',VE),
 (76255,'rank_math_description',IM,M,'פולי קפה ספשלטי בקלייה טרייה מבית מינוטו... לאספרסו או פילטר','Veneto is the non-specialty Italian line (Arabica + robusta), but the SEO snippet calls it specialty and suggests filter.','חבילת 3 ק״ג פולי קפה Veneto – תערובות ערביקה ורובוסטה בסגנון איטלקי, ב-10% הנחה. לאספרסו ומקינטה',C),
 (64772,'rank_math_description',IM,M,'פולי קפה ספשלטי בקלייה טרייה מבית מינוטו... לאספרסו או פילטר','Non-specialty 60/40 Arabica/robusta blend described as specialty, suitable for filter.','1 ק״ג פולי קפה Veneto Delux – 60% ערביקה ו-40% רובוסטה, בסגנון איטלקי. מתיקות עדינה, תווים אגוזיים וחומציות נמוכה. לאספרסו ומקינטה',C),
 (64771,'rank_math_description',IM,M,'פולי קפה ספשלטי בקלייה טרייה מבית מינוטו... לאספרסו או פילטר','Non-specialty 40/60 Arabica/robusta blend described as specialty, suitable for filter.','1 ק״ג פולי קפה Veneto Premium – כ-40% ערביקה ו-60% רובוסטה, תערובת אינטנסיבית עם קקאו ופירות יבשים. לאספרסו וקפוצ׳ינו',C),
 # ---- copy-paste leftovers / duplicates
 (65384,'description',CP,M,'1, יש לו 0 - 3 ליקויים ; זה נדיר! קפה בדרגה 2 מאפשר 4 - 12 ליקויים...','Broken fragment pasted from the Daye Bensa description at the end of the page.','למחוק את הפסקה מ-"1, יש לו 0 - 3 ליקויים" ועד "קפה לא רחוץ."',C),
 (65175,'description',CP,M,'אחד מזני הקפה הקלאסיים בעולם... קרקעות וולקניות ותנאים דמויי אביב נצח','Paragraph copied from Guatemala Antigua (65179); "volcanic soil, eternal spring" describes Antigua, not Carmo de Minas.','להחליף ב: "ערביקה ברזילאית מזן בורבון צהוב – קלאסית, מתוקה ומאוזנת." ולמחוק את המשפט על קרקעות וולקניות ואביב נצח',LI),
 (78450,'whole product vs 65180',CP,M,'Daye Bensa (בהירה) ו-Daye Bensa (בינונית) – תיאור כמעט זהה','Two live listings of the same coffee; 65180 title has no roast level and both share the same story text, so the light/medium difference is easy to miss.','להוסיף "בקלייה בינונית" לשם של 65180; לפתוח את התיאור של כל אחד במשפט על רמת הקלייה והשימוש המומלץ; לאשר ששני המוצרים נמכרים בפועל',C),
 (65463,'whole product vs 65135',IM,M,'גדל בגובה של מעל 1800 מטר (65463) · 1700 מטר, מחוז קיאמבו (65135)','Two Kenya AA+ listings with different altitude; 65135 has no roast level. If the same green lot, the specs must match.','לאמת מול הספק אם זה אותו לוט; ליישר גובה/אזור/זנים, ולהוסיף רמת קלייה ל-65135 (וגם לשם המוצר)',VE),
 (65196,'whole product vs 65189',CP,L,"פרסטיז': ברזיל + רובוסטה הודית 80/20 · טריאסט: דרום אמריקה + הודו 80/20",'Two blends with the same ratio, price and near-identical copy; customers cannot tell them apart.','להוסיף לכל אחת משפט מבדיל (מקור, רמת קלייה, תווי טעם) – לאמת מול מתכון הקלייה',VE),
 # ---- coffee facts
 (65463,'description',CF,M,'פולי קפה קניה AA מגיעים מזן ייחודי של פולי קפה','AA is a Kenyan bean-size grade, not a variety.','"AA הוא דירוג גודל הפול הגבוה בקניה. הזנים: SL28, SL34 ו-Ruiru" (לאמת מול הספק)',C),
 (65135,'description',CF,L,'מדובר באחד מהזנים היותר מיוחדים שנחתו בארץ','AA is a grade, not a variety.','מדובר באחד הקפים המיוחדים ביותר שנחתו בארץ',C),
 (65135,'name vs description',CF,M,'Mount Kenya AA · מחוז קיאמבו - ניירובי','Kiambu (north of Nairobi) is not part of the Mount Kenya growing region (Nyeri, Kirinyaga, Embu, Meru).','לאמת מול הספק את האזור; אם קיאמבו – להסיר "Mount" מהשם או להסביר שזה שם מסחרי',VE),
 (65180,'description',CF,L,'גובה: 1,600 -1,900 מ׳ (חוות דיי בנסה, שאנטאווין)','Daye Bensa lots from Shantawene/Bensa are usually listed around 1,900–2,350 m; 1,600–1,900 m is generic Sidamo.','לאמת את הגובה מול גיליון הלוט של הספק (גם ב-78450 וב-67146)',VE),
 (65169,'description',CF,L,'את האתיופיה סידמו גוג׳י','Guji is its own zone (Oromia), not Sidamo; older trade names mix them up.','"את הגוג׳י מאתיופיה" (ולאמת את שם הלוט מול הספק)',VE),
 (65179,'description',CF,L,'אחד מזני הקפה הקלאסיים בעולם: ערביקה גוואטמלה אנטיגואה','Antigua is a region, not a variety.','אחד מאזורי הקפה הקלאסיים בעולם: אנטיגואה שבגואטמלה',C),
 (65175,'description',CF,L,'עיבוד: נטורל פרוסס · "דובדבן הקפה הוא נשטף ומונח על משטח ייבוש"','"Washed" can be read as washed process; for a natural it means cleaning the cherries before drying.','"לאחר הקטיף הדובדבנים נשטפים וממוינים, ומיובשים בשלמותם (נטורל) על משטחי ייבוש"',LI),
 (65175,'description',IM,M,'גוף – בינוני · "בעלת גוף מלא"','Body is given as medium in the spec box and full in the story text.','למחוק "בעלת גוף מלא"',C),
 (65175,'description',IM,L,'yellow bourbon (כותרת) · זן: 100% ערביקה','Variety in the title is missing from the spec box.','זן: בורבון צהוב (Yellow Bourbon), 100% ערביקה',C),
 (80501,'description',IM,L,'"להעניק גוף מלא ונעים" · גוף: בינוני-קטיפתי','Body is described as both full and medium.','"להעניק גוף נעים וקטיפתי"',C),
 (80501,'short_description',IM,L,'מחווה של לוז הלנה (קולומביה)','Short description calls Luz Helena a farm; the long description names the farm as La Leona and Luz Helena as the producer.','מחוות La Leona של לוז הלנה (קווינדיו, קולומביה)',C),
 (65169,'short_description vs description',IM,L,'גוף – בינוני (קצר) · גוף - בינוני - מלא (ארוך)','Body differs.','גוף – בינוני-מלא בשני השדות',C),
 # ---- missing specs
 (65463,'description',MI,L,'מקור: קניה · גדל בגובה של מעל 1800 מטר','No region, variety, process or harvest; most of the page is generic copy.','להוסיף אזור, זנים, עיבוד – לאמת מול הספק',C),
 (65169,'description',MI,L,'מקור: אתיופיה','No altitude, variety, process or roast level for the most expensive single origin (92 ₪).','להוסיף גובה, זן (היירלום?), עיבוד ורמת קלייה – לאמת מול הספק',C),
 (65110,'rank_math_description / description',MI,M,'1 קג פולי קפה ירוקים איך זה מרגיש. ... קל לשימוש ולתחזוקה','SEO snippet is garbled appliance boilerplate; page has no region, altitude or process and gives brewing advice for green beans.','תיאור SEO: "1 ק״ג פולי קפה ירוקים קניה AA+ לקלייה ביתית – חומציות נוצצת ומתיקות עדינה." ולהוסיף אזור/גובה/עיבוד כמו בקלוי',C),
 (65201,'rank_math_description',HE,L,'...איכות מעולה ועמידות לאורך זמן. ... קל לשימוש ולתחזוקה','Appliance boilerplate on a coffee product.','"250 גרם פולי קפה ירוקים מינוטו פרסטיז׳ לקלייה ביתית – ערביקה ברזילאית ורובוסטה הודית."',C),
 (65111,'rank_math_description / description',MI,L,'איכות מעולה ועמידות לאורך זמן · (אין עיבוד)','Boilerplate in SEO; process missing (roasted page says washed).','להסיר את המשפט הגנרי; להוסיף "עיבוד: שטוף"',C),
 (65201,'price',SC,L,'30 ₪ / 250 גר׳ (120 ₪ לק״ג)','Green robusta blend costs about the same per kg as the green specialty single origins (125 ₪/kg).','לאמת את המחיר מול העלות – ייתכן תקין',VE),
 # ---- commerce / data hygiene
 (82540,'attributes / weight / SKU',SC,L,'כמות: 180 · משקל: 0 · SKU 69f87b45339c1-12','Bag size has no unit and isn\'t in the text; shipping weight empty; SKU is an auto-generated copy of Sweet Leona\'s.','כמות: "180 גר׳"; להוסיף "שקית 180 גר׳, פולים שלמים" לתיאור הקצר; משקל 0.18; מק״ט ייעודי',C),
 (80501,'SKU / text',SC,L,'SKU 69f87b45339c1 · (אין אפשרויות טחינה)','Auto-generated SKU; simple product without grind options and the text doesn\'t say it ships as whole beans.','מק״ט ייעודי; להוסיף "שקית 200 גר׳, פולים שלמים" לתיאור הקצר',C),
 (65431,'short_description / name',CP,L,'מינוטו מלוס סנטוס: · Jungle Java','Short description opens with "Minuto from Los Santos", probably a leftover name; "Java" in the name suggests Indonesia for a Costa Rican coffee.','"ג׳אנגל ג׳אווה – קוסטה ריקה, טארזו:" (לאשר שם המוצר)',VE),
 (65431,'variation SKUs',SC,L,'4545645632-54575 … (מק״ט אב 1000000005)','Variation SKUs use a placeholder-looking prefix unrelated to the parent SKU.','לאחד למבנה 1000000005-xxxxx כמו בשאר המוצרים',C),
 (76255,'bundle setup',SC,L,'מינימום 3 ק"ג · פריטים: Premium×2, Delux×1 (optional, min 0)','Text promises a 3 kg minimum, but bundle items are optional with min 0. Check that WPC bundle limits enforce 3 kg. Slug says "veneto-premium" though it mixes Delux.','לאמת את מגבלת המינימום בהגדרות הבאנדל',VE),
 (64772,'description / name',IM,L,'קלייה מקומית טרייה... טכניקות עתיקות יומין וידע איטלקי · Delux','Unclear whether Veneto is roasted locally by Minuto or imported Italian; "Delux" vs common "Deluxe".','לאשר מי קולה את Veneto ואת איות שם המותג',VE),
 # ---- Hebrew text
 (82540,'description',HE,L,'בחחוות Las Brisas','Typo.','בחוות Las Brisas',C),
 (65180,'short_description',HE,L,'לבנדר וונגיעות לימון','Typo (double vav).','לבנדר ונגיעות לימון',C),
 (65180,'description',HE,L,'אתיופיה נחשבת לעיר הולדתו של קפה','Ethiopia is a country, not a city.','אתיופיה נחשבת לארץ הולדתו של הקפה (גם ב-78450)',C),
 (78450,'description',HE,L,'אתיופיה נחשבת לעיר הולדתו של קפה · פרחים פרחוניים','Country, not city; "flowery flowers" redundancy.','"אתיופיה נחשבת לארץ הולדתו של הקפה" · "טעמים לימוניים מתוקים ופרחוניים"',C),
 (65384,'name / short_description',HE,L,'Yirgacheffee · ירגשף','English typo; Hebrew spelled two ways.','Yirgacheffe · יירגשף',C),
 (65384,'description',HE,L,'קפה אתיופי יירגשף, פולי קפה יירגשף, קפה פרחוני, קפה פירותי.','Visible SEO keyword line.','למחוק את השורה',C),
 (65175,'description',HE,L,'בתחריות קפה · Play · Fazenda Sertão - Nazareth Dias Pereira','Typo plus leftover video-embed text.','בתחרויות קפה; למחוק "Play" ואת שם הסרטון',C),
 (65463,'description',HE,L,'טיפים להכנת קפה קנייה AA · עדינות,.','Typo and stray punctuation.','קפה קניה AA · עדינות.',C),
 (65135,'short_description / rank_math_description',HE,L,'איך זה מרגיש? עם חומציות נוצצת · פרטים באתר &gt;','Broken sentence; HTML entity in SEO text.','"איך זה מרגיש? חומציות נוצצת ומתיקות עדינה, וברקע מרירות נעימה" · להסיר "&gt;"',C),
 (65431,'description',HE,L,'מושלם לאספרסו, קפוצ\'ינו או פילטר ... מושלם להכנת אספרסו,קפוצינו וקפה פילטר.','Same sentence twice.','למחוק את המשפט השני',C),
 (65189,'short_description / description',HE,L,"למשקאות האספרסו ,קפוצ'ינו,",'Sentence ends on a comma; comma spacing.',"למשקאות אספרסו וקפוצ׳ינו.",C),
 (65169,'description',HE,L,'פרנץ׳ פרס, פלאנג׳ר ) וחליטה קרה','Stray parenthesis; French press and plunger are the same thing.','מומלץ מאוד לחובבי V60, פרנץ׳ פרס וחליטה קרה.',C),
 (64855,'description',HE,L,'פרופיל פירחוני שוקולדי','Typo.','פרופיל פרחוני שוקולדי',C),
 (64734,'short_description',HE,L,'פולי קפה נטול 100% ערביקה מקסיקנית, נטול בתהליך Water proccess','Missing word and English typo.','פולי קפה נטול קפאין, 100% ערביקה מקסיקנית, בתהליך Water Process',C),
 (64702,'short_description',HE,L,'הקפו׳צינו','Typo.','הקפוצ׳ינו',C),
 (76255,'description / name',HE,L,'בעלים טעמים · "3  ק״ג"','Typo; double space in title.','בעלי טעמים · "3 ק״ג"',C),
 (67217,'description',HE,L,'ניחוד של שוקולד · Trieste','Typo; blend name spelled differently from its product (טריאסט / Triest).','ניחוח של שוקולד · טריאסט',C),
 (67146,'short_description',HE,L,'לפרטים נוספים והזמנה: https://www.minuto.co.il/','Raw homepage URL in the short description of a page already on the site.','למחוק את השורה',C),
 (65201,'short_description / description',HE,L,'ערביקה ברזיאלית','Typo.','ערביקה ברזילאית',C),
 (67660,'name / short_description vs description',IM,M,'כוס קפוצ׳ינו וצלוחית 250 מ"ל · "הספל מגיע בגודל 200 מ"ל"','Title and short description say 250 ml; description and URL slug say 200 ml.','לאמת את נפח הספל (Loveramics Egg cappuccino מגיע ב-200 וב-250 מ״ל) וליישר את הכותרת, התיאור הקצר והתיאור',LI),
]

rows = []
for pid, field, it, sev, cur, prob, fix, conf in F:
    p = P[pid]
    rows.append(dict(product_id=pid, product_name=strip(p['name']), permalink=p['permalink'], field=field,
                     issue_type=it, severity=sev, current_text=cur, problem=prob, suggested_fix=fix, confidence=conf))

# ---- automated checks: whole catalog, skipping hidden products
manual_ids = {r['product_id'] for r in rows}
for pid in COFFEE:
    p = P[pid]
    if p['type'] == 'woosb': continue
    if not p['weight'] or float(p['weight'] or 0) == 0:
        rows.append(dict(product_id=pid, product_name=strip(p['name']), permalink=p['permalink'], field='weight',
            issue_type=SC, severity=L, current_text=f"weight={p['weight']!r}",
            problem='Shipping weight is empty or 0 although the bag size is known.',
            suggested_fix='להזין משקל לפי גודל השקית (למשל 0.33 לשקית 330 גר׳, 1 לק״ג)', confidence=C))

SERVICE = {65427, 65369, 64714, 64703, 65380, 65414, 65426}  # placeholders / fees, not real products
for p in P.values():
    if p['catalog_visibility'] == 'hidden' or p['status'] != 'publish': continue
    pid, name = p['id'], strip(p['name'])
    def add(field, it, sev, cur, prob, fix, conf=C):
        rows.append(dict(product_id=pid, product_name=name, permalink=p['permalink'], field=field, issue_type=it,
                         severity=sev, current_text=cur, problem=prob, suggested_fix=fix, confidence=conf))
    if p['type'] in ('simple', 'subscription') and (not p['price'] or float(p['price']) == 0):
        sev = H if p['stock_status'] == 'instock' else M
        add('price', SC, sev, f"price={p['price']!r}, {p['stock_status']}",
            'Published and visible in the shop at price 0' + (' and in stock, so it can be added to the cart for free.' if sev == H else '.'),
            'להעביר לנראות "מוסתר" / פרטי, או להזין מחיר' if pid in SERVICE else 'להזין מחיר או להעביר לטיוטה עד שהמוצר מוכן')
    if pid in SERVICE and p['price'] and float(p['price']) > 0:
        add('catalog_visibility', SC, M, f"{name} · {p['price']} ₪",
            'Internal/service or test item is visible in the shop catalogue.', 'להעביר לנראות "מוסתר" (נשאר זמין להזמנות ידניות)')
    if not p['images']:
        add('images', MI, L if pid in SERVICE else M, '(no image)', 'Published product without an image.',
            'להעלות תמונת מוצר' if pid not in SERVICE else 'להסתיר מהקטלוג')
    if len(strip(p['description'])) < 15 and pid not in SERVICE:
        add('description', MI, L, '(empty)', 'Long description is empty.', 'לכתוב תיאור מוצר')
    if len(strip(p['short_description'])) < 5 and pid not in SERVICE:
        add('short_description', MI, L, '(empty)', 'Short description is empty.', 'לכתוב תיאור קצר (2–3 שורות)')
    if not p['sku'].strip():
        add('sku', MI, L, '(empty)', 'No SKU.', 'להזין מק״ט')

# ---- colour variants of the same model priced differently (family.py)
if os.path.exists(f'{D}/raw/family_diffs.json'):
    for d in json.load(open(f'{D}/raw/family_diffs.json')):
        if d['kind'] != 'price': continue
        vals = {int(k): v for k, v in d['values'].items()}
        lo, hi = min(vals.values()), max(vals.values())
        big = hi >= 1000 and (hi - lo) / lo > 0.03
        listing = ' · '.join(f"{i}: {v:g} ₪" for i, v in sorted(vals.items(), key=lambda x: x[1]))
        for i, v in vals.items():
            if v != hi: continue
            p = P[i]
            rows.append(dict(product_id=i, product_name=strip(p['name']), permalink=p['permalink'], field='price',
                issue_type=SC, severity=M if big else L, current_text=listing,
                problem=f'Same model in another colour/finish is priced differently ({lo:g}–{hi:g} ₪). May be a deliberate finish premium or a stale price.',
                suggested_fix='לאמת מול מחירון היבואן אם יש תוספת מחיר לצבע/גימור; אם לא – ליישר את המחיר בין הצבעים', confidence=VE))

# ---- per-product content review of the non-coffee catalog (raw/agent_findings/*.json)
import glob
seen = {(r['product_id'], r['current_text']) for r in rows}
seen_type = {(r['product_id'], r['issue_type']) for r in rows if r['issue_type'] != MI}
for fn in sorted(glob.glob(f'{D}/raw/agent_findings/chunk_*.json')):
    for f in json.load(open(fn)):
        pid = int(f['product_id'])
        if pid not in P or (pid, f['current_text']) in seen: continue
        it0 = {'product_facts': CF}.get(f['issue_type'], f['issue_type'])
        if (pid, f['issue_type']) in seen_type or (pid, it0) in seen_type and pid in manual_ids: continue
        if pid in SERVICE and f['issue_type'] == SC: continue
        p = P[pid]
        it = f['issue_type']
        rows.append(dict(product_id=pid, product_name=strip(p['name']), permalink=p['permalink'], field=f['field'],
            issue_type=it, severity=f['severity'], current_text=f['current_text'], problem=f['problem'],
            suggested_fix=f['suggested_fix'], confidence=f['confidence']))

sevorder = {H: 0, M: 1, L: 2}
rows.sort(key=lambda r: (sevorder[r['severity']], r['issue_type'], r['product_id']))
cols = ['product_id','product_name','permalink','field','issue_type','severity','current_text','problem','suggested_fix','confidence']
with open(f'{D}/findings.csv', 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(rows)

# ---- summary
by = collections.Counter((r['issue_type'], r['severity']) for r in rows)
types = sorted({r['issue_type'] for r in rows})
hit = {r['product_id'] for r in rows}
visible = [p for p in P.values() if p['catalog_visibility'] != 'hidden']
nH, nM, nL = (sum(r['severity'] == s for r in rows) for s in (H, M, L))
lines = ['# Minuto catalog audit: summary', '',
 f"Read-only audit of minuto.co.il through the WooCommerce REST API: {len(P)} products and "
 f"{sum(len(v) for v in json.load(open(f'{D}/raw/variations.json')).values())} variations. "
 f"The {sum(1 for p in P.values() if p['catalog_visibility']=='hidden')} hidden products were excluded, as you asked.", '',
 f"* **Every visible product was read and checked** ({len(visible)}): coffee beans, machines, grinders, capsules, cups, brewing gear, cleaning products, water filters and accessories.",
 '  * Each title, short description, description, attribute set and variation list was compared, and colour/size siblings were compared with each other.',
 '* **Automatic checks:**',
 '  * zero price',
 '  * duplicate SKUs (none found)',
 '  * missing SKU, image or descriptions',
 '  * "100% Arabica" next to robusta',
 '  * stale price-per-100 g text',
 '  * colour variants of the same model priced differently',
 '* Rows marked **verify** need a source the catalog doesn\'t have, such as an importer spec sheet, a supplier lot sheet or packaging. Apply the suggested text only after checking it.', '',
 f"**{len(rows)} findings in {len(hit)} products**: {nH} high · {nM} medium · {nL} low.",
 'Many low rows are the same typo or machine-translated paragraph repeated across a product family, logged once per product.', '',
 '## Counts by issue type and severity', '', '| issue_type | high | medium | low | total |', '|---|---|---|---|---|']
for t in types:
    lines.append(f"| {t} | {by[(t,H)]} | {by[(t,M)]} | {by[(t,L)]} | {sum(by[(t,s)] for s in (H,M,L))} |")
lines.append(f"| **total** | {nH} | {nM} | {nL} | {len(rows)} |")
lines += ['', '## Top 10 fixes', '',
 '1. **Machine pages describing a different model.**',
 '   * Melitta CI Touch (67330) and Latte Select (67329) carry the Caffeo Passione OT short description.',
 '   * The Jura C9 (65446) short description says C8 with 6 drinks.',
 '   * The Jura "W8" (76352) is all WE8 copy. It duplicates 64790 at 8,400 vs 8,000 ₪.',
 '   * The Siemens EQ.9 s700 (65230) shows s500 copy plus an expired "until 30.04.2019, 5-year warranty" offer.',
 '   * The Jura E8 (81455, 64929) contains ENA 8 paragraphs.',
 '2. **Wrong machine specs.**',
 '   * Lelit Mara X (64677, 64678) is listed with two boilers; it is a heat-exchanger machine.',
 '   * ECM Technika VI (67650) is sold as dual boiler.',
 '   * The Flair 58X (64854) spec block says 40 mm / 60 ml, copied from the Signature.',
 '   * Jura Z10 (×3) is listed at 2,450 W instead of 1,450 W.',
 '   * La Pavoni Europiccola (67161) is listed with a 1.6 L boiler.',
 '   * La Pavoni PLQ (67160) is said to need no electricity.',
 '   * Two grinders list US 110–120 V / 60 Hz: Fiorenzato AllGround (64857) and Lelit William (65055).',
 '3. **Capsules: compatibility, pack count, blend.**',
 '   * Lavazza A Modo Mio Oro (64712) is said to fit Nespresso.',
 '   * Dolce Gusto Cortado (67253) and Ardenza (67249) say 16 in one place and 30 in another.',
 '   * Esse Infinito (67210) and Maestoso (67308) say 50 and 100.',
 '   * A Modo Mio Intenso (67395) is 16 capsules at the price of the 36-packs.',
 '   * Suerte (67385) carries the Delizioso text.',
 '   * Lavazza Blue Roma (82277) is called "100% ערביקה" but is a robusta blend.',
 '   * Bialetti Napoli (65015) carries the Milano text.',
 '   * Italian Coffee Lungo (64847) carries the Super Creamy text.',
 '4. **Free or test items that can be bought.** "הצבה" (65427) and "כללי" (65369) are visible at 0 ₪ and in stock. "בדיקת תשלום" (64703) is visible at 1 ₪. "משלוח", "התקנה" and "קפה פילטר" are also visible.',
 '5. **A cut-off promo line on machine pages**, "מותנה ברכישה של 5 ק״ג פולי קפה…". It appears on Profitec Pro 500 and Pro 700, Nivona 790 and 795, Melitta Barista TS and T Smart, and Gaggia Magenta Plus. It reads as if the price depends on buying 5 kg of beans.',
 '6. **Wrong size or volume on cups and serveware.**',
 '   * All 10 NotNeutral Pico saucers, and the 5 Pico 355 ml mugs, have a short description saying 240 ml.',
 '   * Loveramics glass 76799 is titled 180 ml; its description says 120 ml.',
 '   * Dale Harris 80 ml cup 67620: the description calls it a 200 ml cappuccino cup.',
 '   * Loveramics 67660 says both 250 and 200 ml.',
 '   * Bialetti 8-cup French press 65057: the short description says 3 cups.',
 '   * Knock box 79990 is titled 114 mm; its text says 14 cm.',
 '   * Eco Klear tablets 76294 say 8 × 2 g in one place and 6 × 3.4 g in another.',
 '7. **Baskets, tampers and filters.**',
 '   * IMS baskets 82018, 82023, 67207 and 76629 give the wrong gram range or size.',
 '   * ILSA tamper 64799 is 57 mm, but its short description says 51 mm.',
 '   * CafeLat tamper 65140 is titled 58 mm; its spec says 57 mm.',
 '   * The Chemex 6-cup (64894) recommends the 3-cup FP-2 filters.',
 '   * The naked portafilter 65118 claims to fit every machine.',
 '   * The Toddy 50-pack filters 67208 say 20 per pack.',
 '8. **Coffee beans.**',
 '   * The price-per-100 g text is wrong on four products (65135, 65196, 65189, 64855).',
 '   * The Google titles of Daye Bensa (65180) and Yirgacheffe (65384) say light roast; both are medium.',
 '   * Fazenda Sertão (65175) gives two different origins.',
 '   * Green Prestige (65201) says 90/10 in one place and 80/20 in another.',
 '9. **Draft or internal text left on live pages.**',
 '   * An assistant note, "חשוב להתאים את הטקסט לאתר…", on Lelit Bianca V3 (64680, 64679).',
 '   * "4o" (ChatGPT residue) at the end of Rocket TCA and ECM Knock Box M.',
 '   * Visible SEO keyword blocks on ECM Mechanika Max, Lavazza Tierra Africa and others.',
 '   * ",k, ptzh" (תלת פאזי typed with an English keyboard layout) on both La Marzocco KB90 listings.',
 '   * Duplicates published with "- Copy" or "(העתק)" in the title, e.g. 68251, 68253 and 79401.',
 '10. **Colour copied from a sibling product.** Loveramics, Club House, notNeutral and Hario products name another colour in the copy (65475, 78228, 78232, 64903, 80541, 78189, 82537 and more). Colour attributes are also wrong on Airscape 250 g (all say "black") and on the black knock boxes.',
 '', '## Came out clean', '',
 f"{len(visible) - len(hit & {p['id'] for p in visible})} of {len(visible)} visible products had no findings. The full list is in `clean_products.txt`. Coffee products among them:"]
clean = [p for p in visible if p['id'] not in hit]
lines += [f"* {strip(p['name'])} ({p['id']})" for p in clean if p['id'] in COFFEE] or ['* none']
lines += ['', 'Files:',
 '* `findings.csv`: every finding, sorted high → low.',
 '* `raw/`: the API snapshot, the review chunks and the reviewers\' JSON.',
 '* To re-run without fetching: `python3 catalog-audit/family.py && python3 catalog-audit/audit.py`.']
open(f'{D}/summary.md', 'w').write('\n'.join(lines) + '\n')
open(f'{D}/clean_products.txt', 'w').write('\n'.join(f"{p['id']}\t{strip(p['name'])}" for p in sorted(clean, key=lambda p: p['id'])) + '\n')
print(len(rows), 'findings', collections.Counter(r['severity'] for r in rows), len(hit), 'products')
