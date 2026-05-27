// Minuto SEO Agent — admin chat handler.
//
// Powers the live chat surface at /admin/seo-agent. Single POST entry
// point. Loads chat history + recent metrics + recent tasks from the
// shared SEO module, runs a tool-use loop against Claude, persists every
// turn (user, assistant tool_use turns, tool results, final assistant
// text) into chat_messages, and returns the final assistant text + the
// updated history for the front-end to render.
//
// Tool implementations are inline below so the orchestrator's tool-less
// flow stays decoupled. If we ever want a worker to call these tools too
// we can lift them into seo-agent/. Today, only the chat surface uses
// them, so they stay here.
//
// Storage convention vs Anthropic API convention:
//   - chat_messages stores role='tool' rows for each tool result with
//     tool_call_id set, and role='assistant' rows with tool_calls JSON
//     for assistant turns that requested tools.
//   - Anthropic Messages API wants tool_results as content blocks inside
//     a user message. We translate between the two when building the
//     messages array.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { CHAT_SYSTEM_PROMPT } from '../seo-agent/prompts/chat.ts'
import {
  callClaude,
  parseClaudeJson,
  MODEL_CHAT,
  type ChatMessage as ApiChatMessage,
  type MessageContentBlock,
  type ToolDefinition,
} from '../seo-agent/claude.ts'
import { attachFeaturedImage } from '../seo-agent/wpMediaAttach.ts'
import {
  createSupabase,
  appendChatMessage,
  getChatHistory,
  getRecentTasks,
  getRecentMetricsSnapshots,
  getRecentLearnings,
  insertTasks,
  markTaskFailed,
  recordLearning,
  supersedeLearning,
} from '../seo-agent/db.ts'
import type {
  ChatToolName,
  LearningRow,
  LearningScope,
  NewSeoTask,
  SeoTaskRow,
} from '../seo-agent/types.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Env for the publish_ig_post tool — calls meta-publish via the local
// Supabase URL with the function-invoke anon key.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!
// WP credentials for the approve_qa_attempt tool. Same env vars
// seo-worker-visual + blog-publish use — single source of truth.
const WP_URL          = (Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il').replace(/\/+$/, '')
const WP_USERNAME     = Deno.env.get('WP_BLOG_POST_USER_NAME') ?? ''
const WP_APP_PASSWORD = Deno.env.get('WP_BLOG_POST_PASS') ?? ''

// Cap on tool-use loop iterations so a misbehaving model can't pin the
// edge function until the 150s wall clock kills it. 8 is more than
// enough — most turns are 1-2 tool calls deep.
const MAX_TOOL_LOOPS = 8

// ── Tool catalogue (Anthropic input_schema format) ─────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'queue_task',
    description: 'Insert a new task into seo_tasks as pending. Use for text_generation, visual_generation, or dynamic_experiment. brief_data shape depends on task_type — see types.ts.',
    input_schema: {
      type: 'object',
      properties: {
        task_type:  { type: 'string', description: 'Canonical: text_generation | visual_generation | dynamic_experiment. Novel subtypes like seo_experiment:internal_linking_audit are also allowed.' },
        brief_data: { type: 'object', description: 'Brief payload matching the task_type schema in types.ts.' },
        rationale:  { type: 'string', description: 'One-line justification surfaced in the admin UI.' },
      },
      required: ['task_type', 'brief_data', 'rationale'],
    },
  },
  {
    name: 'approve_dynamic_experiment',
    description: 'Approve a pending dynamic_experiment so it can move forward. Currently marks the task as completed with an approval audit trail in result_data — workers can pick it up from there.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the seo_tasks row.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a task (sets status=failed with the supplied reason). Use when Erez says "kill that one" or similar.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the seo_tasks row.' },
        reason:  { type: 'string', description: 'Why the task is being cancelled.' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'get_task_details',
    description: 'Fetch the full seo_tasks row for a task_id.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the seo_tasks row.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_recent_metrics',
    description: 'Pull the most-recent seo_metrics snapshots (source=orchestrator_run). Defaults to 5.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent snapshots to return. Default 5.' },
      },
    },
  },
  {
    name: 'list_pending_tasks',
    description: 'List all pending seo_tasks rows, optionally filtered by task_type.',
    input_schema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', description: 'Optional filter (e.g. dynamic_experiment).' },
      },
    },
  },
  {
    name: 'record_learning',
    description: 'Persist an insight from this conversation into seo_learnings so it survives across chat sessions AND shapes future orchestrator runs. Use when the admin teaches you something durable ("no hands in images", "Yirgacheffe articles work better"). Do NOT use for one-off corrections — only for rules/preferences that should apply going forward. Always confirm the wording with the admin first, in one sentence, before calling.',
    input_schema: {
      type: 'object',
      properties: {
        scope:   { type: 'string', description: "Taxonomy bucket: 'visual_style' | 'brand_voice' | 'render_strategy' | 'content_topic' | 'qa_pattern' | 'other'." },
        insight: { type: 'string', description: 'One- to three-sentence rule in plain English, phrased prescriptively ("Always avoid X" / "Prefer Y when Z").' },
        evidence_task_ids: { type: 'array', items: { type: 'string' }, description: 'Optional UUIDs of seo_tasks rows that triggered this learning, so admins can trace why it was recorded.' },
      },
      required: ['scope', 'insight'],
    },
  },
  {
    name: 'list_learnings',
    description: 'Fetch active (non-superseded) learnings from seo_learnings. Use to recall what was previously taught before acting on something the admin says.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Optional scope filter.' },
        limit: { type: 'number', description: 'Default 20.' },
      },
    },
  },
  {
    name: 'supersede_learning',
    description: 'Mark a learning as superseded when the admin retracts or refines a prior rule. The row stays for audit; it just stops appearing in future context.',
    input_schema: {
      type: 'object',
      properties: {
        learning_id: { type: 'string', description: 'UUID of the seo_learnings row.' },
        reason:      { type: 'string', description: 'Why it is being retracted/refined.' },
      },
      required: ['learning_id', 'reason'],
    },
  },
  {
    name: 'list_pending_ig_posts',
    description: 'List Instagram posts that the IG worker prepared as DRAFTS on Meta (action=prepare → creation_id) and are now awaiting the admin to approve + publish. Auto-publish is hard-blocked at the worker; everything sits here until the admin says go. Returns the queued tasks with their captions and IG creation_ids.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'publish_ig_post',
    description: 'Take a queued IG post (status=completed, result_data.ig_creation_id set, not yet published) and tell Meta to publish it live now. Burns one slot of the 50-posts/24h IG quota. Use only when the admin explicitly approves a specific task_id — never on your own initiative, never for tasks the admin has not seen.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the seo_tasks row whose IG draft to publish.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'ingest_url',
    description: 'Fetch a URL the admin pasted (article, blog post, case study, etc.), summarize it for relevance to the Minuto organic stack, and OPTIONALLY record the insight as a durable best-practice learning. Use this when the admin says something like "read this and remember it" or "what do you think of this article?". Always confirm with the admin BEFORE calling record_learning — return the synthesized insight first, ask if it should be persisted.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_industry_insights',
    description: 'Show recent industry_articles insights (marketing/SEO/social/coffee) that the daily ingester has summarized. Use when the admin asks "what is the field saying about X?" or "show me what you have been reading". Returns the top N by relevance score.',
    input_schema: {
      type: 'object',
      properties: {
        limit:           { type: 'number', description: 'Default 8. Max 30.' },
        min_relevance:   { type: 'number', description: 'Default 0.5. Set to 0 to see everything.' },
        category_filter: { type: 'string', description: "Optional: 'seo' | 'marketing' | 'social' | 'coffee'." },
      },
    },
  },
  {
    name: 'approve_qa_attempt',
    description: 'Override the QA loop for a visual_generation task that got capped (result_data.review_required=true) — the admin has reviewed a specific attempt and approved it for attach. Pulls the image_url from qa_attempts[attempt_number-1], runs the standard WP featured-image attach flow (same code path the worker uses on a QA pass), and patches result_data to clear review_required + record approved_attempt + approved_via_chat_at. Use ONLY when the admin says something like "attempt N is fine" or "approve attempt N of <task_id>". Only works for blog_banner destination today; IG-destination QA approval is a separate flow.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:        { type: 'string', description: 'UUID of the visual_generation seo_tasks row.' },
        attempt_number: { type: 'number', description: '1-based index into qa_attempts[]. The admin tells you which attempt is acceptable.' },
      },
      required: ['task_id', 'attempt_number'],
    },
  },
]

// ── Tool execution ─────────────────────────────────────────────────────

async function executeTool(
  supabase: SupabaseClient,
  name: ChatToolName,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; payload: unknown }> {
  try {
    switch (name) {
      case 'queue_task': {
        const task_type  = String(input.task_type ?? '').trim()
        const brief_data = input.brief_data as Record<string, unknown> | undefined
        const rationale  = String(input.rationale ?? '').trim()
        if (!task_type || !brief_data || !rationale) {
          return { ok: false, payload: { error: 'queue_task requires task_type, brief_data, rationale.' } }
        }
        const newTask: NewSeoTask = {
          task_type,
          brief_data,
          rationale,
          // No orchestrator_run_id for chat-queued tasks — use a synthetic
          // marker so we can audit which tasks came from the chat surface.
          orchestrator_run_id: crypto.randomUUID(),
        }
        const inserted = await insertTasks(supabase, [newTask])
        const row = inserted[0]
        return { ok: true, payload: { task_id: row?.id ?? null, status: row?.status ?? 'pending' } }
      }

      case 'approve_dynamic_experiment': {
        const task_id = String(input.task_id ?? '').trim()
        if (!task_id) return { ok: false, payload: { error: 'task_id required.' } }
        // Mark approved in result_data; status stays pending if a worker
        // is supposed to act on it next, else completed. Today there's no
        // dynamic_experiment worker, so we flip to completed with an
        // approval audit. The admin can re-queue follow-up text/visual
        // tasks via the chat if needed.
        const { data, error } = await supabase
          .from('seo_tasks')
          .update({
            status:       'completed',
            result_data:  { approved_via_chat_at: new Date().toISOString() },
            completed_at: new Date().toISOString(),
            locked_until: null,
            error_msg:    null,
          })
          .eq('id', task_id)
          .select()
          .maybeSingle()
        if (error) return { ok: false, payload: { error: error.message } }
        if (!data)  return { ok: false, payload: { error: `task ${task_id} not found.` } }
        return { ok: true, payload: { status: 'approved', task: data } }
      }

      case 'cancel_task': {
        const task_id = String(input.task_id ?? '').trim()
        const reason  = String(input.reason ?? '').trim()
        if (!task_id || !reason) {
          return { ok: false, payload: { error: 'cancel_task requires task_id and reason.' } }
        }
        await markTaskFailed(supabase, task_id, `[chat-cancel] ${reason}`, true)
        return { ok: true, payload: { status: 'cancelled', task_id } }
      }

      case 'get_task_details': {
        const task_id = String(input.task_id ?? '').trim()
        if (!task_id) return { ok: false, payload: { error: 'task_id required.' } }
        const { data, error } = await supabase
          .from('seo_tasks')
          .select('*')
          .eq('id', task_id)
          .maybeSingle()
        if (error) return { ok: false, payload: { error: error.message } }
        if (!data)  return { ok: false, payload: { error: `task ${task_id} not found.` } }
        return { ok: true, payload: { row: data } }
      }

      case 'get_recent_metrics': {
        const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(20, input.limit)) : 5
        const snapshots = await getRecentMetricsSnapshots(supabase, 'orchestrator_run', limit)
        return { ok: true, payload: { snapshots } }
      }

      case 'list_pending_tasks': {
        const task_type = typeof input.task_type === 'string' ? input.task_type : null
        let q = supabase
          .from('seo_tasks')
          .select('*')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(50)
        if (task_type) q = q.eq('task_type', task_type)
        const { data, error } = await q
        if (error) return { ok: false, payload: { error: error.message } }
        return { ok: true, payload: { rows: data ?? [] } }
      }

      case 'record_learning': {
        const scope   = String(input.scope ?? '').trim() as LearningScope
        const insight = String(input.insight ?? '').trim()
        if (!scope || !insight) {
          return { ok: false, payload: { error: 'record_learning requires scope and insight.' } }
        }
        const evidence = Array.isArray(input.evidence_task_ids)
          ? input.evidence_task_ids.map(String).filter(Boolean)
          : []
        const row = await recordLearning(supabase, {
          scope,
          insight,
          evidence_task_ids: evidence,
          created_by:        'chat_agent',
        })
        return { ok: true, payload: { learning_id: row.id, scope: row.scope, created_at: row.created_at } }
      }

      case 'list_learnings': {
        const scope = typeof input.scope === 'string' ? input.scope : undefined
        const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(50, input.limit)) : 20
        const rows = await getRecentLearnings(supabase, {
          scopes: scope ? [scope] : undefined,
          limit,
        })
        return { ok: true, payload: { learnings: rows } }
      }

      case 'supersede_learning': {
        const learning_id = String(input.learning_id ?? '').trim()
        const reason      = String(input.reason ?? '').trim()
        if (!learning_id || !reason) {
          return { ok: false, payload: { error: 'supersede_learning requires learning_id and reason.' } }
        }
        await supersedeLearning(supabase, learning_id, reason)
        return { ok: true, payload: { learning_id, status: 'superseded' } }
      }

      case 'list_pending_ig_posts': {
        // IG tasks that the worker prepared (creation_id set) but the admin
        // hasn't yet approved for publish. Surfaced for explicit approval.
        const { data, error } = await supabase
          .from('seo_tasks')
          .select('id, task_type, brief_data, result_data, created_at')
          .eq('task_type', 'instagram_post')
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(50)
        if (error) return { ok: false, payload: { error: error.message } }
        const queued = (data ?? []).filter((t: any) => {
          const r = (t.result_data ?? {}) as { ig_creation_id?: string; ig_media_id?: string }
          // Has a creation_id but no media_id = prepared, not yet published.
          return !!r.ig_creation_id && !r.ig_media_id
        })
        return {
          ok: true,
          payload: {
            count: queued.length,
            posts: queued.map((t: any) => ({
              task_id:        t.id,
              created_at:     t.created_at,
              ig_creation_id: t.result_data?.ig_creation_id,
              caption_preview: String(t.result_data?.caption ?? '').slice(0, 200),
              image_url:      t.result_data?.image_url,
              auto_publish_overridden: t.result_data?.auto_publish_overridden === true,
            })),
          },
        }
      }

      case 'publish_ig_post': {
        const task_id = String(input.task_id ?? '').trim()
        if (!task_id) return { ok: false, payload: { error: 'task_id required.' } }
        // Load the task + verify it's in a publishable state.
        const { data: task, error: loadErr } = await supabase
          .from('seo_tasks')
          .select('id, task_type, status, result_data')
          .eq('id', task_id)
          .maybeSingle()
        if (loadErr) return { ok: false, payload: { error: loadErr.message } }
        if (!task)   return { ok: false, payload: { error: `task ${task_id} not found.` } }
        if (task.task_type !== 'instagram_post') {
          return { ok: false, payload: { error: `task is task_type=${task.task_type}, not instagram_post.` } }
        }
        const r = (task.result_data ?? {}) as { ig_creation_id?: string; ig_media_id?: string }
        if (!r.ig_creation_id) {
          return { ok: false, payload: { error: 'task has no ig_creation_id — IG worker probably failed before preparing. Re-queue the task or inspect result_data.' } }
        }
        if (r.ig_media_id) {
          return { ok: false, payload: { error: `task already published (ig_media_id=${r.ig_media_id}). No-op.` } }
        }
        // Tell meta-publish to flip the prepared container live.
        const res = await fetch(`${SUPABASE_URL}/functions/v1/meta-publish`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
          body:    JSON.stringify({ action: 'publish', creation_id: r.ig_creation_id }),
        })
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        if (!res.ok) {
          return { ok: false, payload: { error: `meta-publish ${res.status}: ${(json.error as string) ?? JSON.stringify(json).slice(0, 300)}` } }
        }
        // Patch the task's result_data with the new media_id + permalink so
        // future list_pending_ig_posts calls don't re-surface it.
        const patch = {
          ...(task.result_data as Record<string, unknown> ?? {}),
          ig_media_id:    json.media_id ?? json.id ?? null,
          ig_permalink:   json.permalink ?? null,
          published_at:   new Date().toISOString(),
          published_via:  'chat_agent_approval',
        }
        await supabase.from('seo_tasks').update({ result_data: patch }).eq('id', task_id)

        // ── PUBLISH-AS-VOTE LEARNING SIGNAL ──────────────────────────
        // If this task was part of an A/B experiment, the admin's choice
        // to publish THIS variation (and implicitly NOT publish the
        // sibling) is itself a learning signal — a taste vote. Record it
        // as a learning so future cycles bias toward the chosen
        // variation's style. NOT real engagement data; that comes later
        // when meta-sync ingests the live post's metrics + the experiment
        // evaluator scores it. This is the human-preference layer that
        // shapes captions before any real-world data exists.
        try {
          const { data: taskFull } = await supabase
            .from('seo_tasks')
            .select('experiment_id, variation_label')
            .eq('id', task_id)
            .maybeSingle()
          if (taskFull?.experiment_id && taskFull.variation_label) {
            // Look up the experiment + other variations to find the loser(s).
            const { data: siblings } = await supabase
              .from('seo_tasks')
              .select('id, variation_label')
              .eq('experiment_id', taskFull.experiment_id)
              .neq('id', task_id)
            const losers = (siblings ?? []).map((s: any) => s.variation_label).filter(Boolean)
            const { data: exp } = await supabase
              .from('seo_experiments')
              .select('hypothesis, task_type')
              .eq('id', taskFull.experiment_id)
              .maybeSingle()
            if (losers.length > 0 && exp) {
              await recordLearning(supabase, {
                scope:             'experiment_winner',
                insight:           `Admin-preference signal (NOT real engagement): for the ${exp.task_type} experiment "${(exp.hypothesis ?? '').slice(0, 100)}", the admin chose to publish variation '${taskFull.variation_label}' over alternatives [${losers.join(', ')}]. Provisional rule until real-world metrics from meta-sync land in the experiment evaluator.`,
                evidence_task_ids: [task_id],
                created_by:        'chat_agent',
              })
              console.log(`[handle-seo-chat] recorded publish-as-vote learning: ${taskFull.variation_label} > ${losers.join(', ')}`)
            }
          }
        } catch (e: any) {
          // Don't fail the publish if the learning-write fails — log + continue.
          console.warn(`[handle-seo-chat] publish-as-vote learning failed (publish still succeeded): ${e?.message ?? e}`)
        }

        return {
          ok: true,
          payload: {
            task_id,
            status:       'published',
            ig_media_id:  json.media_id ?? json.id ?? null,
            ig_permalink: json.permalink ?? null,
          },
        }
      }

      case 'ingest_url': {
        const url = String(input.url ?? '').trim()
        if (!url || !/^https?:\/\//.test(url)) {
          return { ok: false, payload: { error: 'ingest_url requires a full http(s) URL.' } }
        }
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MinutoOrganicAgent/1.0)' },
          })
          if (!res.ok) return { ok: false, payload: { error: `fetch HTTP ${res.status}` } }
          const html = await res.text()
          // Cheap text extraction (same as industry-intelligence-sync).
          const body = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 6000)
          if (body.length < 200) return { ok: false, payload: { error: 'page body too short after HTML strip (paywall, JS-heavy SPA, or PDF?). Try a different URL.' } }
          // Synthesize via Haiku — same prompt as the industry ingester.
          const synth = await callClaude({
            model:  'claude-haiku-4-5',
            system: `You are Minuto's organic-marketing research analyst. Given a URL pasted by the admin, summarize it as an actionable insight for Minuto's organic stack (Hebrew SEO blog + Instagram + dynamic experiments). Output strict JSON only:\n{"insight":"2-4 sentences explaining WHAT the source argues + HOW Minuto could apply it","relevance":0.0-1.0,"tags":["tag1","tag2"]}`,
            messages: [{ role: 'user', content: `URL: ${url}\n\nBODY:\n${body}` }],
            maxTokens: 600,
            temperature: 0.3,
            timeoutMs: 30_000,
          })
          let parsed: { insight?: unknown; relevance?: unknown; tags?: unknown } = {}
          try { parsed = parseClaudeJson(synth.text) } catch { parsed = { insight: synth.text } }
          return {
            ok: true,
            payload: {
              url,
              insight:    typeof parsed.insight === 'string' ? parsed.insight : '(synth failed)',
              relevance:  typeof parsed.relevance === 'number' ? parsed.relevance : null,
              tags:       Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
              note:       'NOT yet recorded as a learning. If you want this remembered durably, call record_learning next with scope=industry_best_practice (or similar) + this insight verbatim.',
            },
          }
        } catch (e: any) {
          return { ok: false, payload: { error: `ingest failed: ${e?.message ?? e}` } }
        }
      }

      case 'approve_qa_attempt': {
        const task_id = String(input.task_id ?? '').trim()
        const attemptN = typeof input.attempt_number === 'number' ? Math.floor(input.attempt_number) : 0
        if (!task_id) return { ok: false, payload: { error: 'task_id required.' } }
        if (attemptN < 1) return { ok: false, payload: { error: 'attempt_number must be 1-based positive integer.' } }
        if (!WP_USERNAME || !WP_APP_PASSWORD) {
          return { ok: false, payload: { error: 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not configured — cannot attach.' } }
        }
        // Load + validate the task.
        const { data: task, error: tErr } = await supabase
          .from('seo_tasks')
          .select('id, task_type, parent_task_id, result_data')
          .eq('id', task_id)
          .maybeSingle()
        if (tErr) return { ok: false, payload: { error: tErr.message } }
        if (!task) return { ok: false, payload: { error: `task ${task_id} not found.` } }
        if (task.task_type !== 'visual_generation') {
          return { ok: false, payload: { error: `task is task_type=${task.task_type}, not visual_generation.` } }
        }
        const rd = (task.result_data ?? {}) as {
          destination?: string
          qa_attempts?: Array<{ attempt: number; image_url: string }>
          wp_post_id?: number
          approved_attempt?: number
        }
        if (rd.destination !== 'blog_banner') {
          return { ok: false, payload: { error: `task destination is '${rd.destination}', not 'blog_banner'. IG-destination QA approval not yet supported via this tool.` } }
        }
        if (rd.approved_attempt) {
          return { ok: false, payload: { error: `task already has approved_attempt=${rd.approved_attempt}. Refusing double-approval.` } }
        }
        const attempts = Array.isArray(rd.qa_attempts) ? rd.qa_attempts : []
        const target = attempts.find(a => a.attempt === attemptN)
        if (!target) {
          return { ok: false, payload: { error: `attempt ${attemptN} not found in qa_attempts (have ${attempts.length} attempts).` } }
        }
        if (!target.image_url) {
          return { ok: false, payload: { error: `qa_attempts[${attemptN}] has no image_url.` } }
        }
        if (!rd.wp_post_id) {
          return { ok: false, payload: { error: 'task has no wp_post_id — cannot attach without a target post.' } }
        }
        // Attach via the shared helper (same code path the worker uses on QA pass).
        let mediaId: number
        try {
          mediaId = await attachFeaturedImage({
            wpUrl:       WP_URL,
            username:    WP_USERNAME,
            appPassword: WP_APP_PASSWORD,
            postId:      rd.wp_post_id,
            imageUrl:    target.image_url,
            titleHint:   `seo-banner-attempt-${attemptN}-task-${task_id.slice(0, 8)}`,
          })
        } catch (e: any) {
          return { ok: false, payload: { error: `WP attach failed: ${e?.message ?? e}` } }
        }
        // Patch result_data — clear review_required, record approval audit trail.
        const patch = {
          ...rd,
          attached_media_id:      mediaId,
          review_required:        false,
          approved_attempt:       attemptN,
          approved_via_chat_at:   new Date().toISOString(),
          attach_skipped_reason:  null,
        }
        const { error: updErr } = await supabase.from('seo_tasks').update({ result_data: patch }).eq('id', task_id)
        if (updErr) return { ok: false, payload: { error: `attach succeeded (media_id=${mediaId}) but result_data write failed: ${updErr.message}` } }
        return {
          ok: true,
          payload: {
            task_id,
            attempt_approved:  attemptN,
            attached_media_id: mediaId,
            wp_post_id:        rd.wp_post_id,
            image_url:         target.image_url,
            note:              `Featured image set on WP post ${rd.wp_post_id}. Task marked approved; review_required cleared.`,
          },
        }
      }

      case 'list_industry_insights': {
        const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(30, input.limit)) : 8
        const minRel = typeof input.min_relevance === 'number' ? input.min_relevance : 0.5
        const cat = typeof input.category_filter === 'string' ? input.category_filter : null
        let q = supabase
          .from('industry_articles')
          .select('source_name, source_category, title, url, insight, relevance, tags, summarized_at')
          .not('summarized_at', 'is', null)
          .gte('relevance', minRel)
          .order('relevance', { ascending: false })
          .order('summarized_at', { ascending: false })
          .limit(limit)
        if (cat) q = q.eq('source_category', cat)
        const { data, error } = await q
        if (error) return { ok: false, payload: { error: error.message } }
        return { ok: true, payload: { count: (data ?? []).length, insights: data ?? [] } }
      }

      default:
        return { ok: false, payload: { error: `unknown tool: ${name}` } }
    }
  } catch (e: any) {
    return { ok: false, payload: { error: e?.message ?? String(e) } }
  }
}

// ── Translate stored chat_messages → Anthropic messages array ──────────
// Stored rows look like:
//   { role: 'user',      content: 'text', tool_calls: null }
//   { role: 'assistant', content: 'text', tool_calls: [{id, name, input}, ...] | null }
//   { role: 'tool',      content: '{json result}', tool_call_id: 'toolu_xxx' }
//   { role: 'system',    content: '...' }  ← skipped (handled via system prompt)
//
// Anthropic wants:
//   { role: 'user',      content: 'text' | [tool_result blocks, ...] }
//   { role: 'assistant', content: 'text' | [text+tool_use blocks, ...] }
//
// We group consecutive 'tool' rows into a single user message with
// multiple tool_result blocks (Anthropic's preferred shape).

interface StoredMsg {
  role:         'user' | 'assistant' | 'tool' | 'system'
  content:      string
  tool_calls:   unknown
  tool_call_id: string | null
}

function storedToApiMessages(stored: StoredMsg[]): ApiChatMessage[] {
  const out: ApiChatMessage[] = []
  let pendingToolResults: MessageContentBlock[] = []

  function flushPendingToolResults() {
    if (pendingToolResults.length === 0) return
    out.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const m of stored) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      pendingToolResults.push({
        type:        'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content:     m.content,
      })
      continue
    }

    // Non-tool row → flush any accumulated tool results first.
    flushPendingToolResults()

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
      continue
    }

    if (m.role === 'assistant') {
      const blocks: MessageContentBlock[] = []
      if (m.content && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content })
      }
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      for (const c of calls as Array<{ id: string; name: string; input: Record<string, unknown> }>) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} })
      }
      // If nothing accumulated, the assistant turn was empty — skip
      // rather than send a zero-block message (Anthropic rejects it).
      if (blocks.length === 0) continue
      // If only a single text block, simplify to string content.
      if (blocks.length === 1 && blocks[0].type === 'text') {
        out.push({ role: 'assistant', content: blocks[0].text })
      } else {
        out.push({ role: 'assistant', content: blocks })
      }
      continue
    }
  }

  flushPendingToolResults()
  return out
}

// ── Build the system prompt with live context block ────────────────────

async function buildSystemPrompt(supabase: SupabaseClient): Promise<string> {
  // Most-recent orchestrator snapshot + 10 most-recent tasks + 20 most-
  // recent active learnings (cross-session memory). All three are read
  // fresh on every chat turn so the agent always sees the latest state.
  const [snapshots, recentTasks, learnings] = await Promise.all([
    getRecentMetricsSnapshots(supabase, 'orchestrator_run', 1),
    getRecentTasks(supabase, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), 10),
    getRecentLearnings(supabase, { limit: 20 }),
  ])

  const snapBlock = snapshots[0]
    ? `Last orchestrator snapshot (${snapshots[0].logged_at}):\n${JSON.stringify(snapshots[0].metrics_payload).slice(0, 4000)}`
    : '(no orchestrator snapshots yet)'

  const tasksBlock = recentTasks.length === 0
    ? '(no recent tasks)'
    : recentTasks.map((t: SeoTaskRow) => {
        const brief = JSON.stringify(t.brief_data).slice(0, 200)
        return `  [${t.status.toUpperCase()}] ${t.id} — ${t.task_type}${t.task_subtype ? ':' + t.task_subtype : ''} — ${t.rationale ?? ''} | brief: ${brief}`
      }).join('\n')

  // Standing insights — the closest thing to "memory" the LLM gets. Each
  // row was either recorded via record_learning during a prior chat OR
  // written by the orchestrator from its self_reflection. Grouped by
  // scope so the agent can scan them quickly.
  const learningsBlock = learnings.length === 0
    ? '(no learnings recorded yet — use record_learning to teach me durable rules)'
    : groupLearningsForPrompt(learnings)

  return `${CHAT_SYSTEM_PROMPT}

=== STANDING INSIGHTS (cross-session memory — apply unless explicitly overridden) ===

${learningsBlock}

=== LIVE CONTEXT (refreshed on each chat turn) ===

${snapBlock}

10 most-recent seo_tasks (newest first):
${tasksBlock}`
}

// Render the learnings list in a scope-grouped, compact form. Keeping
// each line short — the agent doesn't need full evidence_task_ids in
// prompt context; it can call list_learnings() if it wants details.
function groupLearningsForPrompt(rows: LearningRow[]): string {
  const grouped: Record<string, string[]> = {}
  for (const r of rows) {
    const scope = r.scope || 'other'
    if (!grouped[scope]) grouped[scope] = []
    grouped[scope].push(`  • [${r.id.slice(0, 8)}] ${r.insight}`)
  }
  return Object.entries(grouped)
    .map(([scope, lines]) => `${scope}:\n${lines.join('\n')}`)
    .join('\n\n')
}

// ── HTTP entry point ───────────────────────────────────────────────────

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  let body: {
    session_id?:      string
    user_message?:    string
    message_history?: StoredMsg[]
  } = {}
  try { body = await req.json() } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }

  const sessionId   = (body.session_id   ?? '').trim()
  const userMessage = (body.user_message ?? '').trim()
  if (!sessionId)   return jsonResponse({ error: 'session_id required' }, 400)
  if (!userMessage) return jsonResponse({ error: 'user_message required' }, 400)

  console.log(`[handle-seo-chat] session=${sessionId} msg="${userMessage.slice(0, 80)}"`)

  try {
    const supabase = createSupabase()

    // 1. Persist the user message first so it's durable even if Claude fails.
    await appendChatMessage(supabase, {
      session_id: sessionId,
      role:       'user',
      content:    userMessage,
    })

    // 2. Load chat history. Front-end override wins if supplied.
    const stored: StoredMsg[] = body.message_history && Array.isArray(body.message_history)
      ? body.message_history
      : await getChatHistory(supabase, sessionId, 50)

    let apiMessages = storedToApiMessages(stored)

    // 3. Build system prompt with live context.
    const systemPrompt = await buildSystemPrompt(supabase)

    // 4. Tool-use loop.
    let loops = 0
    let finalText = ''
    let lastUsage = { input: 0, output: 0, cache_read: 0 }

    while (loops < MAX_TOOL_LOOPS) {
      loops++
      const res = await callClaude({
        model:    MODEL_CHAT,
        system:   systemPrompt,
        messages: apiMessages,
        tools:    TOOL_DEFINITIONS,
        maxTokens:   4096,
        temperature: 0.3,
      })
      lastUsage = {
        input:      res.inputTokens,
        output:     res.outputTokens,
        cache_read: res.cacheReadTokens,
      }

      const toolUses = res.content.filter(
        (b): b is Extract<MessageContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      const assistantText = res.text

      // 4a. Persist this assistant turn. Always persist — even if it's
      // a pure tool_use turn — so the front-end can render the
      // "calling X tool" hint and history is faithful.
      await appendChatMessage(supabase, {
        session_id: sessionId,
        role:       'assistant',
        content:    assistantText,
        tool_calls: toolUses.length > 0
          ? toolUses.map(t => ({ id: t.id, name: t.name, input: t.input }))
          : null,
        metadata: {
          model:        res.model,
          stop_reason:  res.stop_reason,
          input_tokens: res.inputTokens,
          output_tokens: res.outputTokens,
          loop_iteration: loops,
        },
      })

      // Mirror the assistant turn back into apiMessages so the next
      // Claude call sees its own tool_use blocks (required by the API).
      const echoBlocks: MessageContentBlock[] = []
      if (assistantText.length > 0) echoBlocks.push({ type: 'text', text: assistantText })
      for (const t of toolUses) echoBlocks.push(t)
      if (echoBlocks.length > 0) {
        apiMessages.push({
          role: 'assistant',
          content: echoBlocks.length === 1 && echoBlocks[0].type === 'text'
            ? echoBlocks[0].text
            : echoBlocks,
        })
      }

      // 4b. If no tool calls or stop_reason indicates the model is done,
      // we're finished. Note: stop_reason can be 'end_turn' even when
      // the response includes a text-only block, so we trust both signals.
      if (toolUses.length === 0 || res.stop_reason === 'end_turn') {
        finalText = assistantText
        break
      }

      // 4c. Execute each tool call, persist results, push them as a
      // tool_result content-block batch on the next user message.
      const toolResultBlocks: MessageContentBlock[] = []
      for (const call of toolUses) {
        console.log(`[handle-seo-chat] tool=${call.name} input=${JSON.stringify(call.input).slice(0, 200)}`)
        const result = await executeTool(
          supabase,
          call.name as ChatToolName,
          call.input ?? {},
        )
        const contentStr = JSON.stringify(result.payload)
        await appendChatMessage(supabase, {
          session_id:   sessionId,
          role:         'tool',
          content:      contentStr,
          tool_call_id: call.id,
          metadata:     { tool_name: call.name, ok: result.ok },
        })
        toolResultBlocks.push({
          type:        'tool_result',
          tool_use_id: call.id,
          content:     contentStr,
          is_error:    !result.ok,
        })
      }
      apiMessages.push({ role: 'user', content: toolResultBlocks })
    }

    if (loops >= MAX_TOOL_LOOPS && !finalText) {
      finalText = `(stopped after ${MAX_TOOL_LOOPS} tool-use loops — please rephrase your request.)`
      await appendChatMessage(supabase, {
        session_id: sessionId,
        role:       'system',
        content:    finalText,
      })
    }

    // 5. Return final text + fresh history for front-end re-render.
    const newHistory = await getChatHistory(supabase, sessionId, 50)
    return jsonResponse({
      success:     true,
      assistant_text: finalText,
      session_id:  sessionId,
      tool_loops:  loops,
      tokens:      lastUsage,
      history:     newHistory,
    })
  } catch (e: any) {
    console.error('[handle-seo-chat] failed:', e?.message ?? e)
    console.error(e?.stack ?? '')
    return jsonResponse({ error: e?.message ?? String(e) }, 500)
  }
})
