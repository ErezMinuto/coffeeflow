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
  listSystemConfig,
  setSystemConfig,
} from '../seo-agent/db.ts'
import type {
  AnyBrief,
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

// Wall-clock budget for the whole tool-use loop. The Supabase edge gateway
// closes any request idle >150s with no response → the client sees a
// transport-level FunctionsFetchError (no body to surface). A heavy turn
// (e.g. "draft + publish FAQs for both articles" = read ×2, author, write
// ×2, confirm — multiple Claude calls back to back) can blow past that.
// We cap the loop at 130s (leaving ~20s headroom for the final history
// fetch + response), and size each Claude call's timeout to the remaining
// budget so a single call can't overrun. If we run out, we return a
// graceful partial response inviting the admin to say "continue".
const CHAT_LOOP_BUDGET_MS = 130_000
const MIN_CALL_BUDGET_MS  = 20_000  // don't start another Claude call with less than this left

// Per-call output cap. The OLD 4096 let the model spend ~90s generating a
// full article body inline (writing it into an edit_post content arg) — a
// single call would then hit the 90s timeout and abort the whole turn with
// nothing saved. The chat agent is NOT a long-form writer: its outputs are
// short answers + tool calls. The biggest LEGIT output is a full
// text_generation brief or a 6-pair Hebrew FAQ (~1.2-1.5K tokens), so 2000
// leaves headroom for those while bounding any single call to ~40s. If the
// model still tries to draft an article inline it hits this cap
// (stop_reason='max_tokens'); we DETECT that and refuse to execute the
// (truncated) tool call, steering it to queue_task('text_generation')
// instead — see the max-tokens guard in the tool-use loop.
const MAX_OUTPUT_TOKENS_CHAT = 2000

// ── Worker registry — what the agent can nudge ─────────────────────────
// Maps a friendly name to the deployed function path. Used by the
// auto-nudge after queue_task / repoint_ig_to_visual and by the
// explicit trigger_worker chat tool. Keep this in sync as new workers
// land in the org.
const WORKER_REGISTRY: Record<string, { task_type: string; url_path: string }> = {
  ig:       { task_type: 'instagram_post',    url_path: 'organic-worker-instagram' },
  visual:   { task_type: 'visual_generation', url_path: 'seo-worker-visual'       },
  writer:   { task_type: 'text_generation',   url_path: 'seo-worker-writer'       },
  research: { task_type: 'deep_research',     url_path: 'seo-worker-research'     },
  techseo:  { task_type: 'technical_seo',     url_path: 'seo-worker-techseo'      },
  mission:  { task_type: 'mission',           url_path: 'mission-worker'          },
}

// task_type → worker key (for auto-nudge after queue_task).
const TASK_TYPE_TO_WORKER: Record<string, keyof typeof WORKER_REGISTRY> = {
  instagram_post:    'ig',
  visual_generation: 'visual',
  text_generation:   'writer',
  deep_research:     'research',
  technical_seo:     'techseo',
}

// Fire-and-forget POST to a worker. We wait a short time so the agent
// gets a confirmation that the request landed (and any immediate error),
// but never block the chat response on the worker actually finishing —
// most workers take 30s–5min to complete a task and the chat handler
// itself has a 150s wall clock.
async function nudgeWorker(workerKey: keyof typeof WORKER_REGISTRY, opts?: { awaitMs?: number }): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
  const reg = WORKER_REGISTRY[workerKey]
  if (!reg) return { ok: false, error: `unknown worker key '${workerKey}'` }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.awaitMs ?? 8000)
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${reg.url_path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
      body:    '{}',
      signal:  ctrl.signal,
    })
    clearTimeout(timer)
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body }
  } catch (e: any) {
    clearTimeout(timer)
    if (e?.name === 'AbortError') {
      // Worker is still running — that's fine, it'll finish on its own.
      // The fetch was aborted on our side but the function invocation
      // continues server-side until its own work completes.
      return { ok: true, error: 'worker_running_in_background' }
    }
    return { ok: false, error: e?.message ?? String(e) }
  }
}

// ── Tool catalogue (Anthropic input_schema format) ─────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'queue_task',
    description: 'Insert a new task into seo_tasks as pending. Use for text_generation, visual_generation, instagram_post, or dynamic_experiment. brief_data shape depends on task_type — see types.ts. CRITICAL: for instagram_post tasks you MUST also pass parent_task_id pointing at the completed visual_generation task that produced the image — the IG worker rejects any instagram_post with no parent_task_id.',
    input_schema: {
      type: 'object',
      properties: {
        task_type:      { type: 'string', description: 'Canonical: text_generation | visual_generation | instagram_post | dynamic_experiment. Novel subtypes like seo_experiment:internal_linking_audit are also allowed.' },
        brief_data:     { type: 'object', description: 'Brief payload matching the task_type schema in types.ts.' },
        rationale:      { type: 'string', description: 'One-line justification surfaced in the admin UI.' },
        parent_task_id: { type: 'string', description: 'Optional UUID. REQUIRED for instagram_post (points at the visual_generation task that produces the image). Also used by visual_generation when it should attach to a specific text post.' },
        depends_on:     { type: 'array', items: { type: 'string' }, description: 'Optional UUIDs the worker should wait on before claiming this task.' },
      },
      required: ['task_type', 'brief_data', 'rationale'],
    },
  },
  {
    name: 'get_post_faq',
    description: "Read the FAQ currently LIVE on a blog post or product. Fetches the rendered page and extracts the FAQPage JSON-LD the minuto-product-faq plugin emits (data-source=\"minuto-product-faq\"), returning the exact Q&A pairs. Use whenever Erez asks 'what's the FAQ on <page>?' / 'check the FAQ' / before overwriting an existing FAQ so you can show him what's there first. Returns { present, faq_count, faq:[{q,a}] }. Note: reads the LIVE (possibly WP-Rocket-cached) page, so a just-written FAQ may lag until cache purge.",
    input_schema: {
      type: 'object',
      properties: {
        post_url: { type: 'string', description: 'Full URL of the post/product. Provide this OR post_id.' },
        post_id:  { type: 'number', description: 'Numeric WP post/product id (resolved to its URL). Provide this OR post_url.' },
      },
    },
  },
  {
    name: 'set_post_faq',
    description: "Write a FAQ (questions + answers) onto a blog post or product so it renders an accordion AND emits FAQPage JSON-LD (rich-result-eligible structured data) — the minuto-product-faq plugin reads it. Use when Erez asks to add/refresh an FAQ on an article (e.g. the grinder posts) for technical SEO. You author the Q&A yourself in Hebrew following brand voice (gender-inclusive, no em-dashes, no disparaging other gear/brands, 'אלו ש...' not 'מי ש...'). ALWAYS show Erez the exact Q&A you intend to write and get a one-line confirmation BEFORE calling — this writes to the LIVE page immediately (no draft state). Pass post_url (Erez usually pastes a link) or post_id. Passing an empty faq array CLEARS the FAQ.",
    input_schema: {
      type: 'object',
      properties: {
        post_url: { type: 'string', description: 'Full URL of the post/product (the function resolves it to an id). Provide this OR post_id.' },
        post_id:  { type: 'number', description: 'Numeric WP post/product id. Provide this OR post_url.' },
        faq: {
          type: 'array',
          description: 'Array of {q, a} objects. q = question (Hebrew), a = answer (Hebrew). 3-6 pairs is typical. Empty array clears the FAQ.',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'Question text.' },
              a: { type: 'string', description: 'Answer text.' },
            },
            required: ['q', 'a'],
          },
        },
      },
      required: ['faq'],
    },
  },
  {
    name: 'approve_post_faq',
    description: "Approve a technical_seo (faq_injection) task's PROPOSED FAQ and write it to the live page. seo-worker-techseo authors FAQ proposals for ranking articles but never writes them live — they sit with review_required=true until you approve here. Use when Erez says 'approve the FAQ for task X' / 'publish that FAQ'. ALWAYS show Erez the proposed Q&A (from get_task_details → result_data.proposed_faq) and get an explicit go BEFORE calling — this writes live. Optionally pass edited_faq to override the proposal with Erez's edits.",
    input_schema: {
      type: 'object',
      properties: {
        task_id:    { type: 'string', description: 'UUID of the technical_seo seo_tasks row whose proposed_faq to publish.' },
        edited_faq: {
          type: 'array',
          description: 'Optional. If Erez tweaked the wording, pass the final {q,a}[] here; otherwise the stored proposed_faq is used.',
          items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] },
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'trigger_worker',
    description: 'POST directly to a worker function so it drains the next pending task in its queue immediately, without waiting for the cron tick. Use this after queue_task / repoint_ig_to_visual / queue_deep_research if the admin wants the result now instead of in 2-5 minutes. Also useful when the admin reports a task is "stuck pending". Returns the worker\'s response (typically `{processed: 0|1, task_id, ok}` or `worker_running_in_background` if it\'s still working when our short timeout fires). worker ∈ {ig | visual | writer | research | techseo}.',
    input_schema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: "One of: 'ig' (instagram_post queue), 'visual' (visual_generation queue), 'writer' (text_generation queue), 'research' (deep_research queue), 'techseo' (technical_seo / FAQ-proposal queue)." },
      },
      required: ['worker'],
    },
  },
  {
    name: 'repoint_ig_to_visual',
    description: 'Take an instagram_post task that failed because its parent visual_generation task failed QA, repoint it at a different (successful) visual_generation task, and reset it to pending so the IG worker picks it up on the next tick. Use this when a visual regen has succeeded and the admin wants to publish the IG post using the new image. Only works when (a) the IG task currently has status=failed or status=pending, (b) the new visual task is status=completed AND result_data.review_required is not true AND result_data.image_url is set.',
    input_schema: {
      type: 'object',
      properties: {
        ig_task_id:     { type: 'string', description: 'UUID of the instagram_post task to repoint.' },
        visual_task_id: { type: 'string', description: 'UUID of the visual_generation task whose image should be used instead.' },
      },
      required: ['ig_task_id', 'visual_task_id'],
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
    name: 'list_system_thresholds',
    description: 'Show all rows in system_config — runtime tunables (scout spike multiplier, evaluator win-margin, auto-supersede threshold, max brief regens, etc.) with their current value + when last updated + reasoning. Use when the admin asks "what are the current thresholds?" or before recommending a change.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'update_system_threshold',
    description: 'Change one system_config row to a new value. Use ONLY when the admin explicitly approves a specific (key, new_value, reasoning) tuple. Never on your own initiative — admin must say "yes change X to Y because Z". Will write updated_by=chat_agent in the audit trail.',
    input_schema: {
      type: 'object',
      properties: {
        key:       { type: 'string', description: 'Exact key from list_system_thresholds.' },
        new_value: { description: 'New value (number / string / object). The admin specifies this.' },
        reasoning: { type: 'string', description: 'Why this change — for audit trail.' },
      },
      required: ['key', 'new_value', 'reasoning'],
    },
  },
  {
    name: 'queue_deep_research',
    description: 'Queue a deep_research task for the research worker. Use when the admin asks an open-ended strategic question that needs web research + multiple reasoning steps (e.g. "how do LLMs perceive Minuto?", "profile competitor X end-to-end", "is there demand for cold-brew content in IL?"). Worker uses Anthropic web_search + URL fetch + Minuto data queries, runs ~5 turns, writes a structured report into result_data.final_text. DO NOT use for one-line factual questions you can answer from your own context — only for multi-step investigations.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The full research question, phrased as the admin would brief a strategist. One paragraph, no bullets.' },
        scope:    { type: 'string', description: "One of: 'geo_llmo' | 'competitor_deep_dive' | 'content_topic' | 'audience_segment' | 'channel_discovery' | 'other'. Use 'channel_discovery' when Erez wants fresh ideas for NEW ways to grow beyond blog+IG (new platforms, communities, partnerships, tactics)." },
        expected_output: { type: 'string', description: "One of: 'recommendations' (prioritized list) | 'analysis' (narrative w/ citations) | 'action_plan' (concrete tasks to queue next cycle)." },
        max_research_turns: { type: 'number', description: 'Optional cap on Claude reasoning turns. Default 5, max 8.' },
      },
      required: ['question', 'scope', 'expected_output'],
    },
  },
  {
    name: 'list_products',
    description: "Discover what Minuto sells. Lists in-stock products from woo_products: name, slug, url, short_description, categories, price. Use to FIND products by name/keyword (search spans name + short_description + slug — try both languages for origins/processes). Returns shortlists; for the FULL description / origin story / attributes of a SPECIFIC product, follow up with read_product.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional case-insensitive substring. Try both English and Hebrew (e.g. \"Colombia\" + \"קולומביה\") since products are bilingual.' },
        limit:  { type: 'number', description: 'Max rows. Default 30, hard cap 100.' },
      },
    },
  },
  {
    name: 'list_posts',
    description: "List blog posts by status — LIVE WP REST in ONE call. Returns {id, title, slug, status, link, modified, excerpt, has_product_links, product_link_count}. has_product_links is computed server-side by scanning each post's HTML for /product/ links, so you can find 'posts that forgot to link to products' in a SINGLE call — no need to read each post just to check. Use the missing_product_links filter for the most common task (fixing drafts that don't reference Minuto products). Drafts/pending require auth (which we have).",
    input_schema: {
      type: 'object',
      properties: {
        status:                { type: 'string', description: "Filter by status: 'draft' | 'publish' | 'pending' | 'private' | 'any'. Default 'draft'." },
        search:                { type: 'string', description: 'Optional WP search term (matches title + content).' },
        per_page:              { type: 'number', description: 'Max posts. Default 30, hard cap 100.' },
        missing_product_links: { type: 'boolean', description: 'If true, return ONLY posts whose body contains NO Minuto product links. Perfect for the common "find drafts that need product references added" flow — one call collapses scan+identify into one round-trip.' },
      },
    },
  },
  {
    name: 'read_post',
    description: "Fetch a blog post LIVE from WordPress (raw content, title, status, link). Use BEFORE edit_post so you can see what's currently in the post (you can't intelligently edit what you haven't read). Returns {id, title, content_html, content_text (stripped), status, link, modified}. Works for any status (draft / publish / pending).",
    input_schema: {
      type: 'object',
      properties: { post_id: { type: 'number', description: 'WP post id (e.g. 80740).' } },
      required: ['post_id'],
    },
  },
  {
    name: 'edit_post',
    description: "SMALL-EDIT tool ONLY — for inserting/replacing a SHORT span in an existing post: add a products section to a draft that forgot one, fix/add links, tweak a paragraph, append a CTA, fix a typo. The post keeps its status (drafts stay drafts; published stays published). You read_post first, modify in place, then write back the full HTML (it replaces wholesale). ⛔ DO NOT use this to WRITE or REWRITE a full article body. A chat turn cannot fit article-length generation — attempting it gets your output cut off at the length cap and the write is REFUSED (nothing saved). For writing a thin/empty draft up into a full article, or rewriting an article end-to-end, call queue_task('text_generation', {...}) instead — the writer worker owns long-form and returns a NEW draft. NEVER changes publish status (REFUSES any status field). For PUBLISHED posts confirm with Erez in one sentence first; DRAFTS need no confirmation. Returns {id, link, status, modified, content_length}.",
    input_schema: {
      type: 'object',
      properties: {
        post_id: { type: 'number', description: 'WP post id.' },
        content: { type: 'string', description: 'New HTML body (replaces existing wholesale). Use read_post first to fetch + modify in place. Keep the change SMALL — this is not for generating a full article body; route those to queue_task(text_generation).' },
        title:   { type: 'string', description: 'Optional new title.' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'read_product',
    description: "Fetch the FULL product detail LIVE from WooCommerce — long description (origin story, full tasting notes, processing detail, brew tips), short description, attributes, categories, price, stock status. Use whenever you need depth on a SPECIFIC product (writing an article, recommending it, learning about it). Pass `slug` (preferred — e.g. 'sweet-leona'), or `url` (the agent extracts the slug), or `woo_id`. Live fetch every call — no caching, no pre-staging — so newly-added products and edits are seen immediately.",
    input_schema: {
      type: 'object',
      properties: {
        slug:   { type: 'string', description: 'Product slug (e.g. \"sweet-leona\"). Preferred.' },
        url:    { type: 'string', description: 'Product permalink — slug is extracted from /product/<slug>/.' },
        woo_id: { type: 'number', description: 'Direct WooCommerce product id, if you have it.' },
      },
    },
  },
  {
    name: 'start_mission',
    description: "Start a PERSISTENT MISSION — an open-ended objective the agent pursues AUTONOMOUSLY in the background across many cron ticks, for hours or days, even after Erez closes the browser. A server-side worker wakes ~every 10 min, reviews progress + sub-task results, and queues the next gated work toward the goal (everything still stops at the publish gates — nothing goes live without Erez). Use for goals that need ongoing reasoning over time, NOT one-shot tasks (for a single article/research, use queue_task / queue_deep_research instead). Confirm the objective wording with Erez in one sentence before starting. Examples: 'grow our Hebrew YouTube presence', 'get us ranking top-3 for מטחנת קפה', 'build topical authority around cold brew'.",
    input_schema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'The mission goal, phrased as a clear outcome. One or two sentences.' },
        max_steps: { type: 'number', description: 'Optional safety cap on autonomous steps (default 30, max 60). Each step ≈ one 10-min tick of reasoning + queuing.' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'list_missions',
    description: 'List active + recent missions with their status, step count, and latest progress notes. Use when Erez asks "what are you working on?" / "how are the missions going?".',
    input_schema: { type: 'object', properties: { include_finished: { type: 'boolean', description: 'Also show done/failed/cancelled missions. Default false (active only).' } } },
  },
  {
    name: 'cancel_mission',
    description: "Stop a mission (sets status=cancelled). Already-queued sub-tasks keep their own lifecycle (cancel those separately if needed). Use when Erez says 'stop working on X'.",
    input_schema: {
      type: 'object',
      properties: { mission_id: { type: 'string', description: 'UUID of the agent_missions row.' } },
      required: ['mission_id'],
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
        // parent_task_id is a TOP-LEVEL queue_task argument, but the model
        // frequently misplaces it INSIDE brief_data. When it does, the task's
        // top-level parent_task_id column stays null and the worker can't find
        // its parent — e.g. a blog banner never resolves the parent text
        // task's wp_post_id, so the rendered image is orphaned and never
        // attached as the featured image. Defensively promote a nested
        // parent_task_id out of brief_data (and strip it from the brief).
        const nestedParent = typeof (brief_data as Record<string, unknown>).parent_task_id === 'string'
          && ((brief_data as Record<string, unknown>).parent_task_id as string).trim().length > 0
          ? ((brief_data as Record<string, unknown>).parent_task_id as string).trim()
          : null
        if (nestedParent) delete (brief_data as Record<string, unknown>).parent_task_id
        const topLevelParent = typeof input.parent_task_id === 'string' && input.parent_task_id.trim().length > 0
          ? input.parent_task_id.trim()
          : null
        const parent_task_id = topLevelParent ?? nestedParent
        const depends_on = Array.isArray(input.depends_on)
          ? (input.depends_on as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
          : []
        // Guardrail: instagram_post WITHOUT parent_task_id will fail at
        // the worker with a confusing error. Catch it here so the agent
        // gets a clear message it can act on.
        if (task_type === 'instagram_post' && !parent_task_id) {
          return { ok: false, payload: { error: 'instagram_post requires parent_task_id (the visual_generation task whose image will be posted). Pass parent_task_id when calling queue_task.' } }
        }
        const newTask: NewSeoTask = {
          task_type,
          brief_data: brief_data as AnyBrief,
          rationale,
          parent_task_id,
          depends_on,
          // No orchestrator_run_id for chat-queued tasks — use a synthetic
          // marker so we can audit which tasks came from the chat surface.
          orchestrator_run_id: crypto.randomUUID(),
        }
        const inserted = await insertTasks(supabase, [newTask])
        const row = inserted[0]
        // Auto-nudge the relevant worker so the task starts processing
        // immediately rather than waiting for the next cron tick. If the
        // task has dependencies, skip the nudge — the worker would just
        // release it back to pending until its parents complete.
        let nudge: { ok: boolean; status?: number; body?: unknown; error?: string } | null = null
        if (row?.id && depends_on.length === 0) {
          const workerKey = TASK_TYPE_TO_WORKER[task_type]
          if (workerKey) nudge = await nudgeWorker(workerKey)
        }
        return { ok: true, payload: { task_id: row?.id ?? null, status: row?.status ?? 'pending', parent_task_id, depends_on, worker_nudged: nudge } }
      }

      case 'repoint_ig_to_visual': {
        const ig_task_id     = String(input.ig_task_id ?? '').trim()
        const visual_task_id = String(input.visual_task_id ?? '').trim()
        if (!ig_task_id || !visual_task_id) {
          return { ok: false, payload: { error: 'repoint_ig_to_visual requires ig_task_id and visual_task_id.' } }
        }
        // Load + validate both rows.
        const [{ data: ig, error: igErr }, { data: vis, error: visErr }] = await Promise.all([
          supabase.from('seo_tasks').select('id, task_type, status, parent_task_id, error_msg, attempts').eq('id', ig_task_id).maybeSingle(),
          supabase.from('seo_tasks').select('id, task_type, status, result_data').eq('id', visual_task_id).maybeSingle(),
        ])
        if (igErr)  return { ok: false, payload: { error: `ig task lookup failed: ${igErr.message}` } }
        if (visErr) return { ok: false, payload: { error: `visual task lookup failed: ${visErr.message}` } }
        if (!ig)  return { ok: false, payload: { error: `ig task ${ig_task_id} not found.` } }
        if (!vis) return { ok: false, payload: { error: `visual task ${visual_task_id} not found.` } }
        if (ig.task_type !== 'instagram_post') {
          return { ok: false, payload: { error: `ig_task_id is task_type=${ig.task_type}, expected instagram_post.` } }
        }
        if (vis.task_type !== 'visual_generation') {
          return { ok: false, payload: { error: `visual_task_id is task_type=${vis.task_type}, expected visual_generation.` } }
        }
        if (vis.status !== 'completed') {
          return { ok: false, payload: { error: `visual task is status=${vis.status}, must be completed before repointing.` } }
        }
        const vr = (vis.result_data ?? {}) as { image_url?: string; review_required?: boolean }
        if (vr.review_required === true) {
          return { ok: false, payload: { error: `visual task ${visual_task_id} did NOT pass QA (review_required=true). Refusing to repoint to a failed visual.` } }
        }
        if (!vr.image_url) {
          return { ok: false, payload: { error: `visual task ${visual_task_id} has no image_url in result_data. Cannot repoint.` } }
        }
        // Repoint + reset to pending so the IG worker picks it up next tick.
        // Also reset attempts so the worker gets a fresh budget — the
        // prior failures were on a different parent and shouldn't count.
        const { error: updateErr } = await supabase
          .from('seo_tasks')
          .update({
            parent_task_id: visual_task_id,
            status:         'pending',
            attempts:       0,
            error_msg:      null,
            locked_until:   null,
            worker_id:      null,
            started_at:     null,
            completed_at:   null,
          })
          .eq('id', ig_task_id)
        if (updateErr) return { ok: false, payload: { error: `repoint update failed: ${updateErr.message}` } }
        // Nudge the IG worker so the repointed task starts processing
        // immediately rather than waiting for the next cron tick.
        const nudge = await nudgeWorker('ig')
        return {
          ok: true,
          payload: {
            ig_task_id,
            old_parent_task_id: ig.parent_task_id,
            new_parent_task_id: visual_task_id,
            status:             'pending',
            previous_error_msg: ig.error_msg,
            previous_attempts:  ig.attempts,
            worker_nudged:      nudge,
          },
        }
      }

      case 'get_post_faq': {
        let url = typeof input.post_url === 'string' ? input.post_url.trim() : ''
        const pid = typeof input.post_id === 'number' ? input.post_id : undefined
        if (!url && !pid) {
          return { ok: false, payload: { error: 'get_post_faq requires post_url or post_id.' } }
        }
        // Resolve id → URL via the public WP REST API if no URL given.
        if (!url && pid) {
          try {
            const r = await fetch(`${WP_URL}/wp-json/wp/v2/posts/${pid}?_fields=link`)
            if (r.ok) { const j = await r.json(); url = typeof j?.link === 'string' ? j.link : '' }
          } catch { /* fall through */ }
          if (!url) return { ok: false, payload: { error: `could not resolve post_id ${pid} to a URL.` } }
        }
        // Fetch the live page + extract the minuto FAQ JSON-LD block.
        let html = ''
        try {
          const r = await fetch(url, { headers: { 'User-Agent': 'MinutoFaqReader/1.0' } })
          if (!r.ok) return { ok: false, payload: { error: `page fetch HTTP ${r.status} for ${url}` } }
          html = await r.text()
        } catch (e: any) {
          return { ok: false, payload: { error: `page fetch failed: ${e?.message ?? e}` } }
        }
        const m = html.match(/<script type="application\/ld\+json" data-source="minuto-product-faq">([\s\S]*?)<\/script>/)
        if (!m) {
          return { ok: true, payload: { present: false, faq_count: 0, faq: [], url, note: 'No minuto-product-faq JSON-LD on the live page (no FAQ set, or WP Rocket is serving a cached pre-FAQ version).' } }
        }
        try {
          const data = JSON.parse(m[1]) as { mainEntity?: Array<{ name?: string; acceptedAnswer?: { text?: string } }> }
          const faq = (data.mainEntity ?? []).map(q => ({ q: q.name ?? '', a: q.acceptedAnswer?.text ?? '' })).filter(p => p.q && p.a)
          return { ok: true, payload: { present: true, faq_count: faq.length, faq, url, source: 'live_page_jsonld' } }
        } catch (e: any) {
          return { ok: false, payload: { error: `found FAQ JSON-LD but failed to parse it: ${e?.message ?? e}` } }
        }
      }

      case 'set_post_faq': {
        const faqInput = Array.isArray(input.faq) ? input.faq : null
        if (!faqInput) {
          return { ok: false, payload: { error: 'set_post_faq requires faq (array of {q,a}). Empty array clears the FAQ.' } }
        }
        const post_url = typeof input.post_url === 'string' ? input.post_url.trim() : ''
        const post_id  = typeof input.post_id === 'number' ? input.post_id : undefined
        if (!post_url && !post_id) {
          return { ok: false, payload: { error: 'set_post_faq requires post_url or post_id.' } }
        }
        const res = await fetch(`${SUPABASE_URL}/functions/v1/set-post-faq`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
          body:    JSON.stringify({ post_url: post_url || undefined, post_id, faq: faqInput }),
        })
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        if (!res.ok || json.success !== true) {
          return { ok: false, payload: { error: `set-post-faq failed (${res.status}): ${(json.error as string) ?? JSON.stringify(json).slice(0, 300)}` } }
        }
        return {
          ok: true,
          payload: {
            post_id:    json.post_id,
            post_type:  json.post_type,
            post_title: json.post_title,
            faq_count:  json.faq_count,
            cleared:    json.cleared === true,
            note:       'FAQ written to the LIVE page. FAQPage JSON-LD + accordion now render. If WP Rocket caches the page, purge cache to see it immediately.',
          },
        }
      }

      case 'approve_post_faq': {
        const task_id = String(input.task_id ?? '').trim()
        if (!task_id) return { ok: false, payload: { error: 'task_id required.' } }
        const { data: task, error: loadErr } = await supabase
          .from('seo_tasks')
          .select('id, task_type, result_data')
          .eq('id', task_id)
          .maybeSingle()
        if (loadErr) return { ok: false, payload: { error: loadErr.message } }
        if (!task)   return { ok: false, payload: { error: `task ${task_id} not found.` } }
        if (task.task_type !== 'technical_seo') {
          return { ok: false, payload: { error: `task is task_type=${task.task_type}, not technical_seo.` } }
        }
        const rd = (task.result_data ?? {}) as {
          proposed_faq?: Array<{ q: string; a: string }>
          target_post_id?: number
          target_post_url?: string
          faq_written?: boolean
        }
        if (rd.faq_written === true) {
          return { ok: false, payload: { error: 'this task\'s FAQ was already written live. No-op.' } }
        }
        const edited = Array.isArray(input.edited_faq) ? input.edited_faq : null
        const faq = (edited ?? rd.proposed_faq ?? [])
          .map((p: any) => ({ q: typeof p?.q === 'string' ? p.q.trim() : '', a: typeof p?.a === 'string' ? p.a.trim() : '' }))
          .filter((p: any) => p.q && p.a)
        if (faq.length === 0) {
          return { ok: false, payload: { error: 'no valid {q,a} pairs to write (proposed_faq empty and no edited_faq supplied).' } }
        }
        if (!rd.target_post_id && !rd.target_post_url) {
          return { ok: false, payload: { error: 'task result_data has no target_post_id/url to write to.' } }
        }
        // Write live via set-post-faq (same path as the manual tool).
        const res = await fetch(`${SUPABASE_URL}/functions/v1/set-post-faq`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
          body:    JSON.stringify({ post_id: rd.target_post_id, post_url: rd.target_post_url, faq }),
        })
        const wj = await res.json().catch(() => ({})) as Record<string, unknown>
        if (!res.ok || wj.success !== true) {
          return { ok: false, payload: { error: `set-post-faq failed (${res.status}): ${(wj.error as string) ?? JSON.stringify(wj).slice(0, 300)}` } }
        }
        // Patch the task: written + clear the review flag.
        const patched = {
          ...(task.result_data as Record<string, unknown> ?? {}),
          faq_written:          true,
          review_required:      false,
          written_faq:          faq,
          approved_via_chat_at: new Date().toISOString(),
        }
        await supabase.from('seo_tasks').update({ result_data: patched }).eq('id', task_id)
        return {
          ok: true,
          payload: {
            task_id,
            post_id:   wj.post_id,
            post_title: wj.post_title,
            faq_count: wj.faq_count,
            note: 'FAQ written LIVE. If WP Rocket caches the page, purge to see it immediately.',
          },
        }
      }

      case 'list_products': {
        // DISCOVERY only — name + URL + short_description. For depth on a
        // specific product (full description, attributes), the agent calls
        // read_product live afterwards.
        const search = typeof input.search === 'string' ? input.search.trim() : ''
        const limit  = Math.max(1, Math.min(100, typeof input.limit === 'number' ? Math.floor(input.limit) : 30))
        let pq = supabase
          .from('woo_products')
          .select('woo_id, name, slug, permalink, short_description, categories, price')
          .eq('stock_status', 'instock')
          .limit(limit)
        if (search) {
          const esc = search.replace(/[%_]/g, m => `\\${m}`)
          pq = pq.or(`name.ilike.%${esc}%,short_description.ilike.%${esc}%,slug.ilike.%${esc}%`)
        }
        const { data, error } = await pq
        if (error) return { ok: false, payload: { error: `woo_products query failed: ${error.message}` } }
        const trim = (s: unknown, n: number) => typeof s === 'string'
          ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
          : ''
        const rows = (data ?? []).map((p: any) => ({
          woo_id:            Number(p.woo_id),     // ← reliable numeric id for read_product
          name:              p.name,
          slug:              p.slug,
          url:               p.permalink,
          price_ils:         p.price ? Number(p.price) : null,
          short_description: trim(p.short_description, 400),
          categories:        Array.isArray(p.categories) ? p.categories.slice(0, 6) : [],
        }))
        return { ok: true, payload: { count: rows.length, search: search || null, source: 'woo_products (in-stock only)', rows, hint: 'For full description on a specific product, call read_product with woo_id (most reliable) — e.g. read_product({woo_id: 12345}).' } }
      }

      case 'list_posts': {
        const status   = typeof input.status === 'string' && input.status.trim() ? input.status.trim() : 'draft'
        const search   = typeof input.search === 'string' ? input.search.trim() : ''
        const perPage  = Math.max(1, Math.min(100, typeof input.per_page === 'number' ? Math.floor(input.per_page) : 30))
        const missingProductLinks = input.missing_product_links === true
        if (!WP_USERNAME || !WP_APP_PASSWORD) return { ok: false, payload: { error: 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not set.' } }
        const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
        // content is required so we can compute has_product_links server-side
        // (single round-trip for "find posts without product links" instead of
        // N reads). content stays out of the returned rows — we only return the
        // computed flag + count.
        const params = new URLSearchParams({
          status, per_page: String(perPage),
          _fields: 'id,title,slug,status,link,modified,excerpt,content',
          context: 'edit',  // surfaces drafts/pending (anon GET can't see them)
        })
        if (search) params.set('search', search)
        const r = await fetch(`${WP_URL}/wp-json/wp/v2/posts?${params.toString()}`, { headers: { Authorization: auth } })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          return { ok: false, payload: { error: `WP list HTTP ${r.status}: ${body.slice(0, 200)}` } }
        }
        const arr = await r.json() as any[]
        const stripHtml = (s: unknown) => typeof s === 'string'
          ? s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
          : ''
        // Match anchor hrefs that point to /product/<slug> on minuto.co.il
        // OR site-relative /product/ paths. Catches absolute and relative
        // forms of INTERNAL product links only. Ignores text mentions
        // ("Velvet Star" without a hyperlink) AND external /product/ URLs
        // on other shops — the agent needs actual Minuto product anchors.
        const PRODUCT_LINK_RE = /href=["'](?:https?:\/\/(?:www\.)?minuto\.co\.il)?\/product\/[^"']+["']/gi
        let rows = (Array.isArray(arr) ? arr : []).map((p: any) => {
          const html = String(p?.content?.raw ?? p?.content?.rendered ?? '')
          const matches = html.match(PRODUCT_LINK_RE) ?? []
          return {
            id:                  p.id,
            title:               stripHtml(p?.title?.rendered ?? p?.title?.raw ?? ''),
            slug:                p.slug,
            status:              p.status,
            link:                p.link,
            modified:            p.modified,
            excerpt:             stripHtml(p?.excerpt?.rendered ?? '').slice(0, 240),
            has_product_links:   matches.length > 0,
            product_link_count:  matches.length,
            content_length:      html.length,
          }
        })
        if (missingProductLinks) rows = rows.filter(r => !r.has_product_links)
        return {
          ok: true,
          payload: {
            count: rows.length,
            status,
            search: search || null,
            missing_product_links_filter: missingProductLinks,
            source: 'wp REST live',
            rows,
            hint: 'Use list_products({search: "..."}) (returns woo_id) → read_product({woo_id}) → read_post(id) → edit_post(id, content) to fix one in a few rounds.',
          },
        }
      }

      case 'read_post': {
        const post_id = typeof input.post_id === 'number' ? Math.floor(input.post_id) : 0
        if (!post_id) return { ok: false, payload: { error: 'read_post requires post_id (number).' } }
        if (!WP_USERNAME || !WP_APP_PASSWORD) return { ok: false, payload: { error: 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not set.' } }
        const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
        // context=edit returns the raw HTML body (otherwise WP runs filters
        // that mangle it for display). Also surfaces drafts (anon GET can't).
        const r = await fetch(`${WP_URL}/wp-json/wp/v2/posts/${post_id}?context=edit`, { headers: { Authorization: auth } })
        if (!r.ok) return { ok: false, payload: { error: `WP GET HTTP ${r.status}` } }
        const p = await r.json() as any
        const contentHtml = p?.content?.raw ?? p?.content?.rendered ?? ''
        const contentText = String(contentHtml)
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
        return {
          ok: true,
          payload: {
            id:           p?.id,
            title:        p?.title?.raw ?? p?.title?.rendered ?? '',
            content_html: contentHtml,
            content_text: contentText.slice(0, 8000),
            content_length: contentHtml.length,
            status:       p?.status,
            link:         p?.link,
            modified:     p?.modified,
          },
        }
      }

      case 'edit_post': {
        const post_id = typeof input.post_id === 'number' ? Math.floor(input.post_id) : 0
        if (!post_id) return { ok: false, payload: { error: 'edit_post requires post_id (number).' } }
        // Hard refusal: we never change publish status. Publishing is the
        // admin's call (no-auto-publish gate). Title/content only.
        if ('status' in input) {
          return { ok: false, payload: { error: 'edit_post does not accept `status`. Publishing/unpublishing is admin-only — change it in WP admin.' } }
        }
        const newContent = typeof input.content === 'string' ? input.content : undefined
        const newTitle   = typeof input.title === 'string'   ? input.title   : undefined
        if (newContent === undefined && newTitle === undefined) {
          return { ok: false, payload: { error: 'edit_post needs at least one of content or title.' } }
        }
        if (!WP_USERNAME || !WP_APP_PASSWORD) return { ok: false, payload: { error: 'WP_BLOG_POST_USER_NAME / WP_BLOG_POST_PASS not set.' } }
        const auth = 'Basic ' + btoa(`${WP_USERNAME}:${WP_APP_PASSWORD}`)
        const body: Record<string, unknown> = {}
        if (newContent !== undefined) body.content = newContent
        if (newTitle !== undefined)   body.title   = newTitle
        const r = await fetch(`${WP_URL}/wp-json/wp/v2/posts/${post_id}`, {
          method:  'POST',  // WP accepts POST for updates on /posts/{id}
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        })
        const json = await r.json().catch(() => ({})) as any
        if (!r.ok) return { ok: false, payload: { error: `WP update HTTP ${r.status}: ${(json?.message ?? JSON.stringify(json)).toString().slice(0, 300)}` } }
        return {
          ok: true,
          payload: {
            id:             json?.id,
            link:           json?.link,
            status:         json?.status,
            modified:       json?.modified,
            content_length: String(json?.content?.raw ?? json?.content?.rendered ?? '').length,
            note:           json?.status === 'publish'
              ? 'You just edited a LIVE post. Changes are visible immediately (WP Rocket cache may need a purge).'
              : `Draft updated. Still in status='${json?.status}'; admin must click Publish to go live.`,
          },
        }
      }

      case 'read_product': {
        // LIVE fetch the full product from WC REST — no pre-staging. The
        // agent calls this when it needs depth on a specific product
        // (origin story, full tasting notes, attributes). Accepts `slug`
        // or `url` (slug extracted from /product/<slug>/) or `woo_id`.
        let wooId = typeof input.woo_id === 'number' ? Math.floor(input.woo_id) : 0
        const slug = typeof input.slug === 'string' ? input.slug.trim() : ''
        const url  = typeof input.url === 'string' ? input.url.trim() : ''
        let effSlug = slug
        if (!effSlug && url) {
          try {
            const path = new URL(url).pathname.replace(/\/+$/, '')
            const m = path.match(/\/product\/([^/]+)/)
            // Keep the URL-encoded form — woo_products.slug stores the
            // encoded string literally (e.g. "%d7%a4%d7%95%d7%9c..."), so
            // .eq('slug', X) needs the encoded form to match. Decoding it
            // to Hebrew chars (previous behavior) caused every URL-based
            // lookup to fail.
            if (m) effSlug = m[1]
          } catch { /* fall through */ }
        }
        if (!wooId && effSlug) {
          // Try exact slug match first.
          const { data: exact } = await supabase
            .from('woo_products').select('woo_id, name, slug').eq('slug', effSlug).maybeSingle()
          if (exact?.woo_id) {
            wooId = Number(exact.woo_id)
          } else {
            // Fuzzy fallback: search slug + name. Products often have URL-
            // encoded Hebrew slugs that an English-speaking agent can't
            // guess, so accept a sensible token (e.g. "velvet-star") and
            // resolve it via name match.
            const esc = effSlug.replace(/[%_]/g, m => `\\${m}`).replace(/-/g, ' ')
            const { data: fuzzy } = await supabase
              .from('woo_products')
              .select('woo_id, name, slug, permalink')
              .or(`slug.ilike.%${esc}%,name.ilike.%${esc}%`)
              .eq('stock_status', 'instock')
              .limit(5)
            if (fuzzy && fuzzy.length === 1) {
              wooId = Number(fuzzy[0].woo_id)
            } else if (fuzzy && fuzzy.length > 1) {
              return { ok: false, payload: {
                error: `'${effSlug}' matches multiple products — pick one and call again with its exact slug.`,
                candidates: fuzzy.map((f: any) => ({ name: f.name, slug: f.slug, url: f.permalink })),
              } }
            }
          }
        }
        if (!wooId) return { ok: false, payload: { error: `Could not resolve to a product. Try list_products first to find the exact slug, then call read_product with it.` } }

        const wooKey = Deno.env.get('WOO_KEY') ?? ''
        const wooSec = Deno.env.get('WOO_SECRET') ?? ''
        if (!wooKey || !wooSec) return { ok: false, payload: { error: 'WOO_KEY / WOO_SECRET not configured.' } }
        const fetchUrl = `${WP_URL}/wp-json/wc/v3/products/${wooId}` +
          `?consumer_key=${encodeURIComponent(wooKey)}&consumer_secret=${encodeURIComponent(wooSec)}`
        let res: Response
        try { res = await fetch(fetchUrl, { redirect: 'manual' }) }
        catch (e: any) { return { ok: false, payload: { error: `WC fetch threw: ${e?.message ?? e}` } } }
        if (res.status >= 300 && res.status < 400) {
          return { ok: false, payload: { error: `WC redirect ${res.status} — WOO_URL must be canonical (https://www.minuto.co.il).` } }
        }
        if (!res.ok) return { ok: false, payload: { error: `WC HTTP ${res.status}` } }
        let p: any
        try { p = await res.json() } catch { return { ok: false, payload: { error: 'WC returned non-JSON' } } }
        const stripHtml = (s: unknown) => typeof s === 'string'
          ? s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
          : ''
        return {
          ok: true,
          payload: {
            source:            'wc REST live',
            woo_id:            p.id,
            name:              p.name,
            slug:              p.slug,
            url:               p.permalink,
            price_ils:         p.price ? Number(p.price) : null,
            stock_status:      p.stock_status,
            short_description: stripHtml(p.short_description),
            description:       stripHtml(p.description),
            attributes:        (p.attributes ?? []).map((a: any) => ({ name: a.name, options: a.options })),
            categories:        (p.categories ?? []).map((c: any) => c.name),
          },
        }
      }

      case 'start_mission': {
        const objective = String(input.objective ?? '').trim()
        if (!objective) return { ok: false, payload: { error: 'start_mission requires an objective.' } }
        const maxSteps = typeof input.max_steps === 'number'
          ? Math.max(3, Math.min(60, Math.floor(input.max_steps)))
          : 30
        const { data: row, error } = await supabase
          .from('agent_missions')
          .insert({ objective, max_steps: maxSteps, status: 'active', created_by: 'chat_agent' })
          .select()
          .maybeSingle()
        if (error) return { ok: false, payload: { error: `start_mission failed: ${error.message}` } }
        // Nudge the mission worker so it takes the first step immediately.
        const nudge = await nudgeWorker('mission')
        return {
          ok: true,
          payload: {
            mission_id: row?.id ?? null,
            status:     'active',
            max_steps:  maxSteps,
            worker_nudged: nudge,
            note: 'Mission running in the background — it continues even if you close the browser. Progress lands in the briefings thread; nothing publishes without your approval.',
          },
        }
      }

      case 'list_missions': {
        const includeFinished = input.include_finished === true
        let q = supabase
          .from('agent_missions')
          .select('id, objective, status, steps_taken, max_steps, state, result_summary, created_at, last_step_at')
          .order('created_at', { ascending: false })
          .limit(20)
        if (!includeFinished) q = q.eq('status', 'active')
        const { data, error } = await q
        if (error) return { ok: false, payload: { error: error.message } }
        return {
          ok: true,
          payload: {
            missions: (data ?? []).map((m: any) => ({
              mission_id:   m.id,
              objective:    m.objective,
              status:       m.status,
              steps:        `${m.steps_taken}/${m.max_steps}`,
              queued_tasks: (m.state?.queued_task_ids ?? []).length,
              latest_notes: (m.state?.progress_notes ?? []).slice(-3),
              result:       m.result_summary,
              last_step_at: m.last_step_at,
            })),
          },
        }
      }

      case 'cancel_mission': {
        const mission_id = String(input.mission_id ?? '').trim()
        if (!mission_id) return { ok: false, payload: { error: 'cancel_mission requires mission_id.' } }
        const { data, error } = await supabase
          .from('agent_missions')
          .update({ status: 'cancelled', locked_until: null, worker_id: null, updated_at: new Date().toISOString() })
          .eq('id', mission_id)
          .select('id, status')
          .maybeSingle()
        if (error) return { ok: false, payload: { error: error.message } }
        if (!data)  return { ok: false, payload: { error: `mission ${mission_id} not found.` } }
        return { ok: true, payload: { mission_id, status: 'cancelled' } }
      }

      case 'trigger_worker': {
        const workerArg = String(input.worker ?? '').trim().toLowerCase()
        if (!(workerArg in WORKER_REGISTRY)) {
          return { ok: false, payload: { error: `worker must be one of: ${Object.keys(WORKER_REGISTRY).join(' | ')}.` } }
        }
        const nudge = await nudgeWorker(workerArg as keyof typeof WORKER_REGISTRY)
        return {
          ok: nudge.ok,
          payload: {
            worker:    workerArg,
            task_type: WORKER_REGISTRY[workerArg].task_type,
            url_path:  WORKER_REGISTRY[workerArg].url_path,
            result:    nudge,
          },
        }
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

      case 'list_system_thresholds': {
        const rows = await listSystemConfig(supabase)
        return { ok: true, payload: { count: rows.length, thresholds: rows } }
      }

      case 'update_system_threshold': {
        const key = String(input.key ?? '').trim()
        const reasoning = String(input.reasoning ?? '').trim()
        if (!key || !reasoning || input.new_value === undefined) {
          return { ok: false, payload: { error: 'update_system_threshold requires key, new_value, reasoning.' } }
        }
        await setSystemConfig(supabase, key, input.new_value, 'chat_agent', reasoning)
        return { ok: true, payload: { key, new_value: input.new_value, updated_at: new Date().toISOString(), audit: 'updated_by=chat_agent' } }
      }

      case 'queue_deep_research': {
        const question = String(input.question ?? '').trim()
        const scope    = String(input.scope ?? '').trim()
        const expected = String(input.expected_output ?? '').trim()
        if (!question || !scope || !expected) {
          return { ok: false, payload: { error: 'queue_deep_research requires question, scope, expected_output.' } }
        }
        const allowedScopes = ['geo_llmo', 'competitor_deep_dive', 'content_topic', 'audience_segment', 'channel_discovery', 'other']
        if (!allowedScopes.includes(scope)) {
          return { ok: false, payload: { error: `scope must be one of ${allowedScopes.join(' | ')}.` } }
        }
        const allowedOutput = ['recommendations', 'analysis', 'action_plan']
        if (!allowedOutput.includes(expected)) {
          return { ok: false, payload: { error: `expected_output must be one of ${allowedOutput.join(' | ')}.` } }
        }
        const maxTurns = typeof input.max_research_turns === 'number'
          ? Math.max(1, Math.min(8, Math.floor(input.max_research_turns)))
          : 5
        const newTask: NewSeoTask = {
          task_type:           'deep_research',
          brief_data:          { question, scope, expected_output: expected, max_research_turns: maxTurns },
          rationale:           `[chat] deep_research scope=${scope} output=${expected}`,
          orchestrator_run_id: crypto.randomUUID(),
        }
        const inserted = await insertTasks(supabase, [newTask])
        const row = inserted[0]
        const nudge = row?.id ? await nudgeWorker('research') : null
        return { ok: true, payload: { task_id: row?.id ?? null, status: row?.status ?? 'pending', worker_nudged: nudge } }
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
  // Track tool_use IDs emitted in the most-recent assistant turn so we
  // can detect orphans — i.e. an assistant tool_use whose matching
  // tool_result row never got persisted (typically because the prior
  // server invocation crashed inside executeTool before writeBack).
  // Without this, every subsequent chat send 400s at Anthropic with
  // "tool_use_id X has no tool_result", surfaced to the UI as a 500.
  // We patch in synthetic is_error tool_result blocks for any missing
  // IDs at the next non-tool boundary.
  let lastAssistantToolUseIds: string[] = []

  // Reconcile the accumulated tool_result blocks against the
  // immediately-preceding assistant turn's tool_use ids, then flush them
  // as one user message. Enforces BIDIRECTIONAL integrity — both failure
  // modes 400 at Anthropic, and both are caused by the newest-50 window
  // slicing through a tool_use↔tool_result pair:
  //   1. tool_use with NO tool_result  → synthesize an is_error result
  //      (its result row was never persisted, or fell after the window).
  //   2. tool_result with NO matching tool_use  → DROP it (its tool_use
  //      turn fell BEFORE the window, or the row is corrupt). Without this
  //      the orphan gets carried forward and flushed alongside a later
  //      turn's valid results → "unexpected tool_use_id in tool_result".
  // ALWAYS clears state (no early return) so orphans never carry forward.
  function patchOrphansAndFlush() {
    const validIds = new Set(lastAssistantToolUseIds)
    // Keep only tool_results that correspond to the preceding assistant's
    // tool_use ids; drop orphans.
    const kept = pendingToolResults.filter(
      (b): b is Extract<MessageContentBlock, { type: 'tool_result' }> =>
        b.type === 'tool_result' && validIds.has(b.tool_use_id),
    )
    // Synthesize is_error results for any tool_use that never got a row.
    const seen = new Set(kept.map(b => b.tool_use_id))
    for (const id of lastAssistantToolUseIds) {
      if (seen.has(id)) continue
      kept.push({
        type:        'tool_result',
        tool_use_id: id,
        content:     JSON.stringify({ error: 'tool execution was interrupted; no result was persisted' }),
        is_error:    true,
      })
    }
    pendingToolResults     = []
    lastAssistantToolUseIds = []
    if (kept.length > 0) out.push({ role: 'user', content: kept })
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

    // Non-tool row → close out the previous assistant turn's tool cycle.
    // If the prior assistant emitted tool_use blocks, every one of them
    // needs a tool_result before we move on; patch orphans first.
    patchOrphansAndFlush()

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
      // Track new tool_use IDs so we can detect orphans at the next
      // non-tool boundary.
      lastAssistantToolUseIds = blocks
        .filter((b): b is Extract<MessageContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map(b => b.id)
      // If only a single text block, simplify to string content.
      if (blocks.length === 1 && blocks[0].type === 'text') {
        out.push({ role: 'assistant', content: blocks[0].text })
      } else {
        out.push({ role: 'assistant', content: blocks })
      }
      continue
    }
  }

  // Trailing patch — if history ENDS on an assistant tool_use turn (no
  // following tool/user row to trigger patchOrphansAndFlush), still emit
  // synthetic tool_results so the next API call has a valid sequence.
  patchOrphansAndFlush()
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

  // Declared at outer scope so the catch block can use it to surface
  // errors as a system chat_messages row visible to the admin.
  const supabase = createSupabase()

  try {

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
    const loopStartedAt = Date.now()
    let ranOutOfTime = false

    while (loops < MAX_TOOL_LOOPS) {
      // Wall-clock guard: never start a Claude call that could push us past
      // the gateway's 150s ceiling (which would manifest as a FunctionsFetch
      // Error with no body). Stop gracefully and let the admin continue.
      const remainingMs = CHAT_LOOP_BUDGET_MS - (Date.now() - loopStartedAt)
      if (remainingMs < MIN_CALL_BUDGET_MS) {
        ranOutOfTime = true
        break
      }
      loops++
      let res
      try {
        res = await callClaude({
          model:    MODEL_CHAT,
          system:   systemPrompt,
          messages: apiMessages,
          tools:    TOOL_DEFINITIONS,
          maxTokens:   MAX_OUTPUT_TOKENS_CHAT,
          temperature: 0.3,
          // Cache the (system + tools) prefix — ~30 tool schemas + the
          // chat prompt is 5-10K input tokens. First call in the turn
          // pays full cost; calls 2-N hit the 5-min cache and respond
          // several×faster, which is exactly the failure mode the agent
          // was hitting ("running out of time" on multi-round turns).
          cachePrefix: true,
          // Size the call to the remaining budget (cap 90s) so one slow call
          // can't overrun the loop budget.
          timeoutMs: Math.min(90_000, remainingMs - 5_000),
        })
      } catch (callErr: any) {
        // The call itself threw — typically the AbortController firing
        // when Claude takes longer than its sized timeout (manifested to
        // the UI as a 500 with "The signal has been aborted"). Treat like
        // a graceful budget-stop: don't crash the whole turn, just stop
        // looping and let the admin continue. Anything done in PRIOR
        // iterations (tool results, persisted messages) is already saved.
        console.warn(`[handle-seo-chat] callClaude threw on loop ${loops} (treating as budget-stop): ${callErr?.message ?? callErr}`)
        ranOutOfTime = true
        break
      }
      lastUsage = {
        input:      res.inputTokens,
        output:     res.outputTokens,
        cache_read: res.cacheReadTokens,
      }
      // Per-loop timing + cache-hit telemetry so we can verify caching is
      // actually firing (cache_read > 0 from loop 2 onward). Cheap log
      // line — no PII, just numbers.
      console.log(`[handle-seo-chat] loop=${loops} elapsed=${Date.now() - loopStartedAt}ms in=${res.inputTokens} out=${res.outputTokens} cache_read=${res.cacheReadTokens} cache_write=${res.cacheCreationTokens}`)

      const toolUses = res.content.filter(
        (b): b is Extract<MessageContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      const assistantText = res.text
      const elapsedMs = Date.now() - loopStartedAt

      // 4a. Persist this assistant turn. Always persist — even if it's
      // a pure tool_use turn — so the front-end can render the
      // "calling X tool" hint and history is faithful.
      //
      // Telemetry note: we stash per-loop elapsed_ms + cache stats in
      // metadata. Lets us diagnose 'running out of time' without log
      // scraping — just SELECT metadata FROM chat_messages WHERE
      // session_id='...' AND role='assistant' to see per-loop timing
      // + cache_read (verifies prompt-caching is actually firing).
      await appendChatMessage(supabase, {
        session_id: sessionId,
        role:       'assistant',
        content:    assistantText,
        tool_calls: toolUses.length > 0
          ? toolUses.map(t => ({ id: t.id, name: t.name, input: t.input }))
          : null,
        metadata: {
          model:                res.model,
          stop_reason:          res.stop_reason,
          input_tokens:         res.inputTokens,
          output_tokens:        res.outputTokens,
          cache_read_tokens:    res.cacheReadTokens,
          cache_write_tokens:   res.cacheCreationTokens,
          loop_iteration:       loops,
          elapsed_ms_at_loop:   elapsedMs,
          tools_requested:      toolUses.map(t => t.name),
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

      // 4b. Terminal cases — stop looping.
      //  • no tool calls            → the model is answering; we're done
      //  • stop_reason 'end_turn'   → model signalled completion
      //  • stop_reason 'max_tokens' WITH no tool calls → the model was cut
      //    off mid-prose (almost always drafting an article body straight
      //    into the chat). Don't dump the truncated half-article — return a
      //    short nudge to route long-form to the writer worker instead.
      const hitTokenCap = res.stop_reason === 'max_tokens'
      if (toolUses.length === 0) {
        finalText = hitTokenCap
          ? `(I started drafting something too long to finish in a single chat turn. For a full article body, tell me to "queue the writer for post <id>" — the writer worker is built for long-form and returns a fresh WP draft. I keep edit_post for small fixes only.)`
          : assistantText
        break
      }
      if (res.stop_reason === 'end_turn') {
        finalText = assistantText
        break
      }

      // 4c. Execute each tool call, persist results, push them as a
      // tool_result content-block batch on the next user message.
      // CRITICAL: every assistant tool_use we persisted in 4a MUST be
      // matched by a persisted tool_result row, otherwise the next
      // request to this session replays an orphan tool_use and 400s at
      // Anthropic. Wrap each call so even a throw inside executeTool or
      // appendChatMessage(tool) still yields a synthetic error result
      // row — no orphan tool_use ever stays in the DB.
      const toolResultBlocks: MessageContentBlock[] = []
      for (const call of toolUses) {
        console.log(`[handle-seo-chat] tool=${call.name} input=${JSON.stringify(call.input).slice(0, 200)}`)
        let contentStr = ''
        let isError = false
        if (hitTokenCap) {
          // The response was truncated at the output cap, so this tool_use's
          // input is likely partial/invalid — executing it could write a
          // half-finished article to WordPress. Refuse and steer the model
          // to the writer worker. We still persist a matching tool_result so
          // the assistant tool_use isn't left orphaned on the next replay.
          isError = true
          contentStr = JSON.stringify({
            error:  'OUTPUT_TRUNCATED',
            detail: `Your response hit the length cap, so "${call.name}" was NOT executed — its input was cut off. You were almost certainly writing a full article body inline, which a chat turn cannot fit. NEVER draft a full body in chat. To write or rewrite a full article body, call queue_task('text_generation', {keyword, title, key_points, products_to_mention, ...}) — the writer worker has the budget for long-form and returns a NEW WP draft. Reserve edit_post for SMALL inserts only (a section, links, a paragraph). Re-issue your intent now as queue_task.`,
          })
          console.warn(`[handle-seo-chat] refused truncated tool=${call.name} (stop_reason=max_tokens) — steering to writer worker`)
        } else {
          try {
            const result = await executeTool(
              supabase,
              call.name as ChatToolName,
              call.input ?? {},
            )
            contentStr = JSON.stringify(result.payload)
            isError = !result.ok
          } catch (toolErr: any) {
            console.error(`[handle-seo-chat] executeTool(${call.name}) threw:`, toolErr?.message ?? toolErr)
            contentStr = JSON.stringify({ error: toolErr?.message ?? String(toolErr) })
            isError = true
          }
        }
        // Persist tool_result row — failure here gets logged but doesn't
        // skip the in-memory toolResultBlocks push (Anthropic still needs
        // the matching block for this turn to succeed). Worst case the
        // DB row is missing; next session load will patch with a
        // synthetic orphan-tool_result via storedToApiMessages.
        try {
          await appendChatMessage(supabase, {
            session_id:   sessionId,
            role:         'tool',
            content:      contentStr,
            tool_call_id: call.id,
            metadata:     { tool_name: call.name, ok: !isError },
          })
        } catch (persistErr: any) {
          console.error(`[handle-seo-chat] appendChatMessage(tool) failed for ${call.id}:`, persistErr?.message ?? persistErr)
        }
        toolResultBlocks.push({
          type:        'tool_result',
          tool_use_id: call.id,
          content:     contentStr,
          is_error:    isError,
        })
      }
      apiMessages.push({ role: 'user', content: toolResultBlocks })
    }

    if (ranOutOfTime && !finalText) {
      // Hit the wall-clock budget mid-task. Whatever tool calls already ran
      // are persisted (and committed live, e.g. an FAQ write), so this is a
      // safe stopping point — the admin just continues.
      finalText = `(I ran out of time for this turn after completing the steps above — anything still pending wasn't started. Say "continue" and I'll pick up where I left off.)`
      await appendChatMessage(supabase, {
        session_id: sessionId,
        role:       'system',
        content:    finalText,
      })
    } else if (loops >= MAX_TOOL_LOOPS && !finalText) {
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
    const msg = e?.message ?? String(e)
    console.error('[handle-seo-chat] failed:', msg)
    console.error(e?.stack ?? '')
    // Surface the actual server-side error directly into the chat thread
    // as a system message. The frontend's realtime subscription on
    // chat_messages INSERT picks it up immediately so the admin sees
    // WHAT broke instead of an opaque "non-2xx" — even if the Supabase
    // SDK swallows the response body. Best-effort; failure to write is
    // logged but doesn't change the user-visible behavior.
    if (sessionId) {
      try {
        await appendChatMessage(supabase, {
          session_id: sessionId,
          role:       'system',
          content:    `⚠️ Chat handler errored: ${msg.slice(0, 1500)}`,
          metadata:   { type: 'handler_error', stack: (e?.stack ?? '').slice(0, 2000) },
        })
      } catch (writeErr: any) {
        console.error('[handle-seo-chat] failed to write error to chat:', writeErr?.message ?? writeErr)
      }
    }
    return jsonResponse({ error: msg }, 500)
  }
})
