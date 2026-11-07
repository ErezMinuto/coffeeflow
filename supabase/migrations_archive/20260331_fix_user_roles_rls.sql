-- Fix overpermissive user_roles policy:
-- Old policy allowed all authenticated users to read ALL rows.
-- New policy: each user can only read their own role row.

drop policy if exists "Users read own role" on user_roles;

create policy "Users read own role" on user_roles
  for select using (
    user_id = coalesce(
      current_setting('request.jwt.claims', true)::json->>'sub',
      auth.uid()::text
    )
  );
