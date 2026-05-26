# Minuto SEO Agent — Parallel-Session Kickoff Prompts

Three independent next deliverables. Each is its own session with a self-contained kickoff prompt below. Run them in parallel — they don't conflict because they touch different files. Merge order at the end: writer + visual workers first (they're backend-only), then chat handler + admin UI (UI references the workers' results).

Shared context that ALL three sessions should know:

- Branch `claude/seo-task-queue` (local only) is where the orchestrator + shared module live.
- Each session should branch from that branch (NOT from main) — they need the shared module.
- Migration `supabase/migrations/20260526_seo_agent_tables.sql` has been applied to prod.
- `supabase/functions/seo-agent/` is the isolated shared module — types, claude.ts, db.ts, prompts/, services/. **Do not modify it** in these worker sessions unless absolutely necessary; tweaking it changes the shape every other session depends on. If a change is needed, flag it explicitly.
- `supabase/functions/seo-orchestrator/` is deployed and writes pending tasks. Workers + chat handler read/update tasks via `seo-agent/db.ts`.
- Stack: Supabase Edge Functions (Deno), Vite + React + React Router for the dashboard. NOT Vercel API routes, NOT Next.js.

---

## Session A — Writer Worker

> Build `supabase/functions/seo-worker-writer/index.ts` — a cron-polled worker that processes `text_generation` tasks from `seo_tasks`.
>
> Start by reading these in order:
> - `supabase/functions/seo-agent/types.ts` (TextGenerationBrief shape)
> - `supabase/functions/seo-agent/db.ts` (claimNextTask, markTaskCompleted, markTaskFailed)
> - `supabase/functions/seo-agent/prompts/writer.ts` (the system prompt — iterate if needed but don't gut it)
> - `supabase/functions/seo-agent/claude.ts` (MODEL_WRITER, callClaude, parseClaudeJson)
> - `supabase/functions/blog-publish/index.ts` (existing function that pushes to WordPress — call this from the worker, don't reimplement)
> - Memory notes: `hebrew_anti_ai_tells.md`, `brand_voice_no_disparage.md`, `hebrew_gender_inclusive_copy.md`, `hebrew_taste_descriptors.md`
>
> Behavior on each invocation (1 invocation = 1 task at most):
> 1. Generate a worker_id (e.g. `writer-${crypto.randomUUID().slice(0,8)}`)
> 2. Call `claimNextTask(supabase, 'text_generation', workerId)`. If null, return `{processed: 0}`.
> 3. Resolve `brief_data.products_to_mention` against `woo_products` (`.in('name', ...)`) to get permalinks. Build a map of name → permalink with UTM.
> 4. Call Claude Sonnet with WRITER_SYSTEM_PROMPT + the brief + the permalink map (so the writer's draft includes real anchor links).
> 5. Parse the JSON `{ title, slug, meta_description, body }`.
> 6. Substitute permalink placeholders in body if needed.
> 7. Run the Hebrew sanitizer (em-dash strip, etc. — same regex pattern as `marketing-advisor/index.ts` uses for organic captions).
> 8. POST to `blog-publish` edge function with `{title, content_markdown: body, slug, excerpt: meta_description, status: 'draft'}`.
> 9. On success: `markTaskCompleted` with `result_data: { wp_post_id, edit_url, link }`.
> 10. On failure: `markTaskFailed`; if attempts >= max_attempts, status flips to 'failed'.
>
> Then add a cron schedule via a new migration `20260527_seo_workers_cron.sql`:
> ```sql
> SELECT cron.schedule(
>   'seo-worker-writer-tick',
>   '*/2 * * * *',
>   $$SELECT net.http_post(...)$$  -- pattern matches existing organic_agent_twice_weekly_cron.sql
> );
> ```
>
> Don't apply the cron migration without sign-off. Smoke-test by manually queueing one text_generation task (via SQL or curl) and invoking the worker once via curl. Verify a WP draft appears.
>
> Out of scope: prompt copy iteration (do that in a separate prompt-tuning session), worker quota limits, retry backoff (linear retry is fine for v1).

---

## Session B — Visual Worker

> Build `supabase/functions/seo-worker-visual/index.ts` — a cron-polled worker that processes `visual_generation` tasks from `seo_tasks`.
>
> Start by reading these in order:
> - `supabase/functions/seo-agent/types.ts` (VisualGenerationBrief shape)
> - `supabase/functions/seo-agent/db.ts` (claimNextTask + parent task lookup)
> - `supabase/functions/seo-agent/prompts/visual.ts` (system prompt — only used if the orchestrator's scene_brief needs enrichment; many briefs can pass through directly)
> - `supabase/functions/visual-test/index.ts` (Gemini Image path — for `no_bag` AND for `bag_hero` with the Gemini pipeline)
> - `supabase/functions/vertex-imagen-edit/index.ts` (Vertex composite path — for `bag_hero` byte-perfect bag text)
> - Memory notes: `ig_visual_architecture.md`, `vertex_imagen_pipeline.md`, `visual_identity_lessons.md`, `minuto_espresso_machine.md`
>
> Behavior on each invocation:
> 1. Worker_id = `visual-${crypto.randomUUID().slice(0,8)}`
> 2. `claimNextTask(supabase, 'visual_generation', workerId)`.
> 3. Read the task's `brief_data` (VisualGenerationBrief).
> 4. If task has `parent_task_id`, look up the parent's `result_data` — this gives you the WordPress post_id for blog banners (so you can attach the image to the right draft after).
> 5. Route based on `render_mode`:
>    - `no_bag` → POST to `visual-test` with `{scene_brief, aspect, use_reference: false}`
>    - `bag_hero` → POST to `vertex-imagen-edit` with `{scene_brief, aspect, render_mode: 'bag_hero', product_name}` (Vertex byte-perfect bag composite)
> 6. The render function returns `{url}`.
> 7. If `destination === 'blog_banner'` and parent has wp_post_id: POST to `blog-publish` with a "set featured image" call (look up how blog-auto-publish does it currently).
> 8. `markTaskCompleted` with `result_data: { image_url, render_function, destination }`.
>
> Add the cron tick to the same `20260527_seo_workers_cron.sql` migration as Session A (coordinate via the shared session-merge step at the end).
>
> Smoke-test: queue one visual_generation task (manually or as a parent of a text_generation task), invoke the worker, verify the image renders + (if blog_banner) the featured image attaches.
>
> Hard constraint: do NOT bypass the Scene Director rewrite in vertex-imagen-edit (it's the fix that landed in PR #88). Pass scene_brief through faithfully.

---

## Session C — Chat Handler + Admin UI

> Build the live chat surface for the SEO Agent.
>
> ### Backend: `supabase/functions/handle-seo-chat/index.ts`
>
> Start by reading:
> - `supabase/functions/seo-agent/types.ts` (ChatToolName, ChatToolCall, ChatToolResult)
> - `supabase/functions/seo-agent/db.ts` (appendChatMessage, getChatHistory, plus task-related helpers for the tool implementations)
> - `supabase/functions/seo-agent/prompts/chat.ts` (CHAT_SYSTEM_PROMPT — iterate as needed)
> - `supabase/functions/seo-agent/claude.ts` (callClaude with tool_use support, plus parse tool_use blocks from response content)
> - Anthropic docs on tool use (https://docs.anthropic.com/en/docs/build-with-claude/tool-use) — pay attention to the message-content-blocks format
>
> Behavior:
> 1. POST body: `{session_id: string, user_message: string}`. Optional: `{message_history?: ChatMessage[]}` if the front-end wants to override what's loaded from DB.
> 2. Load last 50 messages from chat_messages WHERE session_id, ORDER BY created_at.
> 3. Load 1 most-recent metrics snapshot (source='orchestrator_run') and 10 most-recent tasks — inject into the system prompt as a context block.
> 4. Append the user_message to chat_messages (role='user'), then call Claude with the conversation history + the tools array.
> 5. Define tools (from types.ts ChatToolName):
>    - `queue_task(task_type: string, brief_data: object, rationale: string) → {task_id}`
>    - `approve_dynamic_experiment(task_id: string) → {status}`
>    - `cancel_task(task_id: string, reason: string) → {status}`
>    - `get_task_details(task_id: string) → {row}`
>    - `get_recent_metrics(limit?: number) → {snapshots}`
>    - `list_pending_tasks(task_type?: string) → {rows}`
> 6. If Claude's response has `stop_reason: 'tool_use'`: execute the tool(s) inline, append a `role: 'tool'` message with the result, append the assistant's tool_use message, then call Claude again with the updated history. Loop until `stop_reason: 'end_turn'`.
> 7. Persist all messages (user, assistant turns including tool_use, tool results) into chat_messages.
> 8. Return final assistant text + the new chat history. Streaming SSE is nice-to-have for v1 but not required — start with non-streaming, add streaming once UI works.
>
> ### Frontend: `dashboard/src/pages/admin/SeoAgent.tsx`
>
> Read first:
> - `dashboard/src/pages/Advisor.tsx` for the existing dashboard's conventions (Supabase client, layout patterns, Hebrew RTL handling)
> - `dashboard/src/lib/context.tsx` (the AppContext, useSupabaseData hook)
> - `dashboard/src/App.jsx` (where the React Router routes live)
>
> Build:
> 1. New route `/admin/seo-agent` added to App.jsx — gated by the same auth pattern used elsewhere (Clerk).
> 2. Isolated layout component `SeoAgentLayout.tsx` — minimal chrome, no global nav (this is a "private dashboard" feel per Erez's brief).
> 3. Three-panel layout:
>    - LEFT: pending tasks queue (live from seo_tasks via Supabase realtime subscription)
>    - CENTER: chat conversation thread (messages from chat_messages, scroll-to-bottom on new)
>    - RIGHT: recent metrics snapshot (from seo_metrics, last 5 entries with delta visualization)
> 4. Chat input at the bottom of center panel, calls `handle-seo-chat` via supabase.functions.invoke, then optimistically updates the local thread before the response lands.
> 5. Each pending task row has actions: "View brief", "Approve" (for dynamic_experiment), "Cancel".
> 6. **Brand voice in UI strings**: Hebrew if Erez prefers, English otherwise. Match user language preference. NO em-dashes in Hebrew. Default to English for the admin UI.
>
> Notes:
> - **NOT Next.js.** This is a React Router route in the existing Vite app. If a future Next.js migration happens, this component lifts over easily.
> - Streaming SSE: can add later. Start with non-streaming round-trip.
> - Session ID: generate one per browser tab and persist in localStorage so refresh keeps the conversation.
>
> Smoke-test:
> 1. Open /admin/seo-agent in a Vercel preview
> 2. Type "what's pending?" → chat agent calls list_pending_tasks, replies with current queue
> 3. Type "queue a new article on V60 brewing for beginners" → chat agent calls queue_task, new row appears in left panel
> 4. Click "Cancel" on a task → row updates to status='failed'
>
> Hard rules:
> - Don't touch any other page or component outside `dashboard/src/pages/admin/` except for `App.jsx` (to add the route).
> - Don't share state with the rest of the dashboard — isolated by design.

---

## Merge order

1. Session A (Writer) merges first — smallest scope, validates queue mechanics.
2. Session B (Visual) merges second — builds on the same db.ts helpers.
3. Session C (Chat + UI) merges last — depends on workers being live for the tools to do useful things.

Each session opens its own PR. Reference this file in the PR description.
