// Automated email activity as facts, plus the conclude_brief checks that keep
// the strategist honest about the email channel.
//
// Two kinds of email leave Minuto:
//   • campaigns  — one-off sends to a segment, built by generate-campaign and
//                  logged in campaigns / campaign_events. The strategist can
//                  propose these (action_type email_campaign) and the minimum
//                  email audience (ops_profile.strategist_loop.min_email_reachable)
//                  applies to them.
//   • automations — lifecycle emails sent by email-automation-scheduler from the
//                  email_automation_templates triggers (first_purchase,
//                  abandoned_cart_*, coffee_checkin, refill_reminder, ...) and
//                  logged in email_automations. Never subject to the minimum.
//
// 2026-11-09: the brain read campaigns only, saw 0 sends in 90 days, called the
// email channel "completely dormant" (email_automations had 73 sends) and, because
// big_spender (103 opted in) is below the minimum, asked Erez to send to it by
// hand with action_type "none". Each check below closes one of those gaps.
// Data only: nothing here suggests what to send.

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

export const AUTOMATION_NOTE =
  'Automated lifecycle emails sent by email-automation-scheduler, one row per send in email_automations, ' +
  'one trigger per email_automation_templates row. Counted separately from campaigns (one-off sends to a segment). ' +
  'The minimum email audience applies only to new campaign / segment sends (action_type email_campaign); ' +
  'automations are not subject to it.'

export interface AutomationTriggerActivity {
  trigger_type: string
  display_name: string | null   // null = trigger has sends but no template row
  enabled:      boolean | null  // template's switch; null = no template row
  sent:         number          // status 'sent', sent_at inside the window
  failed:       number          // status 'failed', created inside the window
  last_sent_at: string | null
}

export interface AutomationActivity {
  lookback_days: number
  sent_total:    number
  failed_total:  number
  by_trigger:    AutomationTriggerActivity[]
  note:          string
}

export interface AutomationRow { trigger_type: string | null; status: string | null; sent_at: string | null }
export interface AutomationTemplateRow { trigger_type: string | null; display_name: string | null; enabled: boolean | null }

/** Pure: roll email_automations rows (already limited to the window) and the
 *  template list into per-trigger counts. Every template appears, sends or not. */
export function computeAutomationActivity(rows: AutomationRow[], templates: AutomationTemplateRow[], lookbackDays: number): AutomationActivity {
  const by = new Map<string, AutomationTriggerActivity>()
  const entry = (t: string) => {
    let a = by.get(t)
    if (!a) { a = { trigger_type: t, display_name: null, enabled: null, sent: 0, failed: 0, last_sent_at: null }; by.set(t, a) }
    return a
  }
  for (const t of templates) {
    if (!t.trigger_type) continue
    const a = entry(t.trigger_type)
    a.display_name = t.display_name ?? null
    a.enabled = typeof t.enabled === 'boolean' ? t.enabled : null
  }
  let sent = 0
  let failed = 0
  for (const r of rows) {
    if (!r.trigger_type) continue
    const a = entry(r.trigger_type)
    if (r.status === 'sent') {
      a.sent++; sent++
      if (r.sent_at && (!a.last_sent_at || r.sent_at > a.last_sent_at)) a.last_sent_at = r.sent_at
    } else if (r.status === 'failed') {
      a.failed++; failed++
    }
  }
  const by_trigger = [...by.values()].sort((x, y) => y.sent - x.sent || x.trigger_type.localeCompare(y.trigger_type))
  return { lookback_days: lookbackDays, sent_total: sent, failed_total: failed, by_trigger, note: AUTOMATION_NOTE }
}

async function pageAll<T>(build: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999)
    if (error) throw new Error(`${what} read failed: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

export async function fetchAutomationActivity(db: Db, lookbackDays = 90): Promise<AutomationActivity> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString()
  const [sentRows, failedRows, templates] = await Promise.all([
    pageAll<AutomationRow>((a, b) => db.from('email_automations').select('trigger_type, status, sent_at')
      .eq('status', 'sent').gte('sent_at', since).order('sent_at').range(a, b), 'email_automations'),
    pageAll<AutomationRow>((a, b) => db.from('email_automations').select('trigger_type, status, sent_at')
      .eq('status', 'failed').gte('created_at', since).order('created_at').range(a, b), 'email_automations'),
    pageAll<AutomationTemplateRow>((a, b) => db.from('email_automation_templates').select('trigger_type, display_name, enabled')
      .order('trigger_type').range(a, b), 'email_automation_templates'),
  ])
  return computeAutomationActivity([...sentRows, ...failedRows], templates, lookbackDays)
}

// ── conclude_brief checks ────────────────────────────────────────────────────

interface RecLike { title?: string; rationale?: string; action_type?: string; action_params?: Record<string, unknown> }
interface DiagLike { claim?: string; evidence?: string }
interface OutLike { title?: string; rationale?: string }

export interface BriefText { summary?: string; top_thesis?: string; diagnosis?: DiagLike[]; recommendations?: RecLike[]; out_of_hands?: OutLike[] }

/** Every piece of brief text with a label for the error message. */
function briefPieces(b: BriefText): Array<{ at: string; text: string; rec?: RecLike }> {
  const s = (x: unknown) => (typeof x === 'string' ? x : '')
  const params = (p: unknown) => (p && typeof p === 'object' ? Object.values(p as Record<string, unknown>).filter(v => typeof v === 'string').join('\n') : '')
  return [
    { at: 'summary', text: s(b.summary) },
    { at: 'top_thesis', text: s(b.top_thesis) },
    ...(b.diagnosis ?? []).map((d, i) => ({ at: `diagnosis[${i}]`, text: [s(d?.claim), s(d?.evidence)].join('\n') })),
    ...(b.recommendations ?? []).map((r, i) => ({ at: `recommendations[${i}] "${s(r?.title)}"`, text: [s(r?.title), s(r?.rationale), params(r?.action_params)].join('\n'), rec: r })),
    ...(b.out_of_hands ?? []).map((o, i) => ({ at: `out_of_hands[${i}] "${s(o?.title)}"`, text: [s(o?.title), s(o?.rationale)].join('\n') })),
  ]
}

// "the email channel is completely dormant", "dormant email channel",
// "0 sends in 90 days", "no emails were sent". A phrase that names campaigns
// ("0 campaign sends", "email campaigns are dormant") is true and allowed.
const IDLE = String.raw`(?:dormant|inactive|idle|dead|silent|unused|asleep|switched\s+off|turned\s+off)`
const NOT_CAMPAIGN_WORD = String.raw`(?!(?:campaigns?|newsletters?|broadcasts?|blasts?)\b)[\w'-]+`
const DORMANT_CLAIM = new RegExp([
  String.raw`\be-?mail\b(?:\s+${NOT_CAMPAIGN_WORD}){0,3}?\s+(?:is|was|has\s+been|remains|went|has\s+gone|sits|stays)?\s*(?:completely\s+|fully\s+|totally\s+|entirely\s+|effectively\s+|basically\s+)?${IDLE}`,
  String.raw`${IDLE}\s+(?:e-?mail|email)\b(?!\s+campaigns?)`,
  String.raw`(?:^|[^\w])(?:0|zero|no)\s+(?:e-?mails?\s+)?sends\b`,
  String.raw`\bno\s+e-?mails?\s+(?:were\s+|have\s+been\s+|has\s+been\s+|got\s+|went\s+)?(?:sent|out)\b`,
  String.raw`\be-?mail\b[^.\n]{0,30}\bnot\s+(?:been\s+)?used\b`,
  String.raw`ערוץ\s+(?:ה)?(?:מייל|אימייל|דוא"ל)[^.\n]{0,20}(?:רדום|מת|לא\s+פעיל|מושבת)`,
].join('|'), 'i')

/** The brief may not call the email channel dormant/inactive while automations
 *  send. Returns problems; empty when automations sent nothing or the claim is
 *  absent. activity null = the automation read failed: no check (unknown ≠ 0). */
export function emailDormancyProblems(brief: BriefText, activity: AutomationActivity | null): string[] {
  if (!activity || activity.sent_total <= 0) return []
  const breakdown = activity.by_trigger.filter(t => t.sent > 0).map(t => `${t.trigger_type} ${t.sent}`).join(', ')
  return briefPieces(brief).filter(p => DORMANT_CLAIM.test(p.text)).map(p =>
    `${p.at}: describes the email channel as dormant or as having no sends, but email_automations sent ${activity.sent_total} emails in the last ${activity.lookback_days} days (${breakdown}). Only campaigns had 0; say "0 campaign sends" if that is the point`)
}

// Segment names that are also ordinary words (new, lost, regular) count only
// when written as a segment: 'new', "new segment", segment new, new_segment.
const AMBIGUOUS_SEGMENTS = new Set(['new', 'lost', 'regular'])
function segmentMentioned(text: string, seg: string): boolean {
  const name = seg.replace(/_/g, '[_ -]?')
  if (!AMBIGUOUS_SEGMENTS.has(seg)) return new RegExp(String.raw`(?<![A-Za-z])${name}s?(?![A-Za-z])`, 'i').test(text)
  return new RegExp(String.raw`['"\`‘’“”]${name}['"\`‘’“”]|\b${name}\s+segment|\bsegment\s*[:=]?\s*['"]?${name}\b`, 'i').test(text)
}

const EMAIL_WORD = /\be-?mails?\b|\bnewsletter|\bwin-?back\b|\bmail(?:ing|er)?\b|מייל|ניוזלטר|דיוור/i
const MANUAL_SEND = /\bmanual(?:ly)?\b[^.\n]{0,40}\b(?:send|sent|email|mail)|\b(?:send|sent|email|mail)\w*\b[^.\n]{0,40}\b(?:manually|by\s+hand|himself|yourself|directly\s+from)|\bhand[- ]send|\bErez\s+(?:must|should|needs?\s+to|can|could)\s+(?:\w+\s+){0,2}(?:send|email|mail)/i

export interface SegmentReach { segment: string; opted_in_reachable: number | null }

/** No recommendation (any action_type other than email_campaign, which its own
 *  gate checks) and no out-of-hands item may route an email to a segment below
 *  the minimum, and none may ask Erez to send a segment email by hand: below the
 *  minimum the rec is dropped or widened to an audience that passes. */
export function belowMinimumSendProblems(brief: BriefText, segments: SegmentReach[], minReachable: number): string[] {
  const known = segments.filter(s => typeof s.opted_in_reachable === 'number') as Array<{ segment: string; opted_in_reachable: number }>
  const passing = known.filter(s => s.opted_in_reachable >= minReachable).map(s => `${s.segment} (${s.opted_in_reachable})`)
  const widen = passing.length
    ? `make it an email_campaign to a segment at or above it: ${passing.join(', ')}`
    : `no segment reaches it this cycle (${known.map(s => `${s.segment} ${s.opted_in_reachable}`).join(', ')}), so drop the rec`
  const problems: string[] = []
  for (const p of briefPieces(brief)) {
    if (p.at === 'summary' || p.at === 'top_thesis' || p.at.startsWith('diagnosis')) continue
    if (p.rec?.action_type === 'email_campaign') continue
    if (!EMAIL_WORD.test(p.text)) continue
    const small = known.filter(s => s.opted_in_reachable < minReachable && segmentMentioned(p.text, s.segment))
    const manual = MANUAL_SEND.test(p.text)
    if (small.length) {
      problems.push(`${p.at}: emails ${small.map(s => `${s.segment} (${s.opted_in_reachable} opted in)`).join(', ')}, below the minimum email audience of ${minReachable}. A segment send below the minimum is not recommended in any form, manual or advice: ${widen}`)
    } else if (manual) {
      problems.push(`${p.at}: asks Erez to send a segment email by hand. Segment emails are recommended only as action_type email_campaign, which checks the minimum email audience of ${minReachable}: ${widen}`)
    }
  }
  return problems
}

const AUTOMATION_WORD = /\bautomat(?:ion|ions|ed|ic)\b|\blifecycle\b|\bflows?\b|\btriggers?\b|\bretention\s+(?:e-?mails?|sequence|series)\b|\babandoned[ _-]?cart|\brefill[ _-]?reminder|\bfirst[ _-]?purchase|\bcoffee[ _-]?check-?in|אוטומצי/i
const STOP_VERB = /\b(?:pause|paused|pausing|disable|disabled|disabling|turn(?:ing)?\s+off|switch(?:ing)?\s+off|stop(?:ping)?|suspend|shut(?:ting)?\s+(?:off|down)|kill|retire|gate|hold\s+back)\b|להשהות|לכבות|לעצור/i
const SIZE_REASON = /\bmin(?:imum)?\b|\bthreshold\b|\bbelow\b|\btoo\s+(?:small|few)\b|\baudience\s+size\b|\breachable\b|\bopted[- ]in\s+(?:count|audience)\b|\b200\b/i

/** Automations are never subject to the minimum email audience, so no rec or
 *  out-of-hands item may propose pausing or gating one for audience size. */
export function automationGateProblems(brief: BriefText, minReachable: number, triggerTypes: string[] = []): string[] {
  const named = triggerTypes.length ? new RegExp(triggerTypes.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[_ -]?')).join('|'), 'i') : null
  const problems: string[] = []
  for (const p of briefPieces(brief)) {
    if (p.at === 'summary' || p.at === 'top_thesis' || p.at.startsWith('diagnosis')) continue
    const aboutAutomation = AUTOMATION_WORD.test(p.text) || (named?.test(p.text) ?? false)
    if (aboutAutomation && STOP_VERB.test(p.text) && SIZE_REASON.test(p.text)) {
      problems.push(`${p.at}: proposes pausing or gating an email automation on audience size. Automations (email_automation_templates triggers) are not subject to the minimum email audience of ${minReachable}; it applies only to new campaign / segment sends`)
    }
  }
  return problems
}
