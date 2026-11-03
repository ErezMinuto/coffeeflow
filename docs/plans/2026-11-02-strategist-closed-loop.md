# Strategist closed loop + innovation research — implementation plan

Status: DRAFT v4 (three Gemini 3.1 Pro review rounds applied, see end), 2026-11-02. Nothing built yet. Based on `origin/main` @ 8fc479b.

## Goal

Erez gives only the final approval. Agents plan, draft, critique and revise on
their own; one human gate at the end. Two additions:

- **A. Closed loop**: strategist plans → executors draft → evaluator critiques
  (max 2 revisions) → human queue.
- **B. Innovation loop**: weekly outside-world research → filtered pitches →
  human queue.

## Non-negotiable constraints

1. **Only Erez activates paid ads.** Agents may build PAUSED drafts. No agent
   code path may set ACTIVE/ENABLED or call `update_campaign` (a budget edit on
   a live campaign spends money with no activation step).
2. **Nothing publishes or sends without Erez.** Blog → WP draft, IG →
   `queue_for_review`, email → `campaigns.status='draft'`, ads → PAUSED.
3. **No new edge functions, bots or Supabase projects** (CLAUDE.md). Extend
   existing functions.
4. **No fabricated facts.** Pitches need a cited source; ROI is a testable
   hypothesis, never an invented number.
5. Migrations before deploys; merge to main auto-deploys via CI.

## What exists today (verified in code)

| Piece | Today |
|---|---|
| `strategist-brain` | Weekly. Inserts `strategic_recommendations` as `proposed` (tools.ts ~511). Action types: `email_campaign`, `content_blog`, `content_ig`, `none`. Tools cover orders, email, GSC, Woo, competitor ads, theses, signals. Does **not** read `ops_profile`, `seo_learnings`, `industry_articles`, or paid-ad campaigns (`businessSnapshot.ts` covers email campaigns only). |
| Human planning gate | Erez moves `proposed → approved` in `StrategicBriefPanel` / `NeedsYou`. |
| `strategist-executor` | Claims `approved → drafting` (ledger.ts, fenced on status + worker_id), then marks `drafted` **as soon as the job is enqueued**. Blog/IG drafts are produced later, async, by `seo-worker-writer` / `seo-worker-visual` / `organic-worker-instagram`. Email is synchronous via `generate-campaign`. |
| `strategist-evaluator` | **Thesis grader**, not a draft critic: daily, grades `strategic_theses` against revenue weeks later. |
| Draft revision support | None. No worker accepts feedback. `blog-publish` only POSTs new WP posts (no update), so a revision after publish would create a second WP draft. |
| Existing critic | `seo-worker-visual` already self-QAs images with Claude vision, 3-attempt cap → `review_required=true`. |
| Paid ads | `meta-ads-draft` (admin-role gated) and `google-ads-draft` (service-role) create PAUSED campaigns; both throw on any status ≠ PAUSED. Budget guard = month-to-date actual spend + drafts created this month vs monthly cap. **Backward-looking**: ignores forward run-rate of active campaigns. No overlap check vs running campaigns. Called today from `marketing-advisor` chat, not from the strategist. |
| Synced ad data | `meta_ad_campaigns`, `meta_ad_adsets`, `meta_ad_daily`, `google_campaigns`, `google_ad_group_daily`, … |
| Web research | `seo-worker-research` drains `deep_research` seo_tasks with Anthropic native `web_search` + URL fetch → report with sources. `gemini.ts` supports Google Search grounding (cannot coexist with function declarations in one call). |
| News ingest | `industry-intelligence-sync` daily RSS → `industry_articles` with relevance score. Known to go silently stale on feed 403s. |
| Queue for ideas | `strategist_signals` (kinds `capability_request`, `bug_report`, `feature_idea`; statuses open/approved/building/shipped/declined; `dedupe_key`), shown in `NeedsYou`. |

## Design principle: critique before export

Every revision must happen **before** the draft leaves CoffeeFlow. Otherwise each
round leaves another WP draft / campaigns row / PAUSED campaign behind.

- Blog: writer produces text → critique → only the final version goes to `blog-publish`.
- Email: drafts live only in `artifact_snapshot` while under critique; the `campaigns` row is written once, on `ready_for_review` / `needs_human`.
- IG: critique the caption + image before `meta-publish prepare` (verify what `prepare` creates on Meta's side).
- Paid: iterate on the **spec** in the DB. `create` (PAUSED) runs only after a PASS. A spec that hits the cap is never created; it waits in the queue and Erez can build it with one click.

---

## Part A — Closed loop

### State machine (`strategic_recommendations.status`)

```
proposed ─(auto_approve on for this action_type)─▶ approved
approved ─▶ drafting ─▶ awaiting_critique
awaiting_critique ─ pass ─────────────────────────▶ exporting
exporting ─ executor exports (WP draft / IG queue / campaigns row / validate_only → PAUSED create) ─▶ ready_for_review   (human queue)
exporting ─ platform validation fails & revision_count < 2 ─▶ revising
exporting ─ platform validation fails & revision_count = 2 ─▶ needs_human   (nothing created on the platform)
awaiting_critique ─ reject & revision_count < 2 ──▶ revising ─(executor enqueues a NEW drafter job)─▶ drafting
awaiting_critique ─ reject & revision_count = 2 ──▶ needs_human        (human queue, flagged)
any ─ error ─▶ failed   ;   human ─▶ dismissed
ready_for_review / needs_human ─ Erez publishes/activates ─▶ drafted (terminal)
```

### A1. Schema migration

- Widen status CHECK: add `awaiting_critique`, `revising`, `exporting`, `ready_for_review`, `needs_human`.
- Widen action_type CHECK: add `ad_meta`, `ad_google`.
- Columns: `revision_count int default 0`, `critique_log jsonb default '[]'`,
  `last_feedback text`, `artifact_snapshot jsonb` (the draft content under review).
- `auto_approve` per action_type in `ops_profile` (or a small config table), **default off**.

### A2. Planning gate — `strategist-brain/tools.ts`

Insert as `approved` when auto_approve is on for that action_type, else `proposed`.
Cap auto-approved recs per run (e.g. 5).

### A3. Executor — `strategist-executor/index.ts`, `ledger.ts`, `ledger_test.ts`

- Claim both `approved` and `revising`. For `revising`, **enqueue a new drafter job** (new seo_task / new generate call) carrying `revision = { feedback, previous }`; flipping the status alone would not wake an async worker.
- Finish at `awaiting_critique` (not `drafted`) for synchronous drafters; async
  drafters (blog/IG) stay `drafting` until their worker hands back.
- Add `ad_meta` / `ad_google`: build spec → snapshot → critique → on PASS run `validate_only`/`dry_run` (platform errors such as character limits count as a reject and feed the next revision) → `create` (PAUSED). On cap: no API call, spec stays in the DB.
- **Action allowlist for ad calls from the loop: `dry_run`, `validate_only`, `create`. Never `update_campaign`.**
- **The executor owns export**: it claims `exporting` rows and does the WP / IG / `campaigns` / PAUSED-create step, then moves to `ready_for_review`. The critic only grades.
- Extend the stale-lock sweep to `awaiting_critique` / `revising` / `exporting`.

### A4. Critic — `strategist-evaluator` gets a `critique_draft` action

- New file `strategist-evaluator/critique.ts`; thesis grading untouched.
- Input: original brief (`action_params`, rationale, success_metric), `artifact_snapshot`, brand rules.
- Brand rules: deterministic `brandGuard.ts` checks first (reseller brands, product screening), then an LLM rubric prompt in `seo-agent/prompts/draftCritic.ts`: no disparaging competitors/supermarket coffee, 330g bag, weekly (not daily) roasting, gender-inclusive Hebrew, no em-dashes, sealed bags / jars for special editions, only roasted specialty promoted, product facts must match the catalog.
- Paid-ads extra checks: overlap with active campaigns (same product + audience on Meta; keyword overlap on Google), duplicating a running winner, budget fit.
- Output `{ pass, issues: [{severity, rule, detail}], feedback }` appended to `critique_log`. **PASS only if `pass === true` AND no issue of severity critical/high**; contradictory output counts as a reject. Unparseable output counts as a reject too.
- **Critic model: Gemini** (different model family from the Claude drafters → less self-grading bias; matches the "Gemini QAs everything" rule).
- Trigger: cron poll of `awaiting_critique` (same claim/fence pattern as the executor).

### A5. Async hand-back — `seo-worker-writer`, `organic-worker-instagram`, `seo-worker-visual`

- When a strategist-sourced task (linked via `orchestrator_run_id` = rec id) finishes generating, write the content to `artifact_snapshot` (images as Supabase Storage URLs, never base64 in JSONB) and move the rec to `awaiting_critique` **before** exporting to WP / Meta.
- Accept `brief.revision = { feedback, previous }`.
- Workers **do not export** for strategist-sourced tasks: they only write `artifact_snapshot` and set `awaiting_critique`. Export is the executor's job (A3).

### A6. Email — `generate-campaign`

Add a `persist: false` mode that returns subject/copy/HTML without writing `campaigns`; the executor stores it in `artifact_snapshot`. The `campaigns` draft row is written once, after the loop ends.

### A7. Paid ads must account for active campaigns

- `businessSnapshot.ts`: add active Meta + Google campaigns (objective, product, audience/keywords, daily budget, 30-day results) so the brain plans around them.
- Spec builder gets the same active-campaign context.
- Deterministic forward budget guard in `meta-ads-draft` and `google-ads-draft`:
  (a) month: `MTD spend + Σ(active daily budget × days left) + Σ(committed draft daily budget × days left) + new draft daily budget × days left ≤ monthly cap`, AND
  (b) run-rate: `Σ(active daily budgets) + Σ(committed draft daily budgets) + new daily budget ≤ monthly cap / 30` (assumes Erez may activate every queued draft). (a) alone lets a big campaign created on the 31st blow next month's cap.
  Refuse if either fails. The existing ₪100/day hard cap stays.
  `committed drafts` = PAUSED drafts that still exist, are not yet active and not dismissed (today's `committedThisMonth` counts every draft created this month, so dismissed drafts lock budget). Once a draft goes active it is counted once, as active spend, never twice.
- Freshness gate: refuse if the synced campaign tables are stale (meta-sync has failed silently before) — or read live from the API in `dry_run`.
- `meta-ads-draft` currently requires an admin Clerk token; add a service-role path restricted to the allowlist above.
- "Boost the winner instead" outcome → an advisory rec (`action_type='none'`) to the human queue; the loop never edits a live campaign.

### A8. Human queue — `NeedsYou.tsx`, `StrategicBriefPanel.tsx`

Show `ready_for_review` + `needs_human` with critique verdict + revision history + deep link (WP edit, IG review, campaign draft, Ads Manager / Google Ads). Keep manual approve/dismiss for when auto_approve is off.

### A9. Monitoring — `health-watchdog`

Alert on recs stuck in `drafting` / `awaiting_critique` / `revising` beyond a threshold; register new crons in `EXPECTED_CRONS`.

---

## Part B — Innovation & research loop

### B1. Search — reuse, no new vendor

`seo-worker-research` (Anthropic `web_search`) already does live-web research with sources. No Tavily/Exa/Serper → no new key, no new vendor. Research runs as its own task, separate from the brain run (keeps the brain run bounded; Gemini grounding can't share a call with function tools).

### B2. Weekly schedule — pg_cron, no new edge function

Migration: weekly job inserts a `deep_research` seo_task with an "innovation scan" brief (Meta/Google ads platform changes, WooCommerce ecosystem, email + IG methods, AI search/shopping). Slot it off `:00` (prod DB worker-starvation history) and the day before the brain run. Register in `health-watchdog` `EXPECTED_CRONS` + `EXPECTED_FRESH_DATA`. The brief requires a source URL + date per finding. The brain checks the report's `completed_at`; if it is missing or older than 7 days it makes **no pitches** that week (and the watchdog alerts) instead of pitching from stale data.

### B3. Contextual filtering — `strategist-brain`

New read tools: `get_research_findings` (latest innovation report + top `industry_articles`), `get_ops_profile`, `get_seo_learnings`, `get_current_capabilities`. The capability inventory doesn't exist machine-readably → add an `ops_profile` key listing what CoffeeFlow already does.

Hard filters, in order: cited source → not already built / previously declined (dedupe_key) → tied to bean revenue/margin (north-star) → brand fit. Max 3 pitches/week, **enforced in code**: `emit_innovation_pitch` refuses a 4th call in a run (and checks the 7-day count), not just a prompt rule. Prompt gives data + criteria only, no seeded example tools.

ROI is a **hypothesis**: metric to move (chosen from a fixed list the business snapshot actually contains, e.g. bean revenue, orders, ROAS, CPA, email CTR, organic sessions), baseline, cheapest test, check date — same shape as theses, so `strategist-evaluator` can grade adopted pitches later.

### B4. Pitch queue — extend `strategist_signals`

Migration: kind `innovation_pitch`; columns `sources jsonb`, `implementation_steps jsonb`, `effort`, `cost_estimate`, `check_metric`. Tool `emit_innovation_pitch`. Card in `NeedsYou` (tool/method, why, hypothesis, steps, sources, approve/decline; decline reason stored to stop re-pitching). **Approval builds nothing** — it marks the idea wanted; building is a separate PR-gated task.

### B5. Fix the input

`industry-intelligence-sync`: report failure (not `ok:true` with 0 stored) when feeds 403.

---

## Rollout (one PR each; migration → merge → CI deploy → one real run verified)

1. A1 + A3 + A4 + A6 + A8 for **email only**, auto_approve OFF. Watch critic verdicts on real recs.
2. A5: blog + IG (critique before export).
3. A7: paid ads (spec-level critique, active-campaign awareness, forward budget guard, allowlist).
4. B4 + B2 + B5: pitch queue + weekly research cron.
5. B3: brain filtering tools; show the first pitches to Erez before leaving it on.
6. Flip auto_approve per action_type, one at a time, on Erez's call.

A and B both touch `strategist-brain` → sequential, not parallel.

## Testing

Unit tests for every state transition (pattern: `ledger_test.ts`); critic rubric tested on known-bad drafts (em-dash, "every morning", masculine-only Hebrew, Veneto); budget guard tests with active campaigns; one end-to-end real rec per PR before reporting done.

## Open questions

- Cost: up to 3 drafts + 3 critiques per rec; not yet estimated.
- What `meta-publish prepare` creates on Meta's side (does an IG critique before it avoid orphan containers?).
- Auto_approve granularity: per action_type enough, or also per budget size for ads?

## Review log

**Gemini 3.1 Pro, 2026-11-02, verdict FAIL → applied:**
1. Month-end budget loophole → added run-rate guard (b) in A7. Gemini's "critical" overstates it: activation is human and the ₪100/day cap bounds it, but the fix is right.
2. Don't create known-bad ads on cap → specs at cap are never sent to Meta/Google.
3. Rejected email drafts in `campaigns` → `persist:false` mode, written once after the loop.
4. Async revisions would hang → executor enqueues a new drafter job.
5. Contradictory critic JSON → pass requires no critical/high issues.
6. Stale research → brain checks report freshness, skips pitches if stale. (Not chained execution: keeps the two jobs decoupled.)
7. Ungradable metrics → fixed metric list. (Gemini said the evaluator uses hardcoded SQL; it actually grades with an LLM against the business snapshot, so it wouldn't crash, but a fixed list keeps grades meaningful.)
8. Validate after critique, not before → reordered; platform validation errors feed the revision.

**Gemini 3.1 Pro round 2, verdict PASS WITH CHANGES → applied:**
1. No owner for the export step → new `exporting` state, executor exports, critic only grades.
2. Dismissed drafts lock budget → `committed drafts` scoped to live, not-yet-active, not-dismissed drafts; no double count once active.
3. Pitch cap only in the prompt → enforced in the tool code.
4. Images bloating JSONB → Storage URLs only.

**Gemini 3.1 Pro round 3, verdict PASS WITH CHANGES → applied:**
1. `exporting` could stick at the revision cap → added `exporting → needs_human`.
2. A5 still had workers exporting → removed; executor owns export.
3. Budget terms ambiguous → committed drafts counted as daily budget × days left, and in the run-rate check too.
