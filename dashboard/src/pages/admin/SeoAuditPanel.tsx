// SEO audit: the strategist's weekly whole-site audit, readable in full
// (SEO agent build plan, Phase 1). The email shows the top 10; this shows
// every finding sorted by money, every blind spot, and how fresh the data
// behind it is. Read-only.
//
// Sources: strategic_briefs.seo_audit (written by conclude_brief), plus the
// audit data tables (site_crawls, gsc_query_page, page_speed,
// gsc_url_inspection) for the "data behind it" strip. All admin-read RLS.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, AlertCircle, ChevronLeft } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { PanelHead, RefreshButton, LoadingRows, Empty, Tag, stamp } from './seoUi'

export const AREA_LABEL: Record<string, string> = {
  keyword_map: 'מפת חיפושים ומילות מפתח', crawl_index: 'סריקה ואינדוקס', site_health: 'תקינות האתר',
  speed_mobile: 'מהירות ומובייל', structured_data: 'נתונים מובנים (סכמה)', on_page: 'כותרות ותיאורים לגוגל',
  category_pages: 'דפי קטגוריה', product_pages: 'דפי מוצר', shopping: 'Google Shopping', content: 'תוכן',
  internal_links: 'קישורים פנימיים ומבנה', images_video: 'תמונות ווידאו', authority: 'סמכות וקישורים נכנסים',
  local: 'חיפוש מקומי', brand: 'מותג ומוניטין', ai_search: 'חיפוש AI', seasons: 'עונות ואירועים',
  conversion: 'הפיכת מבקרים לקונים', paid_coordination: 'תיאום עם פרסום ממומן', other_engines: 'מנועי חיפוש אחרים',
  site_changes: 'שינויים באתר', competitors: 'מתחרים', measurement: 'מדידה',
}
const EFFORT: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  low: { label: 'מאמץ קטן', tone: 'ok' }, medium: { label: 'מאמץ בינוני', tone: 'warn' }, high: { label: 'מאמץ גדול', tone: 'danger' },
}

interface Finding { area: string; title: string; evidence: string; pages?: string[]; est_monthly_value_ils?: number | null; value_method?: string; no_value_reason?: string; effort: string; fix: string }
interface BlindSpot { area: string; why: string; needed: string }
interface AreaVerdict { area: string; verdict: 'problem' | 'ok' | 'blind'; note: string }
interface Dismissed { id: string; reason: string }
interface Brief { id: string; week_start: string; created_at: string; seo_audit: { findings?: Finding[]; blind_spots?: BlindSpot[]; area_verdicts?: AreaVerdict[]; dismissed_signals?: Dismissed[]; signals_checked?: number } }

const VERDICT: Record<string, { label: string; tone: 'danger' | 'ok' | 'neutral' }> = {
  problem: { label: 'יש בעיה', tone: 'danger' }, ok: { label: 'נבדק, תקין', tone: 'ok' }, blind: { label: 'לא נראה', tone: 'neutral' },
}
interface DataStatus {
  crawl: { finished_at: string; urls_total: number; urls_ok: number } | null
  queryPageEnd: string | null
  speedOk: number; speedRefused: number
  inspectOk: number; inspectFailed: number
}

/** Hebrew slugs arrive percent-encoded; show them readable. */
function readable(u: string): string { try { return decodeURIComponent(u) } catch { return u } }
function safeHref(u: string): string | null {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null } catch { return null }
}
const ils = (v: number | null | undefined) => (v == null ? null : `₪${Math.round(v).toLocaleString('he-IL')}`)

async function loadAudit(): Promise<{ brief: Brief | null; status: DataStatus }> {
  const since = new Date(Date.now() - 8 * 86_400_000).toISOString()
  const count = async (table: string, col: string, ok: boolean) => {
    let q = supabase.from(table).select('*', { count: 'exact', head: true }).gte(col, since)
    q = ok ? q.is('error', null) : q.not('error', 'is', null)
    const { count: n } = await q
    return n ?? 0
  }
  const [briefRes, crawlRes, qpRes, speedOk, speedRefused, inspectOk, inspectFailed] = await Promise.all([
    // Only briefs written since the audit exists (older ones have an empty seo_audit).
    supabase.from('strategic_briefs').select('id, week_start, created_at, seo_audit')
      .not('seo_audit->>findings', 'is', null).order('created_at', { ascending: false }).limit(1),
    supabase.from('site_crawls').select('finished_at, urls_total, urls_ok').eq('status', 'done').order('finished_at', { ascending: false }).limit(1),
    supabase.from('gsc_query_page').select('period_end').order('period_end', { ascending: false }).limit(1),
    count('page_speed', 'measured_at', true), count('page_speed', 'measured_at', false),
    count('gsc_url_inspection', 'inspected_at', true), count('gsc_url_inspection', 'inspected_at', false),
  ])
  if (briefRes.error) throw new Error(`לא ניתן לטעון את הביקורת: ${briefRes.error.message}`)
  return {
    brief: ((briefRes.data ?? [])[0] as Brief) ?? null,
    status: {
      crawl: ((crawlRes.data ?? [])[0] as DataStatus['crawl']) ?? null,
      queryPageEnd: ((qpRes.data ?? [])[0] as { period_end: string } | undefined)?.period_end ?? null,
      speedOk, speedRefused, inspectOk, inspectFailed,
    },
  }
}

function FindingRow({ f, rank }: { f: Finding; rank: number }) {
  const effort = EFFORT[f.effort] ?? { label: f.effort, tone: 'warn' as const }
  const value = ils(f.est_monthly_value_ils)
  const pages = (f.pages ?? []).filter(Boolean)
  return (
    <li className="px-4 pt-3 pb-2">
      <div className="flex items-start gap-3">
        <span className="text-[12px] text-surface-400 num pt-0.5 w-5 shrink-0">{rank}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <div className="flex-1 min-w-0 text-[14px] font-medium leading-snug text-surface-900 break-words" dir="auto">{f.title}</div>
            {value
              ? <span className="text-[13px] font-semibold text-surface-900 num shrink-0" title={f.value_method || undefined}>{value} לחודש</span>
              : <span className="text-[12.5px] text-surface-400 shrink-0" title={f.no_value_reason || undefined}>שווי לא הוערך</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            <Tag>{AREA_LABEL[f.area] ?? f.area}</Tag>
            <Tag tone={effort.tone}>{effort.label}</Tag>
          </div>
          <div className="text-[13px] leading-relaxed text-surface-600 mt-1.5" dir="auto"><span className="text-surface-500">ממצא: </span>{f.evidence}</div>
          <div className="text-[13px] leading-relaxed text-surface-800 mt-1" dir="auto"><span className="text-surface-500">תיקון: </span>{f.fix}</div>
          {!value && f.no_value_reason && <div className="text-[12.5px] text-surface-500 mt-1" dir="auto">למה אין הערכת שווי: {f.no_value_reason}</div>}
          {(pages.length > 0 || f.value_method) && (
            <details className="mt-1 text-[12.5px] text-surface-700">
              <summary className="inline-flex items-center gap-1 min-h-8 text-surface-500 hover:text-surface-800 select-none">
                <ChevronLeft size={14} aria-hidden="true" className="chev" /> {pages.length ? `${pages.length} עמודים` : 'איך חושב השווי'}
              </summary>
              <div className="mb-1 space-y-1.5 rounded-lg border border-surface-200 bg-surface-50 p-3">
                {f.value_method && <div dir="auto"><span className="text-surface-500">איך חושב השווי: </span>{f.value_method}</div>}
                {pages.map((p, i) => {
                  const href = safeHref(p)
                  return href
                    ? <a key={`${i}-${p}`} href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-brand-600 hover:underline break-all"><ExternalLink size={12} aria-hidden="true" className="shrink-0" /><span dir="auto">{readable(p)}</span></a>
                    : <div key={`${i}-${p}`} className="break-all" dir="auto">{readable(p)}</div>
                })}
              </div>
            </details>
          )}
        </div>
      </div>
    </li>
  )
}

function DataStrip({ s }: { s: DataStatus }) {
  const item = (label: string, value: string, tone: 'ok' | 'warn' | 'danger') => (
    <div className="flex items-center gap-2 min-w-0"><Tag tone={tone}>{value}</Tag><span className="text-[12.5px] text-surface-600 truncate">{label}</span></div>
  )
  return (
    <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-2 border-b border-surface-200 bg-surface-50">
      {s.crawl
        ? item(`סריקת האתר (${stamp(s.crawl.finished_at)})`, `${s.crawl.urls_ok}/${s.crawl.urls_total} עמודים`, s.crawl.urls_ok > 0 ? 'ok' : 'danger')
        : item('סריקת האתר', 'עוד לא רצה', 'danger')}
      {item('Search Console לפי עמוד', s.queryPageEnd ? `עד ${s.queryPageEnd}` : 'אין נתונים', s.queryPageEnd ? 'ok' : 'danger')}
      {item('מהירות (PageSpeed, 8 ימים)', s.speedOk ? `${s.speedOk} נמדדו` : s.speedRefused ? `${s.speedRefused} נדחו` : 'לא נמדד', s.speedOk ? 'ok' : 'warn')}
      {item('סטטוס אינדוקס בגוגל (8 ימים)', s.inspectOk ? `${s.inspectOk} נבדקו` : s.inspectFailed ? `${s.inspectFailed} נדחו` : 'לא נבדק', s.inspectOk ? 'ok' : 'warn')}
    </div>
  )
}

export default function SeoAuditPanel() {
  const [data, setData] = useState<{ brief: Brief | null; status: DataStatus } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [area, setArea] = useState<string>('')

  const refresh = useCallback(async () => {
    setBusy(true)
    try { setError(null); setData(await loadAudit()) }
    catch (e: any) { setError(e?.message ?? String(e)) }
    finally { setBusy(false) }
  }, [])
  useEffect(() => {
    refresh()
    const channel = supabase.channel('seo_audit_panel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strategic_briefs' }, () => refresh())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [refresh])

  // Each finding keeps its rank in the full list, so its key (and an open
  // details panel) stays with it when the list is filtered by area.
  const findings = useMemo(() => (data?.brief?.seo_audit?.findings ?? [])
    .map((f, i) => ({ f, rank: i + 1 }))
    .filter(({ f }) => !area || f.area === area), [data, area])
  const allFindings = data?.brief?.seo_audit?.findings ?? []
  const blind = data?.brief?.seo_audit?.blind_spots ?? []
  const verdicts = data?.brief?.seo_audit?.area_verdicts ?? []
  const dismissed = data?.brief?.seo_audit?.dismissed_signals ?? []
  const total = allFindings.reduce((s, f) => s + (f.est_monthly_value_ils ?? 0), 0)
  const areasPresent = [...new Set(allFindings.map((f) => f.area))]

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelHead
        title={<>ביקורת SEO שבועית{allFindings.length > 0 && <Tag tone="warn"><span className="num">{allFindings.length}</span></Tag>}</>}
        meta={data?.brief ? `שבוע ${data.brief.week_start} · נכתב ${stamp(data.brief.created_at)}` : undefined}
      >
        <RefreshButton onClick={refresh} spinning={busy} disabled={busy} title="רענון הביקורת" />
      </PanelHead>
      {error && (
        <div className="px-4 pt-3 shrink-0">
          <div className="notice notice-danger" role="alert"><AlertCircle size={16} aria-hidden="true" className="notice-icon" /><span>{error}</span></div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {data === null && !error && <LoadingRows rows={4} label="טוען את הביקורת" />}
        {data && <DataStrip s={data.status} />}
        {data && !data.brief && (
          <Empty>עוד אין ביקורת. הביקורת הראשונה מגיעה עם הדוח השבועי הבא של האסטרטג.</Empty>
        )}
        {data?.brief && (
          <>
            <div className="px-4 py-3 flex flex-wrap items-center gap-3 border-b border-surface-200">
              <div className="text-[13px] text-surface-700">
                {allFindings.length} ממצאים{total > 0 && <> · שווי מוערך כולל <b className="num">{ils(total)}</b> לחודש</>}
              </div>
              {areasPresent.length > 1 && (
                <label className="ms-auto flex items-center gap-2 text-[12.5px] text-surface-600">
                  תחום
                  <select value={area} onChange={(e) => setArea(e.target.value)} className="field py-1 text-[13px] w-auto">
                    <option value="">הכול</option>
                    {areasPresent.map((a) => <option key={a} value={a}>{AREA_LABEL[a] ?? a}</option>)}
                  </select>
                </label>
              )}
            </div>
            {findings.length === 0
              ? <Empty>לא נמצאו חולשות{area ? ' בתחום הזה' : ''} השבוע.</Empty>
              : <ol className="divide-y divide-surface-200">{findings.map(({ f, rank }) => <FindingRow key={rank} f={f} rank={rank} />)}</ol>}
            {verdicts.length > 0 && (
              <section className="border-t border-surface-200">
                <h3 className="flex items-center min-h-[44px] px-4 bg-surface-50 border-b border-surface-200 text-[13px] font-semibold text-surface-700">
                  כל 23 התחומים
                  <span className="ms-2 text-surface-500 font-normal">
                    {verdicts.filter((v) => v.verdict === 'problem').length} עם בעיה · {verdicts.filter((v) => v.verdict === 'ok').length} תקינים · {verdicts.filter((v) => v.verdict === 'blind').length} לא נראים
                  </span>
                </h3>
                <ul className="divide-y divide-surface-200">
                  {verdicts.map((v) => {
                    const t = VERDICT[v.verdict] ?? VERDICT.blind
                    return (
                      <li key={v.area} className="px-4 py-2 flex items-start gap-3 text-[13px]">
                        <Tag tone={t.tone}>{t.label}</Tag>
                        <div className="min-w-0"><span className="font-medium text-surface-900">{AREA_LABEL[v.area] ?? v.area}</span>{v.note && <span className="text-surface-600" dir="auto"> — {v.note}</span>}</div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
            {dismissed.length > 0 && (
              <details className="border-t border-surface-200">
                <summary className="flex items-center min-h-[44px] px-4 bg-surface-50 text-[13px] font-semibold text-surface-700 cursor-pointer select-none">
                  אותות שנבדקו ונדחו <span className="ms-2 text-surface-500 num font-normal">{dismissed.length}</span>
                </summary>
                <ul className="divide-y divide-surface-200 border-t border-surface-200">
                  {dismissed.map((d) => (
                    <li key={d.id} className="px-4 py-2 text-[13px] leading-relaxed">
                      <div className="font-mono text-[11.5px] text-surface-500 break-all" dir="ltr">{readable(d.id)}</div>
                      <div className="text-surface-700" dir="auto">{d.reason}</div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {blind.length > 0 && (
              <section className="border-t border-surface-200">
                <h3 className="flex items-center min-h-[44px] px-4 bg-surface-50 border-b border-surface-200 text-[13px] font-semibold text-surface-700">
                  נקודות עיוורות: מה הביקורת לא יכלה לבדוק <span className="ms-2 text-surface-500 num font-normal">{blind.length}</span>
                </h3>
                <ul className="divide-y divide-surface-200">
                  {blind.map((b, i) => (
                    <li key={`${b.area}-${i}`} className="px-4 py-2.5 text-[13px] leading-relaxed">
                      <div className="font-medium text-surface-900">{AREA_LABEL[b.area] ?? b.area}</div>
                      <div className="text-surface-600" dir="auto">{b.why}</div>
                      <div className="text-surface-500" dir="auto">צריך: {b.needed}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
