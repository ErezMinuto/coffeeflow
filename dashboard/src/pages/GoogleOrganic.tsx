import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { KPICard } from '../components/shared/KPICard'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { DateRange } from '../lib/types'
import { getDefaultDateRange, formatNumber } from '../lib/utils'
import { AlertCircle, TrendingUp, TrendingDown, Minus, ChevronUp, ChevronDown, ChevronsUpDown, Search, X } from 'lucide-react'

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

function positionIcon(pos: number) {
  if (pos <= 3)  return <TrendingUp size={14} className="text-green-500" />
  if (pos <= 10) return <Minus size={14} className="text-amber-400" />
  return <TrendingDown size={14} className="text-red-400" />
}

function positionColor(pos: number) {
  if (pos <= 3)  return 'text-green-600 font-bold'
  if (pos <= 10) return 'text-amber-600 font-medium'
  return 'text-red-500'
}

type SortField = 'clicks' | 'impressions' | 'ctr' | 'position'
type SortDir   = 'asc' | 'desc'

function SortIcon({ field, sortBy, sortDir }: { field: SortField; sortBy: SortField; sortDir: SortDir }) {
  if (sortBy !== field) return <ChevronsUpDown size={12} className="text-surface-300" />
  return sortDir === 'asc'
    ? <ChevronUp size={12} className="text-brand-600" />
    : <ChevronDown size={12} className="text-brand-600" />
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

  const q = query.trim().toLowerCase()

  const sortedKeywords = sortRows(
    q ? keywords.filter(k => k.keyword.toLowerCase().includes(q)) : keywords
  )
  const sortedPages = sortRows(
    q ? pages.filter(p => p.page.toLowerCase().includes(q)) : pages
  )

  function highlight(text: string) {
    if (!q) return <>{text}</>
    const idx = text.toLowerCase().indexOf(q)
    if (idx === -1) return <>{text}</>
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-yellow-200 text-yellow-900 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
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

  return (
    <div className="space-y-8 fade-up">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">Google Organic</h2>
          <p className="text-sm text-surface-400 mt-1">
            {hasData
              ? q
                ? `${sortedKeywords.length} / ${keywords.length} מילות מפתח · ${sortedPages.length} / ${pages.length} עמודים`
                : `${keywords.length} מילות מפתח · ${pages.length} עמודים`
              : connected
                ? 'Google Search Console'
                : 'לא מחובר'}
          </p>
        </div>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {/* Not connected */}
      {!connected && !loading && (
        <div className="card bg-amber-50 border-amber-200 flex gap-3">
          <AlertCircle className="text-amber-500 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="font-medium text-amber-800 text-sm">Google לא מחובר</p>
            <p className="text-xs text-amber-700 mt-1">
              חבר את Google ב<a href="/settings" className="underline">הגדרות</a>.
            </p>
          </div>
        </div>
      )}

      {/* Connected but no data yet */}
      {connected && !loading && !hasData && (
        <div className="card bg-blue-50 border-blue-200 flex gap-3">
          <AlertCircle className="text-blue-500 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="font-medium text-blue-800 text-sm">אין נתוני Search Console עדיין</p>
            <p className="text-xs text-blue-700 mt-1">
              לחץ על "סנכרן Search Console" ב<a href="/settings" className="underline">הגדרות</a> כדי לטעון את הנתונים.
              ודא שהאתר <strong>www.minuto.co.il</strong> מאומת ב-Google Search Console.
            </p>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="קליקים" value={formatNumber(totalClicks)} loading={loading} />
        <KPICard label="חשיפות" value={formatNumber(totalImpressions)} loading={loading} />
        <KPICard label="CTR ממוצע" value={`${(avgCtr * 100).toFixed(1)}%`} loading={loading} />
        <KPICard label="מיקום ממוצע" value={avgPosition > 0 ? avgPosition.toFixed(1) : '—'} loading={loading} />
      </div>

      {/* Search bar */}
      {connected && (
        <div className="relative">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="חפש מילת מפתח או עמוד..."
            className="w-full pr-9 pl-9 py-2.5 text-sm rounded-xl border border-surface-200 bg-white focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400 placeholder:text-surface-300 transition"
            dir="rtl"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Tab switcher */}
      <div className="card overflow-hidden p-0">
        <div className="flex border-b border-surface-100">
          <button
            onClick={() => setTab('keywords')}
            className={`px-5 py-3 text-sm font-medium transition-colors ${tab === 'keywords' ? 'border-b-2 border-brand-600 text-brand-700' : 'text-surface-500 hover:text-surface-700'}`}
          >
            מילות מפתח ({q ? `${sortedKeywords.length} / ${keywords.length}` : keywords.length})
          </button>
          <button
            onClick={() => setTab('pages')}
            className={`px-5 py-3 text-sm font-medium transition-colors ${tab === 'pages' ? 'border-b-2 border-brand-600 text-brand-700' : 'text-surface-500 hover:text-surface-700'}`}
          >
            עמודים ({q ? `${sortedPages.length} / ${pages.length}` : pages.length})
          </button>
        </div>

        {/* Keywords table */}
        {tab === 'keywords' && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-100 bg-surface-50">
                <th className="text-right px-5 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">מילת מפתח</th>
                {(['clicks', 'impressions', 'ctr', 'position'] as SortField[]).map(field => (
                  <th key={field} className="px-4 py-3">
                    <button
                      onClick={() => handleSort(field)}
                      className="flex items-center gap-1 text-xs font-semibold text-surface-400 uppercase tracking-wider hover:text-brand-600 transition-colors"
                    >
                      <SortIcon field={field} sortBy={sortBy} sortDir={sortDir} />
                      {field === 'clicks' ? 'קליקים' : field === 'impressions' ? 'חשיפות' : field === 'ctr' ? 'CTR' : 'מיקום'}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-50">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-3 bg-surface-100 rounded animate-pulse" /></td>
                  ))}</tr>
                ))
              ) : sortedKeywords.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-12 text-surface-400">
                    {connected ? 'אין נתונים לתקופה זו' : 'חבר את Google בהגדרות'}
                  </td>
                </tr>
              ) : (
                sortedKeywords.map((kw, i) => (
                  <tr key={i} className="hover:bg-surface-50 transition-colors">
                    <td className="px-5 py-3 font-medium text-surface-800 max-w-xs truncate">{highlight(kw.keyword)}</td>
                    <td className="px-4 py-3 font-mono text-surface-700">{kw.clicks.toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-surface-500">{kw.impressions.toLocaleString()}</td>
                    <td className="px-4 py-3 font-mono text-surface-600">{(kw.ctr * 100).toFixed(1)}%</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {positionIcon(kw.position)}
                        <span className={`font-mono ${positionColor(kw.position)}`}>{kw.position.toFixed(1)}</span>
                      </div>
                    </td>
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
              <tr className="border-b border-surface-100 bg-surface-50">
                <th className="text-right px-5 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">עמוד</th>
                {(['clicks', 'impressions', 'ctr', 'position'] as SortField[]).map(field => (
                  <th key={field} className="px-4 py-3">
                    <button
                      onClick={() => handleSort(field)}
                      className="flex items-center gap-1 text-xs font-semibold text-surface-400 uppercase tracking-wider hover:text-brand-600 transition-colors"
                    >
                      <SortIcon field={field} sortBy={sortBy} sortDir={sortDir} />
                      {field === 'clicks' ? 'קליקים' : field === 'impressions' ? 'חשיפות' : field === 'ctr' ? 'CTR' : 'מיקום'}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-50">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="h-3 bg-surface-100 rounded animate-pulse" /></td>
                  ))}</tr>
                ))
              ) : sortedPages.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-12 text-surface-400">
                    {connected ? 'אין נתונים לתקופה זו' : 'חבר את Google בהגדרות'}
                  </td>
                </tr>
              ) : (
                sortedPages.map((pg, i) => {
                  // Show just the path, not full URL
                  const displayUrl = pg.page.replace(/^https?:\/\/[^/]+/, '') || '/'
                  return (
                    <tr key={i} className="hover:bg-surface-50 transition-colors">
                      <td className="px-5 py-3 text-surface-800 max-w-xs">
                        <a
                          href={pg.page}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-brand-600 hover:text-brand-800 truncate block"
                          title={pg.page}
                        >
                          {highlight(displayUrl)}
                        </a>
                      </td>
                      <td className="px-4 py-3 font-mono text-surface-700">{pg.clicks.toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-surface-500">{pg.impressions.toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-surface-600">{(pg.ctr * 100).toFixed(1)}%</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {positionIcon(pg.position)}
                          <span className={`font-mono ${positionColor(pg.position)}`}>{pg.position.toFixed(1)}</span>
                        </div>
                      </td>
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
        <div className="flex items-center gap-4 text-xs text-surface-400">
          <span className="flex items-center gap-1"><TrendingUp size={12} className="text-green-500" /> מיקום 1–3</span>
          <span className="flex items-center gap-1"><Minus size={12} className="text-amber-400" /> מיקום 4–10</span>
          <span className="flex items-center gap-1"><TrendingDown size={12} className="text-red-400" /> מיקום 11+</span>
        </div>
      )}
    </div>
  )
}
