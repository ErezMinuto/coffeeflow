// Customer RFM segments as facts: what each segment IS (how rfm-sync assigns
// it), how big it is, and how many of its customers can actually be emailed.
//
// Read by the strategist brain (snapshot + drilldown_segment_detail), checked
// against every email_campaign recommendation in conclude_brief, and handed to
// the draft critic. Data only: no advice about which segment to target.
//
// 2026-11-04: the brain proposed a winback to "791 big_spender customers who
// bought equipment but haven't reordered beans". big_spender is scored on Minuto
// bean grams (all 793 had beans) and only 104 were opted in. Both errors are
// what this module exists to catch.

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

/** Plain definitions of rfm-sync's assignSegment() rules (supabase/functions/
 *  rfm-sync/index.ts). Keep in step with that function: rules apply in this
 *  order and the first match wins. */
export const SEGMENT_DEFINITIONS: Record<string, string> = {
  champion:    'R>=4, F>=4 and M>=4: ordered recently, orders often, and is in the top bean-volume tiers.',
  loyal:       'F>=4 and R>=3 (and not champion): orders often and has ordered fairly recently.',
  big_spender: 'M>=4 and F<=3 (and not champion or loyal): top tiers by lifetime Minuto bean grams, with fewer orders. M is bean grams, not shekels and not equipment.',
  at_risk:     'R<=2 and F>=3 (and none of the above): ordered repeatedly in the past, not recently.',
  new:         'R>=4 and F=1 (and none of the above): one order, in the most recent recency tiers.',
  lost:        'Last order 180+ days ago and none of the above.',
  regular:     'Everything that matches none of the rules above.',
}

export const SCORE_NOTE =
  'Scores are quintiles 1-5 across every web customer since 2023 (5 = best). R = recency of the last order, ' +
  'F = number of orders, M = lifetime grams of Minuto-roasted beans (resold brands and green coffee excluded). ' +
  'Ties share a score, so a tier can hold more or less than a fifth of customers. ' +
  'opted_in_reachable = customers whose email is opted in in marketing_contacts: the only people an email can reach.'

export const LAPSED_DAYS = 90

export interface SegmentFact {
  segment:                string
  definition:             string
  total:                  number   // non-superseded customer_rfm rows
  opted_in_reachable:     number | null   // of those, email opted in (marketing_contacts); null = opt-in data unavailable
  lapsed_90d_reachable:   number | null   // opted in AND days_since_last > 90
  bean_buyer_share:       number   // share with bean_grams > 0 (0..1, 2 dp)
  median_days_since_last: number
}

export interface SegmentFacts {
  total_customers:          number
  total_opted_in_reachable: number | null
  segments:                 SegmentFact[]
  note:                     string
}

export interface RfmFactRow {
  email:           string | null
  segment:         string | null
  days_since_last: number | null
  bean_grams:      number | null
}

export const normEmail = (e: string | null | undefined) => (e ?? '').trim().toLowerCase()

/** Pure: roll customer_rfm rows + the opted-in email set into per-segment facts.
 *  optedIn null = the opt-in read failed: reach is unknown (null), never 0. */
export function computeSegmentFacts(rows: RfmFactRow[], optedIn: Set<string> | null): SegmentFacts {
  const by = new Map<string, { total: number; reach: number; lapsed: number; beans: number; days: number[] }>()
  let reachAll = 0
  let total = 0
  for (const r of rows) {
    if (r.segment === 'superseded') continue
    total++
    const seg = r.segment ?? 'unknown'
    const a = by.get(seg) ?? { total: 0, reach: 0, lapsed: 0, beans: 0, days: [] }
    a.total++
    const days = Number(r.days_since_last ?? 0)
    a.days.push(days)
    if (Number(r.bean_grams ?? 0) > 0) a.beans++
    if (optedIn?.has(normEmail(r.email))) {
      a.reach++
      reachAll++
      if (days > LAPSED_DAYS) a.lapsed++
    }
    by.set(seg, a)
  }
  const segments = [...by.entries()].map(([segment, a]) => {
    const days = [...a.days].sort((x, y) => x - y)
    return {
      segment,
      definition:             SEGMENT_DEFINITIONS[segment] ?? 'not a segment rfm-sync assigns',
      total:                  a.total,
      opted_in_reachable:     optedIn ? a.reach : null,
      lapsed_90d_reachable:   optedIn ? a.lapsed : null,
      bean_buyer_share:       a.total ? Math.round((a.beans / a.total) * 100) / 100 : 0,
      median_days_since_last: days.length ? days[Math.floor(days.length / 2)] : 0,
    }
  }).sort((x, y) => y.total - x.total)
  return {
    total_customers: total, total_opted_in_reachable: optedIn ? reachAll : null, segments,
    note: optedIn ? SCORE_NOTE : `${SCORE_NOTE} OPT-IN DATA UNAVAILABLE this read: reachable counts are unknown, not zero.`,
  }
}

/** Every opted-in address in marketing_contacts, normalised. Paged. */
export async function fetchOptedInEmails(db: Db): Promise<Set<string>> {
  const set = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('marketing_contacts').select('email').eq('opted_in', true).order('email').range(from, from + 999)
    if (error) throw new Error(`marketing_contacts read failed: ${error.message}`)
    const rows = (data ?? []) as Array<{ email: string | null }>
    for (const r of rows) set.add(normEmail(r.email))
    if (rows.length < 1000) break
  }
  return set
}

export async function fetchRfmFactRows(db: Db, segment?: string): Promise<RfmFactRow[]> {
  const rows: RfmFactRow[] = []
  for (let from = 0; ; from += 1000) {
    let q = db.from('customer_rfm').select('email, segment, days_since_last, bean_grams')
    q = segment ? q.eq('segment', segment) : q.neq('segment', 'superseded')
    const { data, error } = await q.order('email').range(from, from + 999)
    if (error) throw new Error(`customer_rfm read failed: ${error.message}`)
    rows.push(...((data ?? []) as RfmFactRow[]))
    if (!data || data.length < 1000) break
  }
  return rows
}

export async function fetchSegmentFacts(db: Db): Promise<SegmentFacts> {
  const [rows, optedIn] = await Promise.all([fetchRfmFactRows(db), fetchOptedInEmails(db)])
  return computeSegmentFacts(rows, optedIn)
}

// ── email_campaign recommendation check (conclude_brief) ─────────────────────

// A count of people: a number followed (within three words) by a people noun or
// a segment name. "791 big_spender customers", "104 opted-in contacts".
// Segment names that are also ordinary words (new, lost, regular) are left out:
// "2 new roasts" is not a head count. Words between the number and the noun
// may not be time units or prepositions: "2 weeks after the customers" is not.
const PEOPLE_NOUN = String.raw`(?:customers?|contacts?|recipients?|subscribers?|people|buyers?|shoppers?|champions?|big[_ -]?spenders?|לקוחות|נמענים|מנויים)`
const FILLER = String.raw`(?:(?!(?:days?|weeks?|months?|years?|orders?|bags?|times?|of|after|before|since|per|in|from|than|ago)(?![A-Za-z]))[^\s\d]+\s+)`
const PEOPLE_COUNT = new RegExp(String.raw`(?<![\d.,₪$%])(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,%])\s+${FILLER}{0,2}?${PEOPLE_NOUN}(?![A-Za-z])`, 'gi')

// Claims that the audience bought equipment and no beans.
const NO_BEANS_CLAIM = new RegExp([
  String.raw`(?:bought|purchased|buyers? of|own(?:s|ers? of)?)\s+(?:an?\s+|the\s+)?(?:equipment|(?:espresso\s+)?machines?|grinders?|hardware)`,
  String.raw`equipment[- ]only|hardware[- ]only`,
  String.raw`(?:haven'?t|have not|hasn'?t|has not|never|did not|didn'?t|not yet|without)\s+(?:yet\s+)?(?:re-?)?(?:order(?:ed)?|bought|buy(?:ing)?|purchas(?:e|ed|ing))\s+(?:any\s+)?(?:beans|coffee)`,
  String.raw`\bno\s+beans?\b|\bnon[- ]bean\b`,
].join('|'), 'i')

export function peopleCounts(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(PEOPLE_COUNT)) out.push(Number(m[1].replace(/,/g, '')))
  return out
}

interface EmailRecLike { title?: string; rationale?: string; action_type?: string; action_params?: Record<string, unknown> }

/** Problems with the email_campaign recommendations, checked against one or
 *  more fact sets (the run's snapshot and a fresh read: rfm-sync may have run
 *  in between, and a number taken from either is a number taken from the data).
 *  Empty = every email rec is sized and described by the data.
 *  Only action_type email_campaign (a new campaign / segment send) is checked:
 *  automations are never subject to minReachable. Recs that route a small
 *  segment around this gate are caught by belowMinimumSendProblems
 *  (email_activity.ts). */
export function emailRecProblems(recs: EmailRecLike[], factSets: SegmentFacts[], minReachable: number): string[] {
  const problems: string[] = []
  // A set without opt-in counts cannot size an email.
  const sets = factSets.filter(s => s && Array.isArray(s.segments) && s.segments.length && s.segments.every(f => typeof f.opted_in_reachable === 'number'))
  if (!sets.length) {
    return recs.some(r => r.action_type === 'email_campaign')
      ? ['segment data is unavailable, so no email_campaign can be sized; drop email_campaign recommendations this cycle or make them action_type "none"']
      : []
  }
  const known = [...new Set(sets.flatMap(s => s.segments.map(f => f.segment)))]
  // Any count the data holds is a fair number to cite (rationales compare segments).
  const allowed = new Set<number>(sets.flatMap(s => [
    s.total_customers, s.total_opted_in_reachable,
    ...s.segments.flatMap(f => [f.total, f.opted_in_reachable, f.lapsed_90d_reachable]),
  ]).filter((n): n is number => typeof n === 'number'))
  for (const [i, r] of recs.entries()) {
    if (r.action_type !== 'email_campaign') continue
    const at = `recommendations[${i}] "${r.title ?? ''}"`
    const p = r.action_params ?? {}
    const seg = typeof p.target_segment === 'string' ? p.target_segment.trim() : ''
    const facts = sets.map(s => s.segments.find(f => f.segment === seg)).filter((f): f is SegmentFact => !!f)
    if (!seg || !facts.length) {
      problems.push(`${at}: action_params.target_segment must be one of ${known.join(', ')} (got "${seg}")`)
      continue
    }
    const f = facts[facts.length - 1] as SegmentFact & { opted_in_reachable: number; lapsed_90d_reachable: number }   // the freshest set is passed last
    const stated = Number(p.reachable_opted_in)
    if (!Number.isFinite(stated) || !facts.some(x => x.opted_in_reachable === stated)) {
      problems.push(`${at}: action_params.reachable_opted_in must be the segment's opted_in_reachable from the data, ${f.opted_in_reachable} for ${seg} (got ${p.reachable_opted_in ?? 'nothing'})`)
    }
    if (f.opted_in_reachable < minReachable) {
      problems.push(`${at}: ${seg} has ${f.opted_in_reachable} opted-in reachable customers, below the minimum email audience of ${minReachable} (ops_profile.strategist_loop.min_email_reachable)`)
    }
    const text = [r.title, r.rationale, p.angle, p.subject_he].filter(x => typeof x === 'string').join('\n')
    if (!facts.some(x => new RegExp(String.raw`(?<![\d,])${x.opted_in_reachable}(?![\d,])`).test(text))) {
      problems.push(`${at}: the title or rationale must state the reachable audience, ${f.opted_in_reachable} opted-in customers`)
    }
    const bad = peopleCounts(text).filter(n => !allowed.has(n))
    if (bad.length) {
      problems.push(`${at}: customer count(s) ${bad.join(', ')} are not in the segment data. ${seg}: total ${f.total}, opted_in_reachable ${f.opted_in_reachable}, lapsed_90d_reachable ${f.lapsed_90d_reachable}`)
    }
    if (f.bean_buyer_share >= 0.9 && NO_BEANS_CLAIM.test(text)) {
      problems.push(`${at}: describes the audience as equipment buyers or non-bean buyers, but ${Math.round(f.bean_buyer_share * 100)}% of ${seg} bought Minuto beans. ${seg} = ${f.definition}`)
    }
  }
  return problems
}

/** The facts block the draft critic gets for an email draft. */
export function audienceFactsBlock(facts: SegmentFacts, segment: string): string {
  const f = facts.segments.find(x => x.segment === segment)
  if (f && f.opted_in_reachable == null) {
    return `=== AUDIENCE FACTS ===\nOpt-in data could not be read, so the reachable audience is unknown. Raise a high issue "audience_unverified".`
  }
  if (!f) {
    return `=== AUDIENCE FACTS ===\nThe brief's target_segment "${segment}" is not a current RFM segment (${facts.segments.map(x => x.segment).join(', ')}). Raise a critical issue "audience_unknown".`
  }
  return [
    '=== AUDIENCE FACTS (the only allowed source for who the audience is) ===',
    `Segment: ${f.segment}`,
    `Definition: ${f.definition}`,
    SCORE_NOTE,
    `Total customers in segment: ${f.total}`,
    `Opted in, so reachable by this email: ${f.opted_in_reachable}`,
    `Opted in and last order more than ${LAPSED_DAYS} days ago: ${f.lapsed_90d_reachable}`,
    `Share who bought Minuto beans: ${Math.round(f.bean_buyer_share * 100)}%`,
    `Median days since last order: ${f.median_days_since_last}`,
  ].join('\n')
}
