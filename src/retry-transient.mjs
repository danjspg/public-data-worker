import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const result = await client.query(`
    update work_items
    set status = 'pending', available_at = now(), completed_at = null, updated_at = now()
    where applied_at is null
      and status = 'failed'
      and (
        last_error like 'HTTP 429%'
        or last_error like 'HTTP 408%'
        or last_error like 'HTTP 425%'
        or last_error like 'HTTP 500%'
        or last_error like 'HTTP 502%'
        or last_error like 'HTTP 503%'
        or last_error like 'HTTP 504%'
        or last_error like '%AbortError%'
        or last_error like '%Timeout%'
      )
  `);
  console.log(JSON.stringify({ retried: result.rowCount }, null, 2));
} finally {
  await client.end().catch(() => {});
}
