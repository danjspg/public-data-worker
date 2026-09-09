import pg from 'pg';
import { getCampaignCursor, saveCampaignCursor, storeSourceFingerprint, recordSourceOutcome } from './worker-platform.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const AUTHORITY = String(process.env.HISTORICAL_DISCOVERY_AUTHORITY || '').toUpperCase();
const START_MONTH = process.env.HISTORICAL_DISCOVERY_START || '2016-12';
const MIN_MONTH = process.env.HISTORICAL_DISCOVERY_MIN || '2012-01';
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const SOURCE_NAMES = {
  CORKCOCO:'Cork County Council', CORKCITY:'Cork City Council', DUBLINCITY:'Dublin City Council', FINGAL:'Fingal County Council', SOUTHDUBLIN:'South Dublin County Council', DLR:'Dun Laoghaire Rathdown County Council',
  KILDARE:'Kildare County Council', GALWAYCOCO:'Galway County Council', GALWAYCITY:'Galway City Council', MEATH:'Meath County Council', WICKLOW:'Wicklow County Council', LIMERICK:'Limerick County Council', WATERFORD:'Waterford City and County Council', DONEGAL:'Donegal County Council', WEXFORD:'Wexford County Council', TIPPERARY:'Tipperary County Council', KERRY:'Kerry County Council', MAYO:'Mayo County Council', CLARE:'Clare County Council', LOUTH:'Louth County Council', LAOIS:'Laois County Council', KILKENNY:'Kilkenny County Council', OFFALY:'Offaly County Council', CAVAN:'Cavan County Council', ROSCOMMON:'Roscommon County Council', WESTMEATH:'Westmeath County Council', MONAGHAN:'Monaghan County Council', SLIGO:'Sligo County Council', CARLOW:'Carlow County Council', LONGFORD:'Longford County Council', LEITRIM:'Leitrim County Council'
};
if (!SOURCE_NAMES[AUTHORITY]) throw new Error(`Unsupported HISTORICAL_DISCOVERY_AUTHORITY ${AUTHORITY}`);

const esc = (value) => String(value ?? '').replaceAll("'", "''");
function monthBounds(month) {
  const [year, m] = month.split('-').map(Number);
  const from = `${year}-${String(m).padStart(2,'0')}-01`;
  const next = new Date(Date.UTC(year, m, 1));
  return { from, toExclusive: next.toISOString().slice(0,10) };
}
function previousMonth(month) {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}
function liteRow(attrs) {
  return {
    source_application_id: Number.isInteger(Number(attrs.OBJECTID)) ? Number(attrs.OBJECTID) : null,
    reference: String(attrs.ApplicationNumber || '').trim() || null,
    received_date: attrs.ReceivedDate ?? null,
  };
}
async function fetchMonth(month) {
  const { from, toExclusive } = monthBounds(month);
  const where = `PlanningAuthority='${esc(SOURCE_NAMES[AUTHORITY])}' AND ReceivedDate >= DATE '${from}' AND ReceivedDate < DATE '${toExclusive}'`;
  const rows = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({ where, outFields:'OBJECTID,ApplicationNumber,ReceivedDate', returnGeometry:'false', resultOffset:String(offset), resultRecordCount:'2000', orderByFields:'ReceivedDate ASC,OBJECTID ASC', f:'json' });
    const started = Date.now();
    const response = await fetch(`${ARC_QUERY}?${params}`, { headers:{'User-Agent':'Public records data worker'}, signal:AbortSignal.timeout(30000) });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      await recordSourceOutcome(client,{sourceFamily:'arcgis_planning',authority:AUTHORITY,ok:false,reason:`http_${response.status}`,latencyMs});
      throw new Error(`HTTP ${response.status}`);
    }
    const json = await response.json();
    if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
    await recordSourceOutcome(client,{sourceFamily:'arcgis_planning',authority:AUTHORITY,ok:true,latencyMs});
    const page = (json.features || []).map((f) => liteRow(f.attributes || {})).filter((r) => r.reference);
    rows.push(...page);
    if (!json.exceededTransferLimit || page.length < 2000) break;
    offset += 2000;
  }
  return rows;
}

const client = new Client({ connectionString, ssl:{rejectUnauthorized:false} });
await client.connect();
try {
  const jobKey = `historical-planning-discovery:${AUTHORITY}`;
  const cursor = await getCampaignCursor(client, jobKey, { month: START_MONTH, complete:false });
  if (cursor.complete) {
    console.log(JSON.stringify({ authority:AUTHORITY, complete:true, month:cursor.month || null }, null, 2));
    process.exit(0);
  }
  const month = cursor.month || START_MONTH;
  if (month < MIN_MONTH) {
    await saveCampaignCursor(client, jobKey, { month, complete:true }, 'complete');
    console.log(JSON.stringify({ authority:AUTHORITY, complete:true, month }, null, 2));
    process.exit(0);
  }

  const rows = await fetchMonth(month);
  const fingerprintPayload = rows.map((r) => [r.source_application_id, r.reference, r.received_date]);
  const fp = await storeSourceFingerprint(client, `planning-month:${AUTHORITY}:${month}`, fingerprintPayload, { authority:AUTHORITY, month, row_count:rows.length });
  const workKey = `${AUTHORITY}:${month}:${fp.fingerprint.slice(0,16)}`;
  await client.query(`
    insert into work_items(job_type,work_key,input,result,status,attempts,available_at,completed_at,updated_at)
    values('planning_historical_discovery',$1,$2::jsonb,$3::jsonb,'completed',1,now(),now(),now())
    on conflict(job_type,work_key) do nothing
  `,[workKey,JSON.stringify({local_authority_code:AUTHORITY,month,source_type:'national'}),JSON.stringify({ok:true,rows,row_count:rows.length,fingerprint:fp.fingerprint})]);

  const next = previousMonth(month);
  await saveCampaignCursor(client, jobKey, { month: next, complete: next < MIN_MONTH }, next < MIN_MONTH ? 'complete' : 'ok');
  console.log(JSON.stringify({ authority:AUTHORITY, month, rows:rows.length, sourceChanged:fp.changed, nextMonth:next, complete:next < MIN_MONTH }, null, 2));
} catch (error) {
  const jobKey = `historical-planning-discovery:${AUTHORITY}`;
  await saveCampaignCursor(client, jobKey, await getCampaignCursor(client, jobKey, {month:START_MONTH,complete:false}), 'error', error);
  throw error;
} finally {
  await client.end().catch(()=>{});
}
