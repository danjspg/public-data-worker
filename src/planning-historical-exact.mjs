import pg from 'pg';
import { deferOrDeadLetter, recordSourceOutcome, readSourcePolicy, sleep, storeSourceFingerprint } from './worker-platform.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');
const LIMIT = Math.max(1, Math.min(Number(process.env.HISTORICAL_EXACT_LIMIT || 500), 2000));
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const clean = (v) => String(v ?? '').trim().replace(/\s+/g,' ');
const esc = (v) => clean(v).replaceAll("'", "''");

async function fetchOne(item) {
  const authority = String(item.input.local_authority_code || '').toUpperCase();
  const sourceId = Number(item.input.source_application_id);
  const reference = clean(item.input.reference);
  const where = Number.isInteger(sourceId) ? `OBJECTID=${sourceId}` : `ApplicationNumber='${esc(reference)}'`;
  const params = new URLSearchParams({where,outFields:'*',returnGeometry:'false',resultRecordCount:'3',f:'json'});
  const policy = await readSourcePolicy(client,'arcgis_planning',authority,150);
  if (policy.delayMs > 150) await sleep(policy.delayMs);
  const started = Date.now();
  const response = await fetch(`${ARC_QUERY}?${params}`, {headers:{'User-Agent':'Public records data worker'},signal:AbortSignal.timeout(30000)});
  const latencyMs = Date.now()-started;
  if (!response.ok) {
    await recordSourceOutcome(client,{sourceFamily:'arcgis_planning',authority,ok:false,reason:`http_${response.status}`,latencyMs});
    const e = new Error(`http_${response.status}`); e.reason=`http_${response.status}`; throw e;
  }
  const json = await response.json();
  if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
  await recordSourceOutcome(client,{sourceFamily:'arcgis_planning',authority,ok:true,latencyMs});
  const attrs = (json.features || []).map((f)=>f.attributes||{}).find((a)=>!reference || clean(a.ApplicationNumber).toUpperCase()===reference.toUpperCase()) || (json.features?.[0]?.attributes ?? null);
  if (!attrs) return {ok:true,found:false};
  await storeSourceFingerprint(client,`planning-record:${authority}:${reference || sourceId}`,attrs,{authority,reference,source_application_id:sourceId||null});
  return {ok:true,found:true,attributes:attrs};
}

const client = new Client({connectionString,ssl:{rejectUnauthorized:false}}); await client.connect();
let selected=0,completed=0,missing=0,deferred=0,deadLettered=0;
try {
  const {rows}=await client.query(`select id,input,attempts from work_items where job_type='planning_historical_exact' and status='pending' and applied_at is null and available_at<=now() order by id limit $1`,[LIMIT]);
  selected=rows.length;
  for (const item of rows) {
    await client.query("update work_items set status='running',leased_at=now(),attempts=attempts+1,updated_at=now() where id=$1",[item.id]);
    item.attempts = Number(item.attempts||0)+1;
    try {
      const result=await fetchOne(item);
      await client.query("update work_items set status='completed',result=$2::jsonb,completed_at=now(),last_error=null,updated_at=now() where id=$1",[item.id,JSON.stringify(result)]);
      if(result.found) completed++; else missing++;
    } catch(error) {
      const out=await deferOrDeadLetter(client,item,error,{maxAttempts:8,baseMinutes:5});
      if(out.deadLettered) deadLettered++; else deferred++;
    }
  }
  console.log(JSON.stringify({selected,completed,missing,deferred,deadLettered},null,2));
} finally { await client.end().catch(()=>{}); }
