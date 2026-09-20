-- Write side of the credential profile: put a secret into Vault by name.
--
-- Without this, adding a credential means the dashboard UI or hand-editing a file,
-- which is friction in exactly the place that matters — so credentials end up
-- pasted into a chat instead. With it, adding one is a single command that prompts
-- for the value and never writes it to a file, a shell history or a transcript:
--
--     ./scripts/set-secret.sh SUPABASE_DB_URL
--
-- Signatures verified against this project before writing (they carry defaults, so
-- argument order matters):
--   vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid)
--   vault.update_secret(secret_id uuid, new_secret text, new_name text, new_description text, new_key_id uuid)
--
-- service_role only, like ops_get_secrets. The anon key ships in the frontend and
-- must never reach this.

create or replace function public.ops_set_secret(
  p_name        text,
  p_secret      text,
  p_description text default ''
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'a secret needs a name';
  end if;
  if p_secret is null or p_secret = '' then
    raise exception 'refusing to store an empty value for %', p_name;
  end if;

  select s.id into v_id from vault.secrets s where s.name = p_name;

  if v_id is null then
    perform vault.create_secret(p_secret, p_name, coalesce(p_description, ''));
    return 'created';
  else
    perform vault.update_secret(v_id, p_secret, p_name, nullif(p_description, ''));
    return 'updated';
  end if;
end;
$$;

comment on function public.ops_set_secret(text, text, text) is
  'Upsert a Vault secret by name. service_role only. Never logs or returns the value.';

revoke all     on function public.ops_set_secret(text, text, text) from public, anon, authenticated;
grant  execute on function public.ops_set_secret(text, text, text) to   service_role;


-- Remove one by name, so a rotation can retire the old entry.
create or replace function public.ops_delete_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  delete from vault.secrets s where s.name = p_name;
  get diagnostics v_count = row_count;
  return case when v_count > 0 then 'deleted' else 'not found' end;
end;
$$;

comment on function public.ops_delete_secret(text) is
  'Delete a Vault secret by name. service_role only.';

revoke all     on function public.ops_delete_secret(text) from public, anon, authenticated;
grant  execute on function public.ops_delete_secret(text) to   service_role;
