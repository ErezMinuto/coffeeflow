import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("COFFEEFLOW_ORIGIN") ?? "https://coffeeflow-thaf.vercel.app";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const DAYS_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"];
const DAYS    = ["sun", "mon", "tue", "wed", "thu", "fri"];
const POSITIONS = [
  { id: "opening", label: "פתיחת קפה", time: "07:30" },
  { id: "cafe",    label: "בית קפה",   time: "07:45" },
  { id: "roasting",label: "קלייה",     time: "" },

  { id: "store1",  label: "חנות",      time: "09:30" },
  { id: "store2",  label: "חנות",      time: "09:30" },
  { id: "store3",  label: "חנות",      time: "09:30" },
  { id: "store4",  label: "חנות",      time: "09:30" },
];

// ── Google JWT auth ───────────────────────────────────────────────────────────
function base64url(data: string | Uint8Array): string {
  const str = typeof data === "string" ? data : String.fromCharCode(...data);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGoogleAccessToken(): Promise<string> {
  const sa = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT")!);
  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));

  const sigInput = `${header}.${payload}`;

  // Import private key (strip PEM headers and newlines)
  const pemContents = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", privateKey,
    new TextEncoder().encode(sigInput)
  );

  const jwt = `${sigInput}.${base64url(new Uint8Array(signature))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Google auth failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

// ── Sheets API helpers ────────────────────────────────────────────────────────
async function sheetsRequest(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function driveRequest(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { schedule_id, week_start } = await req.json();

    // Load schedule assignments
    const { data: assignments } = await supabase
      .from("schedule_assignments")
      .select("day, position, employee_name")
      .eq("schedule_id", schedule_id);

    // Load schedule day types
    const { data: schedule } = await supabase
      .from("schedules")
      .select("day_types, roast_days")
      .eq("id", schedule_id)
      .single();

    const dayTypes  = schedule?.day_types  || {};
    const roastDays = schedule?.roast_days || {};

    // Build lookup map
    const cell = (day: string, pos: string) =>
      assignments?.find(a => a.day === day && a.position === pos)?.employee_name || "";

    // Get Google access token
    const token = await getGoogleAccessToken();

    // Use existing shared sheet
    const sheetId  = Deno.env.get("GOOGLE_SHEET_ID")!;
    const gSheetId = 0; // default first sheet

    // Clear existing content first
    await sheetsRequest(token, "POST", `/${sheetId}/values:batchClear`, {
      ranges: ["A1:G50"]
    });

    // Build rows
    const headers = ["תפקיד", ...DAYS.map((d, i) => {
      const type = dayTypes[d];
      const date = new Date(week_start);
      date.setDate(date.getDate() + i);
      const dateStr = `${String(date.getDate()).padStart(2,"0")}.${String(date.getMonth()+1).padStart(2,"0")}`;
      if (type === "closed") return `${DAYS_HE[i]}\n${dateStr}\n(סגור)`;
      if (type === "holiday-eve") return `${DAYS_HE[i]}\n${dateStr}\nערב חג`;
      return `${DAYS_HE[i]}\n${dateStr}`;
    })];

    const rows: string[][] = [headers];

    for (const pos of POSITIONS) {
      const row = [pos.time ? `${pos.label}\n${pos.time}` : pos.label];
      for (const day of DAYS) {
        const type = dayTypes[day];
        if (type === "closed") { row.push(""); continue; }
        if (pos.id === "roasting" && (!roastDays[day] || type === "friday" || type === "holiday-eve")) { row.push(""); continue; }
        if (pos.id === "cashier" && type !== "friday" && type !== "holiday-eve") { row.push(""); continue; }
        row.push(cell(day, pos.id));
      }
      rows.push(row);
    }

    // Add title row at top
    const titleRow = [`☕ MINUTO Café Roastery — סידור עבודה ${week_start}`, "", "", "", "", "", ""];
    const allRows = [titleRow, ...rows];

    // Write data
    await sheetsRequest(token, "PUT",
      `/${sheetId}/values/A1?valueInputOption=RAW`,
      { values: allRows }
    );

    // ── Formatting ────────────────────────────────────────────────────────────
    const numRows = allRows.length;
    const numCols = 7;

    // Minuto brand colors
    const darkGreen  = { red: 0.239, green: 0.290, blue: 0.180 }; // #3D4A2E
    const sageGreen  = { red: 0.710, green: 0.776, blue: 0.604 }; // #B5C69A
    const lightSage  = { red: 0.922, green: 0.937, blue: 0.886 }; // #EBEFE2
    const white      = { red: 1,     green: 1,     blue: 1     };
    const darkText   = { red: 0.161, green: 0.196, blue: 0.110 }; // #29321C

    await sheetsRequest(token, "POST", `/${sheetId}:batchUpdate`, {
      requests: [
        // RTL sheet direction
        { updateSheetProperties: { properties: { sheetId: gSheetId, rightToLeft: true }, fields: "rightToLeft" } },

        // Merge title row
        { mergeCells: { range: { sheetId: gSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }, mergeType: "MERGE_ALL" } },

        // Title row — dark green bg, white bold large text
        {
          repeatCell: {
            range: { sheetId: gSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
            cell: { userEnteredFormat: {
              backgroundColor: darkGreen,
              textFormat: { bold: true, foregroundColor: white, fontSize: 14, fontFamily: "Arial" },
              horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
            }},
            fields: "userEnteredFormat",
          }
        },

        // Header row (row 1) — dark green bg, white bold text
        {
          repeatCell: {
            range: { sheetId: gSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: numCols },
            cell: { userEnteredFormat: {
              backgroundColor: darkGreen,
              textFormat: { bold: true, foregroundColor: white, fontSize: 12, fontFamily: "Arial" },
              horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              borders: { bottom: { style: "SOLID_MEDIUM", color: sageGreen } }
            }},
            fields: "userEnteredFormat",
          }
        },

        // Position label column (col 0) — sage green bg
        {
          repeatCell: {
            range: { sheetId: gSheetId, startRowIndex: 2, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: {
              backgroundColor: sageGreen,
              textFormat: { bold: true, foregroundColor: darkText, fontSize: 10, fontFamily: "Arial" },
              horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
            }},
            fields: "userEnteredFormat",
          }
        },

        // Even data rows — light sage tint
        ...Array.from({ length: Math.ceil((numRows - 2) / 2) }, (_, i) => ({
          repeatCell: {
            range: { sheetId: gSheetId, startRowIndex: 2 + i * 2, endRowIndex: 3 + i * 2, startColumnIndex: 1, endColumnIndex: numCols },
            cell: { userEnteredFormat: {
              backgroundColor: lightSage,
              textFormat: { fontSize: 11, fontFamily: "Arial", foregroundColor: darkText },
              horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
            }},
            fields: "userEnteredFormat",
          }
        })),

        // Odd data rows — white
        ...Array.from({ length: Math.floor((numRows - 2) / 2) }, (_, i) => ({
          repeatCell: {
            range: { sheetId: gSheetId, startRowIndex: 3 + i * 2, endRowIndex: 4 + i * 2, startColumnIndex: 1, endColumnIndex: numCols },
            cell: { userEnteredFormat: {
              backgroundColor: white,
              textFormat: { fontSize: 11, fontFamily: "Arial", foregroundColor: darkText },
              horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
            }},
            fields: "userEnteredFormat",
          }
        })),

        // Borders for all cells
        {
          updateBorders: {
            range: { sheetId: gSheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numCols },
            top:    { style: "SOLID", color: sageGreen },
            bottom: { style: "SOLID", color: sageGreen },
            left:   { style: "SOLID", color: sageGreen },
            right:  { style: "SOLID", color: sageGreen },
            innerHorizontal: { style: "SOLID", color: sageGreen },
            innerVertical:   { style: "SOLID", color: sageGreen },
          }
        },

        // Title row height
        { updateDimensionProperties: { range: { sheetId: gSheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 56 }, fields: "pixelSize" } },

        // Header row height
        { updateDimensionProperties: { range: { sheetId: gSheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 48 }, fields: "pixelSize" } },

        // Column widths — wide enough to avoid line breaks
        { updateDimensionProperties: { range: { sheetId: gSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 160 }, fields: "pixelSize" } },
        { updateDimensionProperties: { range: { sheetId: gSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: numCols }, properties: { pixelSize: 150 }, fields: "pixelSize" } },

        // Data row heights
        { updateDimensionProperties: { range: { sheetId: gSheetId, dimension: "ROWS", startIndex: 2, endIndex: numRows }, properties: { pixelSize: 44 }, fields: "pixelSize" } },
      ]
    });

    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?usp=sharing`;
    return new Response(JSON.stringify({ ok: true, url, sheetId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("export-to-sheets error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
