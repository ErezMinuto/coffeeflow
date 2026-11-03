// Send one attendance reminder at most once per (employee, shift date,
// position, type).
//
// The dedupe row is CLAIMED before the DM goes out: attendance_reminders_sent's
// primary key is exactly that tuple, so when two runs overlap only one insert
// succeeds and only that run sends. If Telegram rejects the message (or the
// request fails) the claim is released, so the next run retries instead of a
// reminder that never arrived being recorded as sent.
//
// The previous version sent first, never looked at Telegram's answer, and
// inserted the row afterwards.

export type ReminderKey = { employee_id: number; shift_date: string; position: string; reminder_type: "in" | "out" };
export type SendResult = { ok: boolean; detail?: string };
export type RemindOutcome = "sent" | "already_sent" | "send_failed" | "claim_failed";

type DbError = { code?: string; message: string } | null;
type Query = PromiseLike<{ error: DbError }> & { eq(col: string, val: unknown): Query };
type Db = {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: DbError }>;
    delete(): Query;
  };
};

export async function telegramSend(token: string, chatId: number | string, text: string, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok === true) return { ok: true };
    return { ok: false, detail: `telegram ${res.status}: ${body?.description ?? "no description"}` };
  } catch (e) {
    return { ok: false, detail: `telegram request failed: ${(e as Error).message}` };
  }
}

export async function remindOnce(db: Db, key: ReminderKey, send: () => Promise<SendResult>): Promise<{ outcome: RemindOutcome; detail?: string }> {
  const { error: claimErr } = await db.from("attendance_reminders_sent").insert({ ...key });
  if (claimErr) {
    if (claimErr.code === "23505") return { outcome: "already_sent" };
    return { outcome: "claim_failed", detail: claimErr.message };
  }

  const sent = await send();
  if (sent.ok) return { outcome: "sent" };

  const { error: relErr } = await db.from("attendance_reminders_sent").delete()
    .eq("employee_id", key.employee_id)
    .eq("shift_date", key.shift_date)
    .eq("position", key.position)
    .eq("reminder_type", key.reminder_type);
  return {
    outcome: "send_failed",
    detail: sent.detail + (relErr ? ` (and the claim could not be released: ${relErr.message})` : ""),
  };
}
