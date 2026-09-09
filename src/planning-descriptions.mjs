import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');
const LIMIT = Math.max(1, Math.min(Number(process.env.DESCRIPTION_WORKER_LIMIT || 400), 400));
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const SOURCE_NAMES = {
  DUBLINCITY:'Dublin City Council', SOUTHDUBLIN:'South Dublin County Council', KILDARE:'Kildare County Council',
  GALWAYCOCO:'Galway County Council', GALWAYCITY:'Galway City Council', MEATH:'Meath County Council', WICKLOW:'Wicklow County Council',
  LIMERICK:'Limerick County Council', WATERFORD:'Waterford City and County Council', DONEGAL:'Donegal County Council',
  TIPPERARY:'Tipperary County Council', KERRY:'Kerry County Council', MAYO:'Mayo County Council', CLARE:'Clare County Council',
  LOUTH:'Louth County Council', LAOIS:'Laois County Council', KILKENNY:'Kilkenny County Council', OFFALY:'Offaly County Council',
  CAVAN:'Cavan County Council', ROSCOMMON:'Roscommon County Council', WESTMEATH:'Westmeath County Council', MONAGHAN:'Monaghan County Council',
  SLIGO:'Sligo County Council', CARLOW:'Carlow County Council', LONGFORD:'Longford County Council', LEITRIM:'Leitrim County Council'
};
const clean = (v) => String(v ?? '').replace(/\s+/g,' ').trim();
const esc = (v) => clean(v).replaceAll("'", "''");
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent':'Public records data worker' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const client = new Client({ connectionString, ssl:{ rejectUnauthorized:false } });
await client.connect();
let completed=0, failed=0;
try {
  const { rows } = await client.query(`select id,input from work_items where job_type='planning_description' and status='pending' and applied_at is null and available_at<=now() order by id limit $1`, [LIMIT]);
  const groups = new Map();
  for (const item of rows) {
    const code = item.input.local_authority_code;
    const list = groups.get(code) || [];
    list.push(item); groups.set(code,list);
  }
  for (const [code, items] of groups) {
    const sourceName = SOURCE_NAMES[code];
    if (!sourceName) {
      for (const item of items) {
        await client.query(`update work_items set status='failed',last_error='unsupported_authority',completed_at=now(),updated_at=now() where id=$1`,[item.id]); failed++;
      }
      continue;
    }
    for (let offset=0; offset<items.length; offset+=50) {
      const batch = items.slice(offset, offset+50);
      const refs = batch.map((x)=>`'${esc(x.input.reference)}'`).join(',');
      const ids = batch.map((x)=>Number(x.input.source_application_id)).filter(Number.isInteger);
      const clauses = [`PlanningAuthority = '${esc(sourceName)}' AND ApplicationNumber IN (${refs})`];
      if (ids.length) clauses.unshift(`OBJECTID IN (${ids.join(',')})`);
      try {
        const params = new URLSearchParams({ where:`(${clauses.join(') OR (')})`, outFields:'OBJECTID,ApplicationNumber,DevelopmentDescription', returnGeometry:'false', f:'json', resultRecordCount:'200' });
        const json = await fetchJson(`${ARC_QUERY}?${params}`);
        const byId = new Map(), byRef = new Map();
        for (const f of json.features || []) {
          const a=f.attributes||{}; const id=Number(a.OBJECTID); if(Number.isInteger(id)) byId.set(id,a); byRef.set(clean(a.ApplicationNumber),a);
        }
        for (const item of batch) {
          const sid=Number(item.input.source_application_id);
          const attrs=(Number.isInteger(sid)?byId.get(sid):null)||byRef.get(clean(item.input.reference));
          const result={ ok:true, proposal: clean(attrs?.DevelopmentDescription)||null, source:'national_arcgis' };
          await client.query(`update work_items set status='completed',result=$2::jsonb,completed_at=now(),last_error=null,updated_at=now() where id=$1`,[item.id,JSON.stringify(result)]); completed++;
        }
      } catch (error) {
        const msg=error instanceof Error?error.message:String(error);
        for (const item of batch) { await client.query(`update work_items set status='failed',last_error=$2,completed_at=now(),updated_at=now() where id=$1`,[item.id,msg.slice(0,500)]); failed++; }
      }
    }
  }
  console.log(JSON.stringify({ selected:rows.length, completed, failed },null,2));
  if (failed > Math.max(10, Math.floor(rows.length*0.1))) process.exitCode=1;
} finally { await client.end().catch(()=>{}); }
