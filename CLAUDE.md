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
6. **After deploying any edge function** — re-patch `verify_jwt: false` via the Management API (deploys reset it).

---

## Supabase Projects

| Environment | Project ID | URL |
|-------------|------------|-----|
| **Production** | `ytydgldyeygpzmlxvpvb` | `https://ytydgldyeygpzmlxvpvb.supabase.co` |
| **Dev** | *(set after project is created)* | *(set after project is created)* |

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
# Deploy a single function
/opt/homebrew/Cellar/supabase/2.75.0/bin/supabase functions deploy <function-name>

# After EVERY deploy — re-patch verify_jwt (deploy resets it to true)
curl -X PATCH "https://api.supabase.com/v1/projects/ytydgldyeygpzmlxvpvb/functions/<slug>" \
  -H "Authorization: Bearer <personal_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"verify_jwt": false}'
```

Functions with `verify_jwt: false` (Telegram webhooks don't send JWTs):
- `coffee-bot`, `employee-bot`, `telegram-bot`, `clerk-user-lookup`

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
