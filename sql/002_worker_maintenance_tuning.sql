-- Maintenance tuning for the high-churn worker tables.
-- These settings keep dead-row accumulation bounded on the 0.25 CU Neon worker
-- without deleting or shortening any queue/backlog retention.

do $$
begin
  if to_regclass('public.work_items') is not null then
    execute 'alter table public.work_items set (
      autovacuum_vacuum_scale_factor = 0.02,
      autovacuum_vacuum_threshold = 500,
      autovacuum_analyze_scale_factor = 0.05,
      autovacuum_analyze_threshold = 500
    )';
  end if;

  if to_regclass('public.source_sync_state') is not null then
    execute 'alter table public.source_sync_state set (
      autovacuum_vacuum_scale_factor = 0.02,
      autovacuum_vacuum_threshold = 200,
      autovacuum_analyze_scale_factor = 0.05,
      autovacuum_analyze_threshold = 200
    )';
  end if;
end $$;
