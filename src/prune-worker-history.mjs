import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const compactAfterHours = Math.max(6, Math.min(Number(process.env.WORKER_COMPACT_AFTER_HOURS || 6), 720));
const deleteRecurringAfterDays = Math.max(1, Math.min(Number(process.env.WORKER_DELETE_RECURRING_AFTER_DAYS || 1), 90));
const batchSize = Math.max(100, Math.min(Number(process.env.WORKER_PRUNE_BATCH_SIZE || 2000), 5000));
const maxRows = Math.max(batchSize, Math.min(Number(process.env.WORKER_PRUNE_MAX_ROWS || 100000), 100000));

const recurringJobTypes = [
  'active_planning_exact',
  'active_planning_agile_detail',
  'active_planning_recent_range',
  'planning_description',
  'eplan_active_lifecycle',
  'procurement_ogp_record',
  'procurement_ted_notice',
];

const db = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

// Keep only compact lifecycle observations until the daily report has assessed its cohort.
// Worker-consumed no-change timestamps must not be mistaken for production writes.
async function compactAppliedPayloads() {
  let compacted = 0;
  while (compacted < maxRows) {
    const limit = Math.min(batchSize, maxRows - compacted);
    const { rowCount } = await db.query(
      `with targets as (
         select id
         from work_items
         where applied_at is not null
           and applied_at < now() - make_interval(hours => $1::int)
           and (result is not null or input <> '{}'::jsonb or last_error is not null)
           and coalesce(result->>'lifecycle_observation_compacted','false') != 'true'
         order by applied_at, id
         limit $2
       )
       update work_items w
       set input=case when w.job_type='active_planning_recent_range' then
             jsonb_build_object(
               'local_authority_code',w.input->>'local_authority_code',
               'queued_for_date',w.input->>'queued_for_date',
               'source_policy_version',w.input->>'source_policy_version'
             )
             when w.job_type in ('active_planning_exact','active_planning_agile_detail','eplan_active_lifecycle') and w.result ? 'checked_at'
             then jsonb_build_object('application_id',w.input->>'application_id') else '{}'::jsonb end,
           result=case when w.job_type in ('active_planning_exact','active_planning_agile_detail','eplan_active_lifecycle') and w.result ? 'checked_at' then
             (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(w.result)
               where key in ('checked_at','ok','found','change_detected','baseline_missing','superseded',
                 'delta','production_outcome_version','production_lifecycle_changed','production_updated','production_changed_fields'))
             || '{"lifecycle_observation_compacted":true}'::jsonb
             when w.job_type='active_planning_recent_range' then
             jsonb_build_object(
               'ok',w.result->'ok',
               'source_type',w.result->'source_type',
               'fallback',w.result->'fallback',
               'lifecycle_observation_compacted',true
             )
             when w.job_type='acp_current_case' then
             jsonb_build_object(
               'source_signature',w.result->'source_signature',
               'checked_at',w.result->'checked_at',
               'lifecycle_observation_compacted',true
             )
             else null end,
           last_error=null,
           updated_at=now()
       from targets t
       where w.id=t.id`,
      [compactAfterHours, limit],
    );
    compacted += rowCount || 0;
    if (!rowCount || rowCount < limit) break;
  }
  return compacted;
}

async function deleteOldRecurringTombstones() {
  let deleted = 0;
  while (deleted < maxRows) {
    const limit = Math.min(batchSize, maxRows - deleted);
    const { rowCount } = await db.query(
      `delete from work_items
       where id in (
         select id
         from work_items
         where applied_at is not null
           and applied_at < now() - make_interval(days =>
             case when job_type in ('active_planning_exact','active_planning_agile_detail','eplan_active_lifecycle','active_planning_recent_range') then greatest($1::int,3) else $1::int end)
           and job_type = any($2::text[])
         order by applied_at, id
         limit $3
       )`,
      [deleteRecurringAfterDays, recurringJobTypes, limit],
    );
    deleted += rowCount || 0;
    if (!rowCount || rowCount < limit) break;
  }
  return deleted;
}

await db.connect();
try {
  const before = await db.query(`
    select count(*)::bigint as rows,
           count(*) filter (where applied_at is not null)::bigint as applied_rows,
           pg_database_size(current_database())::bigint as db_bytes
    from work_items
  `);

  const compacted = await compactAppliedPayloads();
  const deleted = await deleteOldRecurringTombstones();

  const after = await db.query(`
    select count(*)::bigint as rows,
           count(*) filter (where applied_at is not null)::bigint as applied_rows,
           pg_database_size(current_database())::bigint as db_bytes
    from work_items
  `);

  console.log(JSON.stringify({
    compactAfterHours,
    deleteRecurringAfterDays,
    recurringJobTypes,
    compacted,
    deleted,
    before: before.rows[0],
    after: after.rows[0],
  }, null, 2));
} finally {
  await db.end().catch(() => {});
}
