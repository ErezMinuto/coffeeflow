-- Ops profile + Vault-backed credential reader.
--
-- Purpose: let a session started from a phone (a Claude Code cloud session, which
-- cannot see anything on Erez's Mac) bootstrap itself from TWO values only —
-- SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — and fetch everything else it needs
-- from here. Credentials live encrypted in Supabase Vault; non-secret operating
-- context lives in public.ops_profile.
--
-- NOT APPLIED AUTOMATICALLY. Review before running (see scripts/bootstrap-from-db.sh
-- and the "Working from mobile" section of CLAUDE.md).
--
-- Additive only: creates one table and two functions, touches no existing object.

-- ── Vault ─────────────────────────────────────────────────────────────────────
-- Enabled by default on Supabase projects; this is a no-op if it already exists.
create extension if not exists supabase_vault with schema vault cascade;


-- ── Non-secret operating context ──────────────────────────────────────────────
-- Business facts and conventions a session should know before it does anything:
-- which project is prod, bag sizes, which bot owns which edge function, and so on.
-- Nothing secret goes in this table — secrets go in Vault.
create table if not exists public.ops_profile (
  key         text primary key,
  value       jsonb       not null,
  description text,
  updated_at  timestamptz not null default now()
);

comment on table public.ops_profile is
  'Non-secret operating context for AI sessions. Never store credentials here — use Vault.';

alter table public.ops_profile enable row level security;

-- No policies for anon/authenticated => they get nothing. service_role bypasses RLS.
revoke all on public.ops_profile from anon, authenticated;
grant  all on public.ops_profile to   service_role;


-- ── Credential reader ─────────────────────────────────────────────────────────
-- Returns decrypted Vault secrets by name. SECURITY DEFINER so it can read the
-- vault schema, but execution is granted to service_role ONLY — it is never
-- reachable with the anon key, unlike most RPCs in this project.
create or replace function public.ops_get_secrets(p_names text[])
returns table (name text, secret text)
language sql
security definer
set search_path = ''
as $$
  select s.name::text, s.decrypted_secret::text
  from vault.decrypted_secrets s
  where s.name = any(p_names)
$$;

comment on function public.ops_get_secrets(text[]) is
  'Fetch decrypted Vault secrets by name. service_role only. Callers must never print the values.';

revoke all     on function public.ops_get_secrets(text[]) from public, anon, authenticated;
grant  execute on function public.ops_get_secrets(text[]) to   service_role;


-- ── Which credentials exist, without revealing any ────────────────────────────
-- Safe to call and safe to print: names and metadata only. This is what a session
-- uses to discover what it can bootstrap.
create or replace function public.ops_list_secret_names()
returns table (name text, description text, updated_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select s.name::text, s.description::text, s.updated_at
  from vault.decrypted_secrets s
  order by s.name
$$;

comment on function public.ops_list_secret_names() is
  'List Vault secret names and metadata. Returns no secret values — safe to display.';

revoke all     on function public.ops_list_secret_names() from public, anon, authenticated;
grant  execute on function public.ops_list_secret_names() to   service_role;


-- ── Seed the profile ──────────────────────────────────────────────────────────
insert into public.ops_profile (key, value, description) values
  ('prod_project_ref', '"ytydgldyeygpzmlxvpvb"'::jsonb,
   'Supabase production project ref'),
  ('retail_bag_grams', '330'::jsonb,
   'Minuto standard retail bag size in grams (also sold as 1kg). Not 250g.'),
  ('revenue_source', '"mflow"'::jsonb,
   'Single source of truth for revenue. Jun-Jul 2026 is a split ledger with iCount.'),
  ('bots', '{"coffee-bot":"packing reports","employee-bot":"schedules","telegram-bot":"tasks"}'::jsonb,
   'One Telegram bot per edge function. Never merge responsibilities.')
on conflict (key) do nothing;
