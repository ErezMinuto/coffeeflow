import { useEffect, useState } from 'react'
import { TrendingUp, TrendingDown, Minus, ArrowUp, ArrowDown } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { PanelHead, Tag, LoadingRows, Empty, stamp } from './seoUi'

// Right-panel: recent metrics snapshots from seo_metrics.
//
// Shows the last 5 orchestrator_run snapshots with summary numbers and a
// simple delta indicator on blog cadence so Erez can see at a glance
// whether content velocity is trending the right direction.

interface MetricsRow {
  id:              string
  logged_at:       string
  source:          string
  metrics_payload: {
    gsc_top_keywords?:               Array<{ keyword: string; clicks: number; impressions: number; ctr: number; position: number }>
    gsc_position_deltas?:            Array<{ keyword: string; prev_position: number | null; new_position: number; delta: number }> | null
    blog_published_count_30d?:       number
    blog_published_count_7d?:        number
    tasks_completed_since_last_run?: number
    tasks_failed_since_last_run?:    number
    extras?:                         Record<string, unknown>
  }
}

function delta(current: number, prior: number | undefined): React.ReactNode {
  if (prior === undefined || prior === null) {
    return <span className="text-surface-400" aria-label="אין השוואה"><Minus size={12} aria-hidden="true" /></span>
  }
  const diff = current - prior
  if (diff === 0)  return <span className="text-surface-400" aria-label="ללא שינוי"><Minus size={12} aria-hidden="true" /></span>
  if (diff > 0)    return <span className="text-ok inline-flex items-center gap-0.5 text-[12px] font-medium num" dir="ltr"><TrendingUp size={12} aria-hidden="true" /><span>{`+${diff}`}</span></span>
  return <span className="text-danger inline-flex items-center gap-0.5 text-[12px] font-medium num" dir="ltr"><TrendingDown size={12} aria-hidden="true" /><span>{String(diff)}</span></span>
}

export default function SeoMetricsPanel() {
  const [rows, setRows] = useState<MetricsRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data } = await supabase
        .from('seo_metrics')
        .select('*')
        .eq('source', 'orchestrator_run')
        .order('logged_at', { ascending: false })
        .limit(5)
      if (!cancelled) {
        setRows((data ?? []) as MetricsRow[])
        setLoading(false)
      }
    }
    load()

    // Lightweight subscription so a fresh orchestrator run shows up
    // without a manual reload.
    const channel = supabase
      .channel('seo_metrics_panel')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'seo_metrics' }, () => load())
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [])

  return (
    // Same min-h-0 flex-overflow fix as SeoTaskQueue / SeoChatThread.
    <aside className="h-full flex flex-col min-h-0" aria-label="מדדים">
      <PanelHead title="מדדים" meta="5 ריצות אחרונות" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <LoadingRows rows={3} />
        ) : rows.length === 0 ? (
          <Empty>עדיין אין תמונות מצב. הן נרשמות בכל ריצה מתוזמנת של הסוכן.</Empty>
        ) : (
          rows.map((r, i) => {
            const next = rows[i + 1] // older snapshot (rows are DESC)
            const p = r.metrics_payload ?? {}
            const np = next?.metrics_payload ?? {}
            const movement = (p.gsc_position_deltas ?? [])
              .filter(d => d.prev_position != null && Math.abs(d.delta) >= 0.5)
              .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
              .slice(0, 5)
            const failed = p.tasks_failed_since_last_run ?? 0
            // The latest run leads: bigger figures. Older runs are compact rows.
            const latest = i === 0
            return (
              <section key={r.id} className={`px-4 ${latest ? 'pt-4 pb-4' : 'py-3'} ${i > 0 ? 'border-t border-surface-200' : ''}`}>
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <div className="text-[12.5px] text-surface-500 num" dir="ltr">{stamp(r.logged_at)}</div>
                  {latest && <Tag tone="brand">אחרונה</Tag>}
                </div>
                <dl className={`grid ${latest ? 'grid-cols-2 gap-x-4 gap-y-3' : 'grid-cols-1 gap-y-1'}`}>
                  {([
                    ['פוסטים, 7 ימים', p.blog_published_count_7d ?? 0, delta(p.blog_published_count_7d ?? 0, np.blog_published_count_7d)],
                    ['פוסטים, 30 יום', p.blog_published_count_30d ?? 0, delta(p.blog_published_count_30d ?? 0, np.blog_published_count_30d)],
                    ['הושלמו מאז', p.tasks_completed_since_last_run ?? 0, null],
                    ['נכשלו מאז', failed, null],
                  ] as Array<[string, number, React.ReactNode]>).map(([label, value, d], k) => (
                    <div key={label} className={latest ? '' : 'flex items-baseline justify-between gap-2'}>
                      <dt className={`text-surface-500 ${latest ? 'text-[12.5px]' : 'text-[12px]'}`}>{label}</dt>
                      <dd className={`num flex items-center gap-1.5 ${latest ? 'mt-0.5 text-[22px] font-medium tracking-[-0.02em]' : 'text-[13px] font-medium'} ${k === 3 && failed > 0 ? 'text-danger' : 'text-surface-900'}`}>
                        {value}
                        {d}
                      </dd>
                    </div>
                  ))}
                </dl>

                {movement.length > 0 && (
                  <div className="mt-3 pt-2.5 border-t border-surface-100">
                    <div className="text-[12px] text-surface-500 mb-1.5">תזוזה בולטת בגוגל (מיקום)</div>
                    <ul className="space-y-1">
                      {movement.map(m => (
                        <li key={m.keyword} className="flex items-center justify-between gap-2 text-[12.5px]">
                          <span className="truncate text-surface-700" dir="auto">{m.keyword}</span>
                          <span className={`num shrink-0 inline-flex items-center gap-1 font-medium ${m.delta < 0 ? 'text-ok' : 'text-danger'}`} dir="ltr">
                            {m.delta < 0 ? <ArrowUp size={12} aria-label="עלייה" /> : <ArrowDown size={12} aria-label="ירידה" />}
                            {m.prev_position?.toFixed(1)} → {m.new_position.toFixed(1)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )
          })
        )}
      </div>
    </aside>
  )
}
