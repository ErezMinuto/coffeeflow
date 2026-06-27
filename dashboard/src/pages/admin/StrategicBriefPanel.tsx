import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Compass, RefreshCw, Lightbulb, AlertTriangle, Wrench, ThumbsUp, X,
  FlaskConical, ChevronRight,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Strategist Brain panel — the "State of Minuto" reading surface.
//
// Renders the latest strategic_brief (the weekly Opus-4.8 reasoning output) and
// the strategist_signals stream (the agent→team channel: capability requests,
// bug reports, feature ideas). The owner approves or declines signals here —
// the only interactive surface in Phase 1, which is otherwise thinking-only.
//
// Same liveness approach as SeoTaskQueue: realtime channel + a 30s polling
// fallback, so it stays current even if the tables aren't in the realtime
// publication.

interface DiagnosisItem { claim: string; evidence: string }
interface Recommendation { title: string; rationale: string; expected_revenue_effect?: string }

type RecActionType = 'email_campaign' | 'content_blog' | 'content_ig' | 'none'
type RecStatus = 'proposed' | 'approved' | 'drafted' | 'dismissed' | 'failed'
interface StrategistRec {
  id:             string
  title:          string
  rationale:      string | null
  action_type:    RecActionType
  success_metric: { metric?: string; source?: string; baseline?: string; check_date?: string } | null
  status:         RecStatus
  draft_ref:      string | null
  draft_error:    string | null
}

// Only content_blog auto-drafts in Phase 2a; others approve but wait for 2b.
const REC_DRAFTABLE: RecActionType[] = ['content_blog']
const REC_STATUS_STYLE: Record<RecStatus, string> = {
  proposed:  'bg-surface-100 text-surface-700',
  approved:  'bg-blue-100 text-blue-900',
  drafted:   'bg-green-100 text-green-900',
  dismissed: 'bg-surface-200 text-surface-500',
  failed:    'bg-red-100 text-red-900',
}

interface StrategicBrief {
  id:              string
  week_start:      string
  summary:         string
  diagnosis:       DiagnosisItem[]
  top_thesis:      string | null
  recommendations: Recommendation[]
  out_of_hands:    Recommendation[]
  status:          string
  created_at:      string
}

type SignalKind = 'capability_request' | 'bug_report' | 'feature_idea'
interface StrategistSignal {
  id:               string
  kind:             SignalKind
  title:            string
  detail:           string | null
  evidence:         Record<string, unknown> | null
  blocked_decision: string | null
  leverage:         string | null
  status:           'open' | 'approved' | 'building' | 'shipped' | 'declined'
  decline_reason:   string | null
  created_at:       string
}

const KIND_META: Record<SignalKind, { label: string; icon: typeof Wrench; bg: string; text: string }> = {
  capability_request: { label: 'Capability request', icon: Wrench,         bg: 'bg-indigo-50', text: 'text-indigo-800' },
  bug_report:         { label: 'Bug report',          icon: AlertTriangle, bg: 'bg-red-50',    text: 'text-red-800' },
  feature_idea:       { label: 'Feature idea',        icon: Lightbulb,     bg: 'bg-amber-50',  text: 'text-amber-800' },
}

const SIGNAL_STATUS_STYLE: Record<StrategistSignal['status'], string> = {
  open:     'bg-surface-100 text-surface-700',
  approved: 'bg-green-100 text-green-900',
  building: 'bg-blue-100 text-blue-900',
  shipped:  'bg-green-100 text-green-900',
  declined: 'bg-surface-200 text-surface-500',
}

export default function StrategicBriefPanel() {
  const [brief, setBrief]     = useState<StrategicBrief | null>(null)
  const [signals, setSignals] = useState<StrategistSignal[]>([])
  const [recs, setRecs]       = useState<StrategistRec[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  const load = useCallback(async () => {
    const [briefRes, signalRes] = await Promise.all([
      supabase
        .from('strategic_briefs')
        .select('*')
        .order('week_start', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('strategist_signals')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50),
    ])
    if (cancelledRef.current) return
    const latestBrief = ((briefRes.data ?? [])[0] as StrategicBrief) ?? null
    setBrief(latestBrief)
    setSignals((signalRes.data ?? []) as StrategistSignal[])
    if (latestBrief) {
      const { data: recData } = await supabase
        .from('strategic_recommendations')
        .select('id,title,rationale,action_type,success_metric,status,draft_ref,draft_error')
        .eq('brief_id', latestBrief.id)
        .order('created_at', { ascending: true })
      if (!cancelledRef.current) setRecs((recData ?? []) as StrategistRec[])
    } else {
      setRecs([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    load()
    const channel = supabase
      .channel('strategist_brain_panel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategic_briefs' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategist_signals' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategic_recommendations' }, () => load())
      .subscribe()
    const poll = setInterval(() => load(), 30_000)
    return () => {
      cancelledRef.current = true
      clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [load])

  async function handleManualRefresh() {
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false) }
  }

  async function setSignalStatus(s: StrategistSignal, status: StrategistSignal['status'], declineReason?: string) {
    setBusy(s.id)
    try {
      const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
      if (declineReason != null) patch.decline_reason = declineReason
      const { error } = await supabase.from('strategist_signals').update(patch).eq('id', s.id)
      if (error) throw error
      // Optimistic local update — realtime/poll will reconcile.
      setSignals(prev => prev.map(x => (x.id === s.id ? { ...x, status, decline_reason: declineReason ?? x.decline_reason } : x)))
    } catch (e) {
      console.error('[StrategicBriefPanel] signal update failed:', e)
      window.alert('Update failed. See console.')
    } finally {
      setBusy(null)
    }
  }

  function handleDecline(s: StrategistSignal) {
    const reason = window.prompt(`Decline "${s.title}"?\n\nReason (the agent reads this and won't re-ask):`, '')
    if (reason == null) return
    setSignalStatus(s, 'declined', reason)
  }

  // Approve a recommendation → the executor drafts it (content task / email
  // draft) — it never sends or publishes. Dismiss → drop it.
  async function setRecStatus(r: StrategistRec, status: RecStatus) {
    setBusy(r.id)
    try {
      const { error } = await supabase
        .from('strategic_recommendations')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', r.id)
      if (error) throw error
      setRecs(prev => prev.map(x => (x.id === r.id ? { ...x, status } : x)))
    } catch (e) {
      console.error('[StrategicBriefPanel] recommendation update failed:', e)
      window.alert('Update failed. See console.')
    } finally {
      setBusy(null)
    }
  }

  const openSignals = signals.filter(s => s.status === 'open')
  const resolvedSignals = signals.filter(s => s.status !== 'open')

  return (
    <section className="h-full flex flex-col bg-white min-h-0">
      <header className="h-10 px-4 flex items-center justify-between border-b border-surface-200 bg-surface-50 shrink-0">
        <h2 className="text-sm font-semibold text-surface-800 flex items-center gap-2">
          <Compass size={15} className="text-brand-600" /> State of Minuto
        </h2>
        <div className="flex items-center gap-2">
          {brief && (
            <span className="text-xs text-surface-500">week of {brief.week_start}</span>
          )}
          <button
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="text-surface-500 hover:text-surface-900 disabled:opacity-50"
            title="Refresh now"
          ><RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /></button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-5 space-y-6">
          {loading ? (
            <div className="text-xs text-surface-500">Loading…</div>
          ) : (
            <>
              {/* ── The brief ───────────────────────────────────────────── */}
              {!brief ? (
                <div className="text-sm text-surface-500 border border-dashed border-surface-300 rounded-lg p-6 text-center">
                  No strategic brief yet. The strategist runs weekly (Monday). It thinks only — nothing it writes is published or spent without your approval.
                </div>
              ) : (
                <article className="space-y-5">
                  <p className="text-[15px] leading-relaxed text-surface-900">{brief.summary}</p>

                  {brief.top_thesis && (
                    <div className="flex items-start gap-2 rounded-lg border border-brand-200 bg-brand-50/60 px-4 py-3">
                      <Compass size={16} className="text-brand-600 mt-0.5 shrink-0" />
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">Top bet this cycle</div>
                        <div className="text-sm text-surface-900 mt-0.5">{brief.top_thesis}</div>
                      </div>
                    </div>
                  )}

                  {brief.diagnosis?.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500 mb-2">What the numbers say</h3>
                      <ul className="space-y-2">
                        {brief.diagnosis.map((d, i) => (
                          <li key={i} className="text-sm text-surface-900">
                            <div>{d.claim}</div>
                            <div className="text-[12px] text-surface-500 mt-0.5">{d.evidence}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {recs.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500 mb-2">Recommended — approve to draft (never sends)</h3>
                      <ul className="space-y-2">
                        {recs.map(r => {
                          const draftable = REC_DRAFTABLE.includes(r.action_type)
                          return (
                            <li key={r.id} className="rounded-lg border border-surface-200 p-3 text-sm">
                              <div className="flex items-start gap-2">
                                <ChevronRight size={14} className="text-brand-500 mt-1 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium text-surface-900">{r.title}</span>
                                  {r.action_type !== 'none' && (
                                    <span className="ml-1.5 text-[10px] font-medium text-brand-700">[{r.action_type}]</span>
                                  )}
                                  {r.rationale && <span className="text-surface-700"> — {r.rationale}</span>}
                                  {r.success_metric?.metric && (
                                    <div className="text-[12px] text-surface-500 mt-0.5">Measure: {r.success_metric.metric}{r.success_metric.check_date ? ` (by ${r.success_metric.check_date})` : ''}</div>
                                  )}
                                  {r.status === 'drafted' && (
                                    <div className="text-[12px] text-green-700 mt-1">Drafted — review in Workspace → Tasks{r.draft_ref ? ` (#${r.draft_ref.slice(0, 8)})` : ''}, then publish there.</div>
                                  )}
                                  {r.status === 'failed' && r.draft_error && (
                                    <div className="text-[12px] text-red-700 mt-1">Draft failed: {r.draft_error}</div>
                                  )}
                                  {r.status === 'approved' && !draftable && (
                                    <div className="text-[12px] text-surface-500 mt-1">Approved — {r.action_type} drafting arrives in Phase 2b.</div>
                                  )}
                                </div>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${REC_STATUS_STYLE[r.status]}`}>{r.status}</span>
                              </div>
                              {r.status === 'proposed' && (
                                <div className="flex items-center gap-2 mt-2 pl-5">
                                  <button
                                    onClick={() => setRecStatus(r, 'approved')}
                                    disabled={busy === r.id}
                                    className="inline-flex items-center gap-1 text-xs text-green-700 hover:text-green-900 disabled:opacity-50"
                                    title={draftable ? 'Approve — drafts a blog post for your review' : 'Approve — execution arrives in Phase 2b'}
                                  ><ThumbsUp size={12} /> approve</button>
                                  <button
                                    onClick={() => setRecStatus(r, 'dismissed')}
                                    disabled={busy === r.id}
                                    className="inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-800 disabled:opacity-50"
                                  ><X size={12} /> dismiss</button>
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}

                  {brief.out_of_hands?.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500 mb-2">For you to weigh (outside the agent's hands)</h3>
                      <ul className="space-y-2">
                        {brief.out_of_hands.map((r, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm">
                            <ChevronRight size={14} className="text-surface-400 mt-1 shrink-0" />
                            <div>
                              <span className="font-medium text-surface-900">{r.title}</span>
                              <span className="text-surface-700"> — {r.rationale}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="text-[10px] text-surface-400 font-mono pt-1">
                    brief {brief.id.slice(0, 8)} · {new Date(brief.created_at).toISOString().slice(0, 16).replace('T', ' ')} · {brief.status}
                  </div>
                </article>
              )}

              {/* ── Signals (agent → team) ──────────────────────────────── */}
              <div className="border-t border-surface-200 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500 mb-3 flex items-center gap-2">
                  <FlaskConical size={13} /> Signals from the agent
                  {openSignals.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-800 text-[10px] font-semibold">{openSignals.length} open</span>
                  )}
                </h3>

                {signals.length === 0 ? (
                  <div className="text-xs text-surface-500">No signals yet. The agent raises one only when a decision is blocked or it confirms an anomaly.</div>
                ) : (
                  <ul className="space-y-2">
                    {[...openSignals, ...resolvedSignals].map(s => {
                      const meta = KIND_META[s.kind]
                      const Icon = meta.icon
                      const isOpen = s.status === 'open'
                      return (
                        <li key={s.id} className={`rounded-lg border border-surface-200 p-3 ${s.status === 'declined' ? 'opacity-60' : ''}`}>
                          <div className="flex items-start gap-2">
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${meta.bg} ${meta.text} text-[10px] font-medium shrink-0`}>
                              <Icon size={11} /> {meta.label}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-surface-900">{s.title}</div>
                              {s.detail && <div className="text-[12px] text-surface-600 mt-0.5">{s.detail}</div>}
                              {s.blocked_decision && (
                                <div className="text-[12px] text-surface-500 mt-1"><span className="font-medium">Blocks:</span> {s.blocked_decision}</div>
                              )}
                              {s.leverage && (
                                <div className="text-[12px] text-surface-500 mt-0.5"><span className="font-medium">Leverage:</span> {s.leverage}</div>
                              )}
                              {s.decline_reason && (
                                <div className="text-[12px] text-surface-500 mt-1 italic">Declined: {s.decline_reason}</div>
                              )}
                            </div>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${SIGNAL_STATUS_STYLE[s.status]}`}>{s.status}</span>
                          </div>
                          {isOpen && (
                            <div className="flex items-center gap-2 mt-2 pl-1">
                              <button
                                onClick={() => setSignalStatus(s, 'approved')}
                                disabled={busy === s.id}
                                className="inline-flex items-center gap-1 text-xs text-green-700 hover:text-green-900 disabled:opacity-50"
                                title="Approve — mark this for action"
                              ><ThumbsUp size={12} /> approve</button>
                              <button
                                onClick={() => handleDecline(s)}
                                disabled={busy === s.id}
                                className="inline-flex items-center gap-1 text-xs text-surface-500 hover:text-surface-800 disabled:opacity-50"
                                title="Decline — the agent reads the reason and won't re-ask"
                              ><X size={12} /> decline</button>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
