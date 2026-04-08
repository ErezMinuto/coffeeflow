import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { TrendingUp, Shield, Leaf, RefreshCw, AlertCircle, Loader2, Copy, Check, ChevronDown, ChevronUp, XCircle } from 'lucide-react'

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
  headlines: string[]
  descriptions: string[]
  daily_budget_ils: number
  rationale: string
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
  topic: string
  best_day: string
  best_time: string
  caption: string
  hashtags: string[]
  hook: string
  visual_direction: string
}

interface GrowthReport {
  agent_philosophy: string
  summary: string
  google: GoogleKPIs | null
  budget_recommendations: BudgetRec[]
  growth_opportunities: { opportunity: string; action: string; expected_impact: string }[]
  campaigns_to_create: CampaignToCreate[]
  key_insights: string[]
  next_week_focus: string
}

interface EfficiencyReport {
  agent_philosophy: string
  summary: string
  google: GoogleKPIs | null
  budget_recommendations: BudgetRec[]
  waste_identified: { campaign: string; issue: string; estimated_waste: string; fix: string }[]
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

// ── Shared sub-components ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AdvisorReport['status'] }) {
  if (status === 'done')      return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">✓ הושלם</span>
  if (status === 'running')   return <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1"><Loader2 size={10} className="animate-spin" />מנתח...</span>
  if (status === 'error')     return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">✗ שגיאה</span>
  if (status === 'cancelled') return <span className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded-full font-medium">✕ בוטל</span>
  return <span className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded-full font-medium">ממתין</span>
}

function PanelEmpty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center text-surface-400">
      <div className="text-3xl mb-2">🤖</div>
      <p className="text-sm text-surface-500">{label} טרם הופעל</p>
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
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        { label: 'הוצאה', value: `₪${g.total_cost.toLocaleString()}` },
        { label: 'קליקים', value: g.total_clicks.toLocaleString() },
        { label: 'המרות', value: g.total_conversions },
        { label: 'ROAS', value: `${g.roas}x` },
      ].map(k => (
        <div key={k.label} className="bg-surface-50 rounded-xl p-2.5 text-center">
          <p className="text-base font-bold font-mono text-surface-900">{k.value}</p>
          <p className="text-xs text-surface-400 mt-0.5">{k.label}</p>
        </div>
      ))}
    </div>
  )
}

function BudgetRecs({ recs }: { recs: BudgetRec[] }) {
  if (!recs?.length) return null
  return (
    <div>
      <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">המלצות תקציב</h4>
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
            <p className="text-xs text-surface-500 mt-1">{r.reason}</p>
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
      <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">תובנות</h4>
      <ul className="space-y-1">
        {insights.map((ins, i) => (
          <li key={i} className="text-sm text-surface-700 flex gap-2">
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

function GrowthPanel({ row }: { row: AdvisorReport | null }) {
  if (!row)                        return <PanelEmpty label="סוכן צמיחה" />
  if (row.status === 'running')    return <PanelRunning />
  if (row.status === 'cancelled')  return <PanelEmpty label="סוכן צמיחה" />
  if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)                 return <PanelEmpty label="סוכן צמיחה" />
  const r = row.report as GrowthReport

  return (
    <div className="space-y-4">
      <div className="card bg-blue-50 border-blue-100 p-3">
        <p className="text-sm text-blue-900 leading-relaxed">{r.summary}</p>
      </div>

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

      <BudgetRecs recs={r.budget_recommendations} />

      {/* Growth opportunities */}
      {r.growth_opportunities?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">הזדמנויות צמיחה</h4>
          <div className="space-y-2">
            {r.growth_opportunities.map((op, i) => (
              <div key={i} className="card p-3 border-r-4 border-blue-400 bg-blue-50">
                <p className="text-sm font-medium text-blue-900 mb-1">{op.opportunity}</p>
                <p className="text-xs text-blue-700 mb-1">▶ {op.action}</p>
                <p className="text-xs text-blue-600 italic">{op.expected_impact}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Campaigns to create */}
      {r.campaigns_to_create?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">🎯 קמפיינים ליצירה</h4>
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
                  <div className="flex flex-wrap gap-1">
                    {c.keywords.map((kw, j) => (
                      <span key={j} className="text-xs bg-white border border-blue-200 text-blue-700 px-2 py-0.5 rounded-full">{kw}</span>
                    ))}
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
              </div>
            ))}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />

      {r.next_week_focus && (
        <div className="card bg-surface-800 text-white p-4">
          <p className="text-xs font-semibold text-surface-300 mb-1">מוקד שבוע הבא</p>
          <p className="text-sm leading-relaxed">{r.next_week_focus}</p>
        </div>
      )}
    </div>
  )
}

// ── Efficiency Panel ──────────────────────────────────────────────────────────

function EfficiencyPanel({ row }: { row: AdvisorReport | null }) {
  if (!row)                        return <PanelEmpty label="סוכן יעילות" />
  if (row.status === 'running')    return <PanelRunning />
  if (row.status === 'cancelled')  return <PanelEmpty label="סוכן יעילות" />
  if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)                 return <PanelEmpty label="סוכן יעילות" />
  const r = row.report as EfficiencyReport

  return (
    <div className="space-y-4">
      <div className="card bg-amber-50 border-amber-100 p-3">
        <p className="text-sm text-amber-900 leading-relaxed">{r.summary}</p>
      </div>

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
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">בזבוז מזוהה</h4>
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
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ads to rewrite */}
      {r.ads_to_rewrite?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">✏️ מודעות לשכתוב</h4>
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
                            <p className="text-xs text-red-800 font-mono break-all">{fix.original}</p>
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
                          <p className="text-xs text-red-800 break-all">{fix.original}</p>
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

      {r.next_week_focus && (
        <div className="card bg-surface-800 text-white p-4">
          <p className="text-xs font-semibold text-surface-300 mb-1">מוקד שבוע הבא</p>
          <p className="text-sm leading-relaxed">{r.next_week_focus}</p>
        </div>
      )}
    </div>
  )
}

// ── Organic Panel ─────────────────────────────────────────────────────────────

function OrganicPanel({ row, blogState, writeBlogPost }: {
  row: AdvisorReport | null
  blogState: Record<string, { loading: boolean; post: BlogPost | null }>
  writeBlogPost: (rec: GoogleOrganicRec) => void
}) {
  if (!row)                        return <PanelEmpty label="סוכן תוכן אורגני" />
  if (row.status === 'running')    return <PanelRunning />
  if (row.status === 'cancelled')  return <PanelEmpty label="סוכן תוכן אורגני" />
  if (row.status === 'error')      return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)                 return <PanelEmpty label="סוכן תוכן אורגני" />
  const r = row.report as OrganicReport

  return (
    <div className="space-y-4">
      <div className="card bg-green-50 border-green-100 p-3">
        <p className="text-sm text-green-900 leading-relaxed">{r.summary}</p>
      </div>

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
                {/* Blog post writer */}
                {rec.content_type === 'blog_post' && (() => {
                  const bs = blogState[rec.keyword]
                  return (
                    <div className="pt-1">
                      {!bs && (
                        <button
                          onClick={() => writeBlogPost(rec)}
                          className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors"
                        >
                          ✍️ כתוב פוסט בלוג מלא
                        </button>
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
                          <div className="px-3 pb-1 space-y-1">
                            <p className="text-xs text-surface-500 font-semibold">Meta description:</p>
                            <div className="flex items-center gap-2">
                              <p className="text-xs text-indigo-800 flex-1">{bs.post.meta_description}</p>
                              <CopyButton text={bs.post.meta_description} />
                            </div>
                            <p className="text-xs text-surface-500 font-semibold mt-1">Slug: <span className="font-normal text-indigo-700">/{bs.post.slug}</span></p>
                          </div>
                          <div className="px-3 pb-3">
                            <p className="text-xs text-surface-500 font-semibold mb-1">תוכן המאמר (Markdown):</p>
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
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">מוצרים לקדם</h4>
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

      {/* Posts to publish */}
      {r.posts_to_publish?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">📲 פוסטים מוכנים לפרסום</h4>
          <div className="space-y-3">
            {r.posts_to_publish.map((p, i) => (
              <div key={i} className="card p-3 border border-green-200 bg-green-50 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span>{contentTypeIcon(p.type)}</span>
                    <span className="text-sm font-semibold text-green-900">{p.topic}</span>
                  </div>
                  <span className="text-xs text-surface-500">{p.best_day} {p.best_time}</span>
                </div>
                {p.hook && (
                  <p className="text-xs font-medium text-surface-600 italic border-r-2 border-green-400 pr-2">"{p.hook}"</p>
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
            ))}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const ALL_AGENT_TYPES = ['google_ads_growth', 'google_ads_efficiency', 'organic_content'] as const
type AgentType = typeof ALL_AGENT_TYPES[number]

export default function AdvisorPage() {
  const [rows, setRows]               = useState<Record<AgentType, AdvisorReport | null>>({
    google_ads_growth: null, google_ads_efficiency: null, organic_content: null,
  })
  const [availableWeeks, setAvailableWeeks] = useState<string[]>([])
  const [selectedWeek, setSelectedWeek]     = useState<string | null>(null)
  const [loading, setLoading]               = useState(true)
  const [running, setRunning]               = useState(false)
  const [focus, setFocus]                   = useState<string>(() => localStorage.getItem('advisor_focus') ?? '')
  const [blogState, setBlogState]           = useState<Record<string, { loading: boolean; post: BlogPost | null }>>({})
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function writeBlogPost(rec: GoogleOrganicRec) {
    const key = rec.keyword
    setBlogState(s => ({ ...s, [key]: { loading: true, post: null } }))
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: {
          agent: 'blog_writer',
          keyword: rec.keyword,
          title: rec.suggested_title,
          key_points: rec.key_points ?? [],
          position: rec.current_position,
          search_volume_signal: rec.search_volume_signal,
        },
      })
      if (error) throw error
      setBlogState(s => ({ ...s, [key]: { loading: false, post: data as BlogPost } }))
    } catch (e) {
      console.error('blog_writer error', e)
      setBlogState(s => ({ ...s, [key]: { loading: false, post: null } }))
    }
  }

  useEffect(() => {
    loadWeeks()
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
      const newRows = { google_ads_growth: null, google_ads_efficiency: null, organic_content: null } as Record<AgentType, AdvisorReport | null>
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

  const panels = [
    {
      key: 'google_ads_growth' as AgentType,
      label: 'Google Ads — צמיחה',
      sublabel: 'סקייל · הגדלת תקציב · חיפוש הזדמנויות',
      icon: <TrendingUp size={16} className="text-blue-500" />,
      headerColor: 'border-blue-100',
      component: (row: AdvisorReport | null) => <GrowthPanel row={row} />,
    },
    {
      key: 'google_ads_efficiency' as AgentType,
      label: 'Google Ads — יעילות',
      sublabel: 'ROAS · חיתוך בזבוז · שיפור רווחיות',
      icon: <Shield size={16} className="text-amber-500" />,
      headerColor: 'border-amber-100',
      component: (row: AdvisorReport | null) => <EfficiencyPanel row={row} />,
    },
    {
      key: 'organic_content' as AgentType,
      label: 'תוכן אורגני',
      sublabel: 'אינסטגרם · Google Search · מלאי',
      icon: <Leaf size={16} className="text-green-500" />,
      headerColor: 'border-green-100',
      component: (row: AdvisorReport | null) => <OrganicPanel row={row} blogState={blogState} writeBlogPost={writeBlogPost} />,
    },
  ]

  return (
    <div className="space-y-6 fade-up">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">יועץ שיווק AI</h2>
          <p className="text-sm text-surface-400 mt-1">
            {selectedWeek ? `שבוע ${formatWeek(selectedWeek)}` : 'טרם הופעל'} · 3 סוכנים
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          >
            {isRunning
              ? <><Loader2 size={14} className="animate-spin" /> מנתח...</>
              : <><RefreshCw size={14} /> הרץ עכשיו</>}
          </button>
        </div>
      </div>

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

      {/* 3 panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {panels.map(({ key, label, sublabel, icon, headerColor, component }) => (
          <div key={key} className="card flex flex-col">
            <div className={`flex items-start justify-between mb-4 pb-3 border-b ${headerColor}`}>
              <div>
                <div className="flex items-center gap-2">
                  {icon}
                  <h3 className="font-display font-semibold text-surface-900 text-sm">{label}</h3>
                </div>
                <p className="text-xs text-surface-400 mt-0.5 mr-6">{sublabel}</p>
              </div>
              <div className="flex items-center gap-2">
                {rows[key] && <StatusBadge status={rows[key]!.status} />}
                <button
                  onClick={() => runAdvisor(key)}
                  disabled={rows[key]?.status === 'running'}
                  title="הרץ סוכן זה בלבד"
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
                : component(rows[key])}
            </div>
          </div>
        ))}
      </div>

      {/* Week history */}
      {availableWeeks.length > 1 && (
        <div className="card p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-surface-400 font-medium ml-2">שבועות קודמים:</span>
            {availableWeeks.map(week => (
              <button
                key={week}
                onClick={() => setSelectedWeek(week)}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors ${week === selectedWeek ? 'bg-surface-900 text-white' : 'bg-surface-100 text-surface-600 hover:bg-surface-200'}`}
              >
                {formatWeek(week)}
              </button>
            ))}
          </div>
        </div>
      )}

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
