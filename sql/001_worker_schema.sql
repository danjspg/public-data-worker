create table if not exists worker_jobs (
  id bigserial primary key,
  job_key text not null unique,
  cursor jsonb not null default '{}'::jsonb,
  status text not null default 'idle',
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists source_state (
  source_key text not null,
  record_key text not null,
  fingerprint text,
  source_updated_at timestamptz,
  payload jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (source_key, record_key)
);

create table if not exists change_events (
  id bigserial primary key,
  source_key text not null,
  record_key text not null,
  event_type text not null,
  previous_fingerprint text,
  current_fingerprint text,
  payload jsonb,
  detected_at timestamptz not null default now(),
  forwarded_at timestamptz,
  forward_attempts integer not null default 0,
  last_forward_error text
);

create index if not exists change_events_pending_idx
  on change_events (detected_at)
  where forwarded_at is null;

create index if not exists source_state_last_seen_idx
  on source_state (last_seen_at);
