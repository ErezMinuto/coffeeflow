// Minuto Organic Marketing — proactive briefing writer.
//
// After each strategic event (orchestrator run, scout urgency detection,
// evaluator winner-write), write an assistant message into a designated
// chat session ('briefings-system'). When the admin opens the dashboard,
// the chat UI surfaces a "while you were away" badge counting unread
// briefings since their last_seen_at timestamp.
//
// This is the minimum-viable proactivity: no new notification surface,
// no email/push integration. The chat UI we already built becomes the
// place the agent talks to the admin unprompted.
//
// Briefing structure:
//   role:    'assistant'
//   content: markdown-rendered summary
//   metadata: {
//     type:        'briefing',
//     subtype:     'orchestrator_cycle' | 'scout_alert' | 'experiment_winner' | 'health_alert',
//     orchestrator_run_id?, scout_run_id?, experiment_id?
//   }
//
// Briefings ALWAYS go to the same hardcoded session_id so the admin can
// navigate to a single thread to see history.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { appendChatMessage } from './db.ts'

// One hardcoded session per agent-event-type so admin sees a stable
// thread to navigate to. The dashboard maps these to UI tabs / chips.
export const BRIEFING_SESSION_ID = 'briefings-system'

export type BriefingSubtype =
  | 'orchestrator_cycle'
  | 'scout_alert'
  | 'experiment_winner'
  | 'health_alert'

export interface BriefingContent {
  subtype:  BriefingSubtype
  title:    string                      // shown bold at top of message
  body:     string                      // markdown-rendered detail
  context?: Record<string, unknown>     // structured payload for the UI (badges, links to tasks)
}

export async function writeBriefing(
  supabase: SupabaseClient,
  briefing: BriefingContent,
): Promise<string> {
  const formatted = `**🤖 ${briefing.title}**\n\n${briefing.body}`
  const id = await appendChatMessage(supabase, {
    session_id: BRIEFING_SESSION_ID,
    role:       'assistant',
    content:    formatted,
    metadata: {
      type:    'briefing',
      subtype: briefing.subtype,
      ...(briefing.context ?? {}),
    },
  })
  return id
}

// Build the orchestrator-cycle briefing from the orchestrator's own
// outputs. Called at the end of each Sun/Wed orchestrator run.
export function buildOrchestratorCycleBriefing(args: {
  runId:                  string
  summary:                string
  selfReflection:         string[]
  experimentsEmitted:     number
  experimentsEvaluated:   { evaluated: number; inconclusive: number; winners: Array<{ experiment_id: string; winner_label: string; learning_id: string }> }
  tasksEmitted:           number
  taskIds:                string[]
  // Per-task emit outcome — what the strategist PLANNED vs what actually
  // inserted. Surfaces silent drops / zero-task runs in the admin-visible
  // run record instead of only a bare count.
  emitLog?:               Array<{ task_type: string; outcome: 'inserted' | 'dropped'; task_id: string | null }>
}): BriefingContent {
  const reflectionList = (args.selfReflection ?? []).map(r => `- ${r}`).join('\n')
  const winnerLines    = args.experimentsEvaluated.winners.map(w =>
    `- 🏆 winner '${w.winner_label}' from experiment \`${w.experiment_id.slice(0, 8)}\` → wrote learning \`${w.learning_id.slice(0, 8)}\``,
  ).join('\n')

  const body = [
    `_Cycle summary:_ ${args.summary || '(none)'}`,
    '',
    args.experimentsEvaluated.evaluated > 0 || args.experimentsEvaluated.inconclusive > 0
      ? `**Past experiments scored:** ${args.experimentsEvaluated.evaluated} winner(s), ${args.experimentsEvaluated.inconclusive} inconclusive`
      : '_No past experiments matured for evaluation this cycle._',
    winnerLines ? winnerLines : '',
    '',
    `**This cycle:** queued ${args.experimentsEmitted} new experiment(s) totaling ${args.tasksEmitted} task(s).`,
    // Explicit per-task emit record so a "no feed posts were produced" run is
    // visible at a glance (planned-but-dropped, or nothing planned at all).
    args.emitLog
      ? (args.emitLog.length > 0
          ? `**Tasks attempted (${args.emitLog.length}):** ${args.emitLog.map(e => `${e.task_type}→${e.outcome}`).join(', ')}`
          : '_Strategist planned 0 content tasks this cycle (no visual/post/article tasks emitted)._')
      : '',
    '',
    reflectionList ? `**Self-reflection:**\n${reflectionList}` : '',
  ].filter(Boolean).join('\n')

  return {
    subtype: 'orchestrator_cycle',
    title:   `Cycle complete (run ${args.runId.slice(0, 8)})`,
    body,
    context: {
      orchestrator_run_id: args.runId,
      tasks_emitted:       args.tasksEmitted,
      experiments_emitted: args.experimentsEmitted,
      winners_count:       args.experimentsEvaluated.winners.length,
      inconclusive_count:  args.experimentsEvaluated.inconclusive,
    },
  }
}
