create table if not exists worker_jobs (
  job_key text primary key,
  cursor jsonb not null default '{}'::jsonb,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_status text,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists source_state (
  source_key text primary key,
  fingerprint text not null,
  state jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists change_events (
  id bigserial primary key,
  source_key text not null,
  event_type text not null,
  before_state jsonb,
  after_state jsonb,
  detected_at timestamptz not null default now(),
  delivered_at timestamptz,
  delivery_attempts integer not null default 0,
  last_delivery_error text
);

create index if not exists change_events_pending_idx
  on change_events (detected_at)
  where delivered_at is null;

create index if not exists source_state_last_seen_idx
  on source_state (last_seen_at);
