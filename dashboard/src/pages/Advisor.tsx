import React, { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/context'
import { TrendingUp, Shield, Leaf, RefreshCw, AlertCircle, Loader2, Copy, Check, ChevronDown, ChevronUp, XCircle, Zap } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdvisorReport {
  id: string
  agent_type: 'google_ads_growth' | 'google_ads_efficiency' | 'organic_content'
  week_start: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  report: GrowthReport | EfficiencyReport | OrganicReport | null
  error_msg: string | null
  model: string | null
  tokens_used: number
}

interface GoogleKPIs {
  total_cost: number
  total_clicks: number
  total_impressions: number
  total_conversions: number
  roas: number
  top_campaign: string
  worst_campaign: string
}

interface BudgetRec {
  platform: string
  campaign: string
  action: 'increase' | 'decrease' | 'pause' | 'keep' | 'test_new'
  reason: string
  suggested_budget_change_pct: number
}

interface CampaignToCreate {
  campaign_name: string
  campaign_type: string
  target_audience: string
  keywords: string[]
  negative_keywords?: string[]
  headlines: string[]
  descriptions: string[]
  daily_budget_ils: number
  rationale: string
  landing_page_url?: string
  creation_steps?: string[]
}

interface CopyFix {
  original: string
  problem: string
  replacement: string
}

interface AdToRewrite {
  campaign: string
  ad_strength: string
  headline_fixes: CopyFix[]
  description_fixes: CopyFix[]
  expected_improvement: string
  creation_steps?: string[]
}

interface PostToPublish {
  type: string
  intent?: 'save' | 'share' | 'behind_the_scenes' | string
  topic: string
  best_day: string
  best_time: string
  caption: string
  hashtags: string[]
  hook: string
  visual_direction: string
  why_this_intent?: string
}

interface GrowthReport {
  agent_philosophy: string
  summary: string
  google: GoogleKPIs | null
  growth_opportunities: { opportunity: string; action: string; expected_impact: string }[]
  market_insights?: { insight: string; relevance: string; action: string }[]
  campaigns_to_create: CampaignToCreate[]
  key_insights: string[]
  next_week_focus: string
}

interface EfficiencyReport {
  agent_philosophy: string
  summary: string
  google: GoogleKPIs | null
  budget_recommendations: BudgetRec[]
  waste_identified: { campaign: string; issue: string; estimated_waste: string; fix: string; negative_keywords?: string[] }[]
  negative_keywords_to_add?: { campaign: string; keywords: string[]; reason: string }[]
  ads_to_rewrite: AdToRewrite[]
  key_insights: string[]
  next_week_focus: string
}

interface GoogleOrganicRec {
  keyword: string
  current_position: number
  search_volume_signal: string
  content_type: 'blog_post' | 'landing_page' | 'product_page' | 'faq_page'
  suggested_title: string
  key_points: string[]
  why_now: string
  estimated_difficulty: 'קל' | 'בינוני' | 'קשה'
}

interface BlogPost {
  title: string
  meta_description: string
  slug: string
  body: string
  banner_url?: string | null
}

interface OrganicReport {
  summary: string
  account_health: { avg_reach_30d: number; follower_count: number; best_post_type: string; engagement_rate_pct: number }
  google_organic_recommendations: GoogleOrganicRec[]
  content_recommendations: { priority: number; content_type: string; topic: string; reason: string; best_day: string; best_time: string }[]
  products_to_feature: { product: string; reason: string; content_angle: string }[]
  posts_to_publish: PostToPublish[]
  key_insights: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatWeek(weekStart: string) {
  const d = new Date(weekStart)
  const end = new Date(weekStart)
  end.setDate(end.getDate() + 6)
  const fmt = (date: Date) => `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}`
  return `${fmt(d)} – ${fmt(end)}`
}

function actionColor(action: string) {
  switch (action) {
    case 'increase':  return 'border-green-400 bg-green-50'
    case 'test_new':  return 'border-blue-400 bg-blue-50'
    case 'decrease':  return 'border-amber-400 bg-amber-50'
    case 'pause':     return 'border-red-400 bg-red-50'
    default:          return 'border-surface-200 bg-surface-50'
  }
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    increase: '↑ הגדל', decrease: '↓ הקטן',
    pause: '⏸ השהה', keep: '→ המשך', test_new: '🧪 בדוק',
  }
  return map[action] ?? action
}

function contentTypeIcon(type: string) {
  return ({ reel: '🎬', post: '🖼️', story: '⏱' } as Record<string, string>)[type] ?? '📌'
}

// ── Triage action queue ──────────────────────────────────────────────────────
//
// The 3 panels together produce ~30 recommendations (budget changes, waste
// alerts, ad copy rewrites, content ideas, SEO targets, etc). Users can't
// start at "bullet #1 of 30" — they need a ranked shortlist of the things
// that will actually move the needle THIS WEEK. This module builds that
// shortlist across all 3 reports and tracks which items the user has
// marked as done / skipped / snoozed in localStorage keyed to the week.
//
// No backend changes. No `advisor_actions` table yet. Frontend-only ranking
// using deterministic rules — later we can promote this to server-side
// ranking with cross-week memory, but v1 is purely a UX layer on top of
// the data we already have.
//
// (AgentType is declared lower down near the main component — we hoist the
// tuple-derived version so the whole file shares one definition.)

interface TriageAction {
  id:            string   // stable hash so localStorage state survives a re-run
  agent:         AgentType
  priority:      number   // higher = more urgent, used for sort
  headline:      string   // the one-sentence action
  context?:      string   // optional secondary line (reason / expected impact)
  sourceLabel?:  string   // optional small tag (campaign name, estimated waste, etc)
}

type ActionState = 'done' | 'skipped' | 'snoozed' | null

// Deterministic rules for ranking across the 3 reports. Priority scores
// are intentionally coarse (buckets of 10) so the ordering is stable and
// the top N ends up covering all 3 agents rather than being dominated by
// whichever one happens to produce the most items.
function buildTriageQueue(
  growth:     AdvisorReport | null,
  efficiency: AdvisorReport | null,
  organic:    AdvisorReport | null,
): TriageAction[] {
  const out: TriageAction[] = []

  // ── Efficiency: waste (score 100) — stopping the bleed is always first
  const eff = efficiency?.status === 'done' ? (efficiency.report as EfficiencyReport | null) : null
  if (eff?.waste_identified) {
    for (const w of eff.waste_identified) {
      out.push({
        id:          `eff::waste::${w.campaign}`,
        agent:       'google_ads_efficiency',
        priority:    100,
        headline:    `עצור בזבוז: ${w.fix}`,
        context:     w.issue,
        sourceLabel: w.estimated_waste || w.campaign,
      })
    }
  }

  // ── Efficiency budget recs: pause = score 90, decrease = 70
  if (eff?.budget_recommendations) {
    for (const r of eff.budget_recommendations) {
      if (r.action === 'pause') {
        out.push({
          id:          `eff::pause::${r.campaign}`,
          agent:       'google_ads_efficiency',
          priority:    90,
          headline:    `השהה את ${r.campaign}`,
          context:     r.reason,
        })
      } else if (r.action === 'decrease' && r.suggested_budget_change_pct < 0) {
        out.push({
          id:          `eff::decrease::${r.campaign}`,
          agent:       'google_ads_efficiency',
          priority:    70,
          headline:    `הקטן תקציב ב-${Math.abs(r.suggested_budget_change_pct)}%: ${r.campaign}`,
          context:     r.reason,
        })
      }
    }
  }

  // ── Growth campaigns_to_create (score 70) — new campaign suggestions
  const grw = growth?.status === 'done' ? (growth.report as GrowthReport | null) : null
  if (grw?.campaigns_to_create) {
    for (const c of grw.campaigns_to_create) {
      out.push({
        id:          `grw::campaign::${c.campaign_name}`,
        agent:       'google_ads_growth',
        priority:    70,
        headline:    `צור קמפיין: ${c.campaign_name}`,
        context:     c.rationale,
        sourceLabel: `${c.campaign_type} · ₪${c.daily_budget_ils}/יום`,
      })
    }
  }

  // ── Efficiency ads_to_rewrite (score 75) — concrete, actionable copy fixes
  if (eff?.ads_to_rewrite) {
    for (const a of eff.ads_to_rewrite) {
      out.push({
        id:          `eff::rewrite::${a.campaign}`,
        agent:       'google_ads_efficiency',
        priority:    75,
        headline:    `שכתב מודעות: ${a.campaign}`,
        context:     a.expected_improvement,
        sourceLabel: a.ad_strength ? `Ad Strength: ${a.ad_strength}` : undefined,
      })
    }
  }

  // ── Growth growth_opportunities (score 55)
  if (grw?.growth_opportunities) {
    for (const op of grw.growth_opportunities) {
      out.push({
        id:          `grw::opp::${op.opportunity}`,
        agent:       'google_ads_growth',
        priority:    55,
        headline:    op.opportunity,
        context:     op.action,
        sourceLabel: op.expected_impact,
      })
    }
  }

  // ── Organic posts_to_publish (score 65) — ready content, just needs posting
  const org = organic?.status === 'done' ? (organic.report as OrganicReport | null) : null
  if (org?.posts_to_publish) {
    for (const p of org.posts_to_publish) {
      out.push({
        id:          `org::post::${p.topic}`,
        agent:       'organic_content',
        priority:    65,
        headline:    `פרסם: ${p.topic}`,
        context:     p.best_day ? `${p.best_day} ${p.best_time}` : undefined,
        sourceLabel: p.type ? `${contentTypeIcon(p.type)} ${p.type}` : undefined,
      })
    }
  }

  // ── Organic google_organic_recommendations (score 45)
  if (org?.google_organic_recommendations) {
    for (const rec of org.google_organic_recommendations) {
      out.push({
        id:          `org::seo::${rec.keyword}`,
        agent:       'organic_content',
        priority:    rec.estimated_difficulty === 'קל' ? 55 : 45,
        headline:    `כתוב תוכן ל-"${rec.keyword}"`,
        context:     rec.why_now,
        sourceLabel: rec.current_position > 0 ? `מיקום ${rec.current_position}` : undefined,
      })
    }
  }

  // Sort by priority desc, cap at 6 — any more becomes a wall of information
  // again, which is the problem we're trying to solve.
  return out.sort((a, b) => b.priority - a.priority).slice(0, 6)
}

// Persist per-week action state in localStorage. Key is the week_start date
// so switching weeks loads a different state bucket and marking "done" on
// this week doesn't affect the historical view of last week.
// Action states are persisted BOTH to localStorage (instant UI) and to
// the advisor_completed_actions DB table (so the agents can see what the
// user already did and stop recommending those things again).
function useActionStates(weekKey: string | null) {
  const storageKey = weekKey ? `advisor_actions_${weekKey}` : null
  const [states, setStates] = useState<Record<string, ActionState>>({})
  const [labels, setLabels] = useState<Record<string, string>>({})

  // Initial load: prefer DB (authoritative across devices), fall back to localStorage.
  useEffect(() => {
    if (!weekKey) { setStates({}); return }
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('advisor_completed_actions')
        .select('action_id, state')
        .eq('week_start', weekKey)
      if (cancelled) return
      if (!error && data && data.length > 0) {
        const fromDb: Record<string, ActionState> = {}
        for (const row of data as Array<{ action_id: string; state: ActionState }>) {
          fromDb[row.action_id] = row.state
        }
        setStates(fromDb)
        // Mirror DB → localStorage for fast subsequent loads
        if (storageKey) {
          try { localStorage.setItem(storageKey, JSON.stringify(fromDb)) } catch { /* quota */ }
        }
      } else if (storageKey) {
        // No DB data yet — fall back to whatever the browser had cached
        try {
          const raw = localStorage.getItem(storageKey)
          setStates(raw ? JSON.parse(raw) : {})
        } catch {
          setStates({})
        }
      }
    })()
    return () => { cancelled = true }
  }, [storageKey, weekKey])

  // Caller passes a label so we can show useful context to the agent:
  // "user marked done: 'Write blog post on macchiato'" instead of just an opaque ID.
  const setState = (id: string, state: ActionState, label?: string) => {
    setStates(prev => {
      const next = { ...prev }
      if (state === null) delete next[id]
      else next[id] = state
      if (storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* quota */ }
      }
      return next
    })
    if (label) setLabels(prev => ({ ...prev, [id]: label }))

    // Persist to DB so the agents see this on their next run.
    // Fire-and-forget — the localStorage write above guarantees instant UI feedback.
    if (weekKey) {
      const finalLabel = label ?? labels[id] ?? id
      if (state === null) {
        supabase.from('advisor_completed_actions')
          .delete()
          .eq('week_start', weekKey)
          .eq('action_id', id)
          .then(({ error }) => { if (error) console.error('[action-state] delete failed:', error.message) })
      } else {
        supabase.from('advisor_completed_actions')
          .upsert(
            { week_start: weekKey, action_id: id, action_label: finalLabel, state },
            { onConflict: 'week_start,action_id' },
          )
          .then(({ error }) => { if (error) console.error('[action-state] upsert failed:', error.message) })
      }
    }
  }

  return [states, setState] as const
}

// Visual tag per agent — matches the color system in the 3 panels
// (blue=growth, amber=efficiency, green=organic) so the user can tell at
// a glance which panel an action came from.
const AGENT_TAGS: Record<string, { label: string; bg: string }> = {
  strategist_aggressive: { label: 'אגרסיבי',  bg: 'bg-red-50 text-red-700 border-red-100' },
  strategist_precise:    { label: 'מדויק',    bg: 'bg-blue-50 text-blue-700 border-blue-100' },
  google_ads_growth:     { label: 'צמיחה',    bg: 'bg-blue-50 text-blue-700 border-blue-100' },
  google_ads_efficiency: { label: 'יעילות',   bg: 'bg-amber-50 text-amber-700 border-amber-100' },
  organic_content:       { label: 'תוכן',     bg: 'bg-green-50 text-green-700 border-green-100' },
}

function ActionQueue({ rows, weekKey }: { rows: Record<string, AdvisorReport | null>; weekKey: string | null }) {
  const actions = useMemo(
    () => buildTriageQueue(rows.google_ads_growth, rows.google_ads_efficiency, rows.organic_content),
    [rows.google_ads_growth, rows.google_ads_efficiency, rows.organic_content],
  )
  const [states, setState] = useActionStates(weekKey)

  if (actions.length === 0) return null

  const doneCount = actions.filter(a => states[a.id] === 'done').length
  const inactiveCount = actions.filter(a => states[a.id] != null).length
  const activeCount = actions.length - inactiveCount

  // Sort pending first, then inactive (done / skipped / snoozed) to the
  // bottom so the user's next-action eye-line always lands on fresh items.
  const sorted = [...actions].sort((a, b) => {
    const aInactive = states[a.id] != null
    const bInactive = states[b.id] != null
    if (aInactive !== bInactive) return aInactive ? 1 : -1
    return b.priority - a.priority
  })

  return (
    <div className="card p-4 lg:p-5">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-amber-500" />
          <h2 className="text-base font-display font-semibold text-surface-900">לפעולה השבוע</h2>
        </div>
        <span className="text-xs text-surface-500">
          {activeCount > 0
            ? `${activeCount} פעולות פתוחות${doneCount > 0 ? ` · ${doneCount} הושלמו` : ''}`
            : `${doneCount}/${actions.length} הושלמו 🎉`}
        </span>
      </div>
      <div className="space-y-2">
        {sorted.map(a => (
          <ActionRow key={a.id} action={a} state={states[a.id] ?? null} onChange={s => setState(a.id, s, a.headline)} />
        ))}
      </div>
    </div>
  )
}

function ActionRow({ action, state, onChange }: { action: TriageAction; state: ActionState; onChange: (s: ActionState) => void }) {
  const inactive = state != null
  const tag = AGENT_TAGS[action.agent]

  return (
    <div className={`flex items-start gap-3 p-3 rounded-xl border transition-opacity ${inactive ? 'bg-surface-50 border-surface-100 opacity-50' : 'bg-white border-surface-200'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${tag.bg}`}>{tag.label}</span>
          {action.sourceLabel && (
            <span className="text-[10px] text-surface-400 truncate max-w-[200px]">{action.sourceLabel}</span>
          )}
          {state === 'done'    && <span className="text-[10px] text-green-600">✓ הושלם</span>}
          {state === 'skipped' && <span className="text-[10px] text-surface-500">⏭ דילגתי</span>}
          {state === 'snoozed' && <span className="text-[10px] text-blue-600">🕐 שבוע הבא</span>}
        </div>
        <p className={`text-sm font-medium text-surface-800 leading-snug ${inactive ? 'line-through' : ''}`}>
          {action.headline}
        </p>
        {action.context && !inactive && (
          <p className="text-xs text-surface-500 mt-1 leading-relaxed">{action.context}</p>
        )}
      </div>
      {!inactive ? (
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onChange('done')}
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-surface-200 text-surface-500 hover:bg-green-50 hover:text-green-600 hover:border-green-300 transition-colors"
            title="עשיתי"
            aria-label="סמן כהושלם"
          >
            ✓
          </button>
          <button
            onClick={() => onChange('snoozed')}
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-surface-200 text-surface-500 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-300 transition-colors text-[11px]"
            title="שבוע הבא"
            aria-label="דחה לשבוע הבא"
          >
            🕐
          </button>
          <button
            onClick={() => onChange('skipped')}
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-surface-200 text-surface-500 hover:bg-surface-100 hover:text-surface-700 transition-colors"
            title="דלג"
            aria-label="דלג"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          onClick={() => onChange(null)}
          className="shrink-0 text-xs text-surface-400 hover:text-surface-700 transition-colors px-2"
          title="בטל סימון"
        >
          החזר
        </button>
      )}
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AdvisorReport['status'] }) {
  if (status === 'done')      return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">✓ הושלם</span>
  if (status === 'running')   return <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1"><Loader2 size={10} className="animate-spin" />מנתח...</span>
  if (status === 'error')     return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">✗ שגיאה</span>
  if (status === 'cancelled') return <span className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded-full font-medium">✕ בוטל</span>
  return <span className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded-full font-medium">ממתין</span>
}

// Small caption shown above a panel section. Previously the codebase used a
// `text-xs uppercase tracking-wider text-surface-400` treatment everywhere
// which made every header basically invisible — users couldn't scan to the
// section they cared about. A darker, slightly bigger, non-uppercase label
// gives the eye real anchor points without shouting.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h4 className="text-sm font-semibold text-surface-800 mb-2">{children}</h4>
}

// Hero "TL;DR" card — the panel's `next_week_focus` directive plus the
// agent's prose summary, rendered prominently at the top of the panel.
// This used to be the LAST element in each panel (you had to scroll past
// every detail card to get to the actual takeaway); moving it to the top
// flips the reading order so the scan-friendly "what should I actually do
// this week" appears first and the drill-down cards support it below.
function HeroCard({ focus, summary }: { focus?: string; summary?: string }) {
  if (!focus && !summary) return null
  return (
    <div className="rounded-2xl bg-surface-900 text-white p-4 shadow-sm">
      <p className="text-[10px] font-semibold text-surface-400 tracking-[0.15em] mb-1.5">★ מוקד השבוע הבא</p>
      {focus && <p className="text-[15px] font-semibold leading-relaxed mb-2">{focus}</p>}
      {summary && <p className="text-xs text-surface-300 leading-relaxed">{summary}</p>}
    </div>
  )
}

function PanelEmpty({ label, onRun, running }: { label: string; onRun?: () => void; running?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="text-3xl mb-2">🤖</div>
      <p className="text-sm text-surface-500 mb-4">{label} טרם הופעל</p>
      {onRun && (
        <button
          onClick={onRun}
          disabled={running}
          className="btn btn-primary text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running
            ? <><Loader2 size={14} className="animate-spin" /> מנתח...</>
            : <><RefreshCw size={14} /> הפעל סוכן</>}
        </button>
      )}
    </div>
  )
}

function PanelRunning() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Loader2 size={28} className="animate-spin text-blue-500 mb-2" />
      <p className="text-sm text-surface-500">מנתח נתונים... (~30–60 שניות)</p>
    </div>
  )
}

function PanelError({ msg }: { msg: string }) {
  return (
    <div className="card bg-red-50 border-red-200 flex gap-3">
      <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={16} />
      <p className="text-xs text-red-700 font-mono">{msg}</p>
    </div>
  )
}

function GoogleKPIGrid({ g }: { g: GoogleKPIs }) {
  // CPA derived — not stored separately on the Google block, but it's
  // the one number owners ask about most. Compute here + color-code
  // against a ₪30 target (anything >₪30 = red, <₪30 = green).
  const cost = Number(g.total_cost ?? 0)
  const convs = Number(g.total_conversions ?? 0)
  const cpa = convs > 0 ? cost / convs : null
  const cpaColor = cpa == null ? 'text-surface-400'
                 : cpa <= 15  ? 'text-green-600'
                 : cpa <= 30  ? 'text-amber-600'
                 :              'text-red-600'
  return (
    <div>
      <p className="text-[11px] font-semibold text-surface-500 mb-1.5 flex items-center gap-1.5">🔵 Google Ads</p>
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-surface-50 rounded-xl p-3 text-center">
          <p className="text-xl font-bold font-mono text-surface-900 leading-tight">₪{cost.toLocaleString()}</p>
          <p className="text-[11px] text-surface-500 mt-1">הוצאה</p>
        </div>
        <div className="bg-surface-50 rounded-xl p-3 text-center">
          <p className="text-xl font-bold font-mono text-surface-900 leading-tight">{convs}</p>
          <p className="text-[11px] text-surface-500 mt-1">המרות</p>
        </div>
        <div className="bg-surface-50 rounded-xl p-3 text-center">
          <p className={`text-xl font-bold font-mono leading-tight ${cpaColor}`}>{cpa != null ? `₪${cpa.toFixed(2)}` : '—'}</p>
          <p className="text-[11px] text-surface-500 mt-1">CPA</p>
        </div>
        <div className="bg-surface-50 rounded-xl p-3 text-center">
          <p className="text-xl font-bold font-mono text-surface-900 leading-tight">{g.roas ?? 0}×</p>
          <p className="text-[11px] text-surface-500 mt-1">ROAS</p>
        </div>
      </div>
    </div>
  )
}

// Meta KPI grid — mirrors GoogleKPIGrid. Meta doesn't track ROAS in our
// sync (no conversion_value), so the 4th card is CTR instead.
function MetaKPIGrid({ m }: { m: any }) {
  if (!m) return null
  const spend  = Number(m.total_spend ?? 0)
  const convs  = Number(m.total_conversions ?? 0)
  const clicks = Number(m.total_clicks ?? 0)
  const imps   = Number(m.total_impressions ?? 0)
  const cpa    = convs > 0 ? spend / convs : null
  const ctr    = imps > 0  ? (clicks / imps) * 100 : null
  const cpaColor = cpa == null ? 'text-surface-400'
                 : cpa <= 15  ? 'text-green-600'
                 : cpa <= 30  ? 'text-amber-600'
                 :              'text-red-600'
  return (
    <div>
      <p className="text-[11px] font-semibold text-surface-500 mb-1.5 flex items-center gap-1.5">📘 Meta Ads (FB + IG)</p>
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-indigo-50 rounded-xl p-3 text-center">
          <p className="text-xl font-bold font-mono text-surface-900 leading-tight">₪{spend.toLocaleString()}</p>
          <p className="text-[11px] text-surface-500 mt-1">הוצאה</p>
        </div>
        <div className="bg-indigo-50 rounded-xl p-3 text-center">
          <p className="text-xl font-bold font-mono text-surface-900 leading-tight">{convs}</p>
          <p className="text-[11px] text-surface-500 mt-1">המרות</p>
        </div>
        <div className="bg-indigo-50 rounded-xl p-3 text-center">
          <p className={`text-xl font-bold font-mono leading-tight ${cpaColor}`}>{cpa != null ? `₪${cpa.toFixed(2)}` : '—'}</p>
          <p className="text-[11px] text-surface-500 mt-1">CPA</p>
        </div>
        <div className="bg-indigo-50 rounded-xl p-3 text-center">
          <p className="text-xl font-bold font-mono text-surface-900 leading-tight">{ctr != null ? `${ctr.toFixed(1)}%` : '—'}</p>
          <p className="text-[11px] text-surface-500 mt-1">CTR</p>
        </div>
      </div>
    </div>
  )
}

function BudgetRecs({ recs }: { recs: BudgetRec[] }) {
  if (!recs?.length) return null
  return (
    <div>
      <SectionHeader>המלצות תקציב</SectionHeader>
      <div className="space-y-2">
        {recs.map((r, i) => (
          <div key={i} className={`rounded-xl border-r-4 p-3 ${actionColor(r.action)}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold">{actionLabel(r.action)}</span>
              {r.suggested_budget_change_pct !== 0 && (
                <span className="text-xs font-mono bg-white px-1.5 py-0.5 rounded">
                  {r.suggested_budget_change_pct > 0 ? '+' : ''}{r.suggested_budget_change_pct}%
                </span>
              )}
            </div>
            <p className="text-sm font-medium text-surface-800 truncate">{r.campaign}</p>
            <p className="text-xs text-surface-600 mt-1 leading-relaxed">{r.reason}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function KeyInsights({ insights }: { insights: string[] }) {
  if (!insights?.length) return null
  return (
    <div>
      <SectionHeader>תובנות</SectionHeader>
      <ul className="space-y-1.5">
        {insights.map((ins, i) => (
          <li key={i} className="text-sm text-surface-700 flex gap-2 leading-relaxed">
            <span className="text-surface-300 shrink-0 mt-0.5">•</span>{ins}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Growth Panel ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="shrink-0 flex items-center gap-1 text-xs text-surface-400 hover:text-brand-600 transition-colors px-2 py-1 rounded-lg hover:bg-brand-50"
    >
      {copied ? <><Check size={11} className="text-green-500" /> הועתק</> : <><Copy size={11} /> העתק</>}
    </button>
  )
}

function StepsAccordion({ steps, label = '📋 הוראות יצירה ב-Google Ads', defaultOpen = false }: { steps: string[]; label?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!steps?.length) return null
  return (
    <div className="mt-2 border border-surface-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between gap-2 w-full px-3 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors text-xs font-semibold text-surface-600"
      >
        <span>{label}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <ol className="px-3 py-2 space-y-2 bg-white">
          {steps.map((step, i) => (
            <li key={i} className="text-xs text-surface-700 leading-relaxed flex gap-2">
              <span className="font-bold text-brand-600 shrink-0">{i + 1}.</span>
              <span>{step.replace(/^שלב \d+[:.]\s*/i, '')}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function GrowthPanel({ row, onRun, running }: { row: AdvisorReport | null; onRun?: () => void; running?: boolean }) {
  if (!row)                        return <PanelEmpty label="סוכן צמיחה" onRun={onRun} running={running} />
  if (row.status === 'running')    return <PanelRunning />
  if (row.status === 'cancelled')  return <PanelEmpty label="סוכן צמיחה" onRun={onRun} running={running} />
  if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)                 return <PanelEmpty label="סוכן צמיחה" onRun={onRun} running={running} />
  const r = row.report as GrowthReport

  return (
    <div className="space-y-4">
      {/* Hero: next_week_focus + summary. Previously these two pieces lived
          in opposite ends of the panel — summary at top, focus buried after
          every recommendation. Merging them at the top gives the user a real
          TL;DR on first scroll. */}
      <HeroCard focus={r.next_week_focus} summary={r.summary} />

      {r.google && <GoogleKPIGrid g={r.google} />}

      {/* Top / worst campaign */}
      {r.google && (r.google.top_campaign || r.google.worst_campaign) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {r.google.top_campaign && (
            <div className="card p-2 bg-green-50 border-green-100">
              <p className="text-green-600 font-medium mb-0.5">🚀 לסקייל</p>
              <p className="text-surface-700 truncate">{r.google.top_campaign}</p>
            </div>
          )}
          {r.google.worst_campaign && (
            <div className="card p-2 bg-amber-50 border-amber-100">
              <p className="text-amber-600 font-medium mb-0.5">⚠️ לטפל</p>
              <p className="text-surface-700 truncate">{r.google.worst_campaign}</p>
            </div>
          )}
        </div>
      )}

      {/* Market insights — Israeli market intelligence, seasonal, competitor */}
      {r.market_insights && r.market_insights.length > 0 && (
        <div>
          <SectionHeader>🇮🇱 תובנות שוק</SectionHeader>
          <div className="space-y-2">
            {r.market_insights.map((mi, i) => (
              <div key={i} className="card p-3 border-r-4 border-purple-400 bg-purple-50">
                <p className="text-sm font-medium text-purple-900 mb-1">{mi.insight}</p>
                <p className="text-xs text-purple-700 mb-1 leading-relaxed">📎 {mi.relevance}</p>
                <p className="text-xs text-purple-600">▶ {mi.action}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Growth opportunities */}
      {r.growth_opportunities?.length > 0 && (
        <div>
          <SectionHeader>הזדמנויות צמיחה</SectionHeader>
          <div className="space-y-2">
            {r.growth_opportunities.map((op, i) => (
              <div key={i} className="card p-3 border-r-4 border-blue-400 bg-blue-50">
                <p className="text-sm font-medium text-blue-900 mb-1">{op.opportunity}</p>
                <p className="text-xs text-blue-700 mb-1 leading-relaxed">▶ {op.action}</p>
                <p className="text-xs text-blue-600 italic">{op.expected_impact}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Campaigns to create */}
      {r.campaigns_to_create?.length > 0 && (
        <div>
          <SectionHeader>🎯 קמפיינים ליצירה</SectionHeader>
          <div className="space-y-3">
            {r.campaigns_to_create.map((c, i) => (
              <div key={i} className="card p-3 border border-blue-200 bg-blue-50 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-blue-900">{c.campaign_name}</p>
                    <p className="text-xs text-blue-600">{c.campaign_type} · ₪{c.daily_budget_ils}/יום · {c.target_audience}</p>
                  </div>
                </div>
                {c.keywords?.length > 0 && (
                  <div>
                    <p className="text-[10px] text-surface-500 font-semibold mb-1">מילות מפתח:</p>
                    <div className="flex flex-wrap gap-1">
                      {c.keywords.map((kw: any, j: number) => {
                        // Handle both legacy string and new {keyword, match_type, expected_cpc} format.
                        // Rendering an object directly causes React error #31 and crashes the whole panel.
                        const label = typeof kw === 'string'
                          ? kw
                          : `${kw.keyword ?? ''}${kw.match_type ? ` [${kw.match_type}]` : ''}${kw.expected_cpc ? ` ₪${kw.expected_cpc}` : ''}`
                        return (
                          <span key={j} className="text-xs bg-white border border-blue-200 text-blue-700 px-2 py-0.5 rounded-full">{label}</span>
                        )
                      })}
                    </div>
                  </div>
                )}
                {c.negative_keywords && c.negative_keywords.length > 0 && (
                  <div>
                    <p className="text-[10px] text-surface-500 font-semibold mb-1">מילות מפתח שליליות:</p>
                    <div className="flex flex-wrap gap-1">
                      {c.negative_keywords.map((kw, j) => (
                        <span key={j} className="text-xs bg-red-50 border border-red-200 text-red-600 px-2 py-0.5 rounded-full">-{kw}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="bg-white rounded-lg p-2.5 space-y-1.5">
                  <p className="text-xs font-semibold text-surface-500 mb-1">כותרות (העתק לGoogle Ads):</p>
                  {c.headlines?.map((h, j) => (
                    <div key={j} className="flex items-center justify-between gap-2">
                      <p className="text-xs text-surface-800 font-mono">{h}</p>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className={`text-xs font-mono ${h.length > 30 ? 'text-red-500' : 'text-surface-400'}`}>{h.length}/30</span>
                        <CopyButton text={h} />
                      </div>
                    </div>
                  ))}
                  <p className="text-xs font-semibold text-surface-500 mt-2 mb-1">תיאורים:</p>
                  {c.descriptions?.map((d, j) => (
                    <div key={j} className="flex items-center justify-between gap-2">
                      <p className="text-xs text-surface-700">{d}</p>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className={`text-xs font-mono ${d.length > 90 ? 'text-red-500' : 'text-surface-400'}`}>{d.length}/90</span>
                        <CopyButton text={d} />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-blue-700 italic">{c.rationale}</p>
                {c.landing_page_url && (
                  <div className="flex items-center gap-2 bg-blue-100 rounded-lg px-2.5 py-1.5">
                    <span className="text-[10px] text-blue-600 font-semibold shrink-0">🔗 Landing page:</span>
                    <a href={c.landing_page_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-800 hover:underline truncate flex-1 min-w-0 font-mono" dir="ltr">{c.landing_page_url}</a>
                    <CopyButton text={c.landing_page_url} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />
    </div>
  )
}

// ── Efficiency Panel ──────────────────────────────────────────────────────────

function EfficiencyPanel({ row, onRun, running }: { row: AdvisorReport | null; onRun?: () => void; running?: boolean }) {
  if (!row)                        return <PanelEmpty label="סוכן יעילות" onRun={onRun} running={running} />
  if (row.status === 'running')    return <PanelRunning />
  if (row.status === 'cancelled')  return <PanelEmpty label="סוכן יעילות" onRun={onRun} running={running} />
  if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)                 return <PanelEmpty label="סוכן יעילות" onRun={onRun} running={running} />
  const r = row.report as EfficiencyReport

  return (
    <div className="space-y-4">
      <HeroCard focus={r.next_week_focus} summary={r.summary} />

      {r.google && <GoogleKPIGrid g={r.google} />}

      {r.google && (r.google.top_campaign || r.google.worst_campaign) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {r.google.top_campaign && (
            <div className="card p-2 bg-green-50 border-green-100">
              <p className="text-green-600 font-medium mb-0.5">🏆 ROAS מוביל</p>
              <p className="text-surface-700 truncate">{r.google.top_campaign}</p>
            </div>
          )}
          {r.google.worst_campaign && (
            <div className="card p-2 bg-red-50 border-red-100">
              <p className="text-red-600 font-medium mb-0.5">🔥 בזבוז</p>
              <p className="text-surface-700 truncate">{r.google.worst_campaign}</p>
            </div>
          )}
        </div>
      )}

      <BudgetRecs recs={r.budget_recommendations} />

      {/* Waste identified */}
      {r.waste_identified?.length > 0 && (
        <div>
          <SectionHeader>בזבוז מזוהה</SectionHeader>
          <div className="space-y-2">
            {r.waste_identified.map((w, i) => (
              <div key={i} className="card p-3 border-r-4 border-red-400 bg-red-50">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium text-red-900 truncate">{w.campaign}</p>
                  {w.estimated_waste && (
                    <span className="text-xs font-mono bg-red-100 text-red-700 px-1.5 py-0.5 rounded shrink-0 mr-2">
                      {w.estimated_waste}
                    </span>
                  )}
                </div>
                <p className="text-xs text-red-700 mb-1">{w.issue}</p>
                <p className="text-xs text-surface-600">✓ {w.fix}</p>
                {w.negative_keywords && w.negative_keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    <span className="text-[10px] text-red-600 font-semibold ml-1">מילות מפתח שליליות:</span>
                    {w.negative_keywords.map((kw, j) => (
                      <span key={j} className="text-[10px] bg-red-100 border border-red-200 text-red-700 px-1.5 py-0.5 rounded-full">-{kw}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Negative keywords recommendations */}
      {r.negative_keywords_to_add && r.negative_keywords_to_add.length > 0 && (
        <div>
          <SectionHeader>🚫 מילות מפתח שליליות להוספה</SectionHeader>
          <div className="space-y-2">
            {r.negative_keywords_to_add.map((nk, i) => (
              <div key={i} className="card p-3 border-r-4 border-amber-400 bg-amber-50">
                <p className="text-sm font-medium text-amber-900 mb-1">{nk.campaign}</p>
                <p className="text-xs text-surface-600 mb-1.5">{nk.reason}</p>
                <div className="flex items-center gap-2">
                  <div className="flex flex-wrap gap-1 flex-1">
                    {nk.keywords.map((kw, j) => (
                      <span key={j} className="text-xs bg-white border border-amber-200 text-amber-700 px-2 py-0.5 rounded-full">-{kw}</span>
                    ))}
                  </div>
                  <CopyButton text={nk.keywords.map(k => `-${k}`).join('\n')} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ads to rewrite */}
      {r.ads_to_rewrite?.length > 0 && (
        <div>
          <SectionHeader>✏️ מודעות לשכתוב</SectionHeader>
          <div className="space-y-3">
            {r.ads_to_rewrite.map((a, i) => (
              <div key={i} className="card p-3 border border-amber-200 bg-amber-50 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-amber-900">{a.campaign}</p>
                  {a.ad_strength && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      a.ad_strength === 'POOR' ? 'bg-red-100 text-red-700' :
                      a.ad_strength === 'AVERAGE' ? 'bg-amber-100 text-amber-700' :
                      'bg-green-100 text-green-700'
                    }`}>Ad Strength: {a.ad_strength}</span>
                  )}
                </div>

                {/* Headline fixes */}
                {a.headline_fixes?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-surface-500">כותרות:</p>
                    {a.headline_fixes.map((fix, j) => (
                      <div key={j} className="bg-white rounded-xl border border-surface-200 overflow-hidden">
                        {/* Old */}
                        <div className="flex items-start justify-between gap-2 px-3 py-2 bg-red-50 border-b border-red-100">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-red-500 font-semibold mb-0.5">❌ קיים</p>
                            <p className="text-xs text-red-800 font-mono break-words">{fix.original}</p>
                            {fix.problem && <p className="text-xs text-red-600 mt-1 leading-relaxed">↳ {fix.problem}</p>}
                          </div>
                          <span className={`text-xs font-mono shrink-0 ${fix.original?.length > 30 ? 'text-red-500' : 'text-surface-400'}`}>{fix.original?.length}/30</span>
                        </div>
                        {/* New */}
                        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-green-50">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-green-600 font-semibold mb-0.5">✅ החלפה</p>
                            <p className="text-xs text-green-900 font-mono">{fix.replacement}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <span className={`text-xs font-mono ${fix.replacement?.length > 30 ? 'text-red-500' : 'text-green-600'}`}>{fix.replacement?.length}/30</span>
                            <CopyButton text={fix.replacement} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Description fixes */}
                {a.description_fixes?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-surface-500">תיאורים:</p>
                    {a.description_fixes.map((fix, j) => (
                      <div key={j} className="bg-white rounded-xl border border-surface-200 overflow-hidden">
                        <div className="px-3 py-2 bg-red-50 border-b border-red-100">
                          <p className="text-xs text-red-500 font-semibold mb-0.5">❌ קיים</p>
                          <p className="text-xs text-red-800 break-words">{fix.original}</p>
                          {fix.problem && <p className="text-xs text-red-600 mt-1">↳ {fix.problem}</p>}
                        </div>
                        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-green-50">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-green-600 font-semibold mb-0.5">✅ החלפה</p>
                            <p className="text-xs text-green-900">{fix.replacement}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <span className={`text-xs font-mono ${fix.replacement?.length > 90 ? 'text-red-500' : 'text-green-600'}`}>{fix.replacement?.length}/90</span>
                            <CopyButton text={fix.replacement} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <p className="text-xs text-green-700 bg-green-50 rounded px-2 py-1">✓ {a.expected_improvement}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />
    </div>
  )
}

// ── Organic Panel ─────────────────────────────────────────────────────────────

function OrganicPanel({ row, blogState, setBlogState, writeBlogPost, generateBanner, allProducts, onRun, running }: {
  row: AdvisorReport | null
  blogState: Record<string, { loading: boolean; post: BlogPost | null; error?: string; selectedProducts?: string[]; bannerLoading?: boolean }>
  setBlogState: React.Dispatch<React.SetStateAction<Record<string, { loading: boolean; post: BlogPost | null; error?: string; selectedProducts?: string[]; customProductText?: string; bannerLoading?: boolean }>>>
  writeBlogPost: (rec: GoogleOrganicRec, selectedProducts: string[]) => void
  generateBanner: (keyword: string, title: string) => void
  allProducts: string[]
  onRun?: () => void
  running?: boolean
}) {
  if (!row)                        return <PanelEmpty label="סוכן תוכן אורגני" onRun={onRun} running={running} />
  if (row.status === 'running')    return <PanelRunning />
  if (row.status === 'cancelled')  return <PanelEmpty label="סוכן תוכן אורגני" onRun={onRun} running={running} />
  if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)                 return <PanelEmpty label="סוכן תוכן אורגני" onRun={onRun} running={running} />
  const r = row.report as OrganicReport

  // OrganicReport has no next_week_focus field — the hero card falls back
  // to rendering just the summary as the focus. Still gets the dark TL;DR
  // treatment at the top so the three panels feel visually parallel.
  return (
    <div className="space-y-4">
      <HeroCard focus={r.summary} />

      {/* Account health */}
      {r.account_health && (
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: 'reach ממוצע', value: r.account_health.avg_reach_30d.toLocaleString() },
            { label: 'עוקבים', value: r.account_health.follower_count.toLocaleString() },
            { label: 'engagement', value: `${r.account_health.engagement_rate_pct}%` },
            { label: 'תוכן מוביל', value: r.account_health.best_post_type === 'reel' ? '🎬 ריילס' : r.account_health.best_post_type === 'post' ? '🖼️ פוסט' : '⏱ סטורי' },
          ].map(k => (
            <div key={k.label} className="bg-surface-50 rounded-xl p-2.5 text-center">
              <p className="text-base font-bold font-mono text-surface-900">{k.value}</p>
              <p className="text-xs text-surface-400 mt-0.5">{k.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Google Organic / SEO ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-indigo-200 bg-indigo-50 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 bg-indigo-100 border-b border-indigo-200">
          <span className="text-base">🔍</span>
          <span className="text-sm font-bold text-indigo-900">Google אורגני — SEO ותוכן לדרג</span>
        </div>
        {r.google_organic_recommendations?.length > 0 ? (
          <div className="p-3 space-y-3">
            {r.google_organic_recommendations.map((rec, i) => (
              <div key={i} className="bg-white rounded-xl p-3 border border-indigo-200 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-indigo-900">"{rec.keyword}"</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {rec.current_position > 0 && (
                        <span className="text-xs text-indigo-600 font-mono bg-indigo-50 px-1.5 py-0.5 rounded">מיקום {rec.current_position}</span>
                      )}
                      {rec.search_volume_signal && (
                        <span className="text-xs text-surface-500">{rec.search_volume_signal}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                      rec.estimated_difficulty === 'קל' ? 'bg-green-100 text-green-700' :
                      rec.estimated_difficulty === 'בינוני' ? 'bg-amber-100 text-amber-700' :
                      'bg-red-100 text-red-700'
                    }`}>{rec.estimated_difficulty || 'בינוני'}</span>
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full">
                      {rec.content_type === 'blog_post' ? '📝 בלוג' :
                       rec.content_type === 'landing_page' ? '🎯 דף נחיתה' :
                       rec.content_type === 'product_page' ? '🛍️ דף מוצר' :
                       '❓ FAQ'}
                    </span>
                  </div>
                </div>
                <div className="bg-indigo-50 rounded-lg p-2.5 space-y-1">
                  <p className="text-xs font-semibold text-surface-500">כותרת מוצעת (H1):</p>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-indigo-900">{rec.suggested_title}</p>
                    <CopyButton text={rec.suggested_title} />
                  </div>
                </div>
                {rec.key_points?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-surface-500 mb-1">מה לכלול בתוכן:</p>
                    <ul className="space-y-1">
                      {rec.key_points.map((pt, j) => (
                        <li key={j} className="text-xs text-indigo-800 flex gap-1.5">
                          <span className="text-indigo-400 shrink-0">•</span>{pt}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {rec.why_now && (
                  <p className="text-xs text-indigo-700 bg-indigo-100 rounded px-2 py-1">⏰ {rec.why_now}</p>
                )}
                {/* Blog post writer — available on every organic rec, not
                    just ones the AI tagged as content_type='blog_post'. The
                    agent classifies targets into blog_post / landing_page /
                    product_page / faq_page but in practice the user may
                    want a written draft for any of them, and the server-
                    side writer is content-type-agnostic. The previous gate
                    hid the button entirely when the agent picked
                    landing_page, which made the Organic panel look broken
                    on weeks with no explicit blog_post recs. */}
                {(() => {
                  const bs = blogState[rec.keyword]
                  const picked = bs?.selectedProducts ?? []
                  const searchText = bs?.customProductText ?? ''

                  const updateState = (patch: Partial<{ selectedProducts: string[]; customProductText: string }>) =>
                    setBlogState(s => ({ ...s, [rec.keyword]: { ...(s[rec.keyword] ?? { loading: false, post: null }), ...patch } }))

                  const addProduct = (name: string) => {
                    if (!picked.includes(name)) updateState({ selectedProducts: [...picked, name], customProductText: '' })
                    else updateState({ customProductText: '' })
                  }

                  const removeProduct = (name: string) =>
                    updateState({ selectedProducts: picked.filter(n => n !== name) })

                  const suggestions = searchText.trim()
                    ? allProducts.filter(n => n.toLowerCase().includes(searchText.toLowerCase()) && !picked.includes(n))
                    : []

                  return (
                    <div className="pt-1 space-y-2">
                      {/* Product picker — only show when not loading and no post yet */}
                      {!bs?.loading && !bs?.post && (
                        <div className="space-y-2">
                          <p className="text-xs text-surface-500 font-semibold">🛍️ מוצרים לציין בפוסט (אופציונלי):</p>

                          {/* Search input with autocomplete */}
                          <div className="relative">
                            <input
                              type="text"
                              value={searchText}
                              onChange={e => updateState({ customProductText: e.target.value })}
                              placeholder="חפש מוצר..."
                              className="w-full text-xs border border-surface-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-400 placeholder-surface-400"
                              dir="rtl"
                            />
                            {suggestions.length > 0 && (
                              <div className="absolute z-10 top-full mt-1 w-full bg-white border border-surface-200 rounded-lg shadow-lg overflow-hidden">
                                {suggestions.slice(0, 8).map(name => (
                                  <button
                                    key={name}
                                    onMouseDown={e => { e.preventDefault(); addProduct(name) }}
                                    className="w-full text-right text-xs px-3 py-2 hover:bg-indigo-50 hover:text-indigo-700 transition-colors block"
                                  >
                                    {name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Selected products as removable pills */}
                          {picked.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {picked.map(name => (
                                <span key={name} className="inline-flex items-center gap-1 text-xs bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full">
                                  {name}
                                  <button onClick={() => removeProduct(name)} className="text-indigo-400 hover:text-indigo-700 leading-none">×</button>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {!bs?.loading && !bs?.post && (
                        <>
                          {bs?.error && (
                            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                              ⚠️ שגיאה: {bs.error}
                            </div>
                          )}
                          <button
                            onClick={() => writeBlogPost(rec, picked)}
                            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors"
                          >
                            ✍️ {bs?.error ? 'נסה שוב' : 'כתוב פוסט בלוג מלא'}
                            {picked.length > 0 && <span className="bg-indigo-500 rounded-full px-1.5 py-0.5">{picked.length} מוצרים</span>}
                          </button>
                        </>
                      )}
                      {bs?.loading && (
                        <div className="flex items-center gap-2 py-2 px-3 bg-indigo-50 rounded-lg">
                          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                          <span className="text-xs text-indigo-600">כותב פוסט... (~30 שניות)</span>
                        </div>
                      )}
                      {bs?.post && (
                        <div className="space-y-2 border border-indigo-200 rounded-xl overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-2 bg-indigo-600">
                            <span className="text-xs font-bold text-white">📝 פוסט מוכן לפרסום</span>
                            <div className="flex items-center gap-2">
                              <CopyButton text={bs.post.body} />
                              <button
                                onClick={() => setBlogState(s => ({ ...s, [rec.keyword]: { loading: false, post: null } }))}
                                className="text-indigo-200 hover:text-white text-xs"
                              >✕</button>
                            </div>
                          </div>
                          {/* Banner image — shows the generated banner or a
                              button to trigger generation on demand. */}
                          <div className="px-3 pt-2 space-y-1.5">
                            {bs.post.banner_url ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <p className="text-xs text-surface-500 font-semibold">🖼️ באנר:</p>
                                  <CopyButton text={bs.post.banner_url} />
                                  <a
                                    href={bs.post.banner_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[10px] text-indigo-600 hover:underline"
                                  >
                                    פתח בטאב חדש
                                  </a>
                                  <button
                                    onClick={() => generateBanner(rec.keyword, bs.post!.title)}
                                    disabled={bs?.bannerLoading}
                                    className="text-[10px] text-amber-600 hover:underline disabled:opacity-50"
                                  >
                                    🔄 באנר חדש
                                  </button>
                                </div>
                                <a href={bs.post.banner_url} target="_blank" rel="noopener noreferrer">
                                  <img
                                    src={bs.post.banner_url}
                                    alt={`Banner for ${bs.post.title}`}
                                    className="w-full rounded-lg border border-surface-200"
                                    style={{ aspectRatio: '16/9', objectFit: 'cover' }}
                                  />
                                </a>
                              </>
                            ) : bs?.bannerLoading ? (
                              <div className="flex items-center gap-2 py-2 px-3 bg-indigo-50 rounded-lg">
                                <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                                <span className="text-xs text-indigo-600">מייצר באנר... (~10-15 שניות)</span>
                              </div>
                            ) : (
                              <button
                                onClick={() => generateBanner(rec.keyword, bs.post!.title)}
                                className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition-colors"
                              >
                                🖼️ צור באנר לפוסט
                              </button>
                            )}
                          </div>
                          <div className="px-3 pb-1 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <p className="text-xs text-surface-500 font-semibold">Meta description:</p>
                              <CopyButton text={bs.post.meta_description} />
                            </div>
                            <p className="text-xs text-indigo-800">{bs.post.meta_description}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <p className="text-xs text-surface-500 font-semibold">Slug:</p>
                              <span className="font-normal text-xs text-indigo-700">/{bs.post.slug}</span>
                              <CopyButton text={bs.post.slug} />
                            </div>
                          </div>
                          <div className="px-3 pb-3">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-xs text-surface-500 font-semibold">תוכן המאמר (Markdown):</p>
                              <CopyButton text={bs.post.body} />
                            </div>
                            <pre className="text-xs text-surface-700 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 max-h-96 overflow-y-auto leading-relaxed" dir="rtl">{bs.post.body}</pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-indigo-600 px-4 py-3">אין המלצות Google אורגני לשבוע זה</p>
        )}
      </div>

      {/* ── Instagram Content ─────────────────────────────────────────── */}
      {r.content_recommendations?.length > 0 && (
        <div className="rounded-2xl border border-green-200 bg-green-50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-green-100 border-b border-green-200">
            <span className="text-base">📸</span>
            <span className="text-sm font-bold text-green-900">אינסטגרם — תוכן השבוע</span>
          </div>
          <div className="p-3 space-y-2">
            {r.content_recommendations.slice(0, 2).map((rec, i) => (
              <div key={i} className="bg-white rounded-xl p-3 border border-green-200">
                <div className="flex items-center gap-2 mb-1">
                  <span>{contentTypeIcon(rec.content_type)}</span>
                  <span className="text-xs font-medium text-green-800">{rec.topic}</span>
                  <span className="text-xs text-surface-400 mr-auto">{rec.best_day} · {rec.best_time}</span>
                </div>
                <p className="text-xs text-surface-500">{rec.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products to feature */}
      {r.products_to_feature?.length > 0 && (
        <div>
          <SectionHeader>מוצרים לקדם</SectionHeader>
          <div className="space-y-1.5">
            {r.products_to_feature.map((p, i) => (
              <div key={i} className="card p-2.5">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-surface-800">{p.product}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${p.reason === 'low_stock_urgency' ? 'bg-red-100 text-red-600' : p.reason === 'new_batch' ? 'bg-blue-100 text-blue-600' : 'bg-amber-100 text-amber-600'}`}>
                    {p.reason === 'low_stock_urgency' ? '⚠️ מלאי נמוך' : p.reason === 'new_batch' ? '✨ חדש' : '🏆 מוביל'}
                  </span>
                </div>
                <p className="text-xs text-surface-500">{p.content_angle}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Posts to publish — grouped by intent (save / share / BTS) */}
      {r.posts_to_publish?.length > 0 && (
        <div>
          <SectionHeader>📲 פוסטים מוכנים לפרסום</SectionHeader>
          <div className="space-y-3">
            {r.posts_to_publish.map((p, i) => {
              const intentMap: Record<string, { label: string; emoji: string; color: string; bg: string; border: string }> = {
                save: { label: 'לשמירה', emoji: '🔖', color: 'text-blue-900', bg: 'bg-blue-50', border: 'border-blue-300' },
                share: { label: 'לשיתוף', emoji: '📣', color: 'text-rose-900', bg: 'bg-rose-50', border: 'border-rose-300' },
                behind_the_scenes: { label: 'מאחורי הקלעים', emoji: '🎬', color: 'text-amber-900', bg: 'bg-amber-50', border: 'border-amber-300' },
              }
              const intent = intentMap[p.intent ?? ''] ?? { label: 'כללי', emoji: '📱', color: 'text-green-900', bg: 'bg-green-50', border: 'border-green-300' }
              return (
                <div key={i} className={`card p-3 border ${intent.border} ${intent.bg} space-y-2`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border ${intent.border} ${intent.color}`}>
                        {intent.emoji} {intent.label}
                      </span>
                      <span>{contentTypeIcon(p.type)}</span>
                      <span className={`text-sm font-semibold ${intent.color}`}>{p.topic}</span>
                    </div>
                    <span className="text-xs text-surface-500">{p.best_day} {p.best_time}</span>
                  </div>
                  {p.why_this_intent && (
                    <p className="text-[11px] text-surface-600 italic">💡 {p.why_this_intent}</p>
                  )}
                  {p.hook && (
                    <p className={`text-xs font-medium text-surface-600 italic border-r-2 ${intent.border} pr-2`}>"{p.hook}"</p>
                  )}
                  <div className="bg-white rounded-lg p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-surface-800 leading-relaxed whitespace-pre-line flex-1">{p.caption}</p>
                      <CopyButton text={`${p.caption}\n\n${(p.hashtags ?? []).join(' ')}`} />
                    </div>
                    {p.hashtags?.length > 0 && (
                      <p className="text-xs text-blue-600">{p.hashtags.join(' ')}</p>
                    )}
                  </div>
                  {p.visual_direction && (
                    <p className="text-xs text-surface-500">📷 {p.visual_direction}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// New competing agent types — the two strategists replace growth + efficiency
const ALL_AGENT_TYPES = ['strategist_aggressive', 'strategist_precise', 'organic_content'] as const
type NewAgentType = typeof ALL_AGENT_TYPES[number]

// Defensive renderer for the build_meta_campaign response. Claude may omit
// fields, nest differently, or return strings where arrays are expected. We
// normalize everything to primitives/arrays and skip any field that's the
// wrong shape rather than crashing the whole panel.
function MetaSpecView({ spec }: { spec: any }) {
  if (!spec || typeof spec !== 'object') return null
  const str = (v: any): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v))
  const arr = (v: any): any[] => (Array.isArray(v) ? v : [])
  const audience  = spec.audience  && typeof spec.audience  === 'object' ? spec.audience  : null
  const creative  = spec.creative  && typeof spec.creative  === 'object' ? spec.creative  : null
  const metrics   = spec.success_metrics && typeof spec.success_metrics === 'object' ? spec.success_metrics : null
  const tracking  = spec.tracking  && typeof spec.tracking  === 'object' ? spec.tracking  : null
  return (
    <div className="mt-2 bg-white border border-indigo-200 rounded-lg p-3 space-y-3">
      {spec.campaign_name && (
        <div>
          <p className="text-xs font-semibold text-surface-500 mb-1">Campaign</p>
          <p className="text-sm font-mono break-all">{str(spec.campaign_name)}</p>
          <p className="text-xs text-surface-500 mt-1">
            {spec.objective && <>Objective: <strong>{str(spec.objective)}</strong> · </>}
            {spec.daily_budget_ils && <>₪{str(spec.daily_budget_ils)}/day · </>}
            {spec.duration_days && <>{str(spec.duration_days)} days · </>}
            {spec.placements && <>Placements: {str(spec.placements)}</>}
          </p>
        </div>
      )}

      {audience && (
        <div>
          <p className="text-xs font-semibold text-surface-500 mb-1">Audience{audience.type ? ` — ${str(audience.type)}` : ''}</p>
          {arr(audience.definition_step_by_step).length > 0 && (
            <ol className="text-xs text-surface-800 list-decimal list-inside space-y-0.5 pr-2">
              {arr(audience.definition_step_by_step).map((step: any, j: number) => <li key={j}>{str(step)}</li>)}
            </ol>
          )}
          <p className="text-xs text-surface-500 mt-1">
            {audience.age_range && <>גיל {str(audience.age_range)} · </>}
            {audience.geo && <>{str(audience.geo)} · </>}
            {arr(audience.languages).map(str).filter(Boolean).join(', ')}
          </p>
          {arr(audience.interests_or_behaviors).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {arr(audience.interests_or_behaviors).map((x: any, j: number) => (
                <span key={j} className="text-[10px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">{str(x)}</span>
              ))}
            </div>
          )}
          {audience.why_this_audience && <p className="text-xs text-indigo-600 italic mt-1">{str(audience.why_this_audience)}</p>}
        </div>
      )}

      {creative && (
        <div>
          <p className="text-xs font-semibold text-surface-500 mb-1">Creative{creative.format ? ` — ${str(creative.format)}` : ''}</p>
          {creative.visual_brief && <p className="text-xs text-surface-700 italic mb-1">{str(creative.visual_brief)}</p>}
          <div className="bg-surface-50 rounded p-2 space-y-1">
            {creative.primary_text && <p className="text-xs"><strong>Primary text:</strong> {str(creative.primary_text)}</p>}
            {creative.headline && <p className="text-xs"><strong>Headline:</strong> {str(creative.headline)}</p>}
            {creative.description && <p className="text-xs"><strong>Description:</strong> {str(creative.description)}</p>}
            {creative.cta_button && <p className="text-xs"><strong>CTA:</strong> {str(creative.cta_button)}</p>}
          </div>
          {arr(creative.alternate_creative_variants).length > 0 && (
            <div className="mt-1">
              <p className="text-xs font-semibold text-surface-500 mb-0.5">וריאנטים ל-A/B:</p>
              <ul className="text-xs text-surface-700 list-disc list-inside pr-2">
                {arr(creative.alternate_creative_variants).map((v: any, j: number) => <li key={j}>{str(v)}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {arr(spec.step_by_step_build).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-surface-500 mb-1">צעדים ב-Ads Manager</p>
          <ol className="text-xs text-surface-800 list-decimal list-inside space-y-0.5 pr-2">
            {arr(spec.step_by_step_build).map((step: any, j: number) => <li key={j}>{str(step)}</li>)}
          </ol>
        </div>
      )}

      {metrics && (
        <div className="flex gap-2 flex-wrap text-[10px]">
          {metrics.expected_cpa_ils != null && <span className="bg-green-50 border border-green-200 text-green-700 px-2 py-0.5 rounded-full">CPA צפוי: ₪{str(metrics.expected_cpa_ils)}</span>}
          {metrics.expected_ctr_pct != null && <span className="bg-green-50 border border-green-200 text-green-700 px-2 py-0.5 rounded-full">CTR: {str(metrics.expected_ctr_pct)}%</span>}
          {metrics.kill_threshold_cpa_ils != null && <span className="bg-red-50 border border-red-200 text-red-700 px-2 py-0.5 rounded-full">עצור אם CPA &gt; ₪{str(metrics.kill_threshold_cpa_ils)}</span>}
          {metrics.scale_threshold_cpa_ils != null && <span className="bg-blue-50 border border-blue-200 text-blue-700 px-2 py-0.5 rounded-full">הגדל אם CPA &lt; ₪{str(metrics.scale_threshold_cpa_ils)}</span>}
        </div>
      )}

      {tracking && (
        <div className="bg-surface-50 rounded p-2">
          <p className="text-xs font-semibold text-surface-500 mb-0.5">UTM</p>
          <p className="text-xs font-mono text-surface-700 break-all">
            ?utm_source={str(tracking.utm_source)}&amp;utm_medium={str(tracking.utm_medium)}&amp;utm_campaign={str(tracking.utm_campaign)}&amp;utm_content={str(tracking.utm_content)}
          </p>
        </div>
      )}

      {spec.landing_page_url && (
        <div className="flex items-center gap-2 bg-indigo-100 rounded-lg px-2.5 py-1.5">
          <span className="text-[10px] text-indigo-700 font-semibold">🔗 Landing</span>
          <a href={str(spec.landing_page_url)} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-900 hover:underline truncate flex-1 font-mono" dir="ltr">{str(spec.landing_page_url)}</a>
          <CopyButton text={str(spec.landing_page_url)} />
        </div>
      )}

      {spec.notes && <p className="text-xs text-surface-600 italic">💡 {str(spec.notes)}</p>}

      <div className="pt-1">
        <CopyButton text={JSON.stringify(spec, null, 2)} />
      </div>
    </div>
  )
}

export default function AdvisorPage() {
  const { user } = useApp()
  const [rows, setRows]               = useState<Record<string, AdvisorReport | null>>({
    strategist_aggressive: null, strategist_precise: null, organic_content: null,
  })
  const [availableWeeks, setAvailableWeeks] = useState<string[]>([])
  const [selectedWeek, setSelectedWeek]     = useState<string | null>(null)
  const [loading, setLoading]               = useState(true)
  const [running, setRunning]               = useState(false)
  const [focus, setFocus]                   = useState<string>(() => localStorage.getItem('advisor_focus') ?? '')
  const [blogState, setBlogState]           = useState<Record<string, { loading: boolean; post: BlogPost | null; error?: string; selectedProducts?: string[]; customProductText?: string; bannerLoading?: boolean }>>({})
  const [allProducts, setAllProducts]       = useState<string[]>([])
  // Meta campaign build-on-demand: keyed by idea_id. Each entry tracks
  // loading state + the returned spec so we can render it inline below the
  // idea card the owner clicked to build.
  const [metaBuild, setMetaBuild]           = useState<Record<string, { loading: boolean; spec: any | null; error?: string }>>({})

  // Ad-hoc Q&A with the advisor_chat endpoint. History is per-week —
  // switching weeks loads a different thread because the grounding data
  // (current campaigns, current reports, current research) is week-specific.
  const chatKey = selectedWeek ? `advisor_chat_${selectedWeek}` : null
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>(() => {
    if (!chatKey) return []
    try { return JSON.parse(localStorage.getItem(chatKey) ?? '[]') } catch { return [] }
  })
  const [chatInput, setChatInput]   = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatOpen, setChatOpen]     = useState(false)

  // Campaign audit state — deterministic rule + Claude findings
  const [auditOpen, setAuditOpen]   = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditResult, setAuditResult] = useState<any>(null)
  const [auditError, setAuditError] = useState<string | null>(null)

  // Campaign KPIs fed into "Campaign monitoring" chips. Uses WooCommerce
  // orders (ground truth) instead of platform-reported conversions — Meta &
  // Google both inflate "conversions" with soft events (add-to-cart, view-
  // content, initiate-checkout). Ad spend comes from the platform tables;
  // real order count + revenue come from woo_orders matched by utm_source.
  //
  // Match heuristic — platform level first (utm_source contains "google" /
  // "facebook"|"fb"|"instagram"|"meta"), then per-campaign when utm_campaign
  // exactly matches the campaign name. If the campaign's UTM template is
  // broken (seen in real data: utm_campaign="g"), we still get platform-
  // level attribution even if per-campaign matching fails.
  interface CpaInfo {
    spend14: number
    realOrders14: number
    realRevenue14: number
    realCpa14: number | null
    realRoas14: number | null
    realOrders5: number
    realCpa5: number | null
    // Platform-reported (for comparison / debugging)
    reportedCpa14: number | null
  }
  const [campaignCpa, setCampaignCpa] = useState<Record<string, CpaInfo>>({})
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const today = new Date()
        const start = new Date(today); start.setDate(today.getDate() - 13)
        const startStr = start.toISOString().slice(0, 10)
        const five = new Date(today); five.setDate(today.getDate() - 4)
        const fiveStr = five.toISOString().slice(0, 10)
        const [
          { data: g, error: eg },
          { data: m, error: em },
          { data: woo, error: ew },
        ] = await Promise.all([
          supabase.from('google_campaigns').select('name,date,cost,conversions').gte('date', startStr),
          supabase.from('meta_ad_campaigns').select('name,date,spend,conversions').gte('date', startStr),
          supabase
            .from('woo_orders')
            .select('order_date,total,utm_source,utm_campaign,status')
            .gte('order_date', startStr)
            .in('status', ['completed', 'processing']),
        ])
        if (cancelled) return
        if (eg) console.warn('[advisor] google_campaigns fetch error:', eg)
        if (em) console.warn('[advisor] meta_ad_campaigns fetch error:', em)
        if (ew) console.warn('[advisor] woo_orders fetch error:', ew)

        const norm = (s: string) => (s ?? '').toLowerCase().replace(/[_\s|\-]+/g, ' ').trim()

        // Aggregate spend per campaign (normalized name → platform + spend windows)
        type Agg = { platform: 'google' | 'meta'; cost14: number; cost5: number; reportedConv14: number }
        const agg: Record<string, Agg> = {}
        for (const r of (g ?? []) as any[]) {
          const k = norm(r.name); if (!k) continue
          if (!agg[k]) agg[k] = { platform: 'google', cost14: 0, cost5: 0, reportedConv14: 0 }
          agg[k].cost14 += Number(r.cost) || 0
          agg[k].reportedConv14 += Number(r.conversions) || 0
          if (r.date >= fiveStr) agg[k].cost5 += Number(r.cost) || 0
        }
        for (const r of (m ?? []) as any[]) {
          const k = norm(r.name); if (!k) continue
          if (!agg[k]) agg[k] = { platform: 'meta', cost14: 0, cost5: 0, reportedConv14: 0 }
          agg[k].cost14 += Number(r.spend) || 0
          agg[k].reportedConv14 += Number(r.conversions) || 0
          if (r.date >= fiveStr) agg[k].cost5 += Number(r.spend) || 0
        }

        // Classify each Woo order to a platform + (optionally) a campaign.
        // Returns an object with flags so a single order can feed per-campaign
        // AND per-platform aggregates at once.
        const orders = (woo ?? []) as any[]
        const isGoogleOrder = (o: any) => {
          const s = (o.utm_source ?? '').toLowerCase()
          return s.includes('google')
        }
        const isMetaOrder = (o: any) => {
          const s = (o.utm_source ?? '').toLowerCase()
          return /facebook|\bfb\b|instagram|\big\b|meta/.test(s)
        }

        // Platform-level totals — used as fallback when per-campaign match fails
        const platformTotals = {
          google: { orders14: 0, revenue14: 0, orders5: 0, spend14: 0, spend5: 0 },
          meta:   { orders14: 0, revenue14: 0, orders5: 0, spend14: 0, spend5: 0 },
        }
        for (const k of Object.keys(agg)) {
          platformTotals[agg[k].platform].spend14 += agg[k].cost14
          platformTotals[agg[k].platform].spend5  += agg[k].cost5
        }
        for (const o of orders) {
          const total = Number(o.total) || 0
          const recent = o.order_date >= fiveStr
          if (isGoogleOrder(o)) {
            platformTotals.google.orders14++
            platformTotals.google.revenue14 += total
            if (recent) platformTotals.google.orders5++
          }
          if (isMetaOrder(o)) {
            platformTotals.meta.orders14++
            platformTotals.meta.revenue14 += total
            if (recent) platformTotals.meta.orders5++
          }
        }

        // Per-campaign attribution — matches utm_campaign to campaign name.
        // If zero orders match, falls back to the platform's share of orders
        // weighted by this campaign's share of platform spend.
        const out: Record<string, CpaInfo> = {}
        for (const [k, v] of Object.entries(agg)) {
          const platform = v.platform
          const wantsPlatformFilter = platform === 'google' ? isGoogleOrder : isMetaOrder
          const campaignOrders = orders.filter(o =>
            wantsPlatformFilter(o) && norm(o.utm_campaign ?? '') === k,
          )
          const hasPerCampaignMatch = campaignOrders.length > 0

          let realOrders14 = 0, realOrders5 = 0, realRevenue14 = 0
          if (hasPerCampaignMatch) {
            for (const o of campaignOrders) {
              realOrders14++
              realRevenue14 += Number(o.total) || 0
              if (o.order_date >= fiveStr) realOrders5++
            }
          } else {
            // Fallback: share platform-level attribution by spend ratio
            const pt = platformTotals[platform]
            const share = pt.spend14 > 0 ? v.cost14 / pt.spend14 : 0
            realOrders14  = Math.round(pt.orders14 * share * 10) / 10
            realOrders5   = Math.round(pt.orders5 * share * 10) / 10
            realRevenue14 = Math.round(pt.revenue14 * share * 100) / 100
          }

          out[k] = {
            spend14:        Math.round(v.cost14 * 100) / 100,
            realOrders14,
            realRevenue14:  Math.round(realRevenue14 * 100) / 100,
            realCpa14:      realOrders14 > 0 ? Math.round((v.cost14 / realOrders14) * 100) / 100 : null,
            realRoas14:     v.cost14 > 0 ? Math.round((realRevenue14 / v.cost14) * 100) / 100 : null,
            realOrders5,
            realCpa5:       realOrders5 > 0 ? Math.round((v.cost5 / realOrders5) * 100) / 100 : null,
            reportedCpa14:  v.reportedConv14 > 0 ? Math.round((v.cost14 / v.reportedConv14) * 100) / 100 : null,
          }
        }

        console.log('[advisor] Real-orders CPA loaded. Platform totals:', platformTotals, 'campaigns:', Object.keys(out))
        setCampaignCpa(out)
      } catch (e) {
        console.warn('[advisor] CPA fetch failed:', e)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Campaign Doctor — deeper per-campaign diagnosis + full fix plan
  // (20 headlines / 4 descriptions / keyword tiers / negatives / budget /
  // landing / tracking fixes — ready to paste into Google Ads).
  const [doctorOpen, setDoctorOpen]       = useState(false)
  const [doctorLoading, setDoctorLoading] = useState(false)
  const [doctorResult, setDoctorResult]   = useState<any>(null)
  const [doctorError, setDoctorError]     = useState<string | null>(null)
  const [doctorExpandedCampaign, setDoctorExpandedCampaign] = useState<string | null>(null)

  async function runCampaignDoctor() {
    if (doctorLoading) return
    setDoctorLoading(true)
    setDoctorError(null)
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: { agent: 'campaign_doctor' },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error ?? 'Doctor failed')
      setDoctorResult(data)
      setDoctorOpen(true)
    } catch (e: any) {
      setDoctorError(e?.message ?? 'Unknown error')
    } finally {
      setDoctorLoading(false)
    }
  }

  async function runCampaignAudit() {
    if (auditLoading) return
    setAuditLoading(true)
    setAuditError(null)
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: { agent: 'audit_campaigns' },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error ?? 'Audit failed')
      setAuditResult(data)
      setAuditOpen(true)
    } catch (e: any) {
      setAuditError(e?.message ?? 'Unknown error')
    } finally {
      setAuditLoading(false)
    }
  }
  useEffect(() => {
    // Load history bucket when week changes
    if (!chatKey) { setChatMessages([]); return }
    try { setChatMessages(JSON.parse(localStorage.getItem(chatKey) ?? '[]')) } catch { setChatMessages([]) }
  }, [chatKey])

  async function sendChatQuestion(q?: string) {
    const question = (q ?? chatInput).trim()
    if (!question || chatLoading || !selectedWeek) return
    const nextHistory = [...chatMessages, { role: 'user' as const, content: question }]
    setChatMessages(nextHistory)
    setChatInput('')
    setChatLoading(true)
    if (chatKey) localStorage.setItem(chatKey, JSON.stringify(nextHistory))
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: {
          agent: 'advisor_chat',
          question,
          week_start: selectedWeek,
          // Send the conversation minus the just-added question (backend re-adds it)
          history: chatMessages,
        },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error ?? 'Chat failed')
      const withAnswer = [...nextHistory, { role: 'assistant' as const, content: data.answer }]
      setChatMessages(withAnswer)
      if (chatKey) localStorage.setItem(chatKey, JSON.stringify(withAnswer))
    } catch (e: any) {
      const errMsg = `❌ ${e?.message ?? 'Unknown error'}`
      const withError = [...nextHistory, { role: 'assistant' as const, content: errMsg }]
      setChatMessages(withError)
      if (chatKey) localStorage.setItem(chatKey, JSON.stringify(withError))
    } finally {
      setChatLoading(false)
    }
  }

  function clearChat() {
    setChatMessages([])
    if (chatKey) localStorage.removeItem(chatKey)
  }
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function buildMetaCampaign(idea: any) {
    if (!idea || typeof idea !== 'object') return
    const ideaId = idea.idea_id ?? idea.campaign_name ?? 'idea'
    // Derive daily budget cleanly: prefer daily, else monthly/30, else 80.
    const daily = typeof idea.daily_budget_ils === 'number'
      ? idea.daily_budget_ils
      : typeof idea.monthly_budget_ils === 'number'
        ? Math.max(30, Math.round(idea.monthly_budget_ils / 30))
        : 80
    setMetaBuild(s => ({ ...s, [ideaId]: { loading: true, spec: null } }))
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: {
          agent: 'build_meta_campaign',
          idea: `${idea.campaign_name ?? ''} — ${idea.one_line_pitch ?? ''}`.trim() || 'Meta campaign',
          audience_lens: idea.audience_lens ?? 'auto',
          daily_budget_ils: daily,
        },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error ?? 'Build failed')
      setMetaBuild(s => ({ ...s, [ideaId]: { loading: false, spec: data.spec } }))
    } catch (e: any) {
      setMetaBuild(s => ({ ...s, [ideaId]: { loading: false, spec: null, error: e?.message ?? 'Unknown error' } }))
    }
  }

  async function writeBlogPost(rec: GoogleOrganicRec, selectedProducts: string[]) {
    const key = rec.keyword
    setBlogState(s => ({ ...s, [key]: { loading: true, post: null, error: undefined, selectedProducts } }))
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: {
          agent: 'blog_writer',
          keyword: rec.keyword,
          title: rec.suggested_title,
          key_points: rec.key_points ?? [],
          position: rec.current_position,
          search_volume_signal: rec.search_volume_signal,
          products_to_mention: selectedProducts,
        },
      })
      console.log('[blog_writer] invoke result:', { data, error })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      if (!data || !data.body) throw new Error(`תגובה ריקה מהשרת. נסה שוב.`)
      setBlogState(s => ({ ...s, [key]: { loading: false, post: data as BlogPost, selectedProducts } }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('blog_writer error', msg)
      setBlogState(s => ({ ...s, [key]: { loading: false, post: null, error: msg, selectedProducts } }))
    }
  }

  async function generateBanner(keyword: string, title: string) {
    setBlogState(s => {
      const cur = s[keyword]
      if (!cur?.post) return s
      return { ...s, [keyword]: { ...cur, bannerLoading: true } }
    })
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: { agent: 'blog_banner', keyword, title },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setBlogState(s => {
        const cur = s[keyword]
        if (!cur?.post) return s
        return { ...s, [keyword]: { ...cur, bannerLoading: false, post: { ...cur.post!, banner_url: data.banner_url } } }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('blog_banner error', msg)
      setBlogState(s => {
        const cur = s[keyword]
        if (!cur) return s
        return { ...s, [keyword]: { ...cur, bannerLoading: false } }
      })
    }
  }

  useEffect(() => {
    loadWeeks()
    supabase
      .from('woo_products')
      .select('name')
      .order('name')
      .then(({ data, error }) => {
        console.log('[advisor] woo_products fetch:', { count: data?.length, error })
        if (data) setAllProducts(data.map((p: { name: string }) => p.name))
      })
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  useEffect(() => {
    if (selectedWeek) loadReports(selectedWeek)
  }, [selectedWeek])

  async function loadWeeks() {
    setLoading(true)
    const { data } = await supabase
      .from('advisor_reports')
      .select('week_start')
      .in('status', ['done', 'running', 'error', 'cancelled'])
      .order('week_start', { ascending: false })
      .limit(16)

    const weeks = [...new Set((data ?? []).map((r: { week_start: string }) => r.week_start))].sort((a, b) => b.localeCompare(a))
    setAvailableWeeks(weeks)
    const latest = weeks[0] ?? null
    setSelectedWeek(latest)
    if (latest) await loadReports(latest)
    else setLoading(false)
  }

  async function loadReports(weekStart: string) {
    setLoading(true)
    const { data } = await supabase
      .from('advisor_reports')
      .select('*')
      .in('agent_type', ALL_AGENT_TYPES as unknown as string[])
      .eq('week_start', weekStart)

    const fetched = (data ?? []) as AdvisorReport[]
    const newRows = { ...rows }
    for (const type of ALL_AGENT_TYPES) {
      newRows[type] = fetched.find(r => r.agent_type === type) ?? null
    }
    setRows(newRows)
    setLoading(false)

    if (fetched.some(r => r.status === 'running')) startPolling(weekStart)
  }

  function startPolling(weekStart: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const { data } = await supabase
        .from('advisor_reports')
        .select('*')
        .in('agent_type', ALL_AGENT_TYPES as unknown as string[])
        .eq('week_start', weekStart)

      const fetched = (data ?? []) as AdvisorReport[]
      const newRows = { strategist_aggressive: null, strategist_precise: null, organic_content: null } as Record<string, AdvisorReport | null>
      for (const type of ALL_AGENT_TYPES) {
        newRows[type] = fetched.find(r => r.agent_type === type) ?? null
      }
      setRows(newRows)

      // Stop polling when nothing is running (done, error, or cancelled)
      if (!fetched.some(r => r.status === 'running')) {
        clearInterval(pollRef.current!)
        setRunning(false)
        await loadWeeks()
      }
    }, 5000)
  }

  async function runAdvisor(agentType?: AgentType) {
    setRunning(true)
    const agent = agentType ?? 'all'
    supabase.functions.invoke('marketing-advisor', {
      body: { trigger: 'manual', agent, focus: focus.trim() || undefined },
    }).catch(() => {})
    await new Promise(r => setTimeout(r, 1500))
    await loadWeeks()
    const week = selectedWeek
    if (week) startPolling(week)
  }

  async function cancelAdvisor() {
    if (pollRef.current) clearInterval(pollRef.current)
    setRunning(false)
    // Mark all running rows as cancelled in DB
    if (selectedWeek) {
      await supabase
        .from('advisor_reports')
        .update({ status: 'cancelled', error_msg: 'בוטל על ידי המשתמש' })
        .eq('week_start', selectedWeek)
        .eq('status', 'running')
      await loadReports(selectedWeek)
    }
  }

  const isRunning = Object.values(rows).some(r => r?.status === 'running') || running

  // `running` on each panel is derived from the global isRunning state so
  // the empty-state CTA can disable itself while ANY agent is running. We
  // don't have per-agent in-flight tracking yet, so showing all three as
  // disabled during a global run is the safest UX.
  // Two competing strategists side-by-side + organic content below.
  // Both strategists use the same StrategyPanel component since they
  // return the same JSON format — the only difference is the agent
  // philosophy and the color coding.
  const strategistPanels = [
    {
      key: 'strategist_aggressive',
      label: 'מה עושים השבוע?',
      sublabel: 'תכנית פעולה · קמפיינים מוכנים · בדיקת ביצועים ברביעי',
      icon: <TrendingUp size={16} className="text-red-500" />,
      headerColor: 'border-red-100',
    },
    {
      key: 'strategist_precise',
      label: 'אסטרטגיה 90 ימים',
      sublabel: 'מפת דרכים · תקציב חודשי · יעדים מדידים',
      icon: <Shield size={16} className="text-blue-500" />,
      headerColor: 'border-blue-100',
    },
  ]

  const organicPanel = {
    key: 'organic_content',
    label: 'תוכן אורגני',
    sublabel: 'אינסטגרם · Google Search · מלאי',
    icon: <Leaf size={16} className="text-green-500" />,
    headerColor: 'border-green-100',
  }

  // Backward compat: reuse GrowthPanel and EfficiencyPanel for the new
  // strategists since the JSON format is a superset. The HeroCard,
  // BudgetRecs, and CampaignsToCreate sections all render from the
  // same fields. New fields (competitor_insights, market_opportunities,
  // confidence_level, risk_assessment) are rendered via optional sections.
  const renderStrategyPanel = (row: AdvisorReport | null, onRun: () => void, running: boolean, key: string) => {
    // Both strategist types produce the full strategy format which is
    // a superset of both Growth and Efficiency reports. We render them
    // with the same panel, showing all available sections.
    if (!row)                        return <PanelEmpty label={key === 'strategist_aggressive' ? 'אסטרטג אגרסיבי' : 'אסטרטג מדויק'} onRun={onRun} running={running} />
    if (row.status === 'running')    return <PanelRunning />
    if (row.status === 'cancelled')  return <PanelEmpty label="אסטרטג" onRun={onRun} running={running} />
    if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
    if (!row.report)                 return <PanelEmpty label="אסטרטג" onRun={onRun} running={running} />
    const r = row.report as any

    return (
      <div className="space-y-4">
        <HeroCard focus={r.next_week_focus} summary={r.summary} />

        {/* Confidence + Risk */}
        {(r.confidence_level || r.risk_assessment) && (
          <div className="flex gap-2 flex-wrap">
            {r.confidence_level && (
              <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                r.confidence_level === 'high' ? 'bg-green-100 text-green-700' :
                r.confidence_level === 'medium' ? 'bg-amber-100 text-amber-700' :
                'bg-red-100 text-red-700'
              }`}>ביטחון: {r.confidence_level === 'high' ? 'גבוה' : r.confidence_level === 'medium' ? 'בינוני' : 'נמוך'}</span>
            )}
            {r.risk_assessment && (
              <p className="text-xs text-surface-600 italic flex-1">{r.risk_assessment}</p>
            )}
          </div>
        )}

        {r.google && <GoogleKPIGrid g={r.google} />}
        {r.meta && <MetaKPIGrid m={r.meta} />}

        {/* New campaign monitoring — tells the owner what to do with campaigns
            launched in the last 14 days. Only renders if there's actually data. */}
        {Array.isArray(r.new_campaign_monitoring) && r.new_campaign_monitoring.length > 0 && (
          <div>
            <SectionHeader>🎯 ניטור קמפיינים חדשים (14 ימים אחרונים)</SectionHeader>
            <div className="space-y-2">
              {r.new_campaign_monitoring.map((m: any, i: number) => {
                const stageColor: Record<string, string> = {
                  learning:     'bg-yellow-50 border-yellow-200 text-yellow-800',
                  early_signal: 'bg-blue-50 border-blue-200 text-blue-800',
                  optimization: 'bg-green-50 border-green-200 text-green-800',
                  established:  'bg-surface-50 border-surface-200 text-surface-700',
                }
                const stageLabel: Record<string, string> = {
                  learning:     '🟡 Learning',
                  early_signal: '🔵 Early Signal',
                  optimization: '🟢 Optimization',
                  established:  '⚫ Established',
                }
                const cls = stageColor[m.stage] ?? stageColor.established
                const chan = m.channel === 'meta'   ? '📘 Meta'
                           : m.channel === 'google' ? '🔵 Google'
                           : m.channel ?? ''
                return (
                  <div key={i} className={`card p-3 border-r-4 ${cls}`}>
                    <div className="flex items-start justify-between gap-2 mb-1 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium opacity-80">{chan}</span>
                        <span className="text-sm font-semibold">{m.campaign_name}</span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-current">
                        {stageLabel[m.stage] ?? m.stage}
                      </span>
                    </div>
                    <p className="text-sm mt-2">
                      <span className="font-medium">פעולה השבוע:</span> {m.action ?? m.action_this_quarter}
                    </p>
                    {(() => {
                      const nk = (m.campaign_name ?? '').toLowerCase().replace(/[_\s|\-]+/g, ' ').trim()
                      const info = campaignCpa[nk]
                      // Real numbers from WooCommerce (ground truth) — NOT
                      // the inflated platform-reported "conversions" which
                      // include add-to-cart, view-content, etc. If the CPA
                      // looks too-good-to-be-true (<₪5), that means the
                      // platform filter didn't match any real orders and
                      // we're falling back to an estimate.
                      return (
                        <>
                          <div className="grid grid-cols-4 gap-1.5 mt-2 text-center">
                            <div className="bg-white/80 rounded px-2 py-1">
                              <p className="text-[10px] text-surface-500">הזמנות אמיתיות · 14 ימים</p>
                              <p className="text-xs font-bold font-mono text-emerald-700">
                                {info?.realOrders14 != null ? Number(info.realOrders14).toFixed(info.realOrders14 % 1 === 0 ? 0 : 1) : '—'}
                              </p>
                            </div>
                            <div className="bg-white/80 rounded px-2 py-1">
                              <p className="text-[10px] text-surface-500">CPA אמיתי · 14 ימים</p>
                              <p className="text-xs font-bold font-mono">
                                {info?.realCpa14 != null ? `₪${info.realCpa14.toFixed(0)}` : '—'}
                              </p>
                            </div>
                            <div className="bg-white/80 rounded px-2 py-1">
                              <p className="text-[10px] text-surface-500">ROAS אמיתי</p>
                              <p className={`text-xs font-bold font-mono ${info?.realRoas14 != null ? (info.realRoas14 >= 2 ? 'text-emerald-700' : info.realRoas14 >= 1 ? 'text-amber-700' : 'text-red-700') : ''}`}>
                                {info?.realRoas14 != null ? `${info.realRoas14.toFixed(2)}×` : '—'}
                              </p>
                            </div>
                            <div className="bg-white/80 rounded px-2 py-1">
                              <p className="text-[10px] text-surface-500">הוצאה · 14 ימים</p>
                              <p className="text-xs font-bold font-mono">
                                {info ? `₪${info.spend14.toLocaleString()}` : '—'}
                              </p>
                            </div>
                          </div>
                          {info?.reportedCpa14 != null && info?.realCpa14 != null && info.realCpa14 > info.reportedCpa14 * 5 && (
                            <p className="text-[10px] text-amber-600 mt-1">
                              ℹ️ הפלטפורמה מדווחת CPA ₪{info.reportedCpa14.toFixed(2)} (כולל add-to-cart), אבל רק {Number(info.realOrders14).toFixed(0)} הזמנות אמיתיות ב-WooCommerce = CPA אמיתי ₪{info.realCpa14.toFixed(0)}
                            </p>
                          )}
                        </>
                      )
                    })()}
                    <div className="flex gap-2 mt-2 flex-wrap text-[11px]">
                      {m.kill_threshold_ils && (
                        <span className="bg-red-50 border border-red-200 text-red-700 px-2 py-0.5 rounded-full">
                          🛑 עצור אם: {m.kill_threshold_ils}
                        </span>
                      )}
                      {m.scale_threshold_ils && (
                        <span className="bg-green-50 border border-green-200 text-green-700 px-2 py-0.5 rounded-full">
                          📈 הגדל אם: {m.scale_threshold_ils}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Cooldown banner — when the backend blocked new campaigns this cycle */}
        {r._compliance?.cooldownActive && (
          <div className="card p-3 border-r-4 bg-amber-50 border-amber-200">
            <p className="text-sm font-semibold text-amber-900 mb-1">⏸ קירור קמפיינים חדשים פעיל</p>
            <p className="text-xs text-amber-800">
              קמפיין אחד או יותר נמצא ב-Learning או Early Signal (פחות מ-7 ימים).
              המערכת חוסמת הצעות לקמפיינים חדשים עד שהפלטפורמות מסיימות את שלב הלמידה.
              {r._compliance.cooldownClears > 0 && (
                <> הוסרו {r._compliance.cooldownClears} קמפיינים שהוצעו בטעות בחודש 1.</>
              )}
            </p>
          </div>
        )}

        <BudgetRecs recs={r.budget_recommendations} />

        {/* Competitor insights */}
        {r.competitor_insights?.length > 0 && (
          <div>
            <SectionHeader>🔍 תובנות מתחרים</SectionHeader>
            <div className="space-y-2">
              {r.competitor_insights.map((ci: any, i: number) => (
                <div key={i} className="card p-3 border-r-4 border-purple-400 bg-purple-50">
                  <p className="text-sm font-medium text-purple-900 mb-1">{ci.competitor}</p>
                  <p className="text-xs text-purple-700 mb-1">{ci.finding}</p>
                  <p className="text-xs text-purple-600">▶ {ci.action}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Market opportunities */}
        {r.market_opportunities?.length > 0 && (
          <div>
            <SectionHeader>הזדמנויות שוק</SectionHeader>
            <div className="space-y-2">
              {r.market_opportunities.map((mo: any, i: number) => (
                <div key={i} className="card p-3 border-r-4 border-blue-400 bg-blue-50">
                  <p className="text-sm font-medium text-blue-900 mb-1">{mo.opportunity}</p>
                  <p className="text-xs text-blue-700 mb-1">▶ {mo.action}</p>
                  <p className="text-xs text-blue-600 italic">{mo.expected_impact}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Campaigns to create */}
        {r.campaigns_to_create?.length > 0 && (
          <div>
            <SectionHeader>🎯 קמפיינים ליצירה</SectionHeader>
            <div className="space-y-3">
              {r.campaigns_to_create.map((c: any, i: number) => (
                <div key={i} className="card p-3 border border-blue-200 bg-blue-50 space-y-2">
                  <p className="text-sm font-semibold text-blue-900">{c.campaign_name}</p>
                  <p className="text-xs text-blue-600">{c.campaign_type} · ₪{c.daily_budget_ils}/יום · {c.target_audience}</p>
                  {c.keywords?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {c.keywords.map((kw: any, j: number) => {
                        // Handle both formats: string (old) or {keyword, match_type, expected_cpc} (tactical)
                        const label = typeof kw === 'string' ? kw : `${kw.keyword} [${kw.match_type}]`;
                        const cpc = typeof kw === 'object' && kw.expected_cpc ? ` ₪${kw.expected_cpc}` : '';
                        return (
                          <span key={j} className="text-xs bg-white border border-blue-200 text-blue-700 px-2 py-0.5 rounded-full">{label}{cpc}</span>
                        );
                      })}
                    </div>
                  )}
                  {c.headlines?.length > 0 && (
                    <div className="bg-white rounded-lg p-2.5 space-y-1">
                      <p className="text-xs font-semibold text-surface-500">כותרות:</p>
                      {c.headlines.map((h: string, j: number) => (
                        <div key={j} className="flex items-center justify-between gap-2">
                          <p className="text-xs text-surface-800 font-mono">{h}</p>
                          <span className={`text-xs font-mono ${h.length > 30 ? 'text-red-500' : 'text-surface-400'}`}>{h.length}/30</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {c.landing_page_url && (
                    <div className="flex items-center gap-2 bg-blue-100 rounded-lg px-2.5 py-1.5">
                      <span className="text-[10px] text-blue-600 font-semibold shrink-0">🔗</span>
                      <a href={c.landing_page_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-800 hover:underline truncate flex-1 font-mono" dir="ltr">{c.landing_page_url}</a>
                      <CopyButton text={c.landing_page_url} />
                    </div>
                  )}
                  <p className="text-xs text-blue-700 italic">{c.rationale}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Meta campaign ideas — with on-demand "build full spec" button */}
        {r.meta_campaign_ideas?.length > 0 && (
          <div>
            <SectionHeader>📘 רעיונות קמפיין Meta (FB + IG)</SectionHeader>
            <p className="text-xs text-surface-500 mb-3">לחץ על "בנה מפרט מלא" כדי לקבל הוראות יישום ל-Ads Manager.</p>
            <div className="space-y-3">
              {r.meta_campaign_ideas.map((idea: any, i: number) => {
                const ideaId = idea.idea_id ?? idea.campaign_name ?? `idea_${i}`
                const build = metaBuild[ideaId]
                return (
                  <div key={i} className="card p-3 border border-indigo-200 bg-indigo-50 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-indigo-900">{idea.campaign_name}</p>
                        <p className="text-xs text-indigo-700 mt-0.5">{idea.one_line_pitch}</p>
                        <div className="flex gap-2 mt-1 flex-wrap">
                          {idea.audience_lens && (
                            <span className="text-[10px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">
                              🎯 {idea.audience_lens}
                            </span>
                          )}
                          {(idea.daily_budget_ils || idea.monthly_budget_ils) && (
                            <span className="text-[10px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">
                              💰 {idea.daily_budget_ils ? `₪${idea.daily_budget_ils}/יום` : `₪${idea.monthly_budget_ils}/חודש`}
                            </span>
                          )}
                          {idea.expected_cpa_range_ils && (
                            <span className="text-[10px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">
                              CPA צפוי: {idea.expected_cpa_range_ils}
                            </span>
                          )}
                          {idea.launch_month && (
                            <span className="text-[10px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">
                              חודש {idea.launch_month}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => buildMetaCampaign(idea)}
                        disabled={build?.loading}
                        className="text-xs shrink-0 bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {build?.loading ? '⏳ בונה...' : build?.spec ? '🔄 בנה שוב' : '🛠 בנה מפרט מלא'}
                      </button>
                    </div>

                    {build?.error && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700">
                        ❌ {build.error}
                      </div>
                    )}

                    {build?.spec && <MetaSpecView spec={build.spec} />}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Ads to rewrite */}
        {r.ads_to_rewrite?.length > 0 && (
          <div>
            <SectionHeader>✏️ מודעות לשכתוב</SectionHeader>
            <div className="space-y-2">
              {r.ads_to_rewrite.map((a: any, i: number) => (
                <div key={i} className="card p-3 border border-amber-200 bg-amber-50 space-y-2">
                  <p className="text-sm font-semibold text-amber-900">{a.campaign}</p>
                  {a.headline_fixes?.map((fix: any, j: number) => (
                    <div key={j} className="bg-white rounded-lg border border-surface-200 overflow-hidden">
                      <div className="px-3 py-2 bg-red-50 border-b border-red-100">
                        <p className="text-xs text-red-500 font-semibold mb-0.5">❌ קיים</p>
                        <p className="text-xs text-red-800 break-words">{fix.original}</p>
                      </div>
                      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-green-50">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-green-600 font-semibold mb-0.5">✅ החלפה</p>
                          <p className="text-xs text-green-900">{fix.replacement}</p>
                        </div>
                        <CopyButton text={fix.replacement} />
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-green-700 bg-green-50 rounded px-2 py-1">✓ {a.expected_improvement}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Negative keywords */}
        {r.negative_keywords_to_add?.length > 0 && (
          <div>
            <SectionHeader>🚫 מילות מפתח שליליות</SectionHeader>
            <div className="space-y-2">
              {r.negative_keywords_to_add.map((nk: any, i: number) => (
                <div key={i} className="card p-3 border-r-4 border-amber-400 bg-amber-50">
                  <p className="text-sm font-medium text-amber-900 mb-1">{nk.campaign}</p>
                  <div className="flex flex-wrap gap-1">
                    {nk.keywords.map((kw: string, j: number) => (
                      <span key={j} className="text-xs bg-white border border-amber-200 text-amber-700 px-2 py-0.5 rounded-full">-{kw}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* === Strategic 90-day fields (only present in strategist_precise) === */}

        {/* Current diagnosis */}
        {r.current_diagnosis && (
          <div className="card p-3 bg-amber-50 border-amber-200">
            <p className="text-xs font-semibold text-amber-800 mb-1">🔍 אבחון מצב</p>
            <p className="text-sm text-amber-900 leading-relaxed">{r.current_diagnosis}</p>
          </div>
        )}

        {/* 90-day target */}
        {r.target_90_days && (
          <div className="card p-3 bg-green-50 border-green-200">
            <p className="text-xs font-semibold text-green-800 mb-1">🎯 יעד ל-90 ימים</p>
            <p className="text-sm text-green-900 leading-relaxed">{r.target_90_days}</p>
          </div>
        )}

        {/* Monthly roadmap */}
        {r.monthly_roadmap?.length > 0 && (
          <div>
            <SectionHeader>🗺️ מפת דרכים חודשית</SectionHeader>
            <div className="space-y-3">
              {r.monthly_roadmap.map((m: any, i: number) => (
                <div key={i} className="card p-4 border-r-4 border-indigo-400 bg-indigo-50 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold text-indigo-900">{m.month}</p>
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-mono">₪{m.budget_total?.toLocaleString()}</span>
                  </div>
                  <p className="text-sm font-medium text-indigo-800">{m.theme}</p>
                  {m.audience_focus && <p className="text-xs text-indigo-700">👥 {m.audience_focus}</p>}
                  {m.content_strategy && <p className="text-xs text-indigo-600">📝 {m.content_strategy}</p>}
                  {m.seasonal_events && <p className="text-xs text-purple-600">📅 {m.seasonal_events}</p>}
                  {m.kpi_targets && typeof m.kpi_targets === 'object' && Object.keys(m.kpi_targets).length > 0 && (
                    <div className="flex gap-2 flex-wrap mt-1">
                      {m.kpi_targets.roas && <span className="text-[10px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">ROAS {m.kpi_targets.roas}x</span>}
                      {m.kpi_targets.conversions_per_week && <span className="text-[10px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">{m.kpi_targets.conversions_per_week} המרות/שבוע</span>}
                      {m.kpi_targets.new_customers && <span className="text-[10px] bg-white border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">{m.kpi_targets.new_customers} לקוחות חדשים</span>}
                    </div>
                  )}
                  {/* Implementation — campaigns with full specs */}
                  {m.implementation?.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {m.implementation.map((impl: any, j: number) => (
                        <div key={j} className="bg-white rounded-lg border border-indigo-200 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-bold text-indigo-900">{impl.campaign_name}</p>
                            <span className="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{impl.campaign_type} · ₪{impl.daily_budget_ils}/יום</span>
                          </div>
                          {impl.launch_when && <p className="text-[10px] text-indigo-600">🚀 השקה: {impl.launch_when}</p>}
                          {impl.keywords?.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {impl.keywords.map((kw: any, k: number) => (
                                <span key={k} className="text-[10px] bg-indigo-50 border border-indigo-200 text-indigo-700 px-1.5 py-0.5 rounded-full">{typeof kw === 'string' ? kw : `${kw.keyword} [${kw.match_type}]`}</span>
                              ))}
                            </div>
                          )}
                          {impl.headlines?.length > 0 && (
                            <div className="space-y-0.5">
                              <p className="text-[10px] text-surface-500 font-semibold">כותרות:</p>
                              {impl.headlines.slice(0, 5).map((h: string, k: number) => (
                                <div key={k} className="flex items-center justify-between gap-1">
                                  <p className="text-[10px] text-surface-800 font-mono">{h}</p>
                                  <span className={`text-[9px] font-mono ${h.length > 30 ? 'text-red-500' : 'text-surface-400'}`}>{h.length}/30</span>
                                </div>
                              ))}
                              {impl.headlines.length > 5 && <p className="text-[9px] text-surface-400">+{impl.headlines.length - 5} עוד</p>}
                            </div>
                          )}
                          {impl.descriptions?.length > 0 && (
                            <div className="space-y-0.5">
                              <p className="text-[10px] text-surface-500 font-semibold">תיאורים:</p>
                              {impl.descriptions.map((d: string, k: number) => (
                                <p key={k} className="text-[10px] text-surface-700">{d}</p>
                              ))}
                            </div>
                          )}
                          {impl.landing_page_url && (
                            <div className="flex items-center gap-1">
                              <span className="text-[9px] text-indigo-500">🔗</span>
                              <a href={impl.landing_page_url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-indigo-600 hover:underline truncate font-mono" dir="ltr">{impl.landing_page_url}</a>
                              <CopyButton text={impl.landing_page_url} />
                            </div>
                          )}
                          {impl.success_criteria && <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1">📊 סף הצלחה: {impl.success_criteria}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Audience build plan */}
        {r.audience_build_plan?.length > 0 && (
          <div>
            <SectionHeader>👥 תכנית בניית קהלים</SectionHeader>
            <div className="space-y-2">
              {r.audience_build_plan.map((a: any, i: number) => (
                <div key={i} className="card p-3 border-r-4 border-blue-400 bg-blue-50">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-blue-900">{a.phase}</p>
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{a.budget_pct}% תקציב</span>
                  </div>
                  <p className="text-xs text-blue-800">{a.audience}</p>
                  {a.message && <p className="text-xs text-blue-600 italic mt-1">"{a.message}"</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Competitor long-term strategy */}
        {r.competitor_strategy?.length > 0 && (
          <div>
            <SectionHeader>🏴 אסטרטגיית מתחרים</SectionHeader>
            <div className="space-y-2">
              {r.competitor_strategy.map((cs: any, i: number) => (
                <div key={i} className="card p-3 border-r-4 border-red-400 bg-red-50">
                  <p className="text-sm font-medium text-red-900 mb-1">{cs.competitor}</p>
                  <p className="text-xs text-red-700">חולשה: {cs.their_weakness}</p>
                  <p className="text-xs text-red-600 mt-1">▶ {cs.our_attack}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Risk and pivot */}
        {r.risk_and_pivot && (
          <div className="card p-3 bg-amber-50 border-amber-200">
            <p className="text-xs font-semibold text-amber-800 mb-1">⚠️ סיכון ותכנית B</p>
            <p className="text-xs text-amber-900 leading-relaxed">{r.risk_and_pivot}</p>
          </div>
        )}

        {/* === Tactical weekly fields (only present in strategist_aggressive) === */}

        {/* Weekly action plan */}
        {r.weekly_action_plan?.length > 0 && (
          <div>
            <SectionHeader>📅 תכנית פעולה שבועית</SectionHeader>
            <div className="space-y-2">
              {r.weekly_action_plan.map((a: any, i: number) => (
                <div key={i} className="card p-3 border-r-4 border-green-400 bg-green-50">
                  <p className="text-sm font-bold text-green-900 mb-1">{a.day}</p>
                  <p className="text-xs text-green-800">{a.action}</p>
                  {a.expected_result && <p className="text-xs text-green-600 mt-1">צפי: {a.expected_result}</p>}
                  {a.how_to_measure && <p className="text-xs text-green-500 mt-0.5">📊 {a.how_to_measure}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Wednesday check */}
        {r.wednesday_check && (
          <div className="card p-3 bg-yellow-50 border-yellow-300">
            <p className="text-xs font-semibold text-yellow-800 mb-1">📊 בדיקת רביעי</p>
            <p className="text-xs text-yellow-900 leading-relaxed">{r.wednesday_check}</p>
          </div>
        )}

        <KeyInsights insights={r.key_insights} />
      </div>
    )
  }

  return (
    <div className="space-y-6 fade-up">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-display font-semibold text-surface-900">יועץ שיווק AI</h2>
            <p className="text-sm text-surface-400 mt-1">
              {selectedWeek ? `שבוע ${formatWeek(selectedWeek)}` : 'טרם הופעל'} · 3 סוכנים
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isRunning && (
              <button
                onClick={cancelAdvisor}
                className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 bg-white px-3 py-1.5 rounded-xl transition-colors"
              >
                <XCircle size={14} /> עצור
              </button>
            )}
            <button
              onClick={runAdvisor}
              disabled={isRunning}
              className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              title="הרץ את שלושת הסוכנים"
            >
              {isRunning
                ? <><Loader2 size={14} className="animate-spin" /> מנתח...</>
                : <><RefreshCw size={14} /> הרץ הכל</>}
            </button>
          </div>
        </div>

        {/* Week history — moved from the bottom of the page into the header.
            Comparing weeks is a first-class action, so the week pills belong
            right next to the "current week" label, not buried 3,000px down
            the page. Only renders when there's more than one week to switch
            between. */}
        {availableWeeks.length > 1 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-surface-400 font-medium">שבועות:</span>
            {availableWeeks.slice(0, 8).map(week => (
              <button
                key={week}
                onClick={() => setSelectedWeek(week)}
                className={`text-xs px-3 py-1 rounded-full transition-colors ${week === selectedWeek ? 'bg-surface-900 text-white' : 'bg-surface-100 text-surface-600 hover:bg-surface-200'}`}
              >
                {formatWeek(week)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Triage — the top N actions ranked across all 3 agents. This is
          the "what should I actually do this week" layer on top of the
          raw recommendations the 3 panels below expose. Hidden when no
          reports have loaded yet (and when no actionable items parsed). */}
      <ActionQueue rows={rows} weekKey={selectedWeek} />

      {/* Focus context */}
      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-surface-500 uppercase tracking-wider">
            הוראות לסוכנים
          </label>
          {focus.trim() && (
            <span className="text-xs text-brand-600 font-medium">● פעיל</span>
          )}
        </div>
        <textarea
          value={focus}
          onChange={e => { setFocus(e.target.value); localStorage.setItem('advisor_focus', e.target.value) }}
          placeholder="לדוגמה: התמקד במכירות קפה ספשלטי, אנחנו רוצים לגדול בתחום זה. שים דגש על מילות מפתח הקשורות לספשלטי ועל פוסטים שמדגישים את מקור הפולים."
          rows={2}
          dir="rtl"
          className="w-full text-sm border border-surface-200 rounded-xl px-4 py-2.5 bg-surface-50 focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400 transition placeholder:text-surface-300 resize-none"
        />
        <p className="text-xs text-surface-400">
          ההוראות יישלחו לכל שלושת הסוכנים בלחיצה על "הרץ עכשיו". נשמר אוטומטית.
        </p>
      </div>

      {/* Chat with the advisor — ad-hoc questions grounded in this week's data */}
      {/* Campaign audit — rule-based + Claude strategic findings */}
      <div className="card p-4 space-y-3 border border-rose-200 bg-gradient-to-br from-rose-50/40 to-transparent">
        <div className="flex items-center justify-between gap-3 flex-wrap" dir="rtl">
          <div>
            <p className="text-sm font-semibold text-rose-900 flex items-center gap-2">
              🔍 ביקורת קמפיינים
              {auditResult && (
                <span className="text-[10px] bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">
                  {auditResult.critical} קריטי · {auditResult.warning} אזהרות
                </span>
              )}
            </p>
            <p className="text-xs text-rose-700 mt-0.5">
              בודק טעויות בקמפיינים שלך — trademark, character limits, objective mismatch, keyword coverage ועוד.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={runCampaignAudit}
              disabled={auditLoading}
              className="text-sm bg-rose-600 text-white px-4 py-2 rounded-xl font-medium hover:bg-rose-700 disabled:opacity-50"
            >
              {auditLoading ? '🔍 בודק...' : auditResult ? '🔄 הרץ שוב' : '🔍 הרץ ביקורת'}
            </button>
            {auditResult && (
              <button
                onClick={() => setAuditOpen(o => !o)}
                className="text-sm bg-white border border-rose-200 text-rose-700 px-3 py-2 rounded-xl hover:bg-rose-50"
              >
                {auditOpen ? 'סגור' : 'פתח'}
              </button>
            )}
          </div>
        </div>

        {auditError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700" dir="rtl">
            ❌ {auditError}
          </div>
        )}

        {auditResult && auditOpen && (
          <div className="max-h-[500px] overflow-y-auto space-y-2 pr-1" dir="rtl">
            <p className="text-xs text-rose-700">
              נבדקו {auditResult.checked.google_campaigns} קמפיינים ו-{auditResult.checked.google_ads} מודעות ב-Google,
              ו-{auditResult.checked.meta_campaigns} קמפיינים ב-Meta.
              נמצאו <strong>{auditResult.total}</strong> ממצאים.
            </p>
            {(auditResult.findings ?? []).map((f: any, i: number) => {
              const sevColor: Record<string, string> = {
                critical: 'border-red-300 bg-red-50',
                warning:  'border-amber-300 bg-amber-50',
                info:     'border-blue-200 bg-blue-50',
              }
              const sevLabel: Record<string, string> = {
                critical: '🛑 קריטי',
                warning:  '⚠️ אזהרה',
                info:     'ℹ️ מידע',
              }
              const chan = f.channel === 'meta' ? '📘 Meta' : f.channel === 'google' ? '🔵 Google' : f.channel
              return (
                <div key={i} className={`card p-3 border-r-4 ${sevColor[f.severity] ?? 'bg-surface-50'}`}>
                  {/* Severity + channel chip row */}
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white border border-current">
                      {sevLabel[f.severity] ?? f.severity}
                    </span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-current">
                      {chan}
                    </span>
                  </div>

                  {/* Campaign + ad names — big and bold, can't miss them */}
                  <div className="mb-2 text-right" dir="rtl">
                    <p className="text-sm font-bold text-surface-900 break-words">
                      📢 {f.campaign || '(ללא שם קמפיין)'}
                    </p>
                    {f.ad && (
                      <p className="text-xs text-surface-700 mt-0.5 break-words">
                        ↳ מודעה: <span className="font-mono">{f.ad}</span>
                      </p>
                    )}
                  </div>

                  {/* Issue + evidence + fix */}
                  <div className="space-y-1" dir="rtl">
                    <p className="text-sm font-semibold">🔍 {f.issue}</p>
                    {f.evidence && (
                      <p className="text-xs text-surface-700 bg-white/60 rounded px-2 py-1 font-mono break-words">
                        {f.evidence}
                      </p>
                    )}
                    <p className="text-sm"><strong>💡 תיקון:</strong> {f.recommendation}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Campaign Doctor — deep per-campaign diagnosis + ready-to-paste fix plan */}
      <div className="card p-4 space-y-3 border border-emerald-200 bg-gradient-to-br from-emerald-50/40 to-transparent">
        <div className="flex items-center justify-between gap-3 flex-wrap" dir="rtl">
          <div>
            <p className="text-sm font-semibold text-emerald-900 flex items-center gap-2">
              🧑‍⚕️ דוקטור הקמפיינים
              {doctorResult && (
                <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                  {doctorResult.campaigns_analyzed} קמפיינים אובחנו
                </span>
              )}
              {doctorResult?.signals?.budget_cap_suspected && (
                <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                  ⚠️ חשד לתקרת תקציב
                </span>
              )}
            </p>
            <p className="text-xs text-emerald-700 mt-0.5">
              לכל קמפיין פעיל (Google + Meta): אבחון מלא + ניתוח קהל/targeting + mix קריאייטיב + הצעות מחיר והגדרות רשת + 12 כותרות + 3 תיאורים + מבנה מילות מפתח + negatives + תיקוני מעקב. מוכן להדבקה ב-Google Ads / Meta Ads Manager.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={runCampaignDoctor}
              disabled={doctorLoading}
              className="text-sm bg-emerald-600 text-white px-4 py-2 rounded-xl font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {doctorLoading ? '🧑‍⚕️ מאבחן... (עד 2 דקות)' : doctorResult ? '🔄 אבחן שוב' : '🧑‍⚕️ אבחן קמפיינים'}
            </button>
            {doctorResult && (
              <button
                onClick={() => setDoctorOpen(o => !o)}
                className="text-sm bg-white border border-emerald-200 text-emerald-700 px-3 py-2 rounded-xl hover:bg-emerald-50"
              >
                {doctorOpen ? 'סגור' : 'פתח'}
              </button>
            )}
          </div>
        </div>

        {doctorError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700" dir="rtl">
            ❌ {doctorError}
          </div>
        )}

        {/* Diagnostics banner — shown only when the doctor had trouble returning
            all campaigns (e.g., one of the parallel Google/Meta calls errored,
            Claude dropped a campaign, or emitted a name that didn't match). */}
        {doctorResult?.diagnostics && (
          (doctorResult.diagnostics.missing_from_output?.length > 0 ||
           doctorResult.diagnostics.dropped_unknown_names?.length > 0 ||
           doctorResult.diagnostics.call_errors?.length > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800" dir="rtl">
              <p className="font-semibold mb-1">⚠️ התרעות דוקטור (חלק מהקמפיינים לא חזרו):</p>
              {doctorResult.diagnostics.missing_from_output?.length > 0 && (
                <p>
                  <strong>חסרים מהתוצאה:</strong>{' '}
                  {doctorResult.diagnostics.missing_from_output.join(', ')}
                </p>
              )}
              {doctorResult.diagnostics.dropped_unknown_names?.length > 0 && (
                <p>
                  <strong>שמות לא מוכרים שנפלו:</strong>{' '}
                  {doctorResult.diagnostics.dropped_unknown_names.join(', ')}
                </p>
              )}
              {doctorResult.diagnostics.call_errors?.length > 0 && (
                <p>
                  <strong>שגיאות בקריאת Claude:</strong>{' '}
                  {doctorResult.diagnostics.call_errors.join('; ')}
                </p>
              )}
            </div>
          )
        )}

        {doctorResult && doctorOpen && (
          <div className="space-y-3" dir="rtl">
            {(doctorResult.campaigns ?? []).map((c: any, i: number) => {
              const priColor: Record<string, string> = {
                critical: 'border-red-400 bg-red-50',
                high:     'border-amber-400 bg-amber-50',
                medium:   'border-blue-300 bg-blue-50',
              }
              const priLabel: Record<string, string> = {
                critical: '🛑 קריטי',
                high:     '🔥 גבוה',
                medium:   'ℹ️ בינוני',
              }
              const chan = c.channel === 'meta' ? '📘 Meta' : '🔵 Google'
              const expanded = doctorExpandedCampaign === c.name
              const kp = c.keyword_plan || {}
              return (
                <div key={i} className={`card p-3 border-r-4 ${priColor[c.priority] ?? 'bg-surface-50'}`}>
                  {/* Header row */}
                  <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white border">
                        {priLabel[c.priority] ?? c.priority}
                      </span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-white border">
                        {chan}
                      </span>
                    </div>
                    <button
                      onClick={() => setDoctorExpandedCampaign(expanded ? null : c.name)}
                      className="text-xs text-emerald-700 hover:text-emerald-900 underline"
                    >
                      {expanded ? 'קפל' : 'הצג הכל'}
                    </button>
                  </div>

                  {/* Campaign name */}
                  <p className="text-sm font-bold text-surface-900 break-words mb-2">
                    📢 {c.name}
                  </p>

                  {/* Current KPIs — always visible, top of card */}
                  {c.totals_14d && (
                    <div className="grid grid-cols-3 gap-1.5 mb-3 text-center">
                      <div className="bg-white/80 rounded px-2 py-1.5">
                        <p className="text-[10px] text-surface-500">CPA · 5 ימים</p>
                        <p className="text-sm font-bold font-mono text-surface-900">
                          {c.totals_14d.cpa_last_5_days != null
                            ? `₪${c.totals_14d.cpa_last_5_days.toFixed(2)}`
                            : '—'}
                        </p>
                      </div>
                      <div className="bg-white/80 rounded px-2 py-1.5">
                        <p className="text-[10px] text-surface-500">CPA · 14 ימים</p>
                        <p className="text-sm font-bold font-mono text-surface-900">
                          {c.totals_14d.cpa != null
                            ? `₪${c.totals_14d.cpa.toFixed(2)}`
                            : '—'}
                        </p>
                      </div>
                      <div className="bg-white/80 rounded px-2 py-1.5">
                        <p className="text-[10px] text-surface-500">הוצאה · 14 ימים</p>
                        <p className="text-sm font-bold font-mono text-surface-900">
                          ₪{(c.totals_14d.spend ?? 0).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Diagnosis — always visible */}
                  <div className="mb-2">
                    <p className="text-xs font-semibold text-surface-700 mb-1">🔍 אבחון:</p>
                    <ul className="text-xs space-y-0.5 list-disc pr-5">
                      {(c.diagnosis ?? []).map((d: string, j: number) => (
                        <li key={j}>{d}</li>
                      ))}
                    </ul>
                  </div>

                  {/* New: Audience / Creative / Bid diagnoses — only shown when populated.
                      These come from the extended Campaign Doctor that now reads adset
                      targeting, ad creatives, and campaign settings (bid strategy,
                      network, conversion action roles). */}
                  {c.audience_diagnosis?.length > 0 && (
                    <div className="mb-2 bg-violet-50 border border-violet-200 rounded px-2 py-1.5">
                      <p className="text-xs font-semibold text-violet-900 mb-1">🎯 קהל / Targeting:</p>
                      <ul className="text-xs space-y-0.5 list-disc pr-5 text-violet-900">
                        {c.audience_diagnosis.map((d: string, j: number) => (
                          <li key={j}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.creative_diagnosis?.length > 0 && (
                    <div className="mb-2 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
                      <p className="text-xs font-semibold text-rose-900 mb-1">🎨 קריאייטיב:</p>
                      <ul className="text-xs space-y-0.5 list-disc pr-5 text-rose-900">
                        {c.creative_diagnosis.map((d: string, j: number) => (
                          <li key={j}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.bid_strategy_diagnosis?.length > 0 && (
                    <div className="mb-2 bg-sky-50 border border-sky-200 rounded px-2 py-1.5">
                      <p className="text-xs font-semibold text-sky-900 mb-1">🎚️ הצעות מחיר והגדרות:</p>
                      <ul className="text-xs space-y-0.5 list-disc pr-5 text-sky-900">
                        {c.bid_strategy_diagnosis.map((d: string, j: number) => (
                          <li key={j}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Quick actions — always visible */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
                    {c.budget_action && (
                      <div className="bg-white/70 rounded px-2 py-1.5 text-xs">
                        <strong>💰 תקציב:</strong> {c.budget_action.type}
                        {c.budget_action.from_ils != null && c.budget_action.to_ils != null
                          ? ` ₪${c.budget_action.from_ils} → ₪${c.budget_action.to_ils}` : ''}
                        <p className="text-surface-600 mt-0.5">{c.budget_action.reason}</p>
                      </div>
                    )}
                    {c.landing_action && (
                      <div className="bg-white/70 rounded px-2 py-1.5 text-xs">
                        <strong>🎯 עמוד נחיתה:</strong> {c.landing_action.type}
                        {c.landing_action.new_url && (
                          <p className="font-mono text-[10px] break-all mt-0.5">{c.landing_action.new_url}</p>
                        )}
                        <p className="text-surface-600 mt-0.5">{c.landing_action.reason}</p>
                      </div>
                    )}
                  </div>

                  {c.tracking_fixes?.length > 0 && (
                    <div className="bg-amber-100/50 border border-amber-200 rounded px-2 py-1.5 text-xs mb-2">
                      <p className="font-semibold text-amber-900">🛠️ תיקוני מעקב:</p>
                      <ul className="list-disc pr-5 mt-0.5 space-y-0.5">
                        {c.tracking_fixes.map((t: string, j: number) => (
                          <li key={j}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.expected_improvement && (
                    <p className="text-xs text-emerald-800 font-medium mb-1">
                      📈 צפוי: {c.expected_improvement}
                    </p>
                  )}

                  {/* Expanded — creative + full keyword plan */}
                  {expanded && (
                    <div className="mt-3 space-y-3 border-t border-emerald-200 pt-3">
                      {c.new_headlines?.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-surface-700 mb-1">
                            ✍️ 20 כותרות חדשות (העתק ל-Google Ads):
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                            {c.new_headlines.map((h: string, j: number) => (
                              <div key={j} className="text-xs bg-white rounded px-2 py-1 font-mono break-words">
                                {j + 1}. {h}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {c.new_descriptions?.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-surface-700 mb-1">
                            📝 4 תיאורים חדשים:
                          </p>
                          <div className="space-y-1">
                            {c.new_descriptions.map((d: string, j: number) => (
                              <div key={j} className="text-xs bg-white rounded px-2 py-1.5 break-words">
                                {j + 1}. {d}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {(kp.exact?.length || kp.phrase?.length || kp.broad?.length) && (
                        <div>
                          <p className="text-xs font-semibold text-surface-700 mb-1">
                            🎯 מבנה מילות מפתח (3 רבדים):
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            {kp.exact?.length > 0 && (
                              <div className="bg-white rounded p-2">
                                <p className="text-[11px] font-bold text-emerald-700 mb-1">EXACT (כוונה גבוהה)</p>
                                <div className="space-y-0.5">
                                  {kp.exact.map((k: string, j: number) => (
                                    <div key={j} className="text-[11px] font-mono break-words">{k}</div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {kp.phrase?.length > 0 && (
                              <div className="bg-white rounded p-2">
                                <p className="text-[11px] font-bold text-blue-700 mb-1">PHRASE (וריאציות)</p>
                                <div className="space-y-0.5">
                                  {kp.phrase.map((k: string, j: number) => (
                                    <div key={j} className="text-[11px] font-mono break-words">{k}</div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {kp.broad?.length > 0 && (
                              <div className="bg-white rounded p-2">
                                <p className="text-[11px] font-bold text-amber-700 mb-1">BROAD (עם Smart Bidding)</p>
                                <div className="space-y-0.5">
                                  {kp.broad.map((k: string, j: number) => (
                                    <div key={j} className="text-[11px] font-mono break-words">{k}</div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {kp.negatives?.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-surface-700 mb-1">
                            🚫 Negative keywords (הדבק ברמת הקמפיין):
                          </p>
                          <div className="bg-red-50 border border-red-200 rounded p-2">
                            <div className="flex flex-wrap gap-1">
                              {kp.negatives.map((k: string, j: number) => (
                                <span key={j} className="text-[11px] font-mono bg-white rounded px-1.5 py-0.5 border border-red-200">
                                  -{k.replace(/^-/, '')}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="card p-4 space-y-3 border border-indigo-200 bg-gradient-to-br from-indigo-50/40 to-transparent">
        <button
          onClick={() => setChatOpen(o => !o)}
          className="w-full flex items-center justify-between text-right focus:outline-none"
          dir="rtl"
        >
          <span className="text-sm font-semibold text-indigo-900 flex items-center gap-2">
            💬 שאל את היועץ
            {chatMessages.length > 0 && (
              <span className="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{chatMessages.length} הודעות</span>
            )}
          </span>
          <span className="text-xs text-indigo-500">{chatOpen ? 'סגור' : 'פתח'}</span>
        </button>

        {chatOpen && (
          <>
            {chatMessages.length === 0 && (
              <div className="space-y-2">
                <p className="text-xs text-indigo-700">שאלות פופולריות — לחץ על אחת או הקלד שאלה משלך:</p>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    'איזה קמפיין Meta הכי משתלם לי, וכמה ₪ להעביר אליו ומאיפה?',
                    'האם להגדיל קמפיין קיים או לפתוח חדש?',
                    'מה הקמפיין הכי מבזבז לי כסף?',
                    'מה חולשה אצל נחת שאני יכול לנצל השבוע?',
                    'איזה כותרת מודעה בעלת CTR הכי גבוה?',
                    'מה ה-ROAS של Google מול Meta השבוע?',
                  ].map((q, i) => (
                    <button
                      key={i}
                      onClick={() => sendChatQuestion(q)}
                      disabled={chatLoading}
                      className="text-xs bg-white border border-indigo-200 text-indigo-700 px-2.5 py-1 rounded-full hover:bg-indigo-50 disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {chatMessages.length > 0 && (
              <div className="max-h-[400px] overflow-y-auto space-y-2 pr-1" dir="rtl">
                {chatMessages.map((m, i) => (
                  <div
                    key={i}
                    className={`rounded-lg p-2.5 text-sm whitespace-pre-wrap ${
                      m.role === 'user'
                        ? 'bg-indigo-100 text-indigo-900 mr-8'
                        : 'bg-white border border-indigo-200 text-surface-800 ml-8'
                    }`}
                  >
                    <p className="text-[10px] font-semibold opacity-60 mb-1">{m.role === 'user' ? '🧑 אתה' : '🤖 היועץ'}</p>
                    <p className="leading-relaxed">{m.content}</p>
                  </div>
                ))}
                {chatLoading && (
                  <div className="bg-white border border-indigo-200 rounded-lg p-2.5 ml-8 text-sm text-surface-500">
                    <p className="text-[10px] font-semibold opacity-60 mb-1">🤖 היועץ</p>
                    <p>חושב...</p>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatQuestion(); } }}
                placeholder="שאל שאלה — לדוגמה 'מה הקמפיין הכי משתלם שלי ב-Google?'"
                disabled={chatLoading}
                dir="rtl"
                className="flex-1 text-sm border border-indigo-200 rounded-xl px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-50"
              />
              <button
                onClick={() => sendChatQuestion()}
                disabled={chatLoading || !chatInput.trim()}
                className="text-sm bg-indigo-600 text-white px-4 py-2 rounded-xl font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                שאל
              </button>
              {chatMessages.length > 0 && (
                <button
                  onClick={clearChat}
                  disabled={chatLoading}
                  className="text-xs bg-surface-100 text-surface-600 px-2 py-2 rounded-xl hover:bg-surface-200 disabled:opacity-50"
                  title="נקה היסטוריה"
                >
                  🗑
                </button>
              )}
            </div>
            <p className="text-[10px] text-surface-400" dir="rtl">
              מבוסס על הנתונים של השבוע הזה ({selectedWeek}) — הסוכנים, הקמפיינים, ומחקר השוק. היסטוריה נשמרת בדפדפן.
            </p>
          </>
        )}
      </div>

      {/* Two competing strategists — side by side on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {strategistPanels.map(({ key, label, sublabel, icon, headerColor }) => (
          <div key={key} className="card flex flex-col">
            <div className={`flex items-start justify-between mb-4 pb-3 border-b ${headerColor}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {icon}
                  <h3 className="font-display font-semibold text-surface-900 text-sm">{label}</h3>
                </div>
                <p className="text-xs text-surface-400 mt-0.5 mr-6">{sublabel}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {rows[key] && <StatusBadge status={rows[key]!.status} />}
                <button
                  onClick={() => runAdvisor(key)}
                  disabled={rows[key]?.status === 'running' || running}
                  title="הרץ רק את הסוכן הזה"
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-surface-300 bg-white text-surface-600 hover:bg-surface-50 hover:text-surface-900 disabled:opacity-30 transition-colors"
                >
                  <RefreshCw size={11} />
                  הרץ
                </button>
              </div>
            </div>
            <div className="flex-1">
              {loading
                ? <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 bg-surface-100 rounded animate-pulse" />)}</div>
                : renderStrategyPanel(rows[key], () => runAdvisor(key), isRunning, key)}
            </div>
          </div>
        ))}
      </div>

      {/* Organic content — full width below the strategists */}
      <div className="card flex flex-col">
        <div className={`flex items-start justify-between mb-4 pb-3 border-b ${organicPanel.headerColor}`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {organicPanel.icon}
              <h3 className="font-display font-semibold text-surface-900 text-sm">{organicPanel.label}</h3>
            </div>
            <p className="text-xs text-surface-400 mt-0.5 mr-6">{organicPanel.sublabel}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {rows[organicPanel.key] && <StatusBadge status={rows[organicPanel.key]!.status} />}
            <button
              onClick={() => runAdvisor(organicPanel.key)}
              disabled={rows[organicPanel.key]?.status === 'running' || running}
              title="הרץ רק את הסוכן הזה"
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-surface-300 bg-white text-surface-600 hover:bg-surface-50 hover:text-surface-900 disabled:opacity-30 transition-colors"
            >
              <RefreshCw size={11} />
              הרץ
            </button>
          </div>
        </div>
        <div className="flex-1">
          {loading
            ? <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 bg-surface-100 rounded animate-pulse" />)}</div>
            : <OrganicPanel row={rows[organicPanel.key]} blogState={blogState} setBlogState={setBlogState} writeBlogPost={writeBlogPost} generateBanner={generateBanner} allProducts={allProducts} onRun={() => runAdvisor(organicPanel.key)} running={isRunning} />}
        </div>
      </div>

      {/* Full empty state */}
      {!loading && availableWeeks.length === 0 && (
        <div className="card text-center py-20">
          <div className="text-5xl mb-4">🤖</div>
          <h3 className="text-lg font-display font-semibold text-surface-800 mb-2">הסוכנים עדיין לא הופעלו</h3>
          <p className="text-sm text-surface-400 max-w-sm mx-auto mb-6">
            לחץ "הרץ עכשיו" — שלושת הסוכנים ינתחו את הנתונים ויציגו המלצות לשבוע הבא.
          </p>
          <button onClick={runAdvisor} disabled={isRunning} className="btn btn-primary mx-auto flex items-center gap-2">
            <RefreshCw size={14} /> הרץ ניתוח ראשון
          </button>
        </div>
      )}
    </div>
  )
}
