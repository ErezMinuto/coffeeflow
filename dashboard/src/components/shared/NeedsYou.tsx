import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, CircleCheck } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Dot } from './cockpit'

// "Needs You" — one consolidated view of everything awaiting the owner's
// decision, pinned to the top of the /plan home page. The autonomous agents
// draft/propose silently into different admin surfaces; this surfaces them all
// in one place so nothing rots unseen. Quiet when nothing is pending.

interface ActionRow {
  key:   string
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
    return 0 // a missing table / RLS hiccup should never break the page
  }
}

export function NeedsYou() {
  const [rows, setRows] = useState<ActionRow[] | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [proposals, loopDone, drafts, review, signals] = await Promise.all([
        countRows(() => supabase.from('strategic_recommendations')
          .select('*', { count: 'exact', head: true }).eq('status', 'proposed')),
        // Closed loop: drafts that passed review, or did not pass after 2 revisions.
        countRows(() => supabase.from('strategic_recommendations')
          .select('*', { count: 'exact', head: true }).in('status', ['ready_for_review', 'needs_human'])),
        countRows(() => supabase.from('campaigns')
          .select('*', { count: 'exact', head: true }).eq('status', 'draft')),
        countRows(() => supabase.from('seo_tasks')
          .select('*', { count: 'exact', head: true }).eq('result_data->>review_required', 'true')),
        countRows(() => supabase.from('strategist_signals')
          .select('*', { count: 'exact', head: true }).eq('status', 'open')),
      ])
      if (!alive) return
      setRows([
        { key: 'proposals', label: 'המלצות מהאסטרטג לאישור',       to: '/admin/seo-agent?view=inbox',     cta: 'לאישור',  count: proposals },
        { key: 'loop',      label: 'טיוטות מהאסטרטג אחרי בדיקה, ממתינות להחלטה שלך', to: '/admin/seo-agent?view=inbox', cta: 'לבדיקה', count: loopDone },
        { key: 'drafts',    label: 'טיוטות מייל מוכנות לבדיקה ושליחה', to: '/marketing?tab=history',          cta: 'למחולל המיילים', count: drafts },
        { key: 'review',    label: 'תוכן שממתין לבדיקה שלך',         to: '/admin/seo-agent?view=inbox', cta: 'לבדיקה',  count: review },
        { key: 'signals',   label: 'התראות שהאסטרטג העלה',           to: '/admin/seo-agent?view=inbox',     cta: 'לצפייה',  count: signals },
      ])
    })()
    return () => { alive = false }
  }, [])

  // Still loading: a static placeholder the height of one row, so the page
  // neither claims "all clear" early nor jumps when the counts land.
  if (!rows) {
    return (
      <section aria-busy="true" aria-label="ממתין להחלטה" className="card-flush px-[18px] py-4">
        <span aria-hidden="true" className="block h-4 w-48 rounded bg-surface-100" />
      </section>
    )
  }

  const pending = rows.filter(r => r.count > 0)
  const total = pending.reduce((s, r) => s + r.count, 0)

  if (total === 0) {
    return (
      <section aria-label="ממתין להחלטה" className="fade-up card-flush px-[18px] py-4 flex items-center gap-2.5 text-sm text-surface-700">
        <CircleCheck size={18} aria-hidden="true" className="text-ok shrink-0" />
        <span>אין כרגע פריטים שממתינים להחלטה</span>
      </section>
    )
  }

  return (
    <section aria-labelledby="needs-you-title" className="fade-up card-flush overflow-hidden">
      <div className="card-head">
        <h2 id="needs-you-title">ממתין להחלטה שלך</h2>
        <span className="text-[13px] text-surface-500 num">{total} פריטים</span>
      </div>
      <ul>
        {pending.map(r => (
          <li key={r.key} className="flex items-center gap-3 px-[18px] py-2.5 [&+&]:border-t [&+&]:border-surface-200">
            <Dot tone="warn" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-surface-900">{r.label}</p>
              <p className="text-[13px] text-surface-500 num">{r.count === 1 ? 'פריט אחד' : `${r.count} פריטים`}</p>
            </div>
            <Link
              to={r.to}
              className="btn-ghost shrink-0 gap-1 h-9 px-2.5 text-[13px]"
            >
              {r.cta}
              <ChevronLeft size={15} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
