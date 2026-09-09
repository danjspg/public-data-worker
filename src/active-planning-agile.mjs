import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.ACTIVE_AGILE_WORKER_LIMIT || 1000), 5000));
const DETAIL_URL = 'https://planningapi.agileapplications.ie/api/application';
const RETRYABLE = new Set([408,425,429,500,502,503,504]);
const CONFIG = {
  CORKCOCO: { client: 'CORKCOCO', tenant: 'corkcoco', detailIdFromSourceUrl: false },
  CORKCITY: { client: 'CORKCITY', tenant: 'corkcity', detailIdFromSourceUrl: false },
  WEXFORD: { client: 'WEXFORD', tenant: 'wexford', detailIdFromSourceUrl: true },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function detailId(input, config) {
  if (config.detailIdFromSourceUrl) {
    const match = String(input.source_url || '').match(/\/application-details\/(\d+)/);
    if (match) return Number(match[1]);
  }
  const sourceId = Number(input.source_application_id);
  return Number.isInteger(sourceId) ? sourceId : null;
}

async function fetchDetail(input, config) {
  const id = detailId(input, config);
  if (!id) return { found: false, reason: 'missing_detail_id' };
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(`${DETAIL_URL}/${id}`, {
        headers: {
          'User-Agent': 'Public records data worker',
          'x-client': config.client,
          'x-product': 'CITIZENPORTAL',
          'x-service': 'PA',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return { found: true, detail_id: id, detail: await response.json() };
      if (response.status === 404) return { found: false, reason: 'not_found', detail_id: id };
      lastError = new Error(`HTTP ${response.status}`);
      if (!RETRYABLE.has(response.status)) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await sleep(attempt * 1000);
  }
  throw lastError || new Error('detail request failed');
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let selected = 0, completed = 0, missing = 0, deferred = 0;
try {
  const { rows } = await client.query(`
    select id,input
    from work_items
    where job_type='active_planning_agile_detail'
      and status='pending'
      and applied_at is null
      and available_at <= now()
    order by id
    limit $1
  `, [LIMIT]);
  selected = rows.length;

  for (const item of rows) {
    const config = CONFIG[item.input.local_authority_code];
    if (!config) {
      await client.query(`update work_items set status='failed',last_error='unsupported_agile_authority',completed_at=now(),updated_at=now() where id=$1`, [item.id]);
      deferred += 1;
      continue;
    }
    try {
      const result = await fetchDetail(item.input, config);
      await client.query(`
        update work_items
        set status='completed', result=$2::jsonb, completed_at=now(), last_error=null, attempts=attempts+1, updated_at=now()
        where id=$1
      `, [item.id, JSON.stringify({ ok: true, ...result })]);
      if (result.found) completed += 1;
      else missing += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query(`
        update work_items
        set attempts=attempts+1,last_error=$2,available_at=now()+interval '30 minutes',updated_at=now()
        where id=$1
      `, [item.id, message.slice(0,500)]);
      deferred += 1;
    }
    await sleep(250);
  }
  console.log(JSON.stringify({ selected, completed, missing, deferred }, null, 2));
} finally {
  await client.end().catch(() => {});
}
