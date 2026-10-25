/**
 * Data side of the retention emails: loads customers / customer_orders /
 * consent / stop-prefs / send history once per run, then picks candidates
 * with the pure rules in retention.ts.
 *
 * Customers come from the dedupe built by woo-orders-sync (customers +
 * customer_orders), so one person with a guest checkout and an account, or
 * two emails, is ONE customer: once-only and 4-day rules hold across all of
 * their addresses.
 */
import {
  checkinOrder, type ConsentEvent, type CustomerOrder, emailedRecently, hasMarketingConsent,
  hasUnsubscribed, inSendWindow, paidOrders, reminderDue, type ReminderPref, type ReminderRule,
  remindersStopped, stopToken,
} from './retention.ts'

// deno-lint-ignore no-explicit-any
type Db = any

interface OrderRow extends CustomerOrder {
  customer_id: string
  consent_at: string | null
  lines: { product_id: number | null; is_bean?: boolean; name: string }[]
}

export interface RetentionCandidate {
  customer_email: string
  customer_name: string | null
  woo_order_id: number
  order_date: string
  customer_id: string
  extra_vars: Record<string, string>
  list_unsubscribe_url?: string
  detail?: Record<string, unknown>
}

/** Every row of a query, past PostgREST's 1,000-row page limit. */
async function fetchAll<T>(db: Db, table: string, select: string, filter?: (q: Db) => Db): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(select).order(select.split(',')[0].trim(), { ascending: true }).range(from, from + 999)
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

export interface RetentionData {
  now: number
  orders: Map<string, OrderRow[]>           // root customer id → orders
  emails: Map<string, string[]>             // root customer id → every email
  consent: Map<string, ConsentEvent[]>      // root customer id → consent events
  prefs: Map<string, ReminderPref[]>        // root customer id → stop / resume
  lastSent: Map<string, string>             // email → latest automated send
  sentKeys: Set<string>                     // `${trigger}::${email}::${order}` and `${trigger}::${email}`
  products: Map<number, { permalink: string; name: string; image_url: string | null }>
}

export async function loadRetentionData(db: Db): Promise<RetentionData> {
  const [customers, orderRows, contacts, prefRows, sends, products] = await Promise.all([
    fetchAll<{ id: string; merged_into: string | null; emails: string[] }>(db, 'customers', 'id, merged_into, emails'),
    fetchAll<OrderRow>(db, 'customer_orders',
      'woo_order_id, customer_id, status, date_created, date_completed, has_beans, email_norm, first_name, marketing_consent, consent_at, lines',
      q => q.not('customer_id', 'is', null)),
    fetchAll<{ email: string; opted_in: boolean; updated_at: string | null; created_at: string | null }>(db, 'marketing_contacts', 'email, opted_in, updated_at, created_at'),
    fetchAll<{ id: number; customer_id: string; action: 'stop' | 'resume'; created_at: string }>(db, 'messaging_reminder_prefs', 'id, customer_id, action, created_at'),
    fetchAll<{ id: string; trigger_type: string; customer_email: string; woo_order_id: number | null; status: string; sent_at: string | null; created_at: string }>(
      db, 'email_automations', 'id, trigger_type, customer_email, woo_order_id, status, sent_at, created_at'),
    fetchAll<{ woo_id: number; permalink: string; name: string; image_url: string | null }>(db, 'woo_products', 'woo_id, permalink, name, image_url'),
  ])

  // Merged customers point at their survivor; follow the chain to the root.
  const parent = new Map(customers.map(c => [c.id, c.merged_into]))
  const root = (id: string) => { let cur = id; for (let i = 0; i < 10 && parent.get(cur); i++) cur = parent.get(cur)!; return cur }

  const push = <V>(m: Map<string, V[]>, k: string, v: V) => { const a = m.get(k); a ? a.push(v) : m.set(k, [v]) }
  const orders = new Map<string, OrderRow[]>()
  for (const o of orderRows) push(orders, root(o.customer_id), o)

  const emails = new Map<string, string[]>()
  for (const c of customers) for (const e of c.emails ?? []) push(emails, root(c.id), e)

  const byEmail = new Map<string, ConsentEvent[]>()
  for (const m of contacts) {
    const e = (m.email ?? '').toLowerCase().trim()
    const at = m.updated_at ?? m.created_at
    if (e && at) push(byEmail, e, { at, granted: !!m.opted_in })
  }
  const consent = new Map<string, ConsentEvent[]>()
  for (const [id, es] of emails) for (const e of es) for (const ev of byEmail.get(e) ?? []) push(consent, id, ev)
  for (const [id, os] of orders) for (const o of os) {
    if (o.marketing_consent === true) push(consent, id, { at: o.consent_at ?? o.date_created, granted: true })
  }

  const prefs = new Map<string, ReminderPref[]>()
  for (const p of prefRows) push(prefs, root(p.customer_id), { at: p.created_at, action: p.action })

  const lastSent = new Map<string, string>()
  const sentKeys = new Set<string>()
  for (const s of sends) {
    const e = s.customer_email.toLowerCase()
    sentKeys.add(`${s.trigger_type}::${e}`)
    sentKeys.add(`${s.trigger_type}::${e}::${s.woo_order_id}`)
    if (s.status === 'sent' && s.sent_at && (!lastSent.get(e) || s.sent_at > lastSent.get(e)!)) lastSent.set(e, s.sent_at)
  }

  const productMap = new Map(products.map(p => [p.woo_id, { permalink: p.permalink, name: p.name, image_url: p.image_url }]))
  return { now: Date.now(), orders, emails, consent, prefs, lastSent, sentKeys, products: productMap }
}

const recentlyEmailedAny = (d: RetentionData, es: string[]) => es.some(e => emailedRecently(d.lastSent.get(e), d.now))

// ── coffee_checkin ──────────────────────────────────────────────────────────

export function findCheckinCandidates(
  d: RetentionData, tmpl: { delay_days: number; max_lookback_days: number; settings?: Record<string, unknown> },
  unsubscribeUrlFor: (email: string) => string,
): RetentionCandidate[] {
  const s = tmpl.settings ?? {}
  const reviewUrl = typeof s.review_url === 'string' ? s.review_url : ''
  const reviewOn = s.review_link_enabled === true && /^https:\/\//.test(reviewUrl)
  const rule = { delay_days: tmpl.delay_days, window_days: Math.max(0, tmpl.max_lookback_days - tmpl.delay_days) }
  const out: RetentionCandidate[] = []
  for (const [id, os] of d.orders) {
    const o = checkinOrder(os, d.now, rule)
    if (!o) continue
    const es = d.emails.get(id) ?? []
    if (hasUnsubscribed(d.consent.get(id) ?? [])) continue                  // asked us to stop
    if (es.some(e => d.sentKeys.has(`coffee_checkin::${e}`))) continue        // once per customer, ever
    if (recentlyEmailedAny(d, es)) continue                                   // 4-day rule
    out.push({
      customer_email: o.email_norm!, customer_name: o.first_name, woo_order_id: o.woo_order_id,
      order_date: o.date_created.slice(0, 10), customer_id: id,
      extra_vars: {
        review_block_html: reviewOn ? reviewBlock(reviewUrl) : '',
        product_block_html: productBlock(d, o as OrderRow),
      },
      list_unsubscribe_url: unsubscribeUrlFor(o.email_norm!),
      detail: { completed: o.date_completed, review_link: reviewOn },
    })
  }
  return out
}

// Neutral wording on purpose: Google bans asking only happy customers.
function reviewBlock(url: string): string {
  return `<tr><td align="center" style="padding:28px 40px 4px;">
      <p style="margin:0 0 18px; font-size:15px; line-height:1.75; color:#333333; text-align:center;">נשמח גם לשמוע את דעתך בגוגל. כל ביקורת עוזרת לנו להשתפר, ולאנשים נוספים להכיר את בית הקלייה.</p>
      <a href="${escapeAttr(url)}" style="display:inline-block; background:#FFFFFF; color:#3C4A2C; text-decoration:none; font-size:15px; font-weight:700; padding:12px 32px; border:1px solid #3C4A2C; border-radius:4px;">לכתיבת ביקורת בגוגל</a>
    </td></tr>`
}

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Photo of the coffee this customer bought, on a pale sage panel. Empty when
 * the product has no image (the email still reads fine without it).
 * Resold / green coffee (Veneto…) is never pictured, in any email (brand rules).
 */
function productBlock(d: RetentionData, order: OrderRow): string {
  const bean = (order.lines ?? []).find(l => l.is_bean && l.product_id && d.products.get(l.product_id)?.image_url)
  const p = bean ? d.products.get(bean.product_id!) : undefined
  if (!p?.image_url || NOT_PROMOTED.test(p.name)) return ''
  return `<tr><td align="center" style="background:#FFFFFF; padding:28px 32px 8px;">
      <img src="${escapeAttr(p.image_url)}" alt="${escapeAttr(p.name)}" width="220" style="display:block; width:220px; max-width:220px; height:auto; border:0;">
    </td></tr>`
}

// ── refill_reminder ─────────────────────────────────────────────────────────

const RULE_DEFAULTS: ReminderRule = { min_orders: 3, cadence_factor: 0.85, min_cadence_days: 7, max_cadence_days: 120, grace_days: 7 }
// Hard no as a reorder destination (brand rules): resold / green coffee.
const NOT_PROMOTED = /veneto|ירוק|green|לא קלוי/i

export async function findReminderCandidates(
  d: RetentionData, tmpl: { settings?: Record<string, unknown> },
  opts: { stopBase: string; signingKey: string; unsubscribeUrlFor: (email: string) => string },
): Promise<RetentionCandidate[]> {
  const s = tmpl.settings ?? {}
  const num = (k: keyof ReminderRule) => typeof s[k] === 'number' ? s[k] as number : RULE_DEFAULTS[k]
  const rule: ReminderRule = {
    min_orders: num('min_orders'), cadence_factor: num('cadence_factor'),
    min_cadence_days: num('min_cadence_days'), max_cadence_days: num('max_cadence_days'), grace_days: num('grace_days'),
  }
  const out: RetentionCandidate[] = []
  for (const [id, os] of d.orders) {
    const due = reminderDue(os, rule)
    if (!due || !inSendWindow(d.now, due.due_at, rule.grace_days)) continue
    const es = d.emails.get(id) ?? []
    if (!hasMarketingConsent(d.consent.get(id) ?? [])) continue              // advertising: consent only
    if (remindersStopped(d.prefs.get(id) ?? [])) continue                    // pressed "stop reminders"
    const last = due.last_bean_order
    if (es.some(e => d.sentKeys.has(`refill_reminder::${e}::${last.woo_order_id}`))) continue // one per cycle
    if (recentlyEmailedAny(d, es)) continue                                  // 4-day rule
    const latest = paidOrders(os).at(-1)!
    const email = latest.email_norm ?? last.email_norm
    if (!email) continue
    const stopUrl = `${opts.stopBase}?action=stop_reminders&c=${id}&t=${await stopToken(opts.signingKey, id)}`
    out.push({
      customer_email: email, customer_name: latest.first_name ?? last.first_name,
      woo_order_id: last.woo_order_id, order_date: last.date_created.slice(0, 10), customer_id: id,
      extra_vars: {
        stop_reminders_url: stopUrl, shop_url: shopUrl(d, last as OrderRow),
        product_block_html: productBlock(d, last as OrderRow),
      },
      // Gmail/Outlook "unsubscribe" button: one-click POST stops these reminders.
      list_unsubscribe_url: stopUrl,
      detail: { cadence_days: Math.round(due.cadence_days * 10) / 10, due: new Date(due.due_at).toISOString().slice(0, 10) },
    })
  }
  return out
}

function shopUrl(d: RetentionData, order: OrderRow): string {
  const utm = 'utm_source=email&utm_medium=automation&utm_campaign=refill_reminder'
  const bean = (order.lines ?? []).find(l => l.is_bean && l.product_id && d.products.has(l.product_id))
  const p = bean ? d.products.get(bean.product_id!) : undefined
  const base = p && !NOT_PROMOTED.test(p.name) ? p.permalink : 'https://www.minuto.co.il/shop/'
  return `${base}${base.includes('?') ? '&' : '?'}${utm}`
}
