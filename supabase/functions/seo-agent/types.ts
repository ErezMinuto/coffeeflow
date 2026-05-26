// Minuto SEO Agent — shared types.
//
// Single source of truth for the shape of seo_tasks rows, brief payloads
// per task_type, metrics snapshots, and chat-tool inputs/outputs. Imported
// by the orchestrator, both workers, and the chat handler.
//
// Keep this file dependency-free. No DB client imports, no fetch calls —
// just types. Otherwise the module becomes a hairball.

// ── Lifecycle ────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed'

// Canonical known task types. Workers register on these exact strings.
// 'dynamic_experiment' is the escape hatch for orchestrator-invented tasks
// with no automated worker — they sit pending for human review.
export type CanonicalTaskType =
  | 'text_generation'
  | 'visual_generation'
  | 'dynamic_experiment'

// task_type is stored as TEXT in the DB so the orchestrator can emit
// novel subtypes (e.g. 'seo_experiment:internal_linking_audit') without
// schema changes. CanonicalTaskType is just the set we know how to
// auto-process.
export type TaskType = CanonicalTaskType | (string & {})

// Informational subtype for dynamic_experiment rows. Free-form but
// these are the common buckets we expect.
export type ExperimentSubtype =
  | 'technical_seo'
  | 'content_optimization'
  | 'campaign_idea'
  | 'pr_pitch'
  | 'internal_linking'
  | 'schema_markup'
  | (string & {})

// ── Brief payloads ───────────────────────────────────────────────────────
// Each task_type has its own brief shape. The orchestrator emits these
// exactly; workers consume them. Keep them strict so a malformed brief
// is a parse error, not a runtime mystery.

export interface TextGenerationBrief {
  // Target keyword from GSC, raw user query, or orchestrator-chosen.
  keyword: string
  // The H1 / SEO title for the article. NOT the raw search query.
  title: string
  // Bullet points the article must cover. The Writer Worker expands
  // each into 1-3 paragraphs.
  key_points: string[]
  // Catalog-exact product names the writer should link to in markdown.
  // The Writer Worker looks these up in woo_products and uses the
  // permalinks. Mismatched names get dropped, not approximated.
  products_to_mention: string[]
  // Hint for the writer: why this topic, why now. Surfaces in the
  // article's hook.
  why_now?: string
  // Suggested word count. Writer can deviate ±20% if the content
  // demands it.
  target_word_count?: number
  // Current GSC position if this is an existing-keyword optimization.
  current_position?: number
  // Search-volume signal from GSC (high|medium|low|fresh-keyword).
  search_volume_signal?: 'high' | 'medium' | 'low' | 'fresh'
  // Competitive angle — what existing pages on this keyword fail to
  // cover, that ours will. Optional but improves quality when present.
  competitive_angle?: string
  // Internal links to weave in (URL → anchor text). Used to strengthen
  // topic clusters on minuto.co.il/blog.
  internal_links?: Array<{ url: string; anchor: string }>
}

export interface VisualGenerationBrief {
  // 4-6 sentence English photographer's brief. The Visual Worker
  // forwards this to visual-test or vertex-imagen-edit (depending on
  // render_mode). Same shape as the existing IG pipeline's scene_brief.
  scene_brief: string
  // Aspect ratio for the render.
  aspect: 'feed_square' | 'feed_portrait' | 'reel_cover'
  // bag_hero composites a real Minuto bag PNG byte-perfect via Vertex;
  // no_bag is bag-free editorial scene via Gemini Image.
  render_mode: 'bag_hero' | 'no_bag'
  // Optional WooCommerce product name to anchor the bag image. Only
  // used when render_mode='bag_hero'.
  product_name?: string
  // Where this image will be used — drives storage path + final
  // dimensions. 'blog_banner' goes into WP featured image; 'ig_post'
  // into the IG queue.
  destination: 'blog_banner' | 'ig_post'
}

export interface DynamicExperimentBrief {
  // Free-form description of the experiment the orchestrator wants to
  // run. Surfaced verbatim in the admin UI for human review.
  description: string
  // Estimated effort hours so the admin can prioritize. Orchestrator
  // makes its best guess.
  estimated_effort_hours?: number
  // If true, the admin must approve before any action is taken. Most
  // dynamic experiments should be true — that's the point of routing
  // them through human review.
  approval_required: boolean
  // Optional structured payload if the experiment has executable parts
  // (e.g. a list of pages to add canonicals to). Workers don't read
  // this; humans do.
  details?: Record<string, unknown>
}

export type AnyBrief =
  | TextGenerationBrief
  | VisualGenerationBrief
  | DynamicExperimentBrief
  | Record<string, unknown>  // for novel orchestrator-invented task_types

// ── seo_tasks row shape ──────────────────────────────────────────────────

export interface SeoTaskRow {
  id: string
  task_type: TaskType
  task_subtype: ExperimentSubtype | null
  status: TaskStatus
  attempts: number
  max_attempts: number
  parent_task_id: string | null
  depends_on: string[]
  brief_data: AnyBrief
  result_data: Record<string, unknown> | null
  error_msg: string | null
  locked_until: string | null
  worker_id: string | null
  scheduled_for: string
  started_at: string | null
  completed_at: string | null
  orchestrator_run_id: string | null
  rationale: string | null
  created_at: string
  updated_at: string
}

// What the orchestrator inserts. Lifecycle fields default in the DB.
export interface NewSeoTask {
  task_type: TaskType
  task_subtype?: ExperimentSubtype | null
  parent_task_id?: string | null
  depends_on?: string[]
  brief_data: AnyBrief
  rationale: string
  orchestrator_run_id: string
  scheduled_for?: string
  max_attempts?: number
}

// What the orchestrator emits BEFORE we resolve indexes to UUIDs.
// depends_on_index references other entries in the same emit array;
// the orchestrator code converts these to UUIDs after inserting.
export interface OrchestratorEmittedTask {
  task_type: TaskType
  task_subtype?: ExperimentSubtype
  rationale: string
  brief_data: AnyBrief
  // Index into the emitted-tasks array (e.g. 0 means "this task depends
  // on the first task in the batch"). Resolved to UUIDs at insert time.
  depends_on_index?: number
  parent_task_index?: number
  scheduled_offset_hours?: number
}

// ── Metrics snapshot shape ───────────────────────────────────────────────

export interface MetricsSnapshot {
  // GSC top keywords last 30 days, ranked by impressions.
  gsc_top_keywords: Array<{
    keyword: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }>
  // Position deltas vs the previous orchestrator_run snapshot. Computed
  // by the orchestrator before insert; null on first run ever.
  gsc_position_deltas: Array<{
    keyword: string
    prev_position: number | null
    new_position: number
    delta: number  // negative = improved (closer to #1)
  }> | null
  // Counts for at-a-glance feel.
  blog_published_count_30d: number
  blog_published_count_7d: number
  // Recent task outcomes — how many tasks completed/failed in the last
  // run. Self-reflection signal.
  tasks_completed_since_last_run: number
  tasks_failed_since_last_run: number
  // Free-form additions. Future business metrics (Woo revenue,
  // newsletter signups, etc.) can land here without a migration.
  extras?: Record<string, unknown>
}

// ── Chat tool-calling shapes ─────────────────────────────────────────────
// Tools the chat agent can invoke when the admin says things like
// "approve idea #3" or "queue a new task for keyword X". Names mirror
// Anthropic tool-use input_schema shape.

export type ChatToolName =
  | 'queue_task'
  | 'approve_dynamic_experiment'
  | 'cancel_task'
  | 'get_task_details'
  | 'get_recent_metrics'
  | 'list_pending_tasks'

export interface ChatToolCall {
  id: string
  name: ChatToolName
  input: Record<string, unknown>
}

export interface ChatToolResult {
  tool_call_id: string
  // Stringified for chat_messages.content (role='tool'). Structured
  // result lives here as JSON-stringified text — the assistant sees it
  // on the next turn.
  content: string
  is_error?: boolean
}
