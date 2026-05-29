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
  | 'instagram_post'      // Drained by organic-worker-instagram → meta-publish
  | 'deep_research'       // Drained by seo-worker-research → multi-step Claude + web_search
  | 'technical_seo'       // Drained by seo-worker-techseo → authors FAQ proposal (HITL-gated write)
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

export interface DeepResearchBrief {
  // The strategic question the worker should answer. Specific is better.
  // Bad: "tell me about coffee SEO". Good: "Which 5 Israeli-coffee
  // long-tail keywords would yield the highest organic-conversion ROI
  // for Minuto in Q3 2026, accounting for current competitor positions?"
  question: string
  // The lens — guides which tools + how deep to go.
  //   'geo_llmo'             — how do LLMs talk about us? what makes them cite us?
  //   'competitor_deep_dive' — multi-source profile of a specific competitor
  //   'content_topic'        — should we write about X? what angle wins?
  //   'audience_segment'     — what does a specific RFM segment care about?
  //   'other'                — anything else strategic
  scope: 'geo_llmo' | 'competitor_deep_dive' | 'content_topic' | 'audience_segment' | 'channel_discovery' | 'other'
  // The shape of the output the strategist wants. Shapes the system prompt.
  //   'recommendations'      — list of prioritized actions
  //   'analysis'             — narrative reasoning + supporting data
  //   'action_plan'          — concrete tasks to queue (the worker can
  //                            queue them itself via insertTasks)
  expected_output: 'recommendations' | 'analysis' | 'action_plan'
  // Max self-directed multi-turn loops before the worker must finalize.
  // 5 is a good sweet spot: enough to gather + cross-reference but
  // bounded for cost + time. Increase for very complex questions.
  max_research_turns?: number
}

export interface TechnicalSeoBrief {
  // What technical-SEO action this task represents. Today the only
  // automated subtype is faq_injection (author + propose an FAQ for a
  // ranking article). Others (schema, internal-linking) can join later.
  subtype: 'faq_injection'
  // Target page. Provide at least one; the worker resolves a URL to an id.
  target_post_id?:  number
  target_post_url?: string
  // Optional context the identifier knew (saves the worker a lookup, and
  // surfaces in the admin review). Not load-bearing.
  article_title?:   string
  // The ranking signal that made this article a candidate (e.g. GA4
  // organic sessions, GSC impressions/position). Informational — shown
  // in the proposal so the admin understands WHY this article.
  rationale_signal?: Record<string, unknown>
  // How many Q&A pairs to author. Default 5, clamp 3-6.
  target_faq_count?: number
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

export interface InstagramPostBrief {
  // Hebrew caption — primary copy. The orchestrator writes it directly
  // (not deferred to a worker) so the strategist owns the brand-voice
  // execution end-to-end. Worker just publishes verbatim.
  // Constraints: ≤ 2200 chars (IG cap), gender-inclusive 2nd person,
  // no em-dashes, no "מי ש...", no competitor names — same brand-voice
  // rules as blog body. NO product disparagement, ever.
  caption_he: string
  // Optional English caption — used when audience is mixed-language
  // or for cross-posting. If absent, Hebrew-only post.
  caption_en?: string
  // 5-12 hashtags. Strategist picks based on topic + tag-research.
  // No spaces inside individual tags.
  hashtags: string[]
  // What's in the image. The orchestrator typically pairs this brief
  // with a `visual_generation` task via parent_task_id; the visual
  // worker renders the image, then the IG worker pulls the image_url
  // from the parent's result_data. If no parent is set, the IG worker
  // will fail with `image_required` — single-image posts only for v1.
  media_type: 'feed_image' | 'feed_carousel' | 'reel' | 'story'
  // Reference to an existing Minuto product, if the post is product-
  // centric. Used for tagging + landing-page link in caption (UTM-tagged).
  product_reference?: {
    name:      string         // exact woo_products.name
    permalink: string         // full URL, orchestrator inserts UTM params
  }
  // Publishing strategy:
  //   'auto'             — worker publishes immediately on QA pass
  //   'queue_for_review' — worker uploads to IG as DRAFT (not live) and
  //                        surfaces to admin for approval. Default until
  //                        the orchestrator earns trust.
  publish_strategy: 'auto' | 'queue_for_review'
  // Optional CTA — surfaces in caption as a final line.
  cta?: string
}

export type AnyBrief =
  | TextGenerationBrief
  | VisualGenerationBrief
  | InstagramPostBrief
  | DeepResearchBrief
  | TechnicalSeoBrief
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
  // Experiment scaffolding — when set, the orchestrator considers this
  // task part of an autonomous A/B test. variation_label distinguishes
  // siblings within the same experiment (e.g. 'technical_hook' vs
  // 'emotional_hook'). Both nullable for non-experimental tasks.
  experiment_id: string | null
  variation_label: string | null
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
  experiment_id?: string | null
  variation_label?: string | null
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
  // Experiment tagging. experiment_group is a short slug the strategist
  // picks (e.g. "exp_v60_hook_2026w22"); the orchestrator maps it to a
  // real seo_experiments.id at insert time. variation_label names what
  // this specific task varies (e.g. "technical_hook" vs "emotional_hook").
  experiment_group?: string
  variation_label?:  string
}

// Top-level experiments[] in the strategist's JSON output. Each entry
// becomes one seo_experiments row. Tasks reference these via the shared
// experiment_group string.
export interface OrchestratorEmittedExperiment {
  experiment_group:       string
  hypothesis:             string
  task_type:              CanonicalTaskType
  primary_metric:         ExperimentMetric
  min_lookback_days?:     number
  min_sample_size?:       number
  win_margin_multiplier?: number
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
  | 'record_learning'
  | 'list_learnings'
  | 'supersede_learning'
  | 'list_pending_ig_posts'
  | 'publish_ig_post'
  | 'ingest_url'
  | 'list_industry_insights'
  | 'approve_qa_attempt'
  | 'list_system_thresholds'
  | 'update_system_threshold'
  | 'queue_deep_research'
  | 'repoint_ig_to_visual'
  | 'trigger_worker'
  | 'get_post_faq'
  | 'set_post_faq'
  | 'approve_post_faq'

// ── Learnings (cross-session memory) ─────────────────────────────────────
// Persistent insights surfaced via admin chat (or written by the
// orchestrator). Injected as a "STANDING INSIGHTS" context block in the
// next chat session and into the strategist's planning prompt. The LLM
// doesn't have memory; the pipeline does — this is the table that holds it.

// Loose taxonomy — additional scopes can emerge organically (column is
// TEXT, not an enum). These match the canonical scopes documented in
// the 20260527_seo_learnings_table.sql migration.
export type LearningScope =
  | 'visual_style'         // image preferences (no hands, no scattered beans, etc.)
  | 'brand_voice'          // tone / copy rules surfaced via chat
  | 'render_strategy'      // when bag_hero vs no_bag works/doesn't
  | 'content_topic'        // which topics resonate, which don't
  | 'qa_pattern'           // recurring QA fail modes worth pre-empting
  | 'experiment_winner'    // orchestrator-written: synthesized rule from a winning A/B variation
  | 'other'
  | (string & {})          // accept novel scopes; lints checked at write time

export type LearningSource = 'chat_agent' | 'orchestrator' | 'admin_manual' | (string & {})

export interface LearningRow {
  id:                string
  scope:             LearningScope
  insight:           string
  evidence_task_ids: string[]
  created_by:        LearningSource
  superseded_at:     string | null
  superseded_reason: string | null
  superseded_by:     string | null
  created_at:        string
}

export interface NewLearning {
  scope:              LearningScope
  insight:            string
  evidence_task_ids?: string[]
  created_by:         LearningSource
}

// ── Experiments (autonomous A/B testing + self-rewriting rules) ─────────
// The orchestrator queues N variations of a content task with a shared
// experiment_id. After min_lookback_days, it scores variations against
// the primary_metric, declares a winner if the win-margin threshold is
// met AND min_sample_size is reached, and writes a prescriptive learning
// into seo_learnings (created_by='orchestrator', scope='experiment_winner').
// That learning then shapes future strategist planning automatically.

export type ExperimentStatus =
  | 'collecting'     // variations queued; awaiting min_lookback_days
  | 'evaluating'     // orchestrator picked it up this cycle to score
  | 'evaluated'      // winner declared, learning recorded
  | 'inconclusive'   // no clear winner met thresholds; no rule written
  | 'cancelled'

export type ExperimentMetric =
  | 'ga4_conversions'        // best for text_generation
  | 'ga4_conversion_value'   // when revenue per page is meaningful
  | 'meta_engagement_rate'   // best for instagram_post
  | 'meta_reach'             // IG awareness experiments
  | (string & {})            // accept novel metrics; lints checked at eval time

export interface SeoExperimentRow {
  id:                     string
  hypothesis:             string
  task_type:              CanonicalTaskType
  primary_metric:         ExperimentMetric
  min_lookback_days:      number
  min_sample_size:        number
  win_margin_multiplier:  number
  status:                 ExperimentStatus
  winner_task_id:         string | null
  evaluation_summary:     Record<string, unknown> | null
  recorded_learning_id:   string | null
  parent_experiment_id:   string | null
  orchestrator_run_id:    string | null
  created_at:             string
  evaluated_at:           string | null
}

export interface NewExperiment {
  hypothesis:             string
  task_type:              CanonicalTaskType
  primary_metric:         ExperimentMetric
  min_lookback_days?:     number
  min_sample_size?:       number
  win_margin_multiplier?: number
  orchestrator_run_id?:   string
}

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
