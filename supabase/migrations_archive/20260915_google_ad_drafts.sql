-- Tracks PAUSED Google Ads campaign drafts that google-ads-draft creates —
-- the Google twin of meta_ad_drafts. The owner reviews each draft in the
-- Google Ads UI and clicks Enable. The row stays as a permanent breadcrumb so
-- we can:
--   1. Dedupe — drafting the same idea_id twice returns the existing row
--      instead of creating a second campaign in Google.
--   2. Feed the monthly budget guard, which counts daily_budget_ils ×
--      spec.duration_days across the drafts created this calendar month.
--   3. Audit — link the strategist recommendation that produced each draft.
--
-- Search campaigns fill ad_group_id + ad_id; Performance Max has neither and
-- fills asset_group_id instead. campaign_type records which shape it is.
create table if not exists google_ad_drafts (
  id              bigserial primary key,
  idea_id         text not null,
  customer_id     text not null,
  campaign_id     text not null,
  budget_id       text,
  ad_group_id     text,           -- SEARCH only
  ad_id           text,           -- SEARCH only
  asset_group_id  text,           -- PERFORMANCE_MAX only
  campaign_name   text,
  campaign_type   text,           -- SEARCH | PERFORMANCE_MAX
  daily_budget_ils numeric,
  spec            jsonb,          -- the full input spec we built from
  warnings        text[],         -- e.g. headlines truncated to 30 chars
  status          text not null default 'PAUSED',
  created_at      timestamptz not null default now(),
  unique (idea_id)
);

create index if not exists idx_google_ad_drafts_created on google_ad_drafts(created_at desc);

-- Service-role-only: all reads/writes go through edge functions using the
-- service_role key, which bypasses RLS. No legitimate anon access path.
alter table google_ad_drafts enable row level security;
