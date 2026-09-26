# CoffeeFlow — AI Development Guide

This file is read automatically by Claude Code at the start of every session.
All AI assistants working on this project MUST follow the rules below.

---

## ⚠️ Ground Rules for All AI Assistants

1. **Always `git pull` before starting any work.** Never assume your local state is current.
2. **Never push directly to `main`.** Open a PR — another developer reviews it first.
3. **Never create new bots, new edge functions, or new Supabase projects.** Work within what exists.
4. **Before touching any edge function** — read its current code first. Do not rewrite from scratch.
5. **If something "doesn't seem right"** — stop and ask the developer. Do not silently redesign.
6. **Never ask for a credential to be pasted into chat.** Everything is in Vault or the
   local store — run `./scripts/secrets-doctor.sh`. See *Credentials* below.
7. **After deploying any edge function** — re-patch `verify_jwt: false` via the Management API (deploys reset it).

---

## Supabase Projects

| Environment | Project ID | URL |
|-------------|------------|-----|
| **Production** | `ytydgldyeygpzmlxvpvb` | `https://ytydgldyeygpzmlxvpvb.supabase.co` |
| **Dev** | `emnijrlfiuwbddjahkzn` | `https://emnijrlfiuwbddjahkzn.supabase.co` |

> **Rule for AI assistants**: Always deploy to **prod** only when explicitly asked. Never run migrations against prod directly — always apply to dev first.

---

## Dev Environment

### Architecture
```
main branch    →  Vercel PRODUCTION  →  Supabase PROD
feature branch →  Vercel PREVIEW     →  Supabase DEV
```

### Local Setup (for each developer)
1. Copy `.env.local.example` → `.env.local`
2. Fill in the **dev** Supabase URL + anon key (get from project owner)
3. Run `npm start` — app runs locally pointing at dev DB

### First-time Dev DB Setup
```bash
export DEV_DB_URL="postgresql://postgres:<password>@db.<dev-project-id>.supabase.co:5432/postgres"
./scripts/setup-dev-db.sh
```
This applies all migrations and seeds test data.

### Vercel Preview Deployments
- In Vercel → Project Settings → Environment Variables:
  - `REACT_APP_SUPABASE_URL` + `REACT_APP_SUPABASE_ANON_KEY` set for **Preview** → dev project values
  - Same vars set for **Production** → prod project values
- Every feature branch pushed to GitHub auto-gets a preview URL hitting the dev DB

### Seed Data
- File: `supabase/seed.sql`
- Contains: 6 origins, 3 roast profiles, 6 products, 3 employees
- Replace `'DEV_USER_ID'` with actual Clerk user ID before running

---

## Bot Architecture — DO NOT CHANGE

There are exactly **3 Telegram bots**. Each bot has **one** dedicated Supabase Edge Function.
**Never merge responsibilities. Never create new bots. Never move logic between functions.**

| Bot | Username | Edge Function | Responsibility |
|-----|----------|---------------|----------------|
| Minuto Coffee Alerts | @minuto_coffee_bot | `coffee-bot` | Packing reports (private messages from employees) |
| Minuto Team Bot | @minuto_team_bot | `employee-bot` | Work schedules & availability (private + group) |
| CoffeeFlow Tasks | (tasks bot) | `telegram-bot` | Waiting customers & task management (group only) |

### Per-function rules
- **coffee-bot**: `/stock` and free-text packing reports only. Deducts `roasted_stock`, increments `packed_stock`, logs to `packing_logs`. Uses `COFFEE_BOT_TOKEN`. No task or schedule logic.
- **employee-bot**: Name registration, availability submissions, weekly schedule reminders only. Uses `TELEGRAM_BOT_TOKEN`. No packing or task logic.
- **telegram-bot**: `/tasks`, `/done`, free-text customer requests in group chat only. Uses `TELEGRAM_BOT_TOKEN`. **No packing, no stock, no schedule logic.**

---

## Frontend Architecture

- **Framework**: React (Create React App) + React Router
- **Deployed to**: Vercel (auto-deploy on push to `main`)
- **State**: `src/lib/context.jsx` — AppContext holds all DB hooks + `refreshAll()`
- **Auto-refresh**: `src/App.jsx` calls `refreshAll()` on every route navigation
- **DB hooks**: `src/lib/hooks.js` — `useSupabaseData(table, { filterByUser })`

### filterByUser rules
- `filterByUser: true` (default) — for per-user tables like `cost_settings`
- `filterByUser: false` — for all shared org-wide tables (products, origins, roasts, operators, employees, schedules, marketing, packing_logs, etc.)
- **Never add `filterByUser: true` to a shared business table** — it breaks multi-user access

---

## Credentials — never paste a secret into chat

Every credential a session needs is reachable without anyone typing it into the
conversation. Two tiers:

| Tier | What | Where it lives |
|------|------|----------------|
| **Bootstrap** | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | configured once per environment |
| **Everything else** | access token, LLM keys, Woo, Meta, Google, MFlow, Resend | **Supabase Vault**, fetched on demand |

Canonical list of names: `scripts/secret-names.txt`.

Add or rotate one with a single command — it prompts twice, hidden, and writes
straight to Vault. The value never reaches a file, your shell history, or a
conversation:

```bash
./scripts/set-secret.sh SUPABASE_DB_URL     # knows this one: asks for the password only
./scripts/set-secret.sh GEMINI_API_KEY
./scripts/set-secret.sh --list              # names only, never values
./scripts/set-secret.sh --delete NAME
```

Never paste a credential to an assistant, and never put one in a repo file.

### Per environment

**This Mac.** `./scripts/install-secrets.sh --link` creates
`~/.config/coffeeflow/secrets.env` (chmod 600, outside the repo) and adds a block to
`~/.zshenv` that exports it into any shell started inside the repo — including the
shells Claude Code runs commands in.

Do not copy the Supabase keys out of the dashboard by hand — `SUPABASE_ACCESS_TOKEN`
already authorizes fetching them:

```bash
./scripts/fetch-supabase-keys.sh    # writes URL + anon + service_role into the store
```

That leaves only `SUPABASE_DB_URL` to enter manually, because a database password is
resettable but never readable.

**Cloud session (a task sent from your phone).** A cloud session sees nothing on the
Mac, so set those same two variables in the cloud environment's own settings. That
is the entire provisioning step; everything else comes from Vault:

```bash
. scripts/bootstrap-from-db.sh --cache   # fetch from Vault into this session
./scripts/secrets-doctor.sh --live       # confirm what landed
```

`--cache` writes the fetched values to the ephemeral container's local store, so
later commands in the same session need no further network calls.

> To have this happen automatically at session start, add
> `. scripts/bootstrap-from-db.sh --cache --quiet` to the second `SessionStart` hook
> in `.claude/settings.json`, ahead of the `secrets-doctor.sh` call.

### Non-secret context

`public.ops_profile` holds operating facts any session should know before acting
(prod project ref, 330g retail bag, MFlow as the single revenue source, which bot
owns which edge function). `scripts/bootstrap-from-db.sh` prints it. Put facts there
rather than re-explaining them each session — but **never** a credential.

Schema for both: `supabase/migrations/20260920_ops_profile_and_vault_reader.sql`.
`public.ops_get_secrets` is `service_role` only — unlike most RPCs here, it is
unreachable with the anon key.

### Rules for AI assistants

- **Discover, don't ask.** `./scripts/secrets-doctor.sh` lists what is available:
  names, lengths and a 3-character prefix, never values.
- **Use by expansion only**: `curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"`.
  Never `cat`, `echo`, `env` or `printenv` a credential.
- **Headers, not query strings.** A token in a URL leaks into logs, retries and
  error output.
- **Never call `ops_get_secrets` ad hoc** — its response body *is* the secrets, and
  it would land in the transcript. Source `scripts/bootstrap-from-db.sh` instead.
- **A missing credential goes into Vault**, not into chat and not into a repo file.
- `.claude/hooks/block-secret-dumps.sh` (a `PreToolUse` hook) refuses commands whose
  effect is to print a credential. If it fires, rewrite the command — do not work
  around it. Regression suite: `bash .claude/hooks/test-block-secret-dumps.sh`.
- Secrets that only **edge functions** read stay in `supabase secrets set`. The Vault
  entries are for what runs in a session's own shell.

---

## Environment Variables (Supabase Secrets)

| Variable | Used By |
|----------|---------|
| `COFFEE_BOT_TOKEN` | coffee-bot only |
| `TELEGRAM_BOT_TOKEN` | telegram-bot + employee-bot |
| `TELEGRAM_CHAT_ID` | telegram-bot (group chat ID) |
| `COFFEEFLOW_USER_ID` | all functions |
| `ANTHROPIC_API_KEY` | coffee-bot, telegram-bot |
| `CLERK_SECRET_KEY` | clerk-user-lookup |
| `SUPABASE_SERVICE_ROLE_KEY` | all functions (auto-injected) |

**Critical**: Use the JWT-format service role key (starts with `eyJ`). The `sb_secret_*` format breaks PostgREST UPDATE/INSERT.

---

## Supabase Edge Functions — Deployment

```bash
# Deploy a single function — always use --no-verify-jwt for functions that need it
/opt/homebrew/bin/supabase functions deploy <function-name> --project-ref ytydgldyeygpzmlxvpvb --no-verify-jwt
```

Functions that MUST always be deployed with `--no-verify-jwt`:
- `coffee-bot`, `employee-bot`, `telegram-bot`, `clerk-user-lookup`, `marketing-advisor`

> The `--no-verify-jwt` flag replaces the old curl PATCH workaround. No post-deploy patching needed.

---

## Debugging — read the logs first

Edge functions write structured, durable logs to the `system_logs` table via
`supabase/functions/_shared/logger.ts`. Read them with:

```bash
./scripts/logs.sh errors          # what is broken (last 24h)
./scripts/logs.sh runs            # every invocation + outcome
./scripts/logs.sh run <run-id>    # full trace of one invocation
```

Needs `SUPABASE_ACCESS_TOKEN` (the same token deploys use). Read-only.
Retention is 30 days. Full guide: `docs/logging.md`.

Run status `incomplete` means the run was killed mid-flight (worker timeout /
OOM) — it never wrote a terminal line. That is a real signal, not missing data.

**When adding logging to a function**: always `await log.finish(...)`, return
`run_id` in the HTTP response, and use stable `event` keys. Note that editing
`_shared/logger.ts` makes every importing function stale — Supabase bundles
imports at deploy time, so they need redeploying for the change to land.

---

## Clerk User Lookup

- Function: `clerk-user-lookup` (edge function, `verify_jwt: false`)
- Use `email_address=` (not `email_address[]=`) in the Clerk API query — brackets format is broken
- `CLERK_SECRET_KEY` must be a valid secret key from the Clerk dashboard (`sk_live_` or `sk_test_`)

---

## Database — Key Decisions

- **user_roles**: Stores team member roles (`admin` / `employee`). Grants exist for `anon` role. RLS policy: allow all for anon + authenticated.
- **cost_settings**: Per-user. Always filter by `user_id`. One row per user.
- **All other tables**: Org-wide shared data. Do NOT filter by `user_id` on reads.
- **get_role_for_user(p_user_id)**: SECURITY DEFINER RPC — safe to call with anon key. Returns `admin` or `employee`.

---

## Known Issues & Decisions

- **`sb_secret_*` key format**: Breaks PostgREST role assignment → UPDATE/INSERT fail. Always use `eyJ...` JWT format.
- **verify_jwt resets on deploy**: Must re-PATCH after every function deploy. `config.toml` per-function doesn't persist on cloud deploys.
- **One webhook per bot**: Each bot token supports exactly one webhook URL.
- **Clerk email lookup**: Use `email_address=` not `email_address[]=` — bracket format returns wrong user.
- **Teammate sync**: `git fetch origin && git reset --hard origin/main` before starting work.
