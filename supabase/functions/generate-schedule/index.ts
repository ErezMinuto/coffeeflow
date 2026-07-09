import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")  ?? "";
const JWT_SECRET        = Deno.env.get("JWT_SECRET") ?? "";

const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN") ?? "https://coffeeflow.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── JWT verification ──────────────────────────────────────────────────────────
async function verifyJWT(token: string): Promise<string | null> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return null;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const data      = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(
      atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;
    const payload = JSON.parse(atob(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub ?? null;
  } catch { return null; }
}

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

  // Auth guard temporarily disabled — JWT signing mismatch between Clerk and PostgREST

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
HARD RULE — אין כפילות ביום: כל עובד תופס עמדה אחת בלבד באותו יום. לעולם אל תשבץ את אותו שם לשתי עמדות באותו יום. אם אין מספיק עובדים זמינים כדי למלא את כל העמדות — השאר עמדות ריקות (אל תכלול את המפתח שלהן בכלל בתשובה). עדיף פחות עובדים ליום מאשר שם שחוזר פעמיים באותו יום.

עמדות לפי סוג יום:
- יום רגיל (לא קלייה): opening + store1 + store2 + store3 + store4 (5 עובדים)
- יום קלייה: opening + roasting + store1 + store2 + store3 (5 עובדים)
- שישי / ערב חג: opening + cafe + store1 + store2 + store3 (5 עובדים, ללא קלייה)
- מינימום 4 עובדים ליום, מקסימום 5. אם יש רק 4 זמינים — מלא 4. אם יש 5 או יותר — תמיד מלא 5.

עמדות מיוחדות:
- opening (פתיחת קפה 07:30): חייב להיות role=barista. אם אין בריסטה זמין — שים עובד עם barista_skills כגיבוי.
  תעדף רמת בריסטה גבוהה יותר (3>2>1).
- roasting (קלייה): רק role=roaster. בימים שאינם ימי קלייה — שבץ את הקולה לחנות.
- cafe (בית קפה 07:45): שישי/ערב חג בלבד. מועדף barista, אפשר כישורי בריסטה או כללי.
- store1/store2/store3/store4: כל עובד (barista/roaster/general — כולם יכולים לעבוד בחנות).

IMPORTANT: Reply with a single raw JSON object only. No explanation, no markdown.
Format: {"sun_opening": "שם", "sun_store1": "שם", ...}
Valid position keys: opening, cafe, roasting, store1, store2, store3, store4
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
        model: "claude-opus-4-7",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = await res.json();
    const raw = json.content?.[0]?.text ?? "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const clean = match ? match[0] : "{}";
    const schedule = JSON.parse(clean);

    // ── Deterministic safety net: availability + no-duplicates ──────────────────
    // The model still breaks the HARD RULES when a day is short-staffed — it will
    // schedule someone on a day they marked UNavailable (to cover roasting / fill
    // 5), or repeat a name. Neither can be allowed to reach the schedule, so we
    // enforce both here, in code, regardless of what the model returned:
    //   1. Availability — drop any assignment where the employee didn't mark that
    //      day available (or never submitted). A person who can't work simply
    //      can't be scheduled; the day shows fewer people, which is the truth.
    //   2. No duplicates — drop any name already used earlier that same day.
    // Specialized positions (opening/roasting/cafe) are processed first so they
    // keep the employee and a generic store slot is the one left empty. A dropped
    // slot is omitted from the result → the UI shows "— בחר —" for the manager.

    // name (lowercased) → set of day-codes that employee actually marked available.
    // A day value of true OR "HH:MM" both count as available for that day.
    const availByName: Record<string, Set<string>> = {};
    for (const e of employees as any[]) {
      const av = availability.find((a: any) => a.employee_id === e.id)?.days || null;
      const set = new Set<string>();
      if (av) {
        for (const d of activeDays as string[]) {
          if (av[d]) set.add(d);
        }
      }
      availByName[String(e.name ?? "").trim().toLowerCase()] = set;
    }

    const POSITION_PRIORITY = ["opening", "roasting", "cafe", "store1", "store2", "store3", "store4"];
    const positionRank = (pos: string) => {
      const i = POSITION_PRIORITY.indexOf(pos);
      return i === -1 ? POSITION_PRIORITY.length : i;
    };
    const deduped: Record<string, string> = {};
    const seenPerDay: Record<string, Set<string>> = {};
    let droppedDupes = 0;
    let droppedUnavailable = 0;

    // Sort keys so higher-priority positions are assigned before generic slots.
    const orderedKeys = Object.keys(schedule).sort((a, b) => {
      const posA = a.split("_").slice(1).join("_");
      const posB = b.split("_").slice(1).join("_");
      return positionRank(posA) - positionRank(posB);
    });

    for (const key of orderedKeys) {
      const name = schedule[key];
      if (typeof name !== "string" || !name.trim()) continue;
      const day = key.split("_")[0];
      const trimmed = name.trim();

      // 1. Availability — never schedule someone on a day they can't work.
      const availSet = availByName[trimmed.toLowerCase()];
      if (!availSet || !availSet.has(day)) {
        droppedUnavailable++;
        console.warn(`generate-schedule: dropped "${trimmed}" on ${day} — not available (${key})`);
        continue; // leave the slot empty rather than schedule an unavailable person
      }

      // 2. No duplicates within the same day.
      const seen = (seenPerDay[day] ??= new Set<string>());
      if (seen.has(trimmed)) {
        droppedDupes++;
        console.warn(`generate-schedule: dropped duplicate "${trimmed}" on ${day} (${key})`);
        continue; // leave the slot empty rather than repeat a name
      }
      seen.add(trimmed);
      deduped[key] = trimmed;
    }

    if (droppedDupes > 0 || droppedUnavailable > 0) {
      console.log(`generate-schedule: removed ${droppedUnavailable} unavailable + ${droppedDupes} duplicate assignment(s)`);
    }

    return new Response(JSON.stringify({ schedule: deduped }), {
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
