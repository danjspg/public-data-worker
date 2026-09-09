import pg from 'pg';

const { Client } = pg;

const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) {
  console.error('WORKER_DATABASE_URL is not configured');
  process.exit(1);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  const result = await client.query('select now() as now, current_database() as database');
  console.log(`Worker database healthy: ${result.rows[0].database} at ${result.rows[0].now.toISOString()}`);
} finally {
  await client.end().catch(() => {});
}
