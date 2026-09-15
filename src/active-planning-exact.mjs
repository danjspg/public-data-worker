import pg from 'pg';
import { activeExactSignature } from './meaningful-source-signature.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.ACTIVE_PLANNING_WORKER_LIMIT || 500), 5000));
const BATCH_SIZE = Math.max(1, Math.min(Number(process.env.ACTIVE_PLANNING_SOURCE_BATCH || 150), 200));
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const RETRYABLE = new Set([408,425,429,500,502,503,504]);

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clean(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function escapeSql(value) { return clean(value).replaceAll("'", "''"); }
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

async function fetchByReferences(items) {
  const refs = [...new Set(items.map((item) => clean(item.input.reference)).filter(Boolean))];
  if (!refs.length) return new Map();
  const where = refs.map((ref) => `ApplicationNumber='${escapeSql(ref)}'`).join(' OR ');
  const params = new URLSearchParams({
    where,
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
    resultRecordCount: String(Math.max(200, refs.length * 3)),
  });
  const json = await fetchJson(`${ARC_QUERY}?${params.toString()}`);
  const byRef = new Map();
  for (const feature of json.features || []) {
    const attrs = feature.attributes || {};
    const ref = clean(attrs.ApplicationNumber).toUpperCase();
    if (ref && !byRef.has(ref)) byRef.set(ref, attrs);
  }
  return byRef;
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let selected = 0, completed = 0, referenceFallback = 0, missing = 0, failed = 0;
try {
  const { rows } = await client.query(`
    select i.id, i.input,
           s.last_applied_signature
    from work_items i
    left join source_sync_state s
      on s.job_family='active_planning_exact'
     and s.application_key=i.input->>'application_id'
    where i.job_type='active_planning_exact'
      and i.status='pending'
      and i.applied_at is null
      and i.available_at <= now()
    order by i.id
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
      const unresolved = batch.filter((item) => {
        const attrs=byId.get(Number(item.input.source_application_id));
        if(!attrs)return true;
        return clean(attrs.ApplicationNumber).toUpperCase() !== clean(item.input.reference).toUpperCase();
      });
      const byRef = unresolved.length ? await fetchByReferences(unresolved) : new Map();
      for (const item of batch) {
        const sourceId = Number(item.input.source_application_id);
        let attrs = byId.get(sourceId);
        let matchedBy = 'objectid';
        if (attrs && clean(attrs.ApplicationNumber).toUpperCase() !== clean(item.input.reference).toUpperCase()) {
          attrs = null;
        }
        if (!attrs) {
          attrs = byRef.get(clean(item.input.reference).toUpperCase());
          matchedBy = 'reference';
        }
        if (!attrs) {
          await client.query(`
            update work_items
            set status='completed',
                result=$2::jsonb,
                applied_at=now(),
                completed_at=now(),
                last_error=null,
                updated_at=now()
            where id=$1
          `, [item.id, JSON.stringify({
            ok:true, found:false, source_application_id:sourceId,
            change_detected:false, checked_at:new Date().toISOString()
          })]);
          missing += 1;
          continue;
        }
        const baseResult={ ok:true, found:true, matched_by:matchedBy, attributes:attrs };
        const sourceSignature=activeExactSignature(baseResult);
        const previousSignature=item.last_applied_signature || null;
        const unchanged=Boolean(sourceSignature && previousSignature && sourceSignature===previousSignature);
        const checkedAt=new Date().toISOString();
        await client.query(`
          update work_items
          set status='completed',
              result=$2::jsonb,
              applied_at=case when $3 then now() else null end,
              completed_at=now(),
              last_error=null,
              updated_at=now()
          where id=$1
        `, [item.id, JSON.stringify({
          ...baseResult,
          source_signature:sourceSignature,
          change_detected:!unchanged,
          checked_at:checkedAt
        }), unchanged]);
        await client.query(`
          insert into source_sync_state(job_family,application_key,last_checked_at,last_seen_change_at,metadata,updated_at)
          values('active_planning_exact',$1,$2,case when $3 then $2 else null end,'{}'::jsonb,now())
          on conflict(job_family,application_key) do update
          set last_checked_at=excluded.last_checked_at,
              last_seen_change_at=case when $3 then excluded.last_checked_at else source_sync_state.last_seen_change_at end,
              updated_at=now()
        `,[String(item.input.application_id),checkedAt,!unchanged]);
        completed += 1;
        if (matchedBy === 'reference') referenceFallback += 1;
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

  console.log(JSON.stringify({ selected, completed, referenceFallback, missing, deferred: failed }, null, 2));
} finally {
  await client.end().catch(() => {});
}
