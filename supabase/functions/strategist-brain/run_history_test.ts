// deno run -A supabase/functions/strategist-brain/run_history_test.ts
import { latestToolResult, toolCallsIn } from './run_history.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const messages = [
  { role: 'user', content: 'Begin.' },
  { role: 'assistant', content: [{ type: 'thinking' }, { type: 'tool_use', id: 't1', name: 'get_seo_audit_overview', input: {} }, { type: 'tool_use', id: 't2', name: 'get_seo_issue_pages', input: { issue: 'orphan' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ coverage: [1], signals_to_address: [{ id: 'a' }] }) }, { type: 'tool_result', tool_use_id: 't2', content: '{"total":3}' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'get_seo_audit_overview', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: JSON.stringify({ coverage: [1, 2], signals_to_address: [] }) }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'conclude_brief', input: {} }] },
]
check('every tool call listed in order', toolCallsIn(messages).map((c) => c.name).join(',') === 'get_seo_audit_overview,get_seo_issue_pages,get_seo_audit_overview,conclude_brief')
check('tool inputs kept', toolCallsIn(messages)[1].input.issue === 'orphan')
const ov = latestToolResult(messages, 'get_seo_audit_overview')
check('latest overview result is the second call', Array.isArray(ov?.coverage) && (ov!.coverage as unknown[]).length === 2)
check('never-called tool → null', latestToolResult(messages, 'get_page_report') === null)
check('call without a result yet → null', latestToolResult(messages, 'conclude_brief') === null)
check('unreadable result → null', latestToolResult([{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'n' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'not json' }] }], 'n') === null)

// The real run that hit the resource limit (read-only), when credentials are present.
const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), runId = Deno.env.get('CHECK_RUN_ID')
if (url && key && runId) {
  const res = await fetch(`${url}/rest/v1/strategist_runs?id=eq.${runId}&select=state,steps_taken`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  const [run] = await res.json()
  const live = latestToolResult(run.state.messages, 'get_seo_audit_overview')
  check(`live run ${runId.slice(0, 8)}: overview found in saved state (step ${run.steps_taken})`, !!live && Array.isArray(live.coverage) && Array.isArray(live.signals_to_address),
    `coverage ${Array.isArray(live?.coverage) ? (live!.coverage as unknown[]).length : 'none'}, signals ${Array.isArray(live?.signals_to_address) ? (live!.signals_to_address as unknown[]).length : 'none'}`)
  console.log(`     coverage rows ${(live?.coverage as unknown[])?.length}, signals ${(live?.signals_to_address as unknown[])?.length}, tool calls so far ${toolCallsIn(run.state.messages).length}`)
}

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
