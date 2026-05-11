-- Tracks PAUSED ad-campaign drafts that meta-ads-draft creates against the
-- Marketing API. The owner reviews each draft in Ads Manager and clicks
-- Activate. The row stays as a permanent breadcrumb so we can:
--   1. Dedupe — clicking "Build draft" twice for the same idea_id returns
--      the existing row instead of re-creating in Meta.
--   2. Show a "draft exists — open in Ads Manager" state in the UI.
--   3. Audit — link the agent recommendation that produced each draft.
--
-- idea_id mirrors meta_campaign_ideas[].idea_id from advisor_reports; if
-- the spec was built ad-hoc (chat, manual JSON), idea_id is the agent's
-- campaign_name slug.
create table if not exists meta_ad_drafts (
  id           bigserial primary key,
  idea_id      text not null,
  ad_account_id text not null,
  campaign_id  text not null,
  adset_id     text,
  ad_id        text,
  creative_id  text,
  campaign_name text,
  objective    text,
  daily_budget_ils numeric,
  spec         jsonb,                -- the full input spec we built from
  warnings     text[],               -- e.g. interests that didn't resolve
  status       text not null default 'PAUSED',
  created_at   timestamptz not null default now(),
  unique (idea_id)
);

create index if not exists idx_meta_ad_drafts_created on meta_ad_drafts(created_at desc);

grant select, insert, update on meta_ad_drafts to anon, authenticated;
grant usage, select on sequence meta_ad_drafts_id_seq to anon, authenticated;
