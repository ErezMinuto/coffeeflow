-- =============================================================================
-- ops_profile.current_capabilities: what CoffeeFlow already does, so the
-- strategist brain does not pitch an existing feature as an "innovation"
-- (get_current_capabilities tool, strategist-brain/research_tools.ts).
--
-- Written from the edge functions in supabase/functions as of 2026-11-03.
-- Non-secret by design. Edit the row as capabilities change; ON CONFLICT DO
-- NOTHING so re-applying never overwrites Erez's edits.
-- =============================================================================

INSERT INTO public.ops_profile (key, value, description) VALUES
  ('current_capabilities',
   '[
      "Paid ads: Meta and Google Search campaigns drafted PAUSED (meta-ads-draft, google-ads-draft) with daily, monthly and forward budget guards; only Erez activates. Live Meta/Google performance and search-term reports.",
      "Strategist brain (weekly brief, theses graded on revenue), executor, and a draft critic with up to 2 revisions before Erez reviews.",
      "Instagram: feed posts, stories and carousels rendered (shot library, real bag photos, visual QA) and staged for review; publishing only by Erez (meta-publish). Reels via Veo + Remotion.",
      "Blog/SEO: research worker with web search, writer to WordPress drafts, technical SEO worker, product FAQ generation, product description updates, Search Console + GA4 sync, AI-visibility probe (how LLMs mention Minuto), cannibalization check.",
      "Email: AI campaign drafts (generate-campaign), first-purchase automation, Resend delivery and event webhooks, RFM customer segments.",
      "Market intelligence: competitor Meta Ad Library ads, industry RSS articles with relevance scoring, weekly innovation scan.",
      "Commerce data: WooCommerce orders, products and stock sync and webhooks, MFlow POS revenue (single revenue source), packed/roasted stock, green-coffee stock alerts.",
      "Operations: Telegram bots for packing reports, team schedules and group tasks; schedule generation; attendance; Artisan roast-log import; supplier invoices; Google Sheets export.",
      "Customer chat: WhatsApp coffee advisor bot for click-to-WhatsApp ad leads (coexistence with the WhatsApp Business app).",
      "Coffee quiz on the website reporting to GA4.",
      "Monitoring: health-watchdog (cron + data freshness, stuck loop items, daily approval digest email), durable system logs."
    ]'::jsonb,
   'What CoffeeFlow already does (strategist brain reads it so it never pitches an existing feature). Edit as capabilities change.')
ON CONFLICT (key) DO NOTHING;
