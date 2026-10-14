import pg from 'pg';
import { pathToFileURL } from 'node:url';
const { Client } = pg;
export const CATEGORY_SWEEP_JOB = 'planning-category-corpus-v1';
export const CATEGORY_SWEEP_TYPE = 'planning_category_corpus';
export const ZERO_CURSOR = '00000000-0000-0000-0000-000000000000';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// This public runner schedules a bounded unit of work only.
// The private OpenList consumer holds production credentials and classifier.
export async function enqueuePlanningCategorySweep(client) {
  await client.query('begin');
  try {
    const { rows: locks } = await client.query("select pg_try_advisory_xact_lock(hashtext('planning-category-corpus-v1')) as acquired");
    if (!locks[0]?.acquired) {
      await client.query('rollback');
      return { queued: false, reason: 'another_scheduler_running' };
    }
    await client.query("insert into worker_jobs(job_key,cursor,last_status,last_started_at,updated_at) values($1,$2::jsonb,'queued',now(),now()) on conflict(job_key) do nothing", [CATEGORY_SWEEP_JOB, JSON.stringify({ after: ZERO_CURSOR, complete: false, scanned: 0, changed: 0 })]);
    const { rows: jobs } = await client.query('select cursor,last_status from worker_jobs where job_key=$1 for update', [CATEGORY_SWEEP_JOB]);
    const cursor = jobs[0]?.cursor || {};
    if (cursor.complete === true) {
      await client.query('commit');
      return { queued: false, reason: 'complete', scanned: cursor.scanned || 0, changed: cursor.changed || 0 };
    }

    // Even a failed outstanding tranche blocks the next one until resolved.
    const { rows: outstanding } = await client.query("select id,status,attempts from work_items where job_type=$1 and applied_at is null order by id limit 1", [CATEGORY_SWEEP_TYPE]);
    if (outstanding.length) {
      await client.query('commit');
      return { queued: false, reason: 'outstanding', item: outstanding[0] };
    }

    const after = String(cursor.after || ZERO_CURSOR);
    if (!UUID.test(after)) throw new Error('Invalid persisted category sweep cursor');
    const workKey = 'v1:' + after;
    const { rows: inserted } = await client.query("insert into work_items(job_type,work_key,input,status,attempts,available_at,updated_at) values($1,$2,$3::jsonb,'pending',0,now(),now()) on conflict(job_type,work_key) do nothing returning id", [CATEGORY_SWEEP_TYPE, workKey, JSON.stringify({ after, batchSize: 250, maxBatches: 20 })]);
    if (!inserted.length) throw new Error('Duplicate category-corpus cursor without outstanding item');
    await client.query('commit');
    return { queued: true, id: inserted[0].id, after, recordsMax: 5000 };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function main() {
  if (!process.env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.WORKER_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    console.log(JSON.stringify(await enqueuePlanningCategorySweep(client)));
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
