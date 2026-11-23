// Manager tasks (משימות לצוות) — pure helpers for employee-bot.
//
// The owner adds a task on the CoffeeFlow page; employee-bot DMs the assignee
// with a "✅" button per task, reminds every morning while a task is due or
// overdue, and tells the creator when it's done. Everything here is pure so it
// can be unit-tested; index.ts does the I/O.

export interface TaskRow {
  id: number;
  title: string;
  notes?: string | null;
  due_date: string; // YYYY-MM-DD (Israel calendar day)
}

export type TaskMessageKind = "new" | "reminder" | "list";

// Telegram caps: 64 bytes of callback_data, ~100 buttons per message.
export const MAX_TASKS_PER_MESSAGE = 20;
const BUTTON_TITLE_CHARS = 40;

export const TASK_CALLBACK_PREFIX = "mtask:";

export function escHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ddmm(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Whole calendar days from `due` to `today` (both YYYY-MM-DD). Positive = late.
export function daysLate(due: string, today: string): number {
  const ms = Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function dueLabel(due: string, today: string): string {
  const late = daysLate(due, today);
  if (late === 0) return "להיום";
  if (late === 1) return "⏰ באיחור של יום";
  if (late > 1) return `⏰ באיחור של ${late} ימים`;
  if (late === -1) return "למחר";
  return `עד ${ddmm(due)}`;
}

export function taskCallbackData(id: number): string {
  return `${TASK_CALLBACK_PREFIX}${id}`;
}

// "mtask:<id>" → id, anything else → null.
export function parseTaskCallback(data: string): number | null {
  if (!data?.startsWith(TASK_CALLBACK_PREFIX)) return null;
  const raw = data.slice(TASK_CALLBACK_PREFIX.length);
  if (!/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function buttonTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  return t.length > BUTTON_TITLE_CHARS ? `${t.slice(0, BUTTON_TITLE_CHARS - 1)}…` : t;
}

export function sortTasks<T extends TaskRow>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
}

// The DM text plus one "✅ <title>" button per task.
export function buildTaskMessage(
  kind: TaskMessageKind,
  tasks: TaskRow[],
  today: string,
  name?: string,
): { text: string; reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
  const shown = sortTasks(tasks).slice(0, MAX_TASKS_PER_MESSAGE);
  const extra = tasks.length - shown.length;
  const hi = name ? `היי ${escHtml(name)}, ` : "";

  const header =
    kind === "new"
      ? (shown.length === 1 ? `📌 <b>משימה חדשה</b>` : `📌 <b>משימות חדשות (${shown.length})</b>`)
      : kind === "reminder"
        ? `🔔 <b>תזכורת: ${shown.length === 1 ? "משימה פתוחה" : `${tasks.length} משימות פתוחות`}</b>`
        : `📋 <b>המשימות הפתוחות שלך (${tasks.length})</b>`;

  const lines = shown.map((t, i) => {
    const num = shown.length > 1 ? `${i + 1}. ` : "";
    const notes = t.notes?.trim() ? `\n   <i>${escHtml(t.notes.trim())}</i>` : "";
    return `${num}<b>${escHtml(t.title.trim())}</b> · ${dueLabel(t.due_date, today)}${notes}`;
  });

  const footer = shown.length === 1
    ? `${hi}כשסיימת לחצ/י על הכפתור 👇`
    : `${hi}לחצ/י על משימה כשסיימת אותה 👇`;

  const text = [
    header,
    "",
    lines.join("\n"),
    extra > 0 ? `\n+ עוד ${extra} משימות בעמוד "משימות לצוות" ב-CoffeeFlow` : "",
    "",
    footer,
  ].filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n").trim();

  return {
    text,
    reply_markup: {
      inline_keyboard: shown.map((t) => [{
        text: shown.length === 1 ? "✅ בוצע" : `✅ ${buttonTitle(t.title)}`,
        callback_data: taskCallbackData(t.id),
      }]),
    },
  };
}

// Keyboard after a button press: the pressed task's button removed.
export function dropButton(
  keyboard: Array<Array<{ text: string; callback_data?: string }>> | undefined,
  data: string,
): Array<Array<{ text: string; callback_data?: string }>> {
  return (keyboard ?? [])
    .map((row) => row.filter((b) => b.callback_data !== data))
    .filter((row) => row.length > 0);
}

// Text the creator gets when the assignee finishes.
export function doneNoticeText(assigneeName: string, title: string, via: "app" | "telegram" | null): string {
  const where = via === "telegram" ? " (בטלגרם)" : via === "app" ? " (ב-CoffeeFlow)" : "";
  return `✅ <b>${escHtml(assigneeName)}</b> סימנ/ה כבוצע${where}:\n${escHtml(title.trim())}`;
}

// Which open tasks get today's reminder: due today or earlier, not already
// reminded today, and not first sent today (the "new task" DM covers that).
export function needsReminder(
  t: { status: string; due_date: string; last_reminded_on?: string | null; notified_at?: string | null },
  today: string,
  israelDateOf: (iso: string) => string,
): boolean {
  if (t.status !== "open") return false;
  if (t.due_date > today) return false;
  if (t.last_reminded_on && t.last_reminded_on >= today) return false;
  if (t.notified_at && israelDateOf(t.notified_at) === today) return false;
  return true;
}

// ── Creating a task from a Telegram message ──────────────────────────────────
// "משימה לפלג: להזמין חלב מחר"   → for פלג, due tomorrow
// "משימה לפלג אורג: ..."          → a full name before the colon works too
// "משימה: לסגור קופה" / "משימה לעצמי: ..." → for the sender
// "משימה לפלג להזמין חלב"         → no colon: ל<name> counts only if it is a name
// First line is the title, further lines are notes. No date → today.

export interface ParsedTaskMessage {
  assigneeName: string | null; // null → the sender
  explicitName: boolean;       // given before a colon: it must match someone
  title: string;
  notes: string | null;
  due: string;                 // YYYY-MM-DD
}

const HEB = "֐-׿";
const SELF_WORDS = new Set(["עצמי", "לעצמי", "י", "לי"]);
const WEEKDAYS: Record<string, number> = {
  "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6,
};

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "26/11", "עד 26/11", "ב-26/11/2026" — an explicit day/month date.
const DAY_MONTH_RE = /(?<![\d/])(?:עד\s+)?(?:ב-?|ל-?)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/;

const tidy = (s: string) =>
  s.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").replace(/^[\s,–-]+|[\s,–-]+$/g, "").trim();

// Finds one due-date expression in `text`; returns the date and the text
// without it. Nothing found → today. Dates need a slash (25/11) so that
// "1.5 ליטר" is never read as a date; weekdays need "יום" ("ביום שני") so
// that "בשני קרטונים" isn't Monday.
export function extractDue(text: string, today: string): { due: string; rest: string } | { error: string } {
  const notHebBefore = `(?<![${HEB}\\w])`;
  const notHebAfter = `(?![${HEB}\\w])`;

  const dm = DAY_MONTH_RE.exec(text);
  if (dm) {
    const day = Number(dm[1]), month = Number(dm[2]);
    let year = dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : Number(today.slice(0, 4));
    const iso = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const valid = (y: number) => {
      const d = new Date(`${iso(y)}T12:00:00Z`);
      return d.getUTCMonth() + 1 === month && d.getUTCDate() === day;
    };
    if (month < 1 || month > 12 || !valid(year)) return { error: `התאריך ${dm[1]}/${dm[2]} לא תקין` };
    // No year and well in the past → it's next year (written in December
    // for January). A recent past date is more likely a typo.
    if (!dm[3] && iso(year) < today && daysLate(iso(year), today) > 180 && valid(year + 1)) year += 1;
    if (iso(year) < today) return { error: `התאריך ${dm[1]}/${dm[2]} כבר עבר` };
    return { due: iso(year), rest: tidy(text.replace(dm[0], " ")) };
  }

  for (const [word, n] of [["מחרתיים", 2], ["מחר", 1], ["היום", 0]] as Array<[string, number]>) {
    const m = new RegExp(`${notHebBefore}(?:עד\\s+)?ל?${word}${notHebAfter}`).exec(text);
    if (m) return { due: addDays(today, n), rest: tidy(text.replace(m[0], " ")) };
  }

  const wd = new RegExp(`${notHebBefore}(?:עד\\s+)?(?:ב|ל)?יום\\s+(${Object.keys(WEEKDAYS).join("|")})${notHebAfter}`).exec(text);
  if (wd) {
    const now = new Date(`${today}T12:00:00Z`).getUTCDay();
    const ahead = ((WEEKDAYS[wd[1]] - now + 7) % 7) || 7; // the coming one, never today
    return { due: addDays(today, ahead), rest: tidy(text.replace(wd[0], " ")) };
  }

  return { due: today, rest: tidy(text) };
}

// null → not a "משימה" command at all.
export function parseTaskMessage(
  text: string, today: string,
): ParsedTaskMessage | { error: string } | { help: true } | null {
  const m = new RegExp(`^משימה(?![${HEB}])\\s*([\\s\\S]*)$`).exec(text.trim());
  if (!m) return null;
  let [firstLine, ...more] = m[1].split("\n");
  // Pull the next non-empty line up when the current one has no task text:
  // "משימה לפלג:" with the task written on the line below.
  const nextLine = (): string => {
    const i = more.findIndex((l) => l.trim());
    if (i < 0) return "";
    const l = more[i].trim();
    more = more.slice(i + 1);
    return l;
  };
  let line = firstLine.trim() || nextLine();
  if (!line) return { help: true };

  let assigneeName: string | null = null;
  let explicitName = false;
  const colon = line.search(/[:：]/);
  if (colon >= 0 && colon <= 40) {
    const head = line.slice(0, colon).trim();
    line = line.slice(colon + 1).trim() || nextLine();
    if (head) {
      const name = head.startsWith("ל") ? head.slice(1).trim() : head;
      if (!SELF_WORDS.has(head) && !SELF_WORDS.has(name)) { assigneeName = name; explicitName = true; }
    }
  } else if (new RegExp(`^לעצמי(?![${HEB}])`).test(line)) {
    line = line.replace(/^לעצמי\s*/, "");
  } else {
    // A candidate name; the caller keeps it only if it matches an employee
    // and then strips "ל<name>" from the title (stripCandidateName).
    const tok = /^ל([^\s,]+)\s+\S/.exec(line);
    if (tok) assigneeName = tok[1];
  }

  if (!line) return { error: "חסר תיאור למשימה" };
  let due = extractDue(line, today);
  if ("error" in due) return due;
  // No date in the title: an explicit dd/mm on a details line counts too
  // ("...נוזל ניקוי חלב 26/11" wrapped onto the second line). It's removed
  // from that line; the other lines keep their breaks.
  if (due.due === today && due.rest === tidy(line)) {
    const i = more.findIndex((l) => DAY_MONTH_RE.test(l));
    if (i >= 0) {
      const fromNotes = extractDue(more[i], today);
      if ("error" in fromNotes) return fromNotes;
      due = { due: fromNotes.due, rest: due.rest };
      more = [...more.slice(0, i), ...(fromNotes.rest ? [fromNotes.rest] : []), ...more.slice(i + 1)];
    }
  }
  if (!due.rest) return { error: "חסר תיאור למשימה" };
  if (due.rest.length > 300) return { error: "המשימה ארוכה מדי (עד 300 תווים). פרטים אפשר לכתוב בשורה נפרדת" };
  const notesRaw = more.join("\n").trim();
  return { assigneeName, explicitName, title: due.rest, notes: notesRaw ? notesRaw.slice(0, 2000) : null, due: due.due };
}

// The title once a no-colon candidate name matched: drop the "ל<name>".
export function stripCandidateName(title: string, name: string): string {
  const prefix = `ל${name}`;
  return title.startsWith(prefix) ? tidy(title.slice(prefix.length)) : title;
}

// Typed name → employees: exact full name, else first name, else full-name prefix.
export function matchEmployees<T extends { name: string }>(typed: string, employees: T[]): T[] {
  const q = typed.trim().replace(/\s+/g, " ");
  if (!q) return [];
  const exact = employees.filter((e) => e.name.trim() === q);
  if (exact.length) return exact;
  const first = employees.filter((e) => e.name.trim().split(/\s+/)[0] === q);
  if (first.length) return first;
  return employees.filter((e) => e.name.trim().startsWith(q));
}

export const TASK_HELP_TEXT = [
  "📝 <b>איך מוסיפים משימה</b>",
  "",
  "<code>משימה: לסגור את הקופה</code>  (לעצמך, להיום)",
  "<code>משימה לפלג: להזמין חלב מחר</code>",
  "<code>משימה לפלג: לבדוק מלאי ביום שלישי</code>",
  "<code>משימה לפלג: לתקן את המדף 25/11</code>",
  "",
  "בלי תאריך, המשימה היא להיום. שורה שנייה בהודעה נשמרת כפרטים.",
  "<code>משימות</code> מציג את המשימות הפתוחות שלך.",
].join("\n");

// "❌ ביטול" on the creator's confirmation: "mtaskx:<id>".
export const TASK_CANCEL_PREFIX = "mtaskx:";
export function parseCancelCallback(data: string): number | null {
  if (!data?.startsWith(TASK_CANCEL_PREFIX)) return null;
  const raw = data.slice(TASK_CANCEL_PREFIX.length);
  return /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}
