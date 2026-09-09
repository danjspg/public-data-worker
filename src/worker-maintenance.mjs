import pg from 'pg';
import { recoverStaleLeases } from './worker-platform.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const client = new Client({connectionString,ssl:{rejectUnauthorized:false}}); await client.connect();
try {
  const recovered = await recoverStaleLeases(client, Number(process.env.STALE_LEASE_MINUTES || 120));
  const {rows:queues}=await client.query(`
    select job_type,status,count(*)::int as count,
           count(*) filter(where applied_at is null)::int as unapplied,
           min(available_at) filter(where status='pending' and applied_at is null) as oldest_available
    from work_items group by job_type,status order by job_type,status
  `);
  const {rows:dead}=await client.query(`
    select job_type,count(*)::int as count,min(updated_at) as oldest,max(updated_at) as newest
    from work_items
    where status='failed' and applied_at is null and coalesce(last_error,'') like 'dead_letter:%'
    group by job_type order by count(*) desc
  `);
  const {rows:health}=await client.query(`
    select source_key,state from source_state
    where source_key like 'health:%'
    order by greatest(coalesce((state->>'consecutive_failures')::int,0),coalesce((state->>'http_429')::int,0)) desc, source_key
    limit 50
  `);
  console.log(JSON.stringify({recoveredStaleLeases:recovered,queues,deadLetters:dead,sourceHealth:health},null,2));
} finally { await client.end().catch(()=>{}); }
