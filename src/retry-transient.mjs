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
      and coalesce(last_error,'') ~* '(HTTP (408|425|429|500|502|503|504)|timeout|abort|fetch failed|ECONN|socket|temporar|rate limit|too many)'
  `);
  console.log(JSON.stringify({ retried: result.rowCount }, null, 2));
} finally {
  await client.end().catch(() => {});
}
