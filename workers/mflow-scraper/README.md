# MFlow Scraper

Node.js worker that scrapes the MFlow POS system daily, syncs sales data to Supabase, and sends Telegram stock alerts.

## What it does

1. **Daily sales sync** — Logs into MFlow, pulls yesterday's product-sell report via Puppeteer, deducts sold quantities from `origins.roasted_stock` in Supabase.
2. **Stock alerts** — After each sync, checks if any origin has < 14 days of green coffee remaining and sends a Claude-generated Hebrew alert to Telegram.

## Deployed on Railway

The scraper runs as a Docker container on Railway. Cron runs at **06:00 UTC (08:00 IST)** daily.

## Environment variables

Set these in the Railway dashboard under **Variables**:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon key |
| `MFLOW_EMAIL` | MFlow login email |
| `MFLOW_PASSWORD` | MFlow login password |
| `USER_ID` | Clerk user ID for data isolation |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for alerts |
| `ANTHROPIC_API_KEY` | Claude API key for alert generation |

> **Never commit credentials to this file or any tracked file.**

## Local development

```bash
cd workers/mflow-scraper
npm install
SUPABASE_URL=... SUPABASE_KEY=... MFLOW_EMAIL=... MFLOW_PASSWORD=... USER_ID=... node index.js
```

## Deploy to Railway

```bash
npm install -g @railway/cli
railway login
cd workers/mflow-scraper
railway up
```
