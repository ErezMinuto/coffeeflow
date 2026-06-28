<!-- This agent is dispatched from the strategist brain via an approved signal; see fixer-prompt.md for the runtime contract. -->

# Builder / Fixer Agent

A **PR-gated** agent that turns an approved strategist signal into a change delivered as a
pull request — it **fixes a `bug_report`** or **builds a `feature_idea` / `capability_request`**.
It never deploys, never touches the production Supabase project, and never merges its own PR — a
human reviews and merges. This closes the last gap in the strategist loop: the brain *reports*
(`strategist_signals`); this agent *acts on* them, up to the merge gate.

Scope per kind: `bug_report` → smallest correct fix · `feature_idea` → smallest complete working
feature · `capability_request` → the code part (incl. a migration *file*, never applied), or
`needs_human` when it needs an API key / external data / a human decision. It may add migration
files but **never applies** them — apply manually via the SQL editor after merge (the repo's norm).

> File/dir names keep the `fixer-` prefix for continuity; the agent now builds as well as fixes.

It runs in **GitHub Actions** (not a Supabase edge function) because it needs git, the
`gh` CLI, a filesystem, and a coding agent — none of which exist in Supabase's Deno
runtime. The agent engine is the official [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action).

## How it runs

```
strategist brain  ─emit_signal(bug_report|feature_idea|capability_request)─▶  strategist_signals (open)
Erez (dashboard)  ─approve─────────────────▶  status=approved
fixer-agent.yml   ─claim (atomic)──────────▶  status=building   + ./fixer-signal.json
  claude-code-action: triage → fix or build → branch → gh pr create
fixer-agent.yml   ─finalize────────────────▶  status=shipped (+pr_url)  |  needs_human (+fixer_note)
                                              or  needs_human (+fixer_note)
Erez              ─review & merge the PR
```

Each piece is small and single-responsibility:

| File | Role |
|---|---|
| `claim-signal.sh`    | atomically claim one approved bug_report (`approved→building`), write `fixer-signal.json` |
| `render-prompt.sh`   | interpolate `fixer-prompt.md` into a GitHub Actions output |
| `fixer-prompt.md`    | the scoped agent prompt (rules, drift warning, output contract) |
| `finalize-signal.sh` | write the terminal status back (`shipped` / `needs_human`) from `fixer-result.json` |
| `../../.github/workflows/fixer-agent.yml` | the orchestration |

The **LLM only writes code.** Every status transition is deterministic shell + service-role
curl — the model never owns DB bookkeeping.

## Triggering it

- **UI:** GitHub → Actions → *Fixer agent* → **Run workflow**. Optionally paste a
  `signal_id`; leave blank to take the oldest approved `bug_report`.
- **CLI:** `gh workflow run fixer-agent.yml -f signal_id=<uuid>` (or omit `-f` for oldest).

One signal per run, by design ("start small: one signal → one PR").

> `workflow_dispatch` only lists a workflow once the workflow file exists on the repo's
> **default branch**. Merge `fixer-agent.yml` to `main` before the "Run workflow" button
> appears; until then, dispatch from the feature branch's Actions view.

## Required GitHub secrets

| Secret | Notes |
|---|---|
| `ANTHROPIC_API_KEY`         | **NEW — must be added.** Today it exists only as a *Supabase* secret. |
| `SUPABASE_URL`              | already set (`https://ytydgldyeygpzmlxvpvb.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | already set — JWT `eyJ...`, **not** `sb_secret_*` (that format breaks PostgREST writes) |

`GITHUB_TOKEN` is auto-provided (the workflow grants it `contents: write` +
`pull-requests: write`). **There is deliberately no `SUPABASE_ACCESS_TOKEN`** — the agent
holds no credential that could deploy a function or run a migration. Prod is unreachable;
the PR + human merge is the only path live.

## DB migration

`supabase/migrations/20260627_fixer_signal_columns.sql` adds `pr_url`, `fixer_note`, and the
`needs_human` status value. Apply it **manually in the prod SQL editor** (`supabase db push`
is unsafe here — untracked remote history), then it self-`NOTIFY`s PostgREST to reload.

## The edge-function drift footgun

~15 functions in `supabase/functions/**` are **deployed ahead of git** — prod runs newer
code than this repo. The fixer works against git only (no live-source access), so if a fix
touches an edge function the agent is required to flag it in the PR body: the reviewer must
diff against the live deployed source (`supabase functions download <name>`) before merging,
or the merge can revert prod to a stale version. Verify this at review time.

## Deliberate non-goals (possible follow-ups)

- **Dashboard approve → auto-fire.** Today approval just sets `approved`; you still click
  *Run workflow*. A future edge fn could `repository_dispatch` on approve.
- **Live drift reconciliation.** Pulling live prod source in-CI would need
  `SUPABASE_ACCESS_TOKEN` in the repo — weighed against keeping deploy power out of CI.
- **Cost accounting.** The action's token usage isn't logged to `agent_cost_ledger` yet.
- **Auto-deploy after merge.** Explicitly never — merging stays a human action, deploys stay manual.
