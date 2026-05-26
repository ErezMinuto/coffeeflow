import { useEffect, useState } from 'react'
import { Clock, AlertCircle, CheckCircle2, X, Eye, ThumbsUp, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Left-panel: live pending-task queue.
//
// Subscribes to seo_tasks via Supabase realtime so when the chat handler
// (or the cron orchestrator) inserts/updates rows, the panel reflects
// without a manual refresh. We keep the row list capped at 50 so a stuck
// queue doesn't slow the panel.

export interface SeoTaskRow {
  id:              string
  task_type:       string
  task_subtype:    string | null
  status:          'pending' | 'processing' | 'completed' | 'failed'
  brief_data:      Record<string, unknown>
  rationale:       string | null
  created_at:      string
  scheduled_for:   string
  error_msg:       string | null
  result_data:     Record<string, unknown> | null
}

interface Props {
  onTaskAction?: (action: 'view' | 'approve' | 'cancel', task: SeoTaskRow) => void
}

const STATUS_STYLES: Record<SeoTaskRow['status'], { bg: string; text: string; icon: typeof Clock }> = {
  pending:    { bg: 'bg-amber-50',  text: 'text-amber-800',  icon: Clock },
  processing: { bg: 'bg-blue-50',   text: 'text-blue-800',   icon: Loader2 },
  completed:  { bg: 'bg-green-50',  text: 'text-green-800',  icon: CheckCircle2 },
  failed:     { bg: 'bg-red-50',    text: 'text-red-800',    icon: AlertCircle },
}

export default function SeoTaskQueue({ onTaskAction }: Props) {
  const [tasks, setTasks]   = useState<SeoTaskRow[]>([])
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<SeoTaskRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Initial load + realtime subscription. Filter to non-completed (active
  // queue feel) but include the last few completed/failed for context.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data } = await supabase
        .from('seo_tasks')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50)
      if (!cancelled) {
        setTasks((data ?? []) as SeoTaskRow[])
        setLoading(false)
      }
    }
    load()

    const channel = supabase
      .channel('seo_tasks_queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seo_tasks' }, () => {
        // Cheap and correct: re-fetch. The table is small and updates
        // are sparse (a few rows per orchestrator run).
        load()
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [])

  async function handleCancel(t: SeoTaskRow) {
    const reason = window.prompt(`Cancel task "${t.task_type}"?\n\nReason:`, 'No longer needed')
    if (!reason) return
    setBusy(t.id)
    try {
      const { error } = await supabase
        .from('seo_tasks')
        .update({ status: 'failed', error_msg: `[ui-cancel] ${reason}`, locked_until: null })
        .eq('id', t.id)
      if (error) throw error
      onTaskAction?.('cancel', t)
    } catch (e) {
      console.error('[SeoTaskQueue] cancel failed:', e)
      window.alert('Cancel failed. See console.')
    } finally {
      setBusy(null)
    }
  }

  async function handleApprove(t: SeoTaskRow) {
    if (t.task_type !== 'dynamic_experiment') return
    if (!window.confirm(`Approve experiment "${t.task_subtype ?? t.task_type}"?`)) return
    setBusy(t.id)
    try {
      const { error } = await supabase
        .from('seo_tasks')
        .update({
          status:       'completed',
          result_data:  { approved_via_ui_at: new Date().toISOString() },
          completed_at: new Date().toISOString(),
          locked_until: null,
        })
        .eq('id', t.id)
      if (error) throw error
      onTaskAction?.('approve', t)
    } catch (e) {
      console.error('[SeoTaskQueue] approve failed:', e)
      window.alert('Approve failed. See console.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside className="h-full flex flex-col bg-white border-r border-surface-200">
      <header className="h-10 px-3 flex items-center justify-between border-b border-surface-200 bg-surface-50">
        <h2 className="text-sm font-semibold text-surface-800">Task queue</h2>
        <span className="text-xs text-surface-500">{tasks.length} rows</span>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-xs text-surface-500">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="p-4 text-xs text-surface-500">No tasks yet. The orchestrator runs twice weekly.</div>
        ) : (
          <ul className="divide-y divide-surface-100">
            {tasks.map(t => {
              const style = STATUS_STYLES[t.status] ?? STATUS_STYLES.pending
              const StatusIcon = style.icon
              return (
                <li key={t.id} className="p-3 text-xs hover:bg-surface-50 transition-colors">
                  <div className="flex items-start gap-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${style.bg} ${style.text} font-medium shrink-0`}>
                      <StatusIcon size={11} className={t.status === 'processing' ? 'animate-spin' : ''} />
                      {t.status}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-surface-900 truncate">
                        {t.task_type}{t.task_subtype ? `:${t.task_subtype}` : ''}
                      </div>
                      {t.rationale && (
                        <div className="text-surface-600 mt-0.5 line-clamp-2">{t.rationale}</div>
                      )}
                      <div className="text-surface-400 mt-1 text-[10px] font-mono">
                        {new Date(t.created_at).toISOString().slice(0, 16).replace('T', ' ')} · {t.id.slice(0, 8)}
                      </div>
                      {t.error_msg && (
                        <div className="mt-1 text-red-700 line-clamp-2">{t.error_msg}</div>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={() => setViewing(t)}
                          className="inline-flex items-center gap-1 text-surface-500 hover:text-surface-900"
                          title="View brief"
                        ><Eye size={12} /> brief</button>
                        {t.task_type === 'dynamic_experiment' && t.status === 'pending' && (
                          <button
                            onClick={() => handleApprove(t)}
                            disabled={busy === t.id}
                            className="inline-flex items-center gap-1 text-green-700 hover:text-green-900 disabled:opacity-50"
                            title="Approve experiment"
                          ><ThumbsUp size={12} /> approve</button>
                        )}
                        {(t.status === 'pending' || t.status === 'processing') && (
                          <button
                            onClick={() => handleCancel(t)}
                            disabled={busy === t.id}
                            className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 disabled:opacity-50"
                            title="Cancel task"
                          ><X size={12} /> cancel</button>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {viewing && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-6"
          onClick={() => setViewing(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <header className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">
                  {viewing.task_type}{viewing.task_subtype ? `:${viewing.task_subtype}` : ''}
                </div>
                <div className="text-[10px] text-surface-500 font-mono">{viewing.id}</div>
              </div>
              <button onClick={() => setViewing(null)} className="text-surface-500 hover:text-surface-900"><X size={18} /></button>
            </header>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
              {viewing.rationale && (
                <div>
                  <div className="font-semibold text-surface-700 mb-1">Rationale</div>
                  <div className="text-surface-800">{viewing.rationale}</div>
                </div>
              )}
              <div>
                <div className="font-semibold text-surface-700 mb-1">Brief</div>
                <pre className="bg-surface-50 p-3 rounded text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
{JSON.stringify(viewing.brief_data, null, 2)}
                </pre>
              </div>
              {viewing.result_data && (
                <div>
                  <div className="font-semibold text-surface-700 mb-1">Result</div>
                  <pre className="bg-surface-50 p-3 rounded text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
{JSON.stringify(viewing.result_data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
