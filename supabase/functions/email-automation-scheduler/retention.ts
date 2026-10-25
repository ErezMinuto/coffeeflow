/**
 * Eligibility rules for the two retention emails (owner's rules, 2026-10-25):
 *
 *   coffee_checkin   customers with exactly ONE paid web order get one
 *                    "how was your coffee?" email (+ Google review link when
 *                    enabled), once in their lifetime, N days after the order
 *                    was completed. Everyone qualifies: no reward, no filter
 *                    by satisfaction (Google policy). An unsubscribe opts out.
 *   2 orders         nothing new (WooCommerce's own order emails).
 *   refill_reminder  customers with 3+ paid web orders get a reorder reminder
 *                    timed to their own rhythm: median gap between bean
 *                    orders × factor, from the last bean order. One per
 *                    cycle, no follow-up; ordering first moves the cycle.
 *                    Advertising under §30A → marketing consent required,
 *                    and the customer can stop reminders with one click.
 *
 * Plus, for both: at most one automated (non-transactional) email per
 * customer in any 4-day window.
 *
 * Pure functions only — covered by retention_test.ts.
 */

export const DAY_MS = 86_400_000;
export const COLLISION_WINDOW_DAYS = 4;

export interface CustomerOrder {
  woo_order_id: number;
  status: string;
  date_created: string;          // ISO
  date_completed: string | null; // ISO
  has_beans: boolean;
  email_norm: string | null;
  first_name: string | null;
  marketing_consent: boolean | null;
}

export const PAID = new Set(['completed', 'processing']);

export function paidOrders(orders: CustomerOrder[]): CustomerOrder[] {
  return orders
    .filter(o => PAID.has(o.status))
    .sort((a, b) => a.date_created.localeCompare(b.date_created) || a.woo_order_id - b.woo_order_id);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── coffee_checkin ──────────────────────────────────────────────────────────

export interface CheckinRule { delay_days: number; window_days: number }

/**
 * The one order a first-time buyer would be asked about, or null.
 * Due when the order was completed between delay_days and
 * delay_days + window_days ago. The window stops a first enable from
 * emailing every one-time buyer in history.
 */
export function checkinOrder(orders: CustomerOrder[], now: number, rule: CheckinRule): CustomerOrder | null {
  const paid = paidOrders(orders);
  if (paid.length !== 1) return null;
  const o = paid[0];
  if (!o.date_completed || !o.email_norm) return null;
  const age = (now - Date.parse(o.date_completed)) / DAY_MS;
  return age >= rule.delay_days && age <= rule.delay_days + rule.window_days ? o : null;
}

// ── refill_reminder ─────────────────────────────────────────────────────────

export interface ReminderRule {
  min_orders: number;        // 3
  cadence_factor: number;    // 0.85
  min_cadence_days: number;  // 7   — shorter = wholesale / test orders
  max_cadence_days: number;  // 120 — longer = no usable rhythm
  grace_days: number;        // 7   — send window after due, covers missed cron days
}

export interface ReminderDue {
  last_bean_order: CustomerOrder;
  cadence_days: number;
  due_at: number;
}

export function reminderDue(orders: CustomerOrder[], rule: ReminderRule): ReminderDue | null {
  const paid = paidOrders(orders);
  if (paid.length < rule.min_orders) return null;
  const beans = paid.filter(o => o.has_beans);
  if (beans.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < beans.length; i++) {
    const g = (Date.parse(beans[i].date_created) - Date.parse(beans[i - 1].date_created)) / DAY_MS;
    if (g >= 1) gaps.push(g); // same-day split orders are one purchase
  }
  const m = median(gaps);
  if (m === null) return null;
  const cadence = m * rule.cadence_factor;
  if (cadence < rule.min_cadence_days || cadence > rule.max_cadence_days) return null;
  const last = beans[beans.length - 1];
  return { last_bean_order: last, cadence_days: cadence, due_at: Date.parse(last.date_created) + cadence * DAY_MS };
}

export function inSendWindow(now: number, dueAt: number, graceDays: number): boolean {
  return now >= dueAt && now <= dueAt + graceDays * DAY_MS;
}

// ── Consent, stop, collision ────────────────────────────────────────────────

export interface ConsentEvent { at: string; granted: boolean }

/**
 * Marketing consent from every source we hold, latest event wins:
 * newsletter list (opted_in true = granted, false = unsubscribed) and the
 * checkout box (ticked = granted). An unticked box is NOT a withdrawal.
 */
export function hasMarketingConsent(events: ConsentEvent[]): boolean {
  if (!events.length) return false;
  const latest = [...events].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!;
  return latest.granted;
}

/** Unsubscribed from the list at any point after their latest grant. */
export function hasUnsubscribed(events: ConsentEvent[]): boolean {
  return events.length > 0 && !hasMarketingConsent(events) && events.some(e => !e.granted);
}

export interface ReminderPref { at: string; action: 'stop' | 'resume' }

export function remindersStopped(prefs: ReminderPref[]): boolean {
  if (!prefs.length) return false;
  return [...prefs].sort((a, b) => a.at.localeCompare(b.at)).at(-1)!.action === 'stop';
}

export function emailedRecently(lastSentAt: string | null | undefined, now: number): boolean {
  return !!lastSentAt && now - Date.parse(lastSentAt) < COLLISION_WINDOW_DAYS * DAY_MS;
}

// ── Stop-reminders link ─────────────────────────────────────────────────────

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** HMAC token for a customer's stop link. Unforgeable without the key. */
export async function stopToken(key: string, customerId: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`stop-reminders:${customerId}`)));
}
