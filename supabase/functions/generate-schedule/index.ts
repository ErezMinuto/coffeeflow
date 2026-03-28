import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN") ?? "https://coffeeflow.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { employees, availability, weekStart, dayTypes, roastDays, activeDays } = await req.json();

    const DAYS: Record<string, string> = {
      sun: "ראשון", mon: "שני", tue: "שלישי",
      wed: "רביעי", thu: "חמישי", fri: "שישי",
    };

    const empList = employees.map((e: any) => {
      const skills = e.role === "general" && e.barista_skills ? " + כישורי בריסטה (גיבוי)" : "";
      const avail = availability.find((a: any) => a.employee_id === e.id)?.days || null;
      let availStr = "לא שלח";
      if (avail) {
        const parts = Object.entries(avail)
          .filter(([, v]) => v)
          .map(([k, v]) => v === true ? k : `${k}(עד ${v})`);
        availStr = parts.length ? parts.join(",") : "לא זמין";
      }
      return `- ${e.name} (${e.role}${skills}, מקסימום ${e.max_days || 5} ימים, זמין: ${availStr})`;
    });

    const prompt = `אתה מנהל בית קפה ישראלי. צור סידור עבודה לשבוע שמתחיל ב-${weekStart}.

עובדים:
${empList.join("\n")}

ימים פעילים: ${activeDays.map((d: string) => `${d}(${dayTypes[d]})`).join(", ")}
ימי קלייה: ${Object.entries(roastDays).filter(([, v]) => v).map(([k]) => k).join(", ") || "אין"}

עמדות ושעות פתיחה:
- opening (פתיחת קפה): 07:30 — סיום ~11:00
- cafe (בית קפה): 07:45 — סיום ~15:00
- roasting (קלייה): 08:00 — סיום ~13:00
- cashier (קופה): 08:00 — סיום ~14:00
- store (חנות): 09:30 ימים רגילים / 09:00 שישי וערב חג — סיום ~18:00 (17:00 שישי)

כללים:
- עמדת "פתיחת קפה" חייבת להיות בריסטה (role=barista). אם אין, שים עובד עם כישורי בריסטה כגיבוי
- עמדת "בית קפה" — מועדף בריסטה, אפשר גם כישורי בריסטה או כללי
- בריסטה/קולה יכולים לעבוד בחנות בימים שאין צורך בתפקידם (גמישות מלאה בעמדת חנות)
- רק הקולה (role=roaster) יכול לקלות. בימים שאינם ימי קלייה — תשבץ אותו לעמדה אחרת
- ימי שישי/ערב חג: 4 עובדים + קופה, ללא קלייה
- ימים רגילים: 3-4 עובדים
- אל תשבץ עובד יותר מהמקסימום שלו לשבוע
- תשבץ רק עובדים שזמינים ביום
- אם ליום יש "עד XX:XX" בזמינות — אל תשבץ אותו לעמדה שמסתיימת אחרי השעה הזו באותו יום

IMPORTANT: Reply with a single raw JSON object only. No explanation, no markdown, no headings, no text before or after.
Format: {"sun_opening": "name", "sun_cafe": "name", ...}
Valid keys: [day]_opening, [day]_cafe, [day]_roasting, [day]_cashier, [day]_store1, [day]_store2, [day]_store3
Days: sun, mon, tue, wed, thu, fri
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
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = await res.json();
    const raw = json.content?.[0]?.text ?? "{}";
    // Extract JSON object even if Claude added surrounding text
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
