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
  { id: "cashier", label: "קופה קפה",  time: "08:00" },
  { id: "store1",  label: "חנות",      time: "09:30" },
  { id: "store2",  label: "חנות",      time: "09:30" },
  { id: "store3",  label: "חנות",      time: "09:30" },
];

// ── Google JWT auth ───────────────────────────────────────────────────────────
async function getGoogleAccessToken(): Promise<string> {
  const sa = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT")!);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  // Import private key
  const pemHeader = "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooter = "-----END RSA PRIVATE KEY-----";
  const pemContents = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  // Create JWT
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body   = btoa(JSON.stringify(payload));
  const sigInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", privateKey,
    new TextEncoder().encode(sigInput)
  );
  const jwt = `${sigInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;

  // Exchange for access token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const { access_token } = await res.json();
  return access_token;
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

    // Create new spreadsheet
    const title = `סידור עבודה מינוטו - ${week_start}`;
    const created = await sheetsRequest(token, "POST", "", {
      properties: { title, locale: "he_IL" },
      sheets: [{ properties: { title: "סידור עבודה", rightToLeft: true } }],
    });
    const sheetId     = created.spreadsheetId;
    const gSheetId    = created.sheets[0].properties.sheetId;

    // Share with editor access (optional: make it accessible)
    await driveRequest(token, "POST", `/${sheetId}/permissions`, {
      role: "writer", type: "user",
      emailAddress: "erez@minuto.co.il",
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

    // Write data
    await sheetsRequest(token, "PUT",
      `/${sheetId}/values/A1?valueInputOption=RAW`,
      { values: rows }
    );

    // Format: bold header, colors, RTL
    const numRows = rows.length;
    const numCols = 7;
    await sheetsRequest(token, "POST", `/${sheetId}:batchUpdate`, {
      requests: [
        // Header row bold + background
        {
          repeatCell: {
            range: { sheetId: gSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
            cell: { userEnteredFormat: { backgroundColor: { red: 0.44, green: 0.31, blue: 0.22 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 }, horizontalAlignment: "CENTER", wrapStrategy: "WRAP" } },
            fields: "userEnteredFormat",
          }
        },
        // Data rows alternating colors
        {
          repeatCell: {
            range: { sheetId: gSheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numCols },
            cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "MIDDLE", horizontalAlignment: "CENTER" } },
            fields: "userEnteredFormat",
          }
        },
        // Auto resize columns
        { autoResizeDimensions: { dimensions: { sheetId: gSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: numCols } } },
        // Auto resize rows
        { autoResizeDimensions: { dimensions: { sheetId: gSheetId, dimension: "ROWS", startIndex: 0, endIndex: numRows } } },
      ]
    });

    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
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
