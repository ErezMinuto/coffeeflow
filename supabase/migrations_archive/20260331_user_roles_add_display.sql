-- Add display fields to user_roles so the roles management UI
-- can show who is who without requiring a Clerk admin API call.
-- These are auto-populated each time the user loads the app.

alter table user_roles
  add column if not exists email     text,
  add column if not exists full_name text;
