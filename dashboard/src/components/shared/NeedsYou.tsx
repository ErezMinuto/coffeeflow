import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

// "Needs You" — one consolidated view of everything awaiting the owner's
// decision, pinned to the top of the Overview home page. The autonomous agents
// draft/propose silently into different admin surfaces; this surfaces them all
// in one place so nothing rots unseen. Quiet when nothing is pending.

interface ActionRow {
  key:   string
  icon:  string
  label: string
  to:    string
  cta:   string
  count: number
}

async function countRows(build: () => any): Promise<number> {
  try {
    const { count } = await build()
    return count ?? 0
  } catch {
    return 0 // a missing table / RLS hiccup should never break the home page
  }
}

export function NeedsYou() {
  const [rows, setRows] = useState<ActionRow[] | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [proposals, drafts, review, signals] = await Promise.all([
        countRows(() => supabase.from('strategic_recommendations')
          .select('*', { count: 'exact', head: true }).eq('status', 'proposed')),
        countRows(() => supabase.from('campaigns')
          .select('*', { count: 'exact', head: true }).eq('status', 'draft')),
        countRows(() => supabase.from('seo_tasks')
          .select('*', { count: 'exact', head: true }).eq('result_data->>review_required', 'true')),
        countRows(() => supabase.from('strategist_signals')
          .select('*', { count: 'exact', head: true }).eq('status', 'open')),
      ])
      if (!alive) return
      setRows([
        { key: 'proposals', icon: '🧠', label: 'המלצות מהאסטרטג לאישור',       to: '/admin/seo-agent', cta: 'לאישור',  count: proposals },
        { key: 'drafts',    icon: '✉️', label: 'טיוטות מייל מוכנות לבדיקה ושליחה', to: '/marketing',       cta: 'למרקטינג', count: drafts },
        { key: 'review',    icon: '🖼️', label: 'תוכן שממתין לבדיקה שלך',         to: '/admin/seo-agent', cta: 'לבדיקה',  count: review },
        { key: 'signals',   icon: '⚠️', label: 'התראות שהאסטרטג העלה',           to: '/admin/seo-agent', cta: 'לצפייה',  count: signals },
      ])
    })()
    return () => { alive = false }
  }, [])

  if (!rows) return null // still loading — stay quiet, don't flash an empty box

  const pending = rows.filter(r => r.count > 0)
  const total = pending.reduce((s, r) => s + r.count, 0)

  if (total === 0) {
    return (
      <div className="card fade-up flex items-center gap-2 text-sm text-surface-400">
        <span>✓</span>
        <span>אין פעולות ממתינות — הכול מטופל</span>
      </div>
    )
  }

  return (
    <div className="card fade-up border-r-4 border-amber-400">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-semibold text-surface-900">דורש את תשומת לבך</h3>
        <span className="badge bg-amber-100 text-amber-700">{total}</span>
      </div>
      <div className="space-y-1">
        {pending.map(r => (
          <Link
            key={r.key}
            to={r.to}
            className="flex items-center justify-between rounded-xl px-3 py-3 hover:bg-surface-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="text-lg">{r.icon}</span>
              <span className="text-sm text-surface-900">{r.label}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="badge bg-amber-100 text-amber-700">{r.count}</span>
              <span className="text-xs text-surface-400 whitespace-nowrap">{r.cta} ←</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
