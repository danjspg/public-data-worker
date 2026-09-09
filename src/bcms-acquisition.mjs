import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const RESOURCE_ID = '0774e781-7af8-46da-b623-872e74cf541e';
const DATASTORE_URL = 'https://data.nbco.gov.ie/api/3/action/datastore_search';
const DATASTORE_SQL_URL = 'https://data.nbco.gov.ie/api/3/action/datastore_search_sql';
const METADATA_URL = 'https://data.nbco.gov.ie/api/3/action/package_show?id=bcnccc';
const USER_AGENT = 'Public records data worker';
const LIMIT = Math.max(1, Math.min(Number(process.env.BCMS_SOURCE_PAGE_LIMIT || 250), 1000));
const APPEND_PAGES = Math.max(1, Math.min(Number(process.env.BCMS_APPEND_PAGES || 5), 25));
const AUDIT_PAGES = Math.max(1, Math.min(Number(process.env.BCMS_AUDIT_PAGES || 10), 25));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function contentHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');
}
function sameTimestamp(left, right) {
  if (!left || !right) return false;
  const l = Date.parse(left), r = Date.parse(right);
  return Number.isFinite(l) && Number.isFinite(r) ? l === r : left === right;
}
async function fetchJson(url, timeoutMs = 30000) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (json?.success === false || json?.error) throw new Error(json?.error?.message || 'source returned unsuccessful response');
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}
async function metadata() {
  const payload = await fetchJson(METADATA_URL, 15000);
  const resource = payload.result?.resources?.find((item) => item.id === RESOURCE_ID);
  return { sourceFreshnessAt: resource?.last_modified || payload.result?.metadata_modified || null };
}
async function sourcePage(mode, cursor, sourceFreshnessAt) {
  const url = new URL(mode === 'audit' ? DATASTORE_URL : DATASTORE_SQL_URL);
  if (mode === 'audit') {
    url.searchParams.set('resource_id', RESOURCE_ID);
    url.searchParams.set('limit', String(LIMIT));
    url.searchParams.set('offset', String(Math.max(0, Number(cursor) || 0)));
    url.searchParams.set('sort', '_id asc');
  } else {
    const highWater = Math.max(0, Number(cursor) || 0);
    url.searchParams.set('sql', `SELECT * FROM "${RESOURCE_ID}" WHERE "_id" > ${highWater} ORDER BY "_id" ASC LIMIT ${LIMIT}`);
  }
  const payload = await fetchJson(url);
  const rows = (payload.result?.records || []).map((row) => ({ ...row, _openlist_content_hash: contentHash(row) }));
  const next = mode === 'audit'
    ? Number(cursor || 0) + rows.length
    : Math.max(Number(cursor || 0), ...rows.map((row) => Number(row._id) || 0));
  const total = Number(payload.result?.total || 0);
  return { rows, endCursor: mode === 'audit' && next >= total ? '0' : String(next), sourceFreshnessAt };
}
async function setJob(client, jobKey, cursor, status, error = null, completed = false) {
  await client.query(`
    insert into worker_jobs (job_key,cursor,last_started_at,last_completed_at,last_status,last_error,updated_at)
    values ($1,$2::jsonb,now(),$3,$4,$5,now())
    on conflict (job_key) do update set cursor=excluded.cursor,last_started_at=excluded.last_started_at,
      last_completed_at=coalesce(excluded.last_completed_at,worker_jobs.last_completed_at),last_status=excluded.last_status,
      last_error=excluded.last_error,updated_at=now()
  `, [jobKey, JSON.stringify(cursor), completed ? new Date().toISOString() : null, status, error]);
}
async function runMode(client, mode, pageCount, sourceFreshnessAt) {
  const jobKey = `bcms-acquisition-${mode}`;
  const state = await client.query('select cursor from worker_jobs where job_key=$1', [jobKey]);
  let cursor = String(state.rows[0]?.cursor?.cursor ?? '0');
  const previousFreshness = state.rows[0]?.cursor?.source_freshness_at || null;
  if (mode === 'audit' && cursor === '0' && sameTimestamp(sourceFreshnessAt, previousFreshness)) {
    await setJob(client, jobKey, { cursor, source_freshness_at: sourceFreshnessAt }, 'idle', null, true);
    return { mode, pages: 0, rows: 0, cursor, skippedUnchangedSource: true };
  }
  await setJob(client, jobKey, { cursor, source_freshness_at: previousFreshness }, 'running');
  let pages = 0, rowCount = 0;
  try {
    for (let index = 0; index < pageCount; index += 1) {
      const startCursor = cursor;
      const page = await sourcePage(mode, cursor, sourceFreshnessAt);
      const workKey = `${mode}:${sourceFreshnessAt || 'unknown'}:${startCursor}`;
      await client.query(`
        insert into work_items (job_type,work_key,input,result,status,completed_at,updated_at)
        values ('bcms_source_page',$1,$2::jsonb,$3::jsonb,'completed',now(),now())
        on conflict (job_type,work_key) do update set
          input=excluded.input,result=excluded.result,status='completed',completed_at=now(),
          applied_at=case when work_items.result is distinct from excluded.result then null else work_items.applied_at end,
          last_error=null,updated_at=now()
      `, [workKey, JSON.stringify({ mode, start_cursor: startCursor }), JSON.stringify({ mode, start_cursor: startCursor, end_cursor: page.endCursor, source_freshness_at: page.sourceFreshnessAt, rows: page.rows })]);
      pages += 1;
      rowCount += page.rows.length;
      cursor = page.endCursor;
      if (page.rows.length === 0 || cursor === startCursor || (mode === 'audit' && cursor === '0')) break;
    }
    await setJob(client, jobKey, { cursor, source_freshness_at: sourceFreshnessAt }, 'ready', null, true);
    return { mode, pages, rows: rowCount, cursor, skippedUnchangedSource: false };
  } catch (error) {
    await setJob(client, jobKey, { cursor, source_freshness_at: previousFreshness }, 'failed', String(error).slice(0,500), true).catch(() => {});
    throw error;
  }
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { sourceFreshnessAt } = await metadata();
  const append = await runMode(client, 'append', APPEND_PAGES, sourceFreshnessAt);
  const audit = await runMode(client, 'audit', AUDIT_PAGES, sourceFreshnessAt);
  console.log(JSON.stringify({ sourceFreshnessAt, append, audit }, null, 2));
} finally {
  await client.end().catch(() => {});
}
