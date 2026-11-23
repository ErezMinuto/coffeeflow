import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTaskMessage, daysLate, doneNoticeText, dropButton, dueLabel, extractDue, matchEmployees,
  MAX_TASKS_PER_MESSAGE, needsReminder, parseCancelCallback, parseTaskCallback, parseTaskMessage,
  stripCandidateName, taskCallbackData,
} from "./manager_tasks.ts";

const TODAY = "2026-11-20";
const ilDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(iso));

Deno.test("daysLate / dueLabel", () => {
  assertEquals(daysLate("2026-11-20", TODAY), 0);
  assertEquals(daysLate("2026-11-17", TODAY), 3);
  assertEquals(daysLate("2026-11-21", TODAY), -1);
  assertEquals(dueLabel("2026-11-20", TODAY), "להיום");
  assertEquals(dueLabel("2026-11-19", TODAY), "⏰ באיחור של יום");
  assertEquals(dueLabel("2026-11-15", TODAY), "⏰ באיחור של 5 ימים");
  assertEquals(dueLabel("2026-11-21", TODAY), "למחר");
  assertEquals(dueLabel("2026-11-25", TODAY), "עד 25/11");
  // Across a DST change (Israel leaves summer time on 2026-10-25).
  assertEquals(daysLate("2026-10-24", "2026-10-26"), 2);
});

Deno.test("callback data round-trips and rejects junk", () => {
  assertEquals(parseTaskCallback(taskCallbackData(42)), 42);
  assertEquals(parseTaskCallback("mtask:0"), null);
  assertEquals(parseTaskCallback("mtask:-3"), null);
  assertEquals(parseTaskCallback("mtask:1;drop"), null);
  assertEquals(parseTaskCallback("mtask:"), null);
  assertEquals(parseTaskCallback("veh:take:1"), null);
  assert(new TextEncoder().encode(taskCallbackData(999_999_999_999)).length <= 64);
});

Deno.test("single new task: one plain ✅ button, HTML escaped", () => {
  const m = buildTaskMessage("new", [{ id: 7, title: "להזמין <חלב>", notes: "ספק & שות׳", due_date: TODAY }], TODAY, "פלג");
  assert(m.text.includes("משימה חדשה"));
  assert(m.text.includes("&lt;חלב&gt;"));
  assert(m.text.includes("ספק &amp; שות׳"));
  assert(m.text.includes("להיום"));
  assert(m.text.includes("היי פלג"));
  assertEquals(m.reply_markup.inline_keyboard, [[{ text: "✅ בוצע", callback_data: "mtask:7" }]]);
});

Deno.test("reminder: overdue first, one titled button per task", () => {
  const m = buildTaskMessage("reminder", [
    { id: 2, title: "ב", due_date: "2026-11-20" },
    { id: 1, title: "א", due_date: "2026-11-18" },
  ], TODAY);
  assert(m.text.includes("2 משימות פתוחות"));
  assert(m.text.indexOf("א") < m.text.indexOf("<b>ב</b>"));
  assert(m.text.includes("באיחור של 2 ימים"));
  assertEquals(m.reply_markup.inline_keyboard.map((r) => r[0].callback_data), ["mtask:1", "mtask:2"]);
  assertEquals(m.reply_markup.inline_keyboard[0][0].text, "✅ א");
});

Deno.test("long lists are capped and long titles truncated in buttons", () => {
  const many = Array.from({ length: MAX_TASKS_PER_MESSAGE + 5 }, (_, i) => ({
    id: i + 1, title: "x".repeat(80), due_date: TODAY,
  }));
  const m = buildTaskMessage("list", many, TODAY);
  assertEquals(m.reply_markup.inline_keyboard.length, MAX_TASKS_PER_MESSAGE);
  assert(m.text.includes("עוד 5 משימות"));
  assert(m.reply_markup.inline_keyboard[0][0].text.length <= 42);
});

Deno.test("dropButton removes only the pressed task", () => {
  const kb = [[{ text: "a", callback_data: "mtask:1" }], [{ text: "b", callback_data: "mtask:2" }]];
  assertEquals(dropButton(kb, "mtask:1"), [[{ text: "b", callback_data: "mtask:2" }]]);
  assertEquals(dropButton([[{ text: "a", callback_data: "mtask:1" }]], "mtask:1"), []);
  assertEquals(dropButton(undefined, "mtask:1"), []);
});

Deno.test("needsReminder", () => {
  const base = { status: "open", due_date: TODAY, last_reminded_on: null, notified_at: "2026-11-19T15:00:00Z" };
  assert(needsReminder(base, TODAY, ilDate));
  assert(needsReminder({ ...base, due_date: "2026-11-10" }, TODAY, ilDate));
  assert(!needsReminder({ ...base, due_date: "2026-11-21" }, TODAY, ilDate), "future task");
  assert(!needsReminder({ ...base, status: "done" }, TODAY, ilDate), "done task");
  assert(!needsReminder({ ...base, last_reminded_on: TODAY }, TODAY, ilDate), "already reminded");
  assert(needsReminder({ ...base, last_reminded_on: "2026-11-19" }, TODAY, ilDate));
  // First DM went out this (Israel) morning → no reminder on top.
  assert(!needsReminder({ ...base, notified_at: "2026-11-20T05:30:00Z" }, TODAY, ilDate));
  // 23:30 UTC on the 19th is already the 20th in Israel.
  assert(!needsReminder({ ...base, notified_at: "2026-11-19T23:30:00Z" }, TODAY, ilDate));
});

Deno.test("doneNoticeText", () => {
  assertEquals(doneNoticeText("פלג", " לסגור קופה ", "telegram"), "✅ <b>פלג</b> סימנ/ה כבוצע (בטלגרם):\nלסגור קופה");
  assert(doneNoticeText("<x>", "t", "app").includes("&lt;x&gt;"));
});

// ── Telegram task creation (2026-11-20 is a Friday) ─────────────────────────
// deno-lint-ignore no-explicit-any
const parsed = (t: string) => parseTaskMessage(t, TODAY) as any;

Deno.test("parseTaskMessage: not a command / help", () => {
  assertEquals(parseTaskMessage("נכנסתי", TODAY), null);
  assertEquals(parseTaskMessage("משימות", TODAY), null);
  assertEquals(parseTaskMessage("משימה", TODAY), { help: true });
  assertEquals(parseTaskMessage("משימה:", TODAY), { error: "חסר תיאור למשימה" });
});

Deno.test("parseTaskMessage: self tasks", () => {
  assertEquals(parsed("משימה: לסגור את הקופה"), { assigneeName: null, explicitName: false, title: "לסגור את הקופה", notes: null, due: TODAY });
  assertEquals(parsed("משימה לעצמי: להתקשר לספק מחר").assigneeName, null);
  assertEquals(parsed("משימה לעצמי: להתקשר לספק מחר").due, "2026-11-21");
  assertEquals(parsed("משימה לעצמי להתקשר לספק").title, "להתקשר לספק");
  assertEquals(parsed("משימה לעצמי להתקשר לספק").assigneeName, null);
  assertEquals(parsed("משימה לי: x").assigneeName, null);
});

Deno.test("parseTaskMessage: named assignee", () => {
  const a = parsed("משימה לפלג: להזמין חלב מחר");
  assertEquals([a.assigneeName, a.explicitName, a.title, a.due], ["פלג", true, "להזמין חלב", "2026-11-21"]);
  assertEquals(parsed("משימה לפלג אורג: x").assigneeName, "פלג אורג");
  assertEquals(parsed("משימה פלג: x").assigneeName, "פלג");
  // No colon: a candidate only.
  const b = parsed("משימה לפלג להזמין חלב");
  assertEquals([b.assigneeName, b.explicitName, b.title], ["פלג", false, "לפלג להזמין חלב"]);
  assertEquals(stripCandidateName(b.title, "פלג"), "להזמין חלב");
  const c = parsed("משימה לסגור את הקופה");
  assertEquals([c.assigneeName, c.explicitName, c.title], ["סגור", false, "לסגור את הקופה"]);
});

Deno.test("parseTaskMessage: notes on later lines", () => {
  const p = parsed("משימה לפלג: להזמין חלב\nשיבולת שועל\n12 קרטונים");
  assertEquals(p.title, "להזמין חלב");
  assertEquals(p.notes, "שיבולת שועל\n12 קרטונים");
});

Deno.test("parseTaskMessage: task on the line after 'משימה לפלג:'", () => {
  // Erez's real message, the task as one long line.
  const a = parsed("משימה לפלג:\nלשבוע הבא להוציא הזמנה לפומו על פולי קפה ובקבוק גדול של נוזל ניקוי חלב 26/11");
  assertEquals([a.assigneeName, a.explicitName], ["פלג", true]);
  assertEquals(a.title, "לשבוע הבא להוציא הזמנה לפומו על פולי קפה ובקבוק גדול של נוזל ניקוי חלב");
  assertEquals(a.due, "2026-11-26");
  assertEquals(a.notes, null);

  // Same message with a line break before the date: the date still counts.
  const b = parsed("משימה לפלג:\nלהוציא הזמנה לפומו על פולי קפה ובקבוק גדול של נוזל\nניקוי חלב 26/11");
  assertEquals(b.title, "להוציא הזמנה לפומו על פולי קפה ובקבוק גדול של נוזל");
  assertEquals(b.due, "2026-11-26");
  assertEquals(b.notes, "ניקוי חלב");

  // Blank lines between, extra detail lines kept with their breaks.
  const c = parsed("משימה לפלג:\n\n  להזמין חלב מחר\nשיבולת שועל\n12 קרטונים");
  assertEquals([c.title, c.due, c.notes], ["להזמין חלב", "2026-11-21", "שיבולת שועל\n12 קרטונים"]);

  // "משימה" alone on the first line, the rest below.
  const d = parsed("משימה\nלפלג: לבדוק מלאי");
  assertEquals([d.assigneeName, d.title], ["פלג", "לבדוק מלאי"]);

  // A date on the title line wins over one in the details.
  const e = parsed("משימה לפלג: להזמין חלב מחר\nלא אחרי 30/11");
  assertEquals([e.due, e.notes], ["2026-11-21", "לא אחרי 30/11"]);

  // A past date in the details is reported, not silently dropped.
  assertEquals(parsed("משימה לפלג:\nלהזמין חלב\nעד 10/11"), { error: "התאריך 10/11 כבר עבר" });

  // Nothing after the colon at all.
  assertEquals(parsed("משימה לפלג:\n\n"), { error: "חסר תיאור למשימה" });
});

Deno.test("extractDue: relative words", () => {
  assertEquals(extractDue("להזמין חלב היום", TODAY), { due: TODAY, rest: "להזמין חלב" });
  assertEquals(extractDue("עד מחר להזמין חלב", TODAY), { due: "2026-11-21", rest: "להזמין חלב" });
  assertEquals(extractDue("להזמין חלב למחר", TODAY), { due: "2026-11-21", rest: "להזמין חלב" });
  assertEquals(extractDue("להזמין חלב מחרתיים", TODAY), { due: "2026-11-22", rest: "להזמין חלב" });
  assertEquals(extractDue("לבדוק מחרטה", TODAY), { due: TODAY, rest: "לבדוק מחרטה" });
});

Deno.test("extractDue: weekdays need 'יום', always the coming one", () => {
  assertEquals(extractDue("לבדוק מלאי ביום שלישי", TODAY), { due: "2026-11-24", rest: "לבדוק מלאי" });
  assertEquals(extractDue("עד יום ראשון לנקות", TODAY), { due: "2026-11-22", rest: "לנקות" });
  assertEquals(extractDue("ביום שישי לסדר", TODAY).hasOwnProperty("due") && (extractDue("ביום שישי לסדר", TODAY) as { due: string }).due, "2026-11-27");
  assertEquals(extractDue("להביא בשני קרטונים", TODAY), { due: TODAY, rest: "להביא בשני קרטונים" });
});

Deno.test("extractDue: dates need a slash", () => {
  assertEquals(extractDue("לתקן את המדף 25/11", TODAY), { due: "2026-11-25", rest: "לתקן את המדף" });
  assertEquals(extractDue("לתקן ב-25/11", TODAY), { due: "2026-11-25", rest: "לתקן" });
  assertEquals(extractDue("עד 3/1 לסגור שנה", TODAY), { due: "2027-01-03", rest: "לסגור שנה" });
  assertEquals(extractDue("להזמין 1.5 ליטר", TODAY), { due: TODAY, rest: "להזמין 1.5 ליטר" });
  assertEquals(extractDue("x 31/2", TODAY), { error: "התאריך 31/2 לא תקין" });
  assertEquals(extractDue("x 15/11", TODAY), { error: "התאריך 15/11 כבר עבר" });
  assertEquals(extractDue("x 20/11/2026", TODAY), { due: TODAY, rest: "x" });
});

Deno.test("matchEmployees", () => {
  const emps = [{ name: "פלג אורג" }, { name: "אור הררי" }, { name: "אור-יה סודמי" }, { name: "אורי בלבול" }];
  assertEquals(matchEmployees("פלג", emps), [{ name: "פלג אורג" }]);
  assertEquals(matchEmployees("פלג אורג", emps), [{ name: "פלג אורג" }]);
  assertEquals(matchEmployees("אור", emps), [{ name: "אור הררי" }]);
  assertEquals(matchEmployees("או", emps).length, 3);
  assertEquals(matchEmployees("סגור", emps), []);
});

Deno.test("cancel callback", () => {
  assertEquals(parseCancelCallback("mtaskx:12"), 12);
  assertEquals(parseCancelCallback("mtask:12"), null);
  assertEquals(parseTaskCallback("mtaskx:12"), null);
});
