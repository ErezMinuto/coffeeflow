-- User roles for access control
create table if not exists user_roles (
  id        bigint generated always as identity primary key,
  user_id   text not null unique,
  role      text not null default 'employee',
  created_at timestamptz default now()
);

alter table user_roles enable row level security;

-- Allow all authenticated users to read their own role
create policy "Users read own role" on user_roles
  for select using (true);

-- Only admins can manage roles (via service role key in edge functions)
