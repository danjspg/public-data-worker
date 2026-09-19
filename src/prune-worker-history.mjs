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
  'eplan_active_lifecycle',
  'procurement_ogp_record',
  'procurement_ted_notice',
];

const db = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

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
         order by applied_at, id
         limit $2
       )
       update work_items w
       set input='{}'::jsonb,
           result=null,
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
           and applied_at < now() - make_interval(days => $1::int)
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
