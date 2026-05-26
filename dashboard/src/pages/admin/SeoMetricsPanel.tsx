import { useEffect, useState } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { supabase } from '../../lib/supabase'

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
    return <span className="text-surface-400"><Minus size={12} /></span>
  }
  const diff = current - prior
  if (diff === 0)  return <span className="text-surface-400"><Minus size={12} /></span>
  if (diff > 0)    return <span className="text-green-700 inline-flex items-center gap-0.5 text-[10px]"><TrendingUp size={12} />+{diff}</span>
  return <span className="text-red-700 inline-flex items-center gap-0.5 text-[10px]"><TrendingDown size={12} />{diff}</span>
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
    <aside className="h-full flex flex-col bg-white border-l border-surface-200 min-h-0">
      <header className="h-10 px-3 flex items-center justify-between border-b border-surface-200 bg-surface-50 shrink-0">
        <h2 className="text-sm font-semibold text-surface-800">Metrics</h2>
        <span className="text-xs text-surface-500">last 5</span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="text-xs text-surface-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-surface-500">No orchestrator snapshots yet.</div>
        ) : (
          rows.map((r, i) => {
            const next = rows[i + 1] // older snapshot (rows are DESC)
            const p = r.metrics_payload ?? {}
            const np = next?.metrics_payload ?? {}
            const movement = (p.gsc_position_deltas ?? [])
              .filter(d => d.prev_position != null && Math.abs(d.delta) >= 0.5)
              .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
              .slice(0, 5)
            return (
              <div key={r.id} className="border border-surface-200 rounded p-2 text-xs">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-mono text-[10px] text-surface-500">
                    {new Date(r.logged_at).toISOString().slice(0, 16).replace('T', ' ')}
                  </div>
                  {i === 0 && (
                    <span className="text-[9px] px-1 py-0.5 bg-blue-50 text-blue-800 rounded">latest</span>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                  <dt className="text-surface-500">Blog 7d</dt>
                  <dd className="text-right font-medium inline-flex items-center justify-end gap-1">
                    {p.blog_published_count_7d ?? 0}
                    {delta(p.blog_published_count_7d ?? 0, np.blog_published_count_7d)}
                  </dd>
                  <dt className="text-surface-500">Blog 30d</dt>
                  <dd className="text-right font-medium inline-flex items-center justify-end gap-1">
                    {p.blog_published_count_30d ?? 0}
                    {delta(p.blog_published_count_30d ?? 0, np.blog_published_count_30d)}
                  </dd>
                  <dt className="text-surface-500">Done since</dt>
                  <dd className="text-right font-medium">{p.tasks_completed_since_last_run ?? 0}</dd>
                  <dt className="text-surface-500">Failed since</dt>
                  <dd className="text-right font-medium text-red-700">{p.tasks_failed_since_last_run ?? 0}</dd>
                </dl>

                {movement.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-surface-100">
                    <div className="text-[10px] text-surface-500 mb-1">Top movement</div>
                    <ul className="space-y-0.5">
                      {movement.map(m => (
                        <li key={m.keyword} className="flex items-center justify-between gap-2 text-[10px]">
                          <span className="truncate text-surface-700">{m.keyword}</span>
                          <span className={`font-mono shrink-0 ${m.delta < 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {m.delta < 0 ? '↑' : '↓'} {m.prev_position?.toFixed(1)} → {m.new_position.toFixed(1)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
