import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.ACTIVE_PLANNING_WORKER_LIMIT || 500), 5000));
const BATCH_SIZE = Math.max(1, Math.min(Number(process.env.ACTIVE_PLANNING_SOURCE_BATCH || 150), 200));
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const RETRYABLE = new Set([408,425,429,500,502,503,504]);

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Public records data worker' },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) {
        const json = await response.json();
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
        return json;
      }
      lastError = new Error(`HTTP ${response.status}`);
      if (!RETRYABLE.has(response.status)) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await sleep(attempt * 750);
  }
  throw lastError || new Error('request failed');
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let selected = 0, completed = 0, missing = 0, failed = 0;
try {
  const { rows } = await client.query(`
    select id, input
    from work_items
    where job_type='active_planning_exact'
      and status='pending'
      and applied_at is null
      and available_at <= now()
    order by id
    limit $1
  `, [LIMIT]);
  selected = rows.length;

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const ids = batch.map((item) => Number(item.input.source_application_id)).filter(Number.isInteger);
    if (!ids.length) continue;
    const params = new URLSearchParams({
      where: `OBJECTID IN (${ids.join(',')})`,
      outFields: '*',
      returnGeometry: 'false',
      f: 'json',
      resultRecordCount: String(ids.length),
    });
    try {
      const json = await fetchJson(`${ARC_QUERY}?${params.toString()}`);
      const byId = new Map();
      for (const feature of json.features || []) {
        const attrs = feature.attributes || {};
        const id = Number(attrs.OBJECTID);
        if (Number.isInteger(id)) byId.set(id, attrs);
      }
      for (const item of batch) {
        const sourceId = Number(item.input.source_application_id);
        const attrs = byId.get(sourceId);
        if (!attrs) {
          await client.query(`
            update work_items
            set status='completed', result=$2::jsonb, completed_at=now(), last_error=null, updated_at=now()
            where id=$1
          `, [item.id, JSON.stringify({ ok: true, found: false, source_application_id: sourceId })]);
          missing += 1;
          continue;
        }
        await client.query(`
          update work_items
          set status='completed', result=$2::jsonb, completed_at=now(), last_error=null, updated_at=now()
          where id=$1
        `, [item.id, JSON.stringify({ ok: true, found: true, attributes: attrs })]);
        completed += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const item of batch) {
        await client.query(`
          update work_items
          set attempts=attempts+1,
              last_error=$2,
              available_at=now() + interval '30 minutes',
              updated_at=now()
          where id=$1
        `, [item.id, message.slice(0, 500)]);
        failed += 1;
      }
    }
  }

  console.log(JSON.stringify({ selected, completed, missing, deferred: failed }, null, 2));
} finally {
  await client.end().catch(() => {});
}
