// Tests for automated email activity and the email-channel checks in
// conclude_brief (gate scoping, dormancy claims, manual sends below the minimum).
//
//   deno test --allow-read --allow-env --node-modules-dir=none supabase/functions/_shared/email_activity_test.ts
//
// Numbers are prod on 2026-11-09, last 90 days: email_automations status 'sent'
//   abandoned_cart_1 49, first_purchase 9, coffee_checkin 9, refill_reminder 6 = 73
// campaigns sent: 0. big_spender opted in: 103.

import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import {
  AUTOMATION_NOTE, automationGateProblems, belowMinimumSendProblems, computeAutomationActivity, emailDormancyProblems, fetchAutomationActivity,
  type AutomationRow, type AutomationTemplateRow, type BriefText,
} from './email_activity.ts'
import { emailRecProblems, type SegmentFacts } from './segment_facts.ts'
import { DEFAULT_MIN_EMAIL_REACHABLE } from './strategist_loop.ts'

const MIN = DEFAULT_MIN_EMAIL_REACHABLE

const PROD_SENT: Array<[string, number]> = [
  ['abandoned_cart_1', 49], ['first_purchase', 9], ['coffee_checkin', 9], ['refill_reminder', 6],
]
const rows: AutomationRow[] = []
for (const [t, n] of PROD_SENT) for (let i = 0; i < n; i++) rows.push({ trigger_type: t, status: 'sent', sent_at: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z` })
rows.push({ trigger_type: 'first_purchase', status: 'failed', sent_at: null })
rows.push({ trigger_type: 'abandoned_cart_1', status: 'skipped', sent_at: null })
const templates: AutomationTemplateRow[] = [
  { trigger_type: 'abandoned_cart_1', display_name: 'Abandoned cart 1', enabled: true },
  { trigger_type: 'abandoned_cart_2', display_name: 'Abandoned cart 2', enabled: false },
  { trigger_type: 'first_purchase', display_name: 'First purchase', enabled: true },
  { trigger_type: 'first_purchase_invite', display_name: 'First purchase invite', enabled: false },
  { trigger_type: 'coffee_checkin', display_name: 'Coffee check-in', enabled: true },
  { trigger_type: 'refill_reminder', display_name: 'Refill reminder', enabled: true },
]
const ACTIVITY = computeAutomationActivity(rows, templates, 90)

const SEGMENTS = [
  { segment: 'lost', opted_in_reachable: 89 }, { segment: 'big_spender', opted_in_reachable: 103 },
  { segment: 'new', opted_in_reachable: 100 }, { segment: 'loyal', opted_in_reachable: 68 },
  { segment: 'champion', opted_in_reachable: 98 }, { segment: 'at_risk', opted_in_reachable: 52 },
]

// The recommendation the brain wrote on 2026-11-09 (strategic_recommendations 98825af1).
const NOV9_REC = {
  title: "Manually Send Winback Email to 'big_spender' Segment",
  rationale: 'The email channel is completely dormant (0 sends in 90 days), but the drafter requires segments >=200 reachable. With big_spender sitting at 103 opted-in, Erez must manually send a winback email to past hardware buyers offering fresh Fazenda Sertão beans to convert them to recurring customers.',
  action_type: 'none',
  action_params: {},
}

// ── automation counts ────────────────────────────────────────────────────────

Deno.test('automation counts: 73 sends split by trigger, campaigns not involved', () => {
  assertEquals(ACTIVITY.sent_total, 73)
  assertEquals(ACTIVITY.failed_total, 1)
  const by = Object.fromEntries(ACTIVITY.by_trigger.map(t => [t.trigger_type, t.sent]))
  assertEquals(by, { abandoned_cart_1: 49, first_purchase: 9, coffee_checkin: 9, refill_reminder: 6, abandoned_cart_2: 0, first_purchase_invite: 0 })
  assertEquals(ACTIVITY.by_trigger[0].trigger_type, 'abandoned_cart_1')   // sorted by sends
  assertEquals(ACTIVITY.note, AUTOMATION_NOTE)
})

Deno.test('automation counts: every template appears, with its switch and last send', () => {
  const ac2 = ACTIVITY.by_trigger.find(t => t.trigger_type === 'abandoned_cart_2')!
  assertEquals([ac2.enabled, ac2.sent, ac2.last_sent_at], [false, 0, null])
  const ac1 = ACTIVITY.by_trigger.find(t => t.trigger_type === 'abandoned_cart_1')!
  assertEquals(ac1.last_sent_at, '2026-10-28T10:00:00Z')
  assertEquals(ac1.display_name, 'Abandoned cart 1')
})

Deno.test('automation counts: a trigger with sends but no template still counts', () => {
  const a = computeAutomationActivity([{ trigger_type: 'winback_x', status: 'sent', sent_at: '2026-11-01T00:00:00Z' }], [], 90)
  assertEquals(a.sent_total, 1)
  assertEquals([a.by_trigger[0].display_name, a.by_trigger[0].enabled], [null, null])
})

Deno.test('automation note is data: names the scope, offers no ideas', () => {
  assert(/only to new campaign \/ segment sends/.test(AUTOMATION_NOTE))
  assert(!/\b(?:try|consider|e\.g\.|for example|you could)\b/i.test(AUTOMATION_NOTE))
})

// ── dormancy claims ──────────────────────────────────────────────────────────

Deno.test('dormancy: the 2026-11-09 rationale is refused while automations send', () => {
  const p = emailDormancyProblems({ recommendations: [NOV9_REC] }, ACTIVITY)
  assertEquals(p.length, 1)
  assert(p[0].includes('sent 73 emails'))
  assert(p[0].includes('abandoned_cart_1 49'))
})

Deno.test('dormancy: phrasings that are caught', () => {
  for (const t of [
    'The email channel is completely dormant.',
    'Email has been inactive for a quarter.',
    'A dormant email channel is the cheapest lever.',
    'Zero sends in 90 days.',
    'No emails were sent this quarter.',
    'ערוץ המייל רדום לגמרי',
  ]) assertEquals(emailDormancyProblems({ diagnosis: [{ claim: t, evidence: 'x' }] }, ACTIVITY).length, 1, t)
})

Deno.test('dormancy: true campaign-only statements pass', () => {
  for (const t of [
    '0 campaign sends in 90 days; automations sent 73.',
    'Email campaigns are dormant: no one-off campaign since August.',
    'No email campaigns went out; abandoned_cart_1 sent 49.',
    'The dormant big_spender customers have not ordered in 120 days.',
  ]) assertEquals(emailDormancyProblems({ summary: t }, ACTIVITY), [], t)
})

Deno.test('dormancy: no check when automations sent nothing or the read failed', () => {
  const brief: BriefText = { recommendations: [NOV9_REC] }
  assertEquals(emailDormancyProblems(brief, computeAutomationActivity([], templates, 90)), [])
  assertEquals(emailDormancyProblems(brief, null), [])
})

// ── below-minimum workaround ─────────────────────────────────────────────────

Deno.test('below minimum: the 2026-11-09 manual-send rec is refused and a passing audience is asked for', () => {
  const p = belowMinimumSendProblems({ recommendations: [NOV9_REC] }, SEGMENTS, MIN)
  assertEquals(p.length, 1)
  assert(p[0].includes('big_spender (103 opted in)'))
  assert(p[0].includes('no segment reaches it this cycle'))   // all prod segments are < 200
  assert(p[0].endsWith('so drop the rec'))
})

Deno.test('below minimum: also refused as out_of_hands and as advice without "manual"', () => {
  assertEquals(belowMinimumSendProblems({ out_of_hands: [{ title: 'Winback email to champions', rationale: 'Erez sends it from Resend.' }] }, SEGMENTS, MIN).length, 1)
  assertEquals(belowMinimumSendProblems({ recommendations: [{ title: 'Email at_risk', rationale: 'a short email to at_risk', action_type: 'none' }] }, SEGMENTS, MIN).length, 1)
})

Deno.test('below minimum: manual segment send refused even with no segment named', () => {
  const p = belowMinimumSendProblems({ recommendations: [{ title: 'Send the 103 opted-in a winback email manually', rationale: '', action_type: 'none' }] }, SEGMENTS, MIN)
  assertEquals(p.length, 1)
  assert(p[0].includes('by hand'))
})

Deno.test('below minimum: a passing segment is named as the alternative', () => {
  const segs = [...SEGMENTS, { segment: 'lapsed_buyers', opted_in_reachable: 240 }]
  const p = belowMinimumSendProblems({ recommendations: [NOV9_REC] }, segs, MIN)
  assert(p[0].includes('lapsed_buyers (240)'))
})

Deno.test('below minimum: email_campaign recs are left to emailRecProblems; unrelated recs pass', () => {
  const brief: BriefText = {
    recommendations: [
      { title: 'Winback big_spender', rationale: '103 opted-in customers', action_type: 'email_campaign', action_params: { target_segment: 'big_spender' } },
      { title: 'Blog on V60 grind size', rationale: 'GSC rising', action_type: 'content_blog' },
      { title: 'Watch the abandoned_cart_1 automation', rationale: 'it sent 49 emails in 90 days; check its revenue next cycle', action_type: 'none' },
      { title: 'New roast story', rationale: '2 new roasts this week, email-free', action_type: 'content_ig' },
    ],
    diagnosis: [{ claim: 'big_spender has 103 opted-in to email', evidence: 'customer_segments' }],
  }
  assertEquals(belowMinimumSendProblems(brief, SEGMENTS, MIN), [])
})

Deno.test('below minimum: ambiguous segment names count only when written as a segment', () => {
  const ok = belowMinimumSendProblems({ recommendations: [{ title: 'Email about the new roast', rationale: 'to the whole list', action_type: 'none' }] }, SEGMENTS, MIN)
  assertEquals(ok, [])
  const bad = belowMinimumSendProblems({ recommendations: [{ title: "Email the 'new' segment", rationale: '', action_type: 'none' }] }, SEGMENTS, MIN)
  assertEquals(bad.length, 1)
})

// ── gate scoping: automations are never subject to the minimum ───────────────

Deno.test('gate scope: emailRecProblems checks only email_campaign, never automation recs', () => {
  const facts: SegmentFacts = {
    total_customers: 100, total_opted_in_reachable: 50, note: '',
    segments: [{ segment: 'big_spender', definition: 'd', total: 100, opted_in_reachable: 50, lapsed_90d_reachable: 40, bean_buyer_share: 1, median_days_since_last: 100 }],
  }
  const automationRecs = [
    { title: 'Keep first_purchase running', rationale: 'first_purchase sent 9 in 90 days', action_type: 'none' },
    { title: 'Refill reminder copy test', rationale: 'refill_reminder sent 6', action_type: 'none' },
  ]
  assertEquals(emailRecProblems(automationRecs, [facts], MIN), [])
  // and the same segment as a new campaign is still gated
  const p = emailRecProblems([{ title: 'big_spender 50 opted-in', action_type: 'email_campaign', action_params: { target_segment: 'big_spender', reachable_opted_in: 50 } }], [facts], MIN)
  assert(p.some(x => x.includes('below the minimum email audience')))
})

Deno.test('gate scope: pausing an automation for audience size is refused', () => {
  const triggers = ACTIVITY.by_trigger.map(t => t.trigger_type)
  for (const r of [
    { title: 'Pause the refill_reminder automation', rationale: 'its audience is below the 200 minimum', action_type: 'none' },
    { title: 'Disable coffee_checkin', rationale: 'too few reachable customers for an email', action_type: 'none' },
  ]) assertEquals(automationGateProblems({ recommendations: [r] }, MIN, triggers).length, 1, r.title)
  assertEquals(automationGateProblems({ out_of_hands: [{ title: 'Turn off the abandoned cart flow', rationale: 'below minimum reachable' }] }, MIN, triggers).length, 1)
})

Deno.test('gate scope: automation recs not about audience size pass', () => {
  const triggers = ACTIVITY.by_trigger.map(t => t.trigger_type)
  const brief: BriefText = { recommendations: [
    { title: 'Measure abandoned_cart_1 revenue', rationale: '49 sends in 90 days', action_type: 'none' },
    { title: 'Pause the Meta ad', rationale: 'CPA above target', action_type: 'none' },
    { title: 'Email champion segment', rationale: 'reaches 230 opted-in', action_type: 'email_campaign' },
  ] }
  assertEquals(automationGateProblems(brief, MIN, triggers), [])
})

// ── fetch path (fake PostgREST) ──────────────────────────────────────────────

Deno.test('fetchAutomationActivity: sent by sent_at, failed by created_at, templates listed', async () => {
  const calls: string[] = []
  const table: Record<string, Array<Record<string, unknown>>> = {
    email_automations: [...rows, { trigger_type: 'first_purchase', status: 'failed', sent_at: null }] as unknown as Array<Record<string, unknown>>,
    email_automation_templates: templates as unknown as Array<Record<string, unknown>>,
  }
  const db = { from(t: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { calls.push(`${t}.eq.${c}=${v}`); filters.push(r => r[c] === v); return q },
      gte: (c: string, _v: unknown) => { calls.push(`${t}.gte.${c}`); return q },
      order: () => q,
      range: (a: number, b: number) => Promise.resolve({ data: table[t].filter(r => filters.every(f => f(r))).slice(a, b + 1), error: null }),
    }
    return q
  } }
  const a = await fetchAutomationActivity(db, 90)
  assertEquals(a.sent_total, 73)
  assertEquals(a.failed_total, 2)
  assertEquals(a.by_trigger.length, 6)
  assert(calls.includes('email_automations.gte.sent_at') && calls.includes('email_automations.gte.created_at'))
})

Deno.test('fetchAutomationActivity: a read error throws (caller reports unknown, never 0)', async () => {
  const q = { select: () => q, eq: () => q, gte: () => q, order: () => q, range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
  let threw = false
  try { await fetchAutomationActivity({ from: () => q }, 90) } catch (e) { threw = String(e).includes('boom') }
  assert(threw)
})
