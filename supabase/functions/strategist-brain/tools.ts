// Minuto Strategist Brain — tool definitions + handlers.
//
// The brain's action space, kept OUT of the loop runner (index.ts) so the
// runner stays a thin ReAct driver and each tool is independently readable.
// Three families:
//   • drilldown_* — READ-ONLY investigation of tables the base snapshot
//     summarizes but doesn't fully expand. ReAct "act to investigate".
//   • record_thesis / emit_signal — WRITE to the brain's own memory + the
//     agent→team channel. No production side-effects.
//   • conclude_brief — WRITE the deliverable, link theses, end the run, email.
//
// Phase 1 is THINKING ONLY: nothing here publishes content, sends a campaign,
// or spends. Every tool touches only the strategist's own tables or reads.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { ToolDefinition } from '../seo-agent/claude.ts'
import type { BriefRecommendation } from '../seo-agent/types.ts'
import { appendChatMessage } from '../seo-agent/db.ts'
import { sendOwnerEmail, OWNER_EMAIL } from '../_shared/email.ts'

export type BrainToolDefinition = ToolDefinition

// Context every handler gets: which run is calling, the week it reasons about,
// and the dashboard URL for the email CTA.
export interface ToolContext {
  runId:        string
  weekStart:    string   // ISO date (Monday)
  workerId:     string
  dashboardUrl: string
}

const REVENUE_ORDER_STATUSES = ['completed', 'processing']

// ── Tool result shape ────────────────────────────────────────────────────────
// Handlers return a plain JS value; the runner JSON-stringifies it into the
// tool_result block. `concluded:true` tells the runner the loop is over.
export interface ToolOutcome {
  result:     unknown
  concluded?: boolean
  briefId?:   string
}

// ─────────────────────────────────────────────────────────────────────────────
// DRILLDOWNS (read-only)
// ─────────────────────────────────────────────────────────────────────────────

async function drilldownOrdersTimeseries(
  supabase: SupabaseClient,
  input: { window_days?: number },
): Promise<unknown> {
  const windowDays = Math.min(Math.max(input.window_days ?? 30, 7), 180)
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('woo_orders')
    .select('order_date, total, status')
    .gte('order_date', since)
    .in('status', REVENUE_ORDER_STATUSES)
    .limit(20000)
  if (error) return { error: error.message }
  const byDate = new Map<string, { revenue_ils: number; orders: number }>()
  for (const r of (data ?? []) as Array<{ order_date: string; total: number | null }>) {
    const d = r.order_date
    const a = byDate.get(d) ?? { revenue_ils: 0, orders: 0 }
    a.revenue_ils += Number(r.total ?? 0); a.orders++
    byDate.set(d, a)
  }
  const series = Array.from(byDate.entries())
    .map(([date, a]) => ({ date, revenue_ils: Math.round(a.revenue_ils), orders: a.orders }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return { window_days: windowDays, daily: series }
}

async function drilldownCategorySkus(
  supabase: SupabaseClient,
  input: { category: string; window_days?: number },
): Promise<unknown> {
  if (!input.category) return { error: 'category is required' }
  const windowDays = Math.min(Math.max(input.window_days ?? 30, 7), 180)
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('woo_order_items_enriched')
    .select('product_name, sku, quantity, line_total, order_date')
    .eq('product_category', input.category)
    .gte('order_date', since)
    .limit(20000)
  if (error) return { error: error.message }
  const bySku = new Map<string, { name: string; revenue_ils: number; units: number; orders: number }>()
  for (const r of (data ?? []) as Array<{ product_name: string | null; sku: string | null; quantity: number | null; line_total: number | null }>) {
    const key = r.sku || r.product_name || 'unknown'
    const a = bySku.get(key) ?? { name: r.product_name ?? key, revenue_ils: 0, units: 0, orders: 0 }
    a.revenue_ils += Number(r.line_total ?? 0); a.units += Number(r.quantity ?? 0); a.orders++
    bySku.set(key, a)
  }
  return {
    category: input.category,
    window_days: windowDays,
    skus: Array.from(bySku.entries())
      .map(([sku, a]) => ({ sku, name: a.name, revenue_ils: Math.round(a.revenue_ils), units: a.units, line_count: a.orders }))
      .sort((a, b) => b.revenue_ils - a.revenue_ils)
      .slice(0, 40),
  }
}

async function drilldownSegmentDetail(
  supabase: SupabaseClient,
  input: { segment: string },
): Promise<unknown> {
  if (!input.segment) return { error: 'segment is required' }
  const { data, error } = await supabase
    .from('customer_rfm')
    .select('total_spent_ils, order_count, days_since_last')
    .eq('segment', input.segment)
    .limit(10000)
  if (error) return { error: error.message }
  const rows = (data ?? []) as Array<{ total_spent_ils: number | null; order_count: number | null; days_since_last: number | null }>
  if (rows.length === 0) return { segment: input.segment, count: 0 }
  const spends = rows.map(r => Number(r.total_spent_ils ?? 0)).sort((a, b) => a - b)
  const orders = rows.map(r => Number(r.order_count ?? 0))
  const recency = rows.map(r => Number(r.days_since_last ?? 0))
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
  const median = (xs: number[]) => xs.length ? xs[Math.floor(xs.length / 2)] : 0
  return {
    segment: input.segment,
    count: rows.length,
    total_spent_ils: Math.round(sum(spends)),
    median_spent_ils: Math.round(median(spends)),
    avg_order_count: Math.round((sum(orders) / rows.length) * 10) / 10,
    median_days_since_last: median([...recency].sort((a, b) => a - b)),
    repeat_buyer_share: Math.round((orders.filter(o => o > 1).length / rows.length) * 100) / 100,
  }
}

async function drilldownEmailCampaign(
  supabase: SupabaseClient,
  input: { subject_contains?: string; campaign_id?: number },
): Promise<unknown> {
  let campaignId = input.campaign_id
  let subject: string | null = null
  if (!campaignId && input.subject_contains) {
    const { data: c, error: cErr } = await supabase
      .from('campaigns')
      .select('id, subject')
      .ilike('subject', `%${input.subject_contains}%`)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
    if (cErr) return { error: cErr.message }
    if (!c || c.length === 0) return { error: `no sent campaign matching "${input.subject_contains}"` }
    campaignId = (c[0] as { id: number }).id
    subject = (c[0] as { subject: string | null }).subject
  }
  if (!campaignId) return { error: 'campaign_id or subject_contains is required' }
  const { data, error } = await supabase
    .from('campaign_events')
    .select('event_type')
    .eq('campaign_id', campaignId)
    .limit(50000)
  if (error) return { error: error.message }
  const counts: Record<string, number> = {}
  for (const r of (data ?? []) as Array<{ event_type: string }>) {
    counts[r.event_type] = (counts[r.event_type] ?? 0) + 1
  }
  return { campaign_id: campaignId, subject, event_counts: counts }
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY WRITES
// ─────────────────────────────────────────────────────────────────────────────

async function handleRecordThesis(
  supabase: SupabaseClient,
  ctx: ToolContext,
  input: {
    thesis: string
    lever: string
    rationale?: string
    success_metric: string
    metric_baseline?: number
    check_date?: string
    evidence_snapshot?: Record<string, unknown>
  },
): Promise<unknown> {
  if (!input.thesis || !input.lever || !input.success_metric) {
    return { error: 'thesis, lever, and success_metric are required' }
  }
  const { data, error } = await supabase
    .from('strategic_theses')
    .insert({
      thesis:            input.thesis,
      lever:             input.lever,
      rationale:         input.rationale ?? null,
      success_metric:    input.success_metric,
      metric_baseline:   input.metric_baseline ?? null,
      check_date:        input.check_date ?? null,
      evidence_snapshot: input.evidence_snapshot ?? {},
      run_id:            ctx.runId,
    })
    .select('id')
    .single()
  if (error) return { error: error.message }
  return { recorded: true, thesis_id: (data as { id: string }).id }
}

async function handleEmitSignal(
  supabase: SupabaseClient,
  ctx: ToolContext,
  input: {
    kind: 'capability_request' | 'bug_report' | 'feature_idea'
    title: string
    detail?: string
    evidence?: Record<string, unknown>
    blocked_decision?: string
    leverage?: string
    dedupe_key: string
  },
): Promise<unknown> {
  if (!input.kind || !input.title || !input.dedupe_key) {
    return { error: 'kind, title, and dedupe_key are required' }
  }
  // Dedupe: never re-raise a signal already on file (open OR declined — a decline
  // is an answer, re-asking is noise). The brain is shown declines in its prompt.
  const { data: existing } = await supabase
    .from('strategist_signals')
    .select('id, status')
    .eq('dedupe_key', input.dedupe_key)
    .limit(1)
  if (existing && existing.length > 0) {
    const e = existing[0] as { id: string; status: string }
    return { recorded: false, reason: `duplicate of existing signal (status=${e.status})`, signal_id: e.id }
  }
  const { data, error } = await supabase
    .from('strategist_signals')
    .insert({
      kind:             input.kind,
      title:            input.title,
      detail:           input.detail ?? null,
      evidence:         input.evidence ?? {},
      blocked_decision: input.blocked_decision ?? null,
      leverage:         input.leverage ?? null,
      dedupe_key:       input.dedupe_key,
      run_id:           ctx.runId,
    })
    .select('id')
    .single()
  if (error) return { error: error.message }
  return { recorded: true, signal_id: (data as { id: string }).id }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCLUDE — write the brief, link this run's theses, email the owner.
// ─────────────────────────────────────────────────────────────────────────────

interface DiagnosisItem { claim: string; evidence: string }
interface OutOfHandsItem { title: string; rationale: string }

async function handleConcludeBrief(
  supabase: SupabaseClient,
  ctx: ToolContext,
  input: {
    summary: string
    diagnosis: DiagnosisItem[]
    top_thesis?: string
    recommendations?: BriefRecommendation[]
    out_of_hands?: OutOfHandsItem[]
  },
): Promise<ToolOutcome> {
  if (!input.summary || !Array.isArray(input.diagnosis)) {
    return { result: { error: 'summary and diagnosis[] are required' } }
  }
  const { data: brief, error } = await supabase
    .from('strategic_briefs')
    .insert({
      run_id:          ctx.runId,
      week_start:      ctx.weekStart,
      summary:         input.summary,
      diagnosis:       input.diagnosis ?? [],
      top_thesis:      input.top_thesis ?? null,
      recommendations: input.recommendations ?? [],
      out_of_hands:    input.out_of_hands ?? [],
      status:          'draft',
    })
    .select('id')
    .single()
  if (error) return { result: { error: `conclude_brief insert failed: ${error.message}` } }
  const briefId = (brief as { id: string }).id

  // Promote recommendations into the execution ledger (Phase 2): each becomes a
  // strategic_recommendations row the human approves in the dashboard → the
  // executor drafts it (content task / email draft), never sends. Best-effort —
  // a brief that's already persisted must not unwind if this insert hiccups.
  const recs = input.recommendations ?? []
  if (recs.length > 0) {
    const rows = recs.map(r => ({
      brief_id:       briefId,
      run_id:         ctx.runId,
      title:          r.title,
      rationale:      r.rationale ?? null,
      action_type:    r.action_type ?? 'none',
      action_params:  r.action_params ?? {},
      success_metric: r.success_metric ?? {},
      status:         'proposed',
    }))
    const { error: recErr } = await supabase.from('strategic_recommendations').insert(rows)
    if (recErr) console.warn(`[strategist] recommendation rows insert failed (non-fatal): ${recErr.message}`)
  }

  // Email the owner + log a chat briefing. Both best-effort — a notification
  // failure must not unwind a brief that's already persisted.
  const emailStatus = await sendOwnerEmail({
    subject: `🧭 State of Minuto — week of ${ctx.weekStart}`,
    html: renderBriefHtml(input, ctx.dashboardUrl),
  }).catch(e => `error: ${e instanceof Error ? e.message : String(e)}`)

  // Flip status to emailed only if the email actually went out.
  if (emailStatus.startsWith('sent')) {
    await supabase.from('strategic_briefs').update({ status: 'emailed' }).eq('id', briefId)
  }

  try {
    await appendChatMessage(supabase, {
      session_id: 'strategist-brain',
      role: 'assistant',
      content: `**State of Minuto — week of ${ctx.weekStart}**\n\n${input.summary}` +
        (input.top_thesis ? `\n\n**Top thesis:** ${input.top_thesis}` : ''),
      metadata: { brief_id: briefId, run_id: ctx.runId, kind: 'strategic_brief' },
    })
  } catch { /* chat log is non-critical */ }

  return { result: { brief_id: briefId, email: emailStatus, status: 'brief written' }, concluded: true, briefId }
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderBriefHtml(
  b: { summary: string; diagnosis: DiagnosisItem[]; top_thesis?: string; recommendations?: BriefRecommendation[]; out_of_hands?: OutOfHandsItem[] },
  dashboardUrl: string,
): string {
  const diag = (b.diagnosis ?? [])
    .map(d => `<li style="margin:0 0 8px"><span style="color:#111827">${esc(d.claim)}</span><br><span style="color:#6b7280;font-size:13px">${esc(d.evidence)}</span></li>`)
    .join('')
  const recs = (b.recommendations ?? [])
    .map(r => {
      const tag = r.action_type && r.action_type !== 'none' ? ` <span style="font-size:11px;color:#6A7D45">[${esc(r.action_type)}]</span>` : ''
      const measure = r.success_metric?.metric ? `<br><span style="color:#6b7280;font-size:13px">Measure: ${esc(r.success_metric.metric)}</span>` : ''
      return `<li style="margin:0 0 8px"><b style="color:#111827">${esc(r.title)}</b>${tag} — <span style="color:#374151">${esc(r.rationale)}</span>${measure}</li>`
    })
    .join('')
  const ooh = (b.out_of_hands ?? [])
    .map(r => `<li style="margin:0 0 8px"><b style="color:#111827">${esc(r.title)}</b> — <span style="color:#374151">${esc(r.rationale)}</span></li>`)
    .join('')
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111827">
    <h2 style="margin:0 0 4px">🧭 State of Minuto</h2>
    <p style="color:#6b7280;margin:0 0 16px">${esc(b.summary)}</p>
    ${b.top_thesis ? `<div style="padding:10px 14px;background:#f0f7e8;border:1px solid #cfe0b4;border-radius:8px;margin:0 0 16px"><b>Top bet this cycle:</b> ${esc(b.top_thesis)}</div>` : ''}
    ${diag ? `<h3 style="margin:16px 0 6px;font-size:15px">What the numbers say</h3><ul style="padding-left:18px;margin:0">${diag}</ul>` : ''}
    ${recs ? `<h3 style="margin:16px 0 6px;font-size:15px">Recommended (for your approval)</h3><ul style="padding-left:18px;margin:0">${recs}</ul>` : ''}
    ${ooh ? `<h3 style="margin:16px 0 6px;font-size:15px">For you to weigh (outside the agent's hands)</h3><ul style="padding-left:18px;margin:0">${ooh}</ul>` : ''}
    <p style="margin-top:20px"><a href="${dashboardUrl}/admin/seo-agent" style="display:inline-block;background:#6A7D45;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Open the full brief →</a></p>
    <p style="color:#9ca3af;font-size:12px;margin-top:16px">Thinking only — nothing here is published or spent without your approval. — strategist-brain</p>
  </div>`
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY + DISPATCH
// ─────────────────────────────────────────────────────────────────────────────

export const BRAIN_TOOLS: BrainToolDefinition[] = [
  {
    name: 'drilldown_orders_timeseries',
    description: 'Daily revenue + order count over a window (default 30d, max 180), so you can see WHERE in the window sales moved rather than just a total. Revenue orders only (completed/processing).',
    input_schema: { type: 'object', properties: { window_days: { type: 'number', description: 'lookback in days (7–180)' } } },
  },
  {
    name: 'drilldown_category_skus',
    description: 'SKU-level revenue/units for ONE product category (coffee|machine|grinder|accessory|other) over a window. Use when a category-level number in the snapshot needs you to see which products drive it.',
    input_schema: { type: 'object', properties: { category: { type: 'string' }, window_days: { type: 'number' } }, required: ['category'] },
  },
  {
    name: 'drilldown_segment_detail',
    description: 'Aggregated profile of ONE customer RFM segment (count, spend distribution, recency, repeat-buyer share). Aggregated only — no individual customer data.',
    input_schema: { type: 'object', properties: { segment: { type: 'string' } }, required: ['segment'] },
  },
  {
    name: 'drilldown_email_campaign',
    description: 'Raw event breakdown (sent/delivered/opened/clicked/bounced) for one sent email campaign, found by campaign_id or a subject substring. Use to confirm whether a campaign\'s rollup counts are real vs a stale-zero sync gap.',
    input_schema: { type: 'object', properties: { campaign_id: { type: 'number' }, subject_contains: { type: 'string' } } },
  },
  {
    name: 'record_thesis',
    description: 'Record a durable, revenue-graded belief about what moves Minuto (your long-term memory). Must name a falsifiable success_metric, its baseline now, and a check_date when reality will judge it. Do not duplicate a thesis you already hold.',
    input_schema: {
      type: 'object',
      properties: {
        thesis: { type: 'string' },
        lever: { type: 'string', description: 'reach|retention|aov|reactivation|conversion|... (your call)' },
        rationale: { type: 'string' },
        success_metric: { type: 'string', description: 'the measurable proxy this will be judged on' },
        metric_baseline: { type: 'number', description: 'the metric\'s value right now' },
        check_date: { type: 'string', description: 'ISO date to score it against revenue' },
        evidence_snapshot: { type: 'object', description: 'the cited data slice supporting it' },
      },
      required: ['thesis', 'lever', 'success_metric'],
    },
  },
  {
    name: 'emit_signal',
    description: 'Tell Erez you need a capability, found a bug, or have a feature idea. EVIDENCE-GATED: each must point to a concrete blocked decision or a confirmed anomaly with data attached — not a wishlist. Choose a stable dedupe_key so you never re-raise the same thing.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['capability_request', 'bug_report', 'feature_idea'] },
        title: { type: 'string' },
        detail: { type: 'string' },
        evidence: { type: 'object' },
        blocked_decision: { type: 'string', description: 'the exact decision this gates (capability_request)' },
        leverage: { type: 'string', description: 'rough expected payoff if addressed' },
        dedupe_key: { type: 'string', description: 'stable slug; re-emitting the same key is ignored' },
      },
      required: ['kind', 'title', 'dedupe_key'],
    },
  },
  {
    name: 'conclude_brief',
    description: 'End the cycle and write the "State of Minuto" brief. Call EXACTLY ONCE, only after your adversarial self-check. diagnosis must be cited (claim + evidence). recommendations are in-hands moves that get DRAFTED (never sent/published) on your approval; out_of_hands need Erez. Concluding with little or nothing to do is valid if the data supports it.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        diagnosis: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, evidence: { type: 'string' } }, required: ['claim', 'evidence'] } },
        top_thesis: { type: 'string' },
        recommendations: {
          type: 'array',
          description: 'In-hands moves. Each must name how it will be DRAFTED (action_type) and how it will be MEASURED (success_metric). Use action_type "none" for advice with no draftable artifact.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              rationale: { type: 'string' },
              action_type: { type: 'string', enum: ['email_campaign', 'content_blog', 'content_ig', 'none'], description: 'what the executor will draft: an email-campaign draft, a blog draft, an IG draft, or none (pure advice)' },
              action_params: { type: 'object', description: 'draft inputs. email_campaign: {target_segment, angle, products[], subject_he}. content_blog: {keyword|topic, key_points[], why_now}. content_ig: {caption_he, hashtags[], media_type(feed_image|story), scene_brief, render_mode(bag_hero+product_name|no_bag), aspect(feed_square|story)}' },
              success_metric: {
                type: 'object',
                description: 'ATTRIBUTABLE: prefer a revenue / repeat-purchase proxy over a noisy segment-count. Name the data source and a baseline value now.',
                properties: {
                  metric:     { type: 'string', description: 'what is measured' },
                  source:     { type: 'string', description: 'the table/query it comes from' },
                  baseline:   { type: 'string', description: 'its value right now' },
                  check_date: { type: 'string', description: 'ISO date to evaluate it' },
                },
                required: ['metric', 'source', 'baseline', 'check_date'],
              },
            },
            required: ['title', 'rationale', 'action_type', 'success_metric'],
          },
        },
        out_of_hands: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, rationale: { type: 'string' } }, required: ['title', 'rationale'] } },
      },
      required: ['summary', 'diagnosis'],
    },
  },
]

/** Dispatch a tool_use to its handler. Returns the outcome (and `concluded`
 *  when conclude_brief ran). Never throws — a handler error becomes an
 *  { error } result the brain can read and react to. */
export async function dispatchTool(
  supabase: SupabaseClient,
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'drilldown_orders_timeseries': return { result: await drilldownOrdersTimeseries(supabase, input as { window_days?: number }) }
      case 'drilldown_category_skus':     return { result: await drilldownCategorySkus(supabase, input as { category: string; window_days?: number }) }
      case 'drilldown_segment_detail':    return { result: await drilldownSegmentDetail(supabase, input as { segment: string }) }
      case 'drilldown_email_campaign':    return { result: await drilldownEmailCampaign(supabase, input as { subject_contains?: string; campaign_id?: number }) }
      case 'record_thesis':               return { result: await handleRecordThesis(supabase, ctx, input as Parameters<typeof handleRecordThesis>[2]) }
      case 'emit_signal':                 return { result: await handleEmitSignal(supabase, ctx, input as Parameters<typeof handleEmitSignal>[2]) }
      case 'conclude_brief':              return await handleConcludeBrief(supabase, ctx, input as Parameters<typeof handleConcludeBrief>[2])
      default:                            return { result: { error: `unknown tool: ${name}` } }
    }
  } catch (e) {
    return { result: { error: `${name} threw: ${e instanceof Error ? e.message : String(e)}` } }
  }
}

export { OWNER_EMAIL }
