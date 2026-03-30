-- Marketing contacts with opt-in tracking
create table if not exists marketing_contacts (
  id          bigint generated always as identity primary key,
  user_id     text not null,
  email       text not null,
  phone       text,
  name        text,
  source      text not null default 'manual',
  opted_in    boolean not null default false,
  brevo_id    bigint,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique(user_id, email)
);

alter table marketing_contacts enable row level security;

create policy "Users see own contacts" on marketing_contacts
  for all using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Campaign history
create table if not exists campaigns (
  id              bigint generated always as identity primary key,
  user_id         text not null,
  channel         text not null default 'email',
  subject         text,
  message         text,
  html_content    text,
  recipient_count int default 0,
  status          text not null default 'draft',
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz default now()
);

alter table campaigns enable row level security;

create policy "Users see own campaigns" on campaigns
  for all using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');
