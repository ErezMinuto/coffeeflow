import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Compass, Lightbulb, AlertTriangle, Wrench, X, Check,
  FlaskConical, ChevronLeft, GitPullRequest,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { PanelHead, RefreshButton, Tag, Dot, Status, stamp, type Tone } from './seoUi'

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

type RecActionType = 'email_campaign' | 'content_blog' | 'content_ig' | 'ad_meta' | 'ad_google' | 'none'
type RecStatus =
  | 'proposed' | 'approved' | 'drafted' | 'dismissed' | 'failed' | 'drafting'
  // closed loop: draft → critique → revise (max 2) → you
  | 'awaiting_critique' | 'revising' | 'exporting' | 'ready_for_review' | 'needs_human'
interface CritiqueEntry {
  at:       string
  revision: number
  pass:     boolean
  issues:   Array<{ severity: string; rule: string; detail: string }>
  feedback: string
}
interface StrategistRec {
  id:             string
  title:          string
  rationale:      string | null
  action_type:    RecActionType
  success_metric: { metric?: string; source?: string; baseline?: string; check_date?: string } | null
  status:         RecStatus
  draft_ref:      string | null
  draft_error:    string | null
  revision_count?: number
  critique_log?:   CritiqueEntry[] | null
  auto_approved?:  boolean
}

// Content + email all draft (never send/publish); 'none' is pure advice.
const REC_DRAFTABLE: RecActionType[] = ['content_blog', 'content_ig', 'email_campaign', 'ad_meta', 'ad_google']
// Recommendation state as a dot + word. In-flight states are neutral; the ones
// that need Erez are amber; failures red.
const REC_STATUS: Record<RecStatus, { tone: Tone; label: string }> = {
  proposed:          { tone: 'neutral', label: 'הוצעה' },
  approved:          { tone: 'brand',   label: 'אושרה' },
  drafted:           { tone: 'ok',      label: 'נוצרה טיוטה' },
  dismissed:         { tone: 'neutral', label: 'הוסרה' },
  failed:            { tone: 'danger',  label: 'נכשלה' },
  drafting:          { tone: 'neutral', label: 'בכתיבה' },
  awaiting_critique: { tone: 'neutral', label: 'ממתינה לביקורת' },
  revising:          { tone: 'neutral', label: 'בתיקון' },
  exporting:         { tone: 'neutral', label: 'בייצוא' },
  ready_for_review:  { tone: 'ok',      label: 'מוכנה לבדיקה' },
  needs_human:       { tone: 'warn',    label: 'דורשת החלטה' },
}

const ACTION_LABEL: Record<string, string> = {
  email_campaign: 'קמפיין מייל', content_blog: 'פוסט בבלוג', content_ig: 'אינסטגרם',
  ad_meta: 'מודעת Meta', ad_google: 'מודעת Google',
}

// Where each exported draft waits for you.
function draftHome(ref: string | null): string {
  if (ref?.startsWith('campaign:')) return 'לבדיקה במחולל המיילים (טיוטה), והשליחה משם'
  if (ref?.startsWith('wp:'))        return 'לבדיקה כטיוטה ב-WordPress (פוסטים, טיוטות), והפרסום משם'
  if (ref?.startsWith('meta_ad:'))  return 'לבדיקה במנהל המודעות של Meta (מושהית). ההפעלה רק בידיים שלך'
  if (ref?.startsWith('google_ad:')) return 'לבדיקה ב-Google Ads (מושהית). ההפעלה רק בידיים שלך'
  return 'לבדיקה בסביבת העבודה, בתור המשימות, והפרסום משם'
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
  status:           'open' | 'approved' | 'building' | 'shipped' | 'declined' | 'needs_human'
  decline_reason:   string | null
  pr_url:           string | null   // set by the fixer agent when it opens a PR
  fixer_note:       string | null   // the fixer's reason when it can't auto-fix (needs_human)
  created_at:       string
}

const KIND_META: Record<SignalKind, { label: string; icon: typeof Wrench; tone: Tone }> = {
  capability_request: { label: 'בקשת יכולת',   icon: Wrench,        tone: 'neutral' },
  bug_report:         { label: 'דיווח על תקלה', icon: AlertTriangle, tone: 'danger' },
  feature_idea:       { label: 'רעיון לפיצ׳ר',  icon: Lightbulb,     tone: 'neutral' },
}

const SIGNAL_STATUS: Record<StrategistSignal['status'], { tone: Tone; label: string }> = {
  open:        { tone: 'warn',    label: 'פתוח' },
  approved:    { tone: 'ok',      label: 'אושר' },
  building:    { tone: 'brand',   label: 'בבנייה' },
  shipped:     { tone: 'ok',      label: 'עלה לאוויר' },
  declined:    { tone: 'neutral', label: 'נדחה' },
  needs_human: { tone: 'warn',    label: 'דורש החלטה' },
}

type ThesisStatus = 'active' | 'validated' | 'refuted' | 'superseded'
interface StrategistThesis {
  id:             string
  thesis:         string
  lever:          string
  success_metric: string
  check_date:     string | null
  status:         ThesisStatus
  outcome:        string | null
}
const THESIS_STATUS: Record<ThesisStatus, { tone: Tone; label: string }> = {
  active:     { tone: 'brand',   label: 'פעילה' },
  validated:  { tone: 'ok',      label: 'אוששה' },
  refuted:    { tone: 'danger',  label: 'הופרכה' },
  superseded: { tone: 'neutral', label: 'הוחלפה' },
}

export default function StrategicBriefPanel() {
  const [brief, setBrief]     = useState<StrategicBrief | null>(null)
  const [signals, setSignals] = useState<StrategistSignal[]>([])
  const [recs, setRecs]       = useState<StrategistRec[]>([])
  const [theses, setTheses]   = useState<StrategistThesis[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const cancelledRef = useRef(false)

  const load = useCallback(async () => {
    const [briefRes, signalRes, thesisRes] = await Promise.all([
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
      supabase
        .from('strategic_theses')
        .select('id,thesis,lever,success_metric,check_date,status,outcome')
        .order('updated_at', { ascending: false })
        .limit(20),
    ])
    if (cancelledRef.current) return
    const latestBrief = ((briefRes.data ?? [])[0] as StrategicBrief) ?? null
    setBrief(latestBrief)
    setSignals((signalRes.data ?? []) as StrategistSignal[])
    setTheses((thesisRes.data ?? []) as StrategistThesis[])
    if (latestBrief) {
      const { data: recData } = await supabase
        .from('strategic_recommendations')
        .select('*')
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategic_theses' }, () => load())
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
      toast.error('העדכון נכשל. הפרטים בקונסול.')
    } finally {
      setBusy(null)
    }
  }

  function handleDecline(s: StrategistSignal) {
    const reason = window.prompt(`לדחות את "${s.title}"?\n\nסיבה (הסוכן קורא אותה ולא ישאל שוב):`, '')
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
      toast.error('העדכון נכשל. הפרטים בקונסול.')
    } finally {
      setBusy(null)
    }
  }

  const openSignals = signals.filter(s => s.status === 'open')
  const resolvedSignals = signals.filter(s => s.status !== 'open')

  return (
    <section className="h-full flex flex-col min-h-0" aria-label="מצב מינוטו">
      <PanelHead
        title={<><Compass size={18} aria-hidden="true" className="text-surface-500" /> מצב מינוטו</>}
        meta={brief ? <>שבוע של <span dir="ltr">{brief.week_start}</span></> : undefined}
      >
        <RefreshButton onClick={handleManualRefresh} disabled={refreshing} spinning={refreshing} title="רענון עכשיו" />
      </PanelHead>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-5 lg:px-8 lg:py-8 space-y-8">
          {loading ? (
            <div className="space-y-3" role="status" aria-label="טוען את התדריך">
              <div className="skel lg w-11/12" />
              <div className="skel lg w-4/5" />
              <div className="skel lg w-2/3" />
            </div>
          ) : (
            <>
              {/* ── The brief ───────────────────────────────────────────── */}
              {!brief ? (
                <div className="rounded-[10px] border border-surface-200 bg-surface-50 px-6 py-8 text-center text-[13px] leading-relaxed text-surface-500">
                  עדיין אין תדריך אסטרטגי. האסטרטג רץ פעם בשבוע (ביום שני). הוא רק חושב: שום דבר שהוא כותב לא מתפרסם ולא מוציא כסף בלי אישור שלך.
                </div>
              ) : (
                <article className="space-y-8">
                  <p className="text-[16px] leading-[1.7] text-surface-900" dir="auto">{brief.summary}</p>

                  {brief.top_thesis && (
                    <div className="rounded-[10px] border border-surface-200 bg-surface-50 px-4 py-3.5">
                      <div className="text-[12.5px] font-medium text-surface-500">ההימור המרכזי במחזור הזה</div>
                      <div className="text-[15px] font-medium leading-relaxed text-surface-900 mt-1" dir="auto">{brief.top_thesis}</div>
                    </div>
                  )}

                  {brief.diagnosis?.length > 0 && (
                    <div>
                      <h3 className="text-[15px] font-semibold text-surface-900 mb-3">מה המספרים אומרים</h3>
                      <ul className="space-y-3">
                        {brief.diagnosis.map((d, i) => (
                          <li key={i} className="text-[14px] leading-relaxed text-surface-900" dir="auto">
                            <div>{d.claim}</div>
                            <div className="text-[13px] text-surface-500 mt-0.5">{d.evidence}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {recs.length > 0 && (
                    <div>
                      <h3 className="text-[15px] font-semibold text-surface-900">המלצות</h3>
                      <p className="text-[13px] text-surface-500 mt-0.5 mb-3">אישור יוצר טיוטה. שום דבר לא נשלח.</p>
                      <ul className="rounded-[10px] border border-surface-200 divide-y divide-surface-200">
                        {recs.map(r => {
                          const draftable = REC_DRAFTABLE.includes(r.action_type)
                          const st = REC_STATUS[r.status] ?? { tone: 'neutral' as Tone, label: r.status }
                          return (
                            <li key={r.id} className={`px-4 pt-3 pb-2 ${r.status === 'dismissed' ? 'opacity-60' : ''}`}>
                              <div className="flex items-start gap-3">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start gap-2 flex-wrap">
                                    <span className="text-[14px] font-medium leading-snug text-surface-900" dir="auto">{r.title}</span>
                                    {r.action_type !== 'none' && <Tag>{ACTION_LABEL[r.action_type] ?? r.action_type}</Tag>}
                                  </div>
                                  {r.rationale && <div className="text-[13px] leading-relaxed text-surface-500 mt-1" dir="auto">{r.rationale}</div>}
                                  {r.success_metric?.metric && (
                                    <div className="text-[12.5px] text-surface-500 mt-1">מדד: <span dir="auto">{r.success_metric.metric}</span>{r.success_metric.check_date ? <> (עד <span dir="ltr" className="num">{r.success_metric.check_date}</span>)</> : ''}</div>
                                  )}
                                  {(r.status === 'drafted' || r.status === 'ready_for_review') && (
                                    <div className="text-[12.5px] leading-relaxed text-surface-700 mt-1.5">
                                      <span className="font-medium text-ok">{r.status === 'ready_for_review' ? 'עבר בדיקה' : 'נוצרה טיוטה'}:</span> {draftHome(r.draft_ref)}
                                      {r.draft_ref ? <span className="font-mono text-[11.5px] text-surface-500" dir="ltr"> ({r.draft_ref})</span> : ''}. שום דבר לא נשלח, פורסם או הופעל.
                                    </div>
                                  )}
                                  {(r.status === 'awaiting_critique' || r.status === 'revising' || r.status === 'exporting' || r.status === 'drafting') && (
                                    <div className="text-[12.5px] leading-relaxed text-surface-700 mt-1.5">
                                      בלולאת הבדיקה{r.revision_count ? ` (תיקון ${r.revision_count} מתוך 2)` : ''}. ההמלצה תגיע לכאן כשתעבור, או אחרי 2 תיקונים.
                                    </div>
                                  )}
                                  {r.status === 'needs_human' && (
                                    <div className="text-[12.5px] leading-relaxed text-surface-700 mt-1.5">
                                      <span className="font-medium text-warn">לא עברה בדיקה</span>{r.draft_error ? <>: <span dir="auto">{r.draft_error}</span></> : ''}. לא יוצאה טיוטה.
                                    </div>
                                  )}
                                  {r.auto_approved && <div className="text-[12px] text-surface-500 mt-1">אושרה אוטומטית בלולאת האסטרטג.</div>}
                                  {Array.isArray(r.critique_log) && r.critique_log.length > 0 && (
                                    <details className="mt-1 text-[12.5px] text-surface-700">
                                      <summary className="inline-flex items-center gap-1 min-h-8 text-surface-500 hover:text-surface-800">
                                        <ChevronLeft size={14} aria-hidden="true" className="chev" /> היסטוריית בדיקות <span className="num">({r.critique_log.length})</span>
                                      </summary>
                                      <ul className="mt-1 mb-1 space-y-1.5 rounded-lg border border-surface-200 bg-surface-50 p-3">
                                        {r.critique_log.map((c, i) => (
                                          <li key={i}>
                                            <span className="inline-flex items-center gap-1.5">
                                              <Dot tone={c.pass ? 'ok' : 'danger'} />
                                              <span className="font-medium">{c.pass ? 'עבר' : 'נדחה'}</span>
                                              <span className="text-surface-500 num">· טיוטה {c.revision + 1}</span>
                                            </span>
                                            {c.issues?.length ? (
                                              <ul className="ps-4 list-disc mt-0.5" dir="auto">
                                                {c.issues.map((x, j) => <li key={j}><b className="font-medium">{x.severity}</b> {x.rule}: {x.detail}</li>)}
                                              </ul>
                                            ) : null}
                                          </li>
                                        ))}
                                      </ul>
                                    </details>
                                  )}
                                  {r.status === 'failed' && r.draft_error && (
                                    <div className="text-[12.5px] text-danger mt-1.5">הטיוטה נכשלה: <span dir="auto">{r.draft_error}</span></div>
                                  )}
                                  {r.status === 'approved' && !draftable && (
                                    <div className="text-[12.5px] text-surface-500 mt-1.5">אושרה. זו עצה בלי תוצר לטיוטה.</div>
                                  )}
                                </div>
                                <Status tone={st.tone} label={st.label} />
                              </div>
                              {r.status === 'ready_for_review' && (
                                <div className="flex items-center gap-0.5 mt-1 -ms-2.5">
                                  <button
                                    type="button"
                                    onClick={() => setRecStatus(r, 'drafted')}
                                    disabled={busy === r.id}
                                    className="act primary"
                                    title="הטיוטה טופלה (פורסמה, נשלחה, הופעלה או נזנחה)"
                                  ><Check size={16} aria-hidden="true" /> טופל</button>
                                </div>
                              )}
                              {r.status === 'needs_human' && (
                                <div className="flex items-center gap-0.5 mt-1 -ms-2.5">
                                  <button
                                    type="button"
                                    onClick={() => setRecStatus(r, 'exporting')}
                                    disabled={busy === r.id}
                                    className="act primary"
                                    title="יצירת הטיוטה בכל זאת (טיוטת WordPress, טיוטת קמפיין או מודעה מושהית). שום דבר לא מתפרסם, נשלח או מופעל."
                                  ><Check size={16} aria-hidden="true" /> ליצור טיוטה בכל זאת</button>
                                  <button
                                    type="button"
                                    onClick={() => setRecStatus(r, 'dismissed')}
                                    disabled={busy === r.id}
                                    className="act danger"
                                  ><X size={16} aria-hidden="true" /> הסרה</button>
                                </div>
                              )}
                              {r.status === 'proposed' && (
                                <div className="flex items-center gap-0.5 mt-1 -ms-2.5">
                                  <button
                                    type="button"
                                    onClick={() => setRecStatus(r, 'approved')}
                                    disabled={busy === r.id}
                                    className="act primary"
                                    title={draftable ? 'אישור יוצר טיוטה לבדיקה' : 'אישור. הביצוע יגיע בשלב 2b'}
                                  ><Check size={16} aria-hidden="true" /> אישור</button>
                                  <button
                                    type="button"
                                    onClick={() => setRecStatus(r, 'dismissed')}
                                    disabled={busy === r.id}
                                    className="act danger"
                                  ><X size={16} aria-hidden="true" /> הסרה</button>
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
                      <h3 className="text-[15px] font-semibold text-surface-900">לשיקולך</h3>
                      <p className="text-[13px] text-surface-500 mt-0.5 mb-3">דברים שמחוץ לידיים של הסוכן.</p>
                      <ul className="space-y-3">
                        {brief.out_of_hands.map((r, i) => (
                          <li key={i} className="flex items-start gap-2 text-[14px] leading-relaxed">
                            <ChevronLeft size={16} aria-hidden="true" className="text-surface-400 mt-1 shrink-0" />
                            <div dir="auto">
                              <div className="font-medium text-surface-900">{r.title}</div>
                              <div className="text-[13px] text-surface-500">{r.rationale}</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="text-[11.5px] text-surface-400 font-mono" dir="ltr">
                    brief {brief.id.slice(0, 8)} · {stamp(brief.created_at)} · {brief.status}
                  </div>
                </article>
              )}

              {/* ── Theses — the revenue-graded memory ──────────────────── */}
              {theses.length > 0 && (
                <div className="border-t border-surface-200 pt-8">
                  <h3 className="text-[15px] font-semibold text-surface-900">תזות</h3>
                  <p className="text-[13px] text-surface-500 mt-0.5 mb-3">הימורים שנמדדים מול הכנסות.</p>
                  <ul className="rounded-[10px] border border-surface-200 divide-y divide-surface-200">
                    {theses.map(t => {
                      const st = THESIS_STATUS[t.status] ?? { tone: 'neutral' as Tone, label: t.status }
                      return (
                        <li key={t.id} className={`px-4 py-3 ${t.status === 'superseded' ? 'opacity-60' : ''}`}>
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-[14px] leading-relaxed text-surface-900" dir="auto">{t.thesis}</div>
                              <div className="text-[12.5px] text-surface-500 mt-0.5">
                                <span className="font-medium text-surface-700" dir="auto">{t.lever}</span> · מדד: <span dir="auto">{t.success_metric}</span>{t.check_date ? <> · בדיקה <span dir="ltr" className="num">{t.check_date}</span></> : ''}
                              </div>
                              {t.outcome && (
                                <div className={`text-[12.5px] mt-1 ${t.status === 'validated' ? 'text-ok' : t.status === 'refuted' ? 'text-danger' : 'text-surface-500'}`} dir="auto">{t.outcome}</div>
                              )}
                            </div>
                            <Status tone={st.tone} label={st.label} />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {/* ── Signals (agent → team) ──────────────────────────────── */}
              <div className="border-t border-surface-200 pt-8">
                <h3 className="text-[15px] font-semibold text-surface-900 mb-3 flex items-center gap-2">
                  <FlaskConical size={16} aria-hidden="true" className="text-surface-500" /> אותות מהסוכן
                  {openSignals.length > 0 && (
                    <Tag tone="warn"><span className="num">{openSignals.length}</span> פתוחים</Tag>
                  )}
                </h3>

                {signals.length === 0 ? (
                  <div className="text-[13px] text-surface-500">עדיין אין אותות. הסוכן מעלה אות רק כשהחלטה חסומה או כשהוא מאשר חריגה.</div>
                ) : (
                  <ul className="rounded-[10px] border border-surface-200 divide-y divide-surface-200">
                    {[...openSignals, ...resolvedSignals].map(s => {
                      const meta = KIND_META[s.kind] ?? { label: String(s.kind), icon: Wrench, tone: 'neutral' as Tone }
                      const Icon = meta.icon
                      const isOpen = s.status === 'open'
                      const st = SIGNAL_STATUS[s.status] ?? { tone: 'neutral' as Tone, label: s.status }
                      return (
                        <li key={s.id} className={`px-4 pt-3 ${isOpen ? 'pb-2' : 'pb-3'} ${s.status === 'declined' ? 'opacity-60' : ''}`}>
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start gap-2 flex-wrap">
                                <Tag tone={meta.tone}><Icon size={12} aria-hidden="true" /> {meta.label}</Tag>
                                <span className="text-[14px] font-medium leading-snug text-surface-900" dir="auto">{s.title}</span>
                              </div>
                              {s.detail && <div className="text-[13px] leading-relaxed text-surface-500 mt-1" dir="auto">{s.detail}</div>}
                              {s.blocked_decision && (
                                <div className="text-[12.5px] text-surface-500 mt-1"><span className="font-medium text-surface-700">חוסם: </span><span dir="auto">{s.blocked_decision}</span></div>
                              )}
                              {s.leverage && (
                                <div className="text-[12.5px] text-surface-500 mt-0.5"><span className="font-medium text-surface-700">תועלת: </span><span dir="auto">{s.leverage}</span></div>
                              )}
                              {s.decline_reason && (
                                <div className="text-[12.5px] text-surface-500 mt-1"><span className="font-medium text-surface-700">נדחה: </span><span dir="auto">{s.decline_reason}</span></div>
                              )}
                              {s.fixer_note && (
                                <div className="text-[12.5px] text-surface-700 mt-1"><span className="font-medium text-warn">הסוכן המתקן: </span><span dir="auto">{s.fixer_note}</span></div>
                              )}
                              {s.pr_url && (
                                <a
                                  href={s.pr_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="act primary -ms-2.5 mt-0.5"
                                ><GitPullRequest size={16} aria-hidden="true" /> לצפייה ב-PR</a>
                              )}
                            </div>
                            <Status tone={st.tone} label={st.label} />
                          </div>
                          {isOpen && (
                            <div className="flex items-center gap-0.5 mt-1 -ms-2.5">
                              <button
                                type="button"
                                onClick={() => setSignalStatus(s, 'approved')}
                                disabled={busy === s.id}
                                className="act primary"
                                title="אישור, מסמן לטיפול"
                              ><Check size={16} aria-hidden="true" /> אישור</button>
                              <button
                                type="button"
                                onClick={() => handleDecline(s)}
                                disabled={busy === s.id}
                                className="act danger"
                                title="דחייה. הסוכן קורא את הסיבה ולא ישאל שוב"
                              ><X size={16} aria-hidden="true" /> דחייה</button>
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
