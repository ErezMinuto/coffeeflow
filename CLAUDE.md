# CoffeeFlow — AI Development Guide

This file is read automatically by Claude Code at the start of every session.
All AI assistants working on this project MUST follow the rules below.

---

## Supabase Project

- **Project ID**: `ytydgldyeygpzmlxvpvb`
- **URL**: `https://ytydgldyeygpzmlxvpvb.supabase.co`

---

## Bot Architecture — DO NOT CHANGE

There are exactly 3 Telegram bots. Each bot has one dedicated Supabase Edge Function.
**Never merge responsibilities. Never create new bots.**

| Bot | Username | Edge Function | Responsibility |
|-----|----------|---------------|----------------|
| Minuto Coffee Alerts | @minuto_coffee_bot | `coffee-bot` | Packing reports (private messages from employees) |
| Minuto Team Bot | @minuto_team_bot | `employee-bot` | Work schedules & availability (private + group) |
| CoffeeFlow Tasks | (tasks bot) | `telegram-bot` | Waiting customers & task management (group only) |

### Rules
- **coffee-bot**: Handles `/stock` and free-text packing reports. Deducts `roasted_stock`, increments `packed_stock`, logs to `packing_logs`. Uses `COFFEE_BOT_TOKEN` env var.
- **employee-bot**: Handles name registration, availability submissions, weekly schedule reminders. Uses `TELEGRAM_BOT_TOKEN` env var.
- **telegram-bot**: Handles `/tasks`, `/done`, and free-text customer requests in the group chat only. Uses `TELEGRAM_BOT_TOKEN` env var. **No packing or stock logic here.**

---

## Environment Variables (Supabase Secrets)

| Variable | Used By |
|----------|---------|
| `COFFEE_BOT_TOKEN` | coffee-bot only |
| `TELEGRAM_BOT_TOKEN` | telegram-bot + employee-bot |
| `TELEGRAM_CHAT_ID` | telegram-bot (group chat ID) |
| `COFFEEFLOW_USER_ID` | all functions |
| `ANTHROPIC_API_KEY` | coffee-bot, telegram-bot |
| `SUPABASE_SERVICE_ROLE_KEY` | all functions (auto-injected) |

**Important**: Use the JWT-format service role key (starts with `eyJ`), not the `sb_secret_*` format — the new format does not work with PostgREST role assignment and will cause permission errors on UPDATE/INSERT.

---

## Frontend (React + Vite)

- **Framework**: React with React Router
- **State**: AppContext in `src/lib/context.jsx` — holds all DB hooks + `refreshAll()`
- **Auto-refresh**: `src/App.jsx` calls `refreshAll()` on every route navigation
- **Security**: `src/lib/hooks.js` — all `fetchData`, `update`, `remove` filter by `user_id`

---

## Supabase Edge Functions — Deployment

```bash
# Deploy a single function
/opt/homebrew/Cellar/supabase/2.75.0/bin/supabase functions deploy <function-name>

# Set a secret
/opt/homebrew/Cellar/supabase/2.75.0/bin/supabase secrets set KEY=value

# Disable JWT verification (required for Telegram webhooks — do via Management API)
curl -X PATCH "https://api.supabase.com/v1/projects/ytydgldyeygpzmlxvpvb/functions/<slug>" \
  -H "Authorization: Bearer <personal_access_token>" \
  -H "Content-Type: application/json" \
  -d '{"verify_jwt": false}'
```

All 3 edge functions have `verify_jwt: false` — Telegram does not send JWTs.

---

## Known Issues & Decisions

- **`sb_secret_*` key format**: Does NOT work for server-side Supabase clients that need UPDATE/INSERT. Always use the `eyJ...` JWT format service role key.
- **One webhook per bot**: Each bot token supports exactly one webhook URL. Do not try to share a webhook between functions.
- **Teammate sync**: If your local branch is behind, run `git fetch origin && git reset --hard origin/main`. Do not force-push main without coordinating first.
