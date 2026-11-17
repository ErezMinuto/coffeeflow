import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { CardHead, Dot, Kpi, Kpis, Notice, SectionHead, Segmented, TD, TH, Tone } from '../components/shared/cockpit'
import { DateRange } from '../lib/types'
import { getDefaultDateRange, formatNumber } from '../lib/utils'
import { AlertCircle, Info, ChevronUp, ChevronDown, ChevronsUpDown, Search, X } from 'lucide-react'

interface GSCRow {
  id: string
  date: string
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
}

interface AggregatedKeyword {
  keyword: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

interface AggregatedPage {
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

// Search position as a status dot: page one top 3 / rest of page one / beyond.
// Beyond page one is the common case, so it stays a quiet grey dot.
function positionTone(pos: number): Tone {
  if (pos <= 3)  return 'ok'
  if (pos <= 10) return 'warn'
  return 'neutral'
}

function Position({ pos }: { pos: number }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${pos <= 3 ? 'font-medium text-surface-900' : 'text-surface-700'}`}>
      <Dot tone={positionTone(pos)} />{pos.toFixed(1)}
    </span>
  )
}

type SortField = 'clicks' | 'impressions' | 'ctr' | 'position'
type SortDir   = 'asc' | 'desc'

const SORT_LABEL: Record<SortField, string> = { clicks: 'קליקים', impressions: 'חשיפות', ctr: 'CTR', position: 'מיקום' }

function SortIcon({ field, sortBy, sortDir }: { field: SortField; sortBy: SortField; sortDir: SortDir }) {
  if (sortBy !== field) return <ChevronsUpDown size={13} aria-hidden="true" className="text-surface-400" />
  return sortDir === 'asc'
    ? <ChevronUp size={13} aria-hidden="true" className="text-surface-900" />
    : <ChevronDown size={13} aria-hidden="true" className="text-surface-900" />
}

export default function GoogleOrganicPage() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange())
  const [keywords, setKeywords]   = useState<AggregatedKeyword[]>([])
  const [pages, setPages]         = useState<AggregatedPage[]>([])
  const [loading, setLoading]     = useState(true)
  const [connected, setConnected] = useState(false)
  const [hasData, setHasData]     = useState(false)
  const [tab, setTab]             = useState<'keywords' | 'pages'>('keywords')
  const [sortBy, setSortBy]       = useState<SortField>('clicks')
  const [sortDir, setSortDir]     = useState<SortDir>('desc')
  const [query, setQuery]         = useState('')

  useEffect(() => { loadData() }, [dateRange])

  async function loadData() {
    setLoading(true)

    const { data: token } = await supabase
      .from('oauth_tokens')
      .select('platform')
      .eq('platform', 'google')
      .single()
    setConnected(!!token)

    if (token) {
      const from = dateRange.from.toISOString().split('T')[0]
      const to   = dateRange.to.toISOString().split('T')[0]

      const { data } = await supabase
        .from('google_search_console')
        .select('*')
        .gte('date', from)
        .lte('date', to)
        .order('clicks', { ascending: false })

      const rows = (data ?? []) as GSCRow[]
      setHasData(rows.length > 0)

      // Aggregate keywords (exclude page rows stored with keyword='__page__')
      const keywordRows = rows.filter(r => r.keyword !== '__page__')
      const kwMap = new Map<string, { clicks: number; impressions: number; ctrs: number[]; positions: number[] }>()
      for (const r of keywordRows) {
        const existing = kwMap.get(r.keyword)
        if (existing) {
          existing.clicks      += r.clicks
          existing.impressions += r.impressions
          existing.ctrs.push(r.ctr)
          existing.positions.push(r.position)
        } else {
          kwMap.set(r.keyword, { clicks: r.clicks, impressions: r.impressions, ctrs: [r.ctr], positions: [r.position] })
        }
      }
      const aggKeywords: AggregatedKeyword[] = Array.from(kwMap.entries())
        .map(([keyword, v]) => ({
          keyword,
          clicks:      v.clicks,
          impressions: v.impressions,
          ctr:         v.ctrs.reduce((a, b) => a + b, 0) / v.ctrs.length,
          position:    Math.round((v.positions.reduce((a, b) => a + b, 0) / v.positions.length) * 10) / 10,
        }))
        .sort((a, b) => b.clicks - a.clicks)

      // Aggregate pages (rows stored with keyword='__page__')
      const pageRows = rows.filter(r => r.keyword === '__page__' && r.page)
      const pageMap = new Map<string, { clicks: number; impressions: number; ctrs: number[]; positions: number[] }>()
      for (const r of pageRows) {
        const key = r.page!
        const existing = pageMap.get(key)
        if (existing) {
          existing.clicks      += r.clicks
          existing.impressions += r.impressions
          existing.ctrs.push(r.ctr)
          existing.positions.push(r.position)
        } else {
          pageMap.set(key, { clicks: r.clicks, impressions: r.impressions, ctrs: [r.ctr], positions: [r.position] })
        }
      }
      const aggPages: AggregatedPage[] = Array.from(pageMap.entries())
        .map(([page, v]) => ({
          page,
          clicks:      v.clicks,
          impressions: v.impressions,
          ctr:         v.ctrs.reduce((a, b) => a + b, 0) / v.ctrs.length,
          position:    Math.round((v.positions.reduce((a, b) => a + b, 0) / v.positions.length) * 10) / 10,
        }))
        .sort((a, b) => b.clicks - a.clicks)

      setKeywords(aggKeywords)
      setPages(aggPages)
    }

    setLoading(false)
  }

  function handleSort(field: SortField) {
    if (sortBy === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(field)
      // Position: lower is better → default asc; everything else: higher is better → default desc
      setSortDir(field === 'position' ? 'asc' : 'desc')
    }
  }

  function sortRows<T extends { clicks: number; impressions: number; ctr: number; position: number }>(rows: T[]): T[] {
    return [...rows].sort((a, b) => {
      const diff = a[sortBy] - b[sortBy]
      return sortDir === 'asc' ? diff : -diff
    })
  }

  const q = query.trim()

  // Build a case-insensitive regex from the query.
  // Supports: | for OR  (e.g. specialty|ספשלטי)
  //           space as AND — all space-separated terms must match
  // Falls back to plain substring if the regex is invalid.
  const { regex, isAnd } = (() => {
    if (!q) return { regex: null, isAnd: false }
    try {
      if (q.includes('|')) {
        // OR mode — any part of the pipe-expression matches
        return { regex: new RegExp(q, 'gi'), isAnd: false }
      } else {
        // AND mode — every space-separated term must appear somewhere
        const terms = q.split(/\s+/).filter(Boolean)
        return { regex: terms.map(t => new RegExp(t, 'gi')), isAnd: true }
      }
    } catch {
      return { regex: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), isAnd: false }
    }
  })()

  function matches(text: string) {
    if (!regex) return true
    if (isAnd) return (regex as RegExp[]).every(r => { r.lastIndex = 0; return r.test(text) })
    const r = regex as RegExp; r.lastIndex = 0; return r.test(text)
  }

  const sortedKeywords = sortRows(q ? keywords.filter(k => matches(k.keyword)) : keywords)
  const sortedPages    = sortRows(q ? pages.filter(p => matches(p.page))       : pages)

  function highlight(text: string) {
    if (!regex) return <>{text}</>
    const regexes = isAnd ? (regex as RegExp[]) : [regex as RegExp]
    // Split text by all matches across all regexes and wrap matches in <mark>
    let result = text
    const parts: Array<{ str: string; marked: boolean }> = [{ str: text, marked: false }]
    for (const r of regexes) {
      r.lastIndex = 0
      const next: typeof parts = []
      for (const part of parts) {
        if (part.marked) { next.push(part); continue }
        const segs = part.str.split(new RegExp(`(${r.source})`, 'gi'))
        const rTest = new RegExp(r.source, 'i')
        segs.forEach(seg => next.push({ str: seg, marked: rTest.test(seg) && seg.length > 0 }))
      }
      parts.splice(0, parts.length, ...next)
    }
    return (
      <>
        {parts.map((p, i) =>
          p.marked
            ? <mark key={i} className="bg-brand-100 text-brand-800 rounded-[3px] px-0.5">{p.str}</mark>
            : <span key={i}>{p.str}</span>
        )}
      </>
    )
  }

  // KPIs
  const totalClicks      = keywords.reduce((s, k) => s + k.clicks, 0)
  const totalImpressions = keywords.reduce((s, k) => s + k.impressions, 0)
  const avgCtr           = totalImpressions > 0
    ? keywords.reduce((s, k) => s + k.ctr * k.impressions, 0) / totalImpressions
    : 0
  const avgPosition      = keywords.length > 0
    ? keywords.reduce((s, k) => s + k.position, 0) / keywords.length
    : 0

  // Sortable numeric header cells, shared by both tables.
  const sortHeads = (['clicks', 'impressions', 'ctr', 'position'] as SortField[]).map(field => (
    <th
      key={field}
      scope="col"
      aria-sort={sortBy === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`${TH} p-0 text-left ${field === 'impressions' || field === 'ctr' ? 'hidden lg:table-cell' : ''}`}
    >
      <button
        type="button"
        onClick={() => handleSort(field)}
        className={`w-full inline-flex items-center justify-end gap-1 h-10 px-4 transition-colors duration-150 cursor-pointer ${sortBy === field ? 'text-surface-900' : '[@media(hover:hover)]:hover:text-surface-900'}`}
      >
        {SORT_LABEL[field]}
        <SortIcon field={field} sortBy={sortBy} sortDir={sortDir} />
      </button>
    </th>
  ))

  const skeleton = (rows: number) => Array.from({ length: rows }).map((_, i) => (
    <tr key={i} className="border-t border-surface-200 first:border-t-0">{Array.from({ length: 5 }).map((_, j) => (
      <td key={j} className={`px-4 py-3.5 ${j === 2 || j === 3 ? 'hidden lg:table-cell' : ''}`}><div className="h-3 bg-surface-100 rounded" /></td>
    ))}</tr>
  ))

  const emptyRow = (
    <tr>
      <td colSpan={5} className="text-center py-12 text-[13px] text-surface-500">
        {connected ? 'אין נתונים לתקופה הזו' : 'אפשר לחבר את Google בהגדרות'}
      </td>
    </tr>
  )

  const ROW = 'border-t border-surface-200 first:border-t-0 [@media(hover:hover)]:hover:bg-surface-50 transition-colors duration-150'

  return (
    <div className="space-y-5 fade-up">
      <SectionHead
        title="Google אורגני"
        sub={hasData
          ? q
            ? `${sortedKeywords.length} / ${keywords.length} מילות מפתח · ${sortedPages.length} / ${pages.length} עמודים`
            : `${keywords.length} מילות מפתח · ${pages.length} עמודים`
          : connected
            ? 'Google Search Console'
            : 'לא מחובר'}
        actions={<div className="w-full lg:w-auto"><DateRangePicker value={dateRange} onChange={setDateRange} /></div>}
      />

      {/* Not connected */}
      {!connected && !loading && (
        <Notice tone="warn" icon={<AlertCircle />} title="Google לא מחובר">
          אפשר לחבר את Google ב<a href="/settings" className="font-medium text-surface-900 underline underline-offset-2">הגדרות</a>.
        </Notice>
      )}

      {/* Connected but no data yet */}
      {connected && !loading && !hasData && (
        <Notice icon={<Info className="text-surface-500" />} title="אין עדיין נתוני Search Console">
          הכפתור "סנכרן Search Console" ב<a href="/settings" className="font-medium text-surface-900 underline underline-offset-2">הגדרות</a> טוען את הנתונים.
          האתר <strong className="font-medium text-surface-900" dir="ltr">www.minuto.co.il</strong> צריך להיות מאומת ב-Google Search Console.
        </Notice>
      )}

      {/* KPIs */}
      <Kpis label="מדדי חיפוש אורגני">
        <Kpi label="קליקים" value={formatNumber(totalClicks)} loading={loading} note="מילות מפתח בטווח" />
        <Kpi label="חשיפות" value={formatNumber(totalImpressions)} loading={loading} note="מילות מפתח בטווח" />
        <Kpi label="CTR ממוצע" value={`${(avgCtr * 100).toFixed(1)}%`} loading={loading} note="משוקלל לפי חשיפות" />
        <Kpi label="מיקום ממוצע" value={avgPosition > 0 ? avgPosition.toFixed(1) : '—'} loading={loading} note="ממוצע פשוט למילת מפתח" />
      </Kpis>

      {/* Tables */}
      <section className="card-flush overflow-hidden">
        <CardHead title={
          <Segmented
            label="תצוגה"
            value={tab}
            onChange={setTab}
            options={[
              { id: 'keywords', label: <>מילות מפתח <span className="num text-surface-500 font-normal">{q ? `${sortedKeywords.length}/${keywords.length}` : keywords.length}</span></> },
              { id: 'pages', label: <>עמודים <span className="num text-surface-500 font-normal">{q ? `${sortedPages.length}/${pages.length}` : pages.length}</span></> },
            ]}
          />
        }>
          {connected && (
            <div className="relative w-full lg:w-72">
              <Search size={16} aria-hidden="true" className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="חיפוש מילה או ביטוי"
                aria-label="חיפוש במילות מפתח ובעמודים"
                aria-describedby="gsc-search-help"
                className="field pr-9 pl-10"
                dir="rtl"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="ניקוי החיפוש"
                  className="absolute left-0.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-9 h-9 rounded-md text-surface-400 transition-colors duration-150 [@media(hover:hover)]:hover:text-surface-900 cursor-pointer"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </CardHead>
        {connected && (
          <p id="gsc-search-help" className="px-[18px] py-2 text-[12.5px] text-surface-500 border-b border-surface-200 bg-surface-50">
            רווח בין מילים: כולן חייבות להופיע. <span dir="ltr" className="font-medium text-surface-700">specialty|ספשלטי</span>: אחת מהן מספיקה.
          </p>
        )}

        <div className="relative overflow-x-auto">
          {/* Keywords table */}
          {tab === 'keywords' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th scope="col" className={`${TH} text-right ps-[18px]`}>מילת מפתח</th>
                  {sortHeads}
                </tr>
              </thead>
              <tbody>
                {loading ? skeleton(8) : sortedKeywords.length === 0 ? emptyRow : (
                  sortedKeywords.map((kw, i) => (
                    <tr key={i} className={ROW}>
                      <td className="px-4 ps-[18px] py-3 font-medium text-surface-900 max-w-[12rem] lg:max-w-xs truncate" title={kw.keyword}>{highlight(kw.keyword)}</td>
                      <td className={`${TD} text-left text-surface-900`}>{kw.clicks.toLocaleString()}</td>
                      <td className={`${TD} text-left text-surface-600 hidden lg:table-cell`}>{kw.impressions.toLocaleString()}</td>
                      <td className={`${TD} text-left text-surface-600 hidden lg:table-cell`}>{(kw.ctr * 100).toFixed(1)}%</td>
                      <td className={`${TD} text-left`}><Position pos={kw.position} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}

          {/* Pages table */}
          {tab === 'pages' && (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th scope="col" className={`${TH} text-right ps-[18px]`}>עמוד</th>
                  {sortHeads}
                </tr>
              </thead>
              <tbody>
                {loading ? skeleton(5) : sortedPages.length === 0 ? emptyRow : (
                  sortedPages.map((pg, i) => {
                    // Show just the path, not full URL
                    const displayUrl = pg.page.replace(/^https?:\/\/[^/]+/, '') || '/'
                    return (
                      <tr key={i} className={ROW}>
                        <td className="px-4 ps-[18px] py-3 max-w-[12rem] lg:max-w-xs">
                          <a
                            href={pg.page}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-[13px] text-surface-900 underline decoration-surface-300 underline-offset-2 [@media(hover:hover)]:hover:decoration-surface-900 transition-colors duration-150 text-right"
                            dir="ltr"
                            title={pg.page}
                          >
                            {highlight(displayUrl)}
                          </a>
                        </td>
                        <td className={`${TD} text-left text-surface-900`}>{pg.clicks.toLocaleString()}</td>
                        <td className={`${TD} text-left text-surface-600 hidden lg:table-cell`}>{pg.impressions.toLocaleString()}</td>
                        <td className={`${TD} text-left text-surface-600 hidden lg:table-cell`}>{(pg.ctr * 100).toFixed(1)}%</td>
                        <td className={`${TD} text-left`}><Position pos={pg.position} /></td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Position legend */}
        {hasData && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-[18px] py-3 border-t border-surface-200 text-[12.5px] text-surface-500">
            <span className="inline-flex items-center gap-1.5"><Dot tone="ok" /> מיקום 1 עד 3</span>
            <span className="inline-flex items-center gap-1.5"><Dot tone="warn" /> מיקום 4 עד 10</span>
            <span className="inline-flex items-center gap-1.5"><Dot tone="neutral" /> מיקום 11 ומעלה</span>
          </div>
        )}
      </section>
    </div>
  )
}
