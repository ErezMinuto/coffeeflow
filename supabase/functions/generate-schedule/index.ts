import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN") ?? "https://coffeeflow.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAY_LABEL: Record<string, string> = {
  sun: "ראשון", mon: "שני", tue: "שלישי",
  wed: "רביעי", thu: "חמישי", fri: "שישי",
};

function addDays(base: string, n: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}`;
}

const DAY_OFFSET: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 };

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { employees, availability, weekStart, dayTypes, roastDays, activeDays } = await req.json();

    // Build per-employee availability — explicit allowed days only
    const empList = employees.map((e: any) => {
      const skills = e.role === "general" && e.barista_skills ? " + כישורי בריסטה (גיבוי)" : "";
      const bLevel = (e.role === "barista" || e.barista_skills) && e.barista_level > 1
        ? `, רמת בריסטה ${e.barista_level}/3` : "";
      const rLevel = e.role === "roaster" && e.roaster_level > 1
        ? `, רמת קלייה ${e.roaster_level}/3` : "";

      const avail = availability.find((a: any) => a.employee_id === e.id)?.days || null;
      let availStr: string;
      if (!avail) {
        availStr = "לא שלח זמינות — אל תשבץ";
      } else {
        const parts = (activeDays as string[])
          .filter((d) => avail[d])
          .map((d) => {
            const date = addDays(weekStart, DAY_OFFSET[d]);
            const limit = avail[d] !== true ? ` (עד ${avail[d]})` : "";
            return `${DAY_LABEL[d]} ${date}${limit}`;
          });
        availStr = parts.length
          ? `זמין רק בימים: ${parts.join(" | ")}`
          : "לא זמין השבוע — אל תשבץ";
      }

      return `- ${e.name} | תפקיד: ${e.role}${skills}${bLevel}${rLevel} | מקס׳ ימים: ${e.max_days || 5} | ${availStr}`;
    });

    // Build active-day descriptions
    const dayDescriptions = (activeDays as string[]).map((d: string) => {
      const date = addDays(weekStart, DAY_OFFSET[d]);
      const type = dayTypes[d] === "friday" ? "שישי" : dayTypes[d] === "holiday-eve" ? "ערב חג" : "רגיל";
      const roast = roastDays[d] ? " + קלייה" : "";
      return `${d} = ${DAY_LABEL[d]} ${date} (${type}${roast})`;
    });

    const prompt = `אתה מנהל בית קפה ישראלי. בנה סידור עבודה לשבוע שמתחיל ב-${weekStart}.

=== עובדים וזמינות מדויקת ===
${empList.join("\n")}

=== ימים פעילים השבוע ===
${dayDescriptions.join("\n")}

=== כללי שיבוץ ===
HARD RULE — זמינות: שבץ עובד ONLY ביום שמפורש ברשימת "זמין רק בימים" שלו. כל שיבוץ ביום אחר הוא שגיאה קריטית.
HARD RULE — מקסימום: אל תשבץ עובד יותר מ-מקס׳ ימים שלו בשבוע.
HARD RULE — עד שעה: אם הזמינות כוללת "עד XX:XX", אל תשבץ לעמדה שמסתיימת אחרי השעה הזו.

עמדות לפי סוג יום:
- יום רגיל (לא קלייה): opening + store1 + store2 + store3 (4 עובדים)
- יום קלייה: opening + roasting + store1 + store2 (4 עובדים)
- שישי / ערב חג: opening + cafe + store1 + store2 (4 עובדים, ללא קלייה)
- אם אין מספיק עובדים זמינים ביום — מלא כמה שיש, לא יותר מ-4

עמדות מיוחדות:
- opening (פתיחת קפה 07:30): חייב להיות role=barista. אם אין בריסטה זמין — שים עובד עם barista_skills כגיבוי.
  תעדף רמת בריסטה גבוהה יותר (3>2>1).
- roasting (קלייה): רק role=roaster. בימים שאינם ימי קלייה — שבץ את הקולה לחנות.
- cafe (בית קפה 07:45): שישי/ערב חג בלבד. מועדף barista, אפשר כישורי בריסטה או כללי.
- store1/store2/store3: כל עובד (barista/roaster/general — כולם יכולים לעבוד בחנות).

IMPORTANT: Reply with a single raw JSON object only. No explanation, no markdown.
Format: {"sun_opening": "שם", "sun_store1": "שם", ...}
Valid position keys: opening, cafe, roasting, store1, store2, store3
Valid day keys: ${(activeDays as string[]).join(", ")}
Start your response with { and end with }`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = await res.json();
    const raw = json.content?.[0]?.text ?? "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const clean = match ? match[0] : "{}";
    const schedule = JSON.parse(clean);

    return new Response(JSON.stringify({ schedule }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("generate-schedule error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
