// Tests for attendance-reminder's send-once logic.
//
//   deno run --allow-read supabase/functions/attendance-reminder/remind_test.ts
//
// The fake table enforces the real primary key (employee_id, shift_date,
// position, reminder_type) and answers a duplicate with 23505, the way
// PostgREST does, so overlapping runs race the way they do in production.

import { remindOnce, telegramSend, type ReminderKey } from "./remind.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 10));

function fakeDb() {
  const rows = new Set<string>();
  const k = (r: Record<string, unknown>) => `${r.employee_id}|${r.shift_date}|${r.position}|${r.reminder_type}`;
  const db = {
    from(_t: string) {
      return {
        async insert(row: Record<string, unknown>) {
          await jitter();
          if (rows.has(k(row))) return { error: { code: "23505", message: "duplicate key" } };
          rows.add(k(row));
          return { error: null };
        },
        delete() {
          const f: Record<string, unknown> = {};
          const q: any = {
            eq(col: string, val: unknown) { f[col] = val; return q; },
            then(res: (v: { error: null }) => unknown) { rows.delete(k(f)); return Promise.resolve({ error: null }).then(res); },
          };
          return q;
        },
      };
    },
  };
  return { db, rows };
}

const KEY: ReminderKey = { employee_id: 5, shift_date: "2026-10-24", position: "store1", reminder_type: "in" };

// Two overlapping runs: one DM.
{
  const { db, rows } = fakeDb();
  let sends = 0;
  const send = async () => { sends++; await jitter(); return { ok: true }; };
  const out = await Promise.all([remindOnce(db, KEY, send), remindOnce(db, KEY, send), remindOnce(db, KEY, send)]);
  check("overlapping runs send exactly one DM", sends === 1, `sends=${sends}`);
  check("the others report already_sent", out.filter((o) => o.outcome === "already_sent").length === 2);
  check("one row recorded", rows.size === 1);
}

// Telegram rejects: not recorded as sent, claim released, next run retries.
{
  const { db, rows } = fakeDb();
  const r1 = await remindOnce(db, KEY, async () => ({ ok: false, detail: "telegram 403: bot was blocked" }));
  check("rejection is send_failed", r1.outcome === "send_failed" && /403/.test(r1.detail ?? ""));
  check("rejection releases the claim", rows.size === 0);
  let sends = 0;
  const r2 = await remindOnce(db, KEY, async () => { sends++; return { ok: true }; });
  check("next run retries and sends", r2.outcome === "sent" && sends === 1 && rows.size === 1);
}

// A claim that can't be written sends nothing.
{
  let sends = 0;
  const db = { from: () => ({ insert: async () => ({ error: { code: "42501", message: "denied" } }), delete: () => { throw new Error("no"); } }) };
  const r = await remindOnce(db as any, KEY, async () => { sends++; return { ok: true }; });
  check("claim failure sends nothing", r.outcome === "claim_failed" && sends === 0);
}

// telegramSend reads Telegram's answer instead of assuming success.
{
  const mk = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status });
  check("telegram ok", (await telegramSend("t", 1, "x", mk(200, { ok: true }))).ok === true);
  const bad = await telegramSend("t", 1, "x", mk(403, { ok: false, description: "Forbidden: bot was blocked by the user" }));
  check("telegram 403 is a failure", !bad.ok && /403/.test(bad.detail ?? ""));
  const thrown = await telegramSend("t", 1, "x", async () => { throw new Error("network down"); });
  check("network error is a failure", !thrown.ok && /network down/.test(thrown.detail ?? ""));
}

// index.ts must claim before sending, not insert after.
{
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  check("index.ts sends through remindOnce", (src.match(/remindOnce\(/g) ?? []).length >= 2);
  check("index.ts no longer inserts the row itself", !/from\("attendance_reminders_sent"\)\.insert/.test(src));
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1); }
console.log("\nall checks passed");
