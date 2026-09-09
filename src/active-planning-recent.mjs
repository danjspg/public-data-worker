import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.ACTIVE_RECENT_WORKER_LIMIT || 40), 100));
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const AGILE_SEARCH = 'https://planningapi.agileapplications.ie/api/application/search';
const RETRYABLE = new Set([408,425,429,500,502,503,504]);
const SOURCE_NAMES = {
  DUBLINCITY:'Dublin City Council', FINGAL:'Fingal County Council', SOUTHDUBLIN:'South Dublin County Council', DLR:'Dun Laoghaire Rathdown County Council',
  KILDARE:'Kildare County Council', GALWAYCOCO:'Galway County Council', GALWAYCITY:'Galway City Council', MEATH:'Meath County Council', WICKLOW:'Wicklow County Council',
  LIMERICK:'Limerick County Council', WATERFORD:'Waterford City and County Council', DONEGAL:'Donegal County Council', TIPPERARY:'Tipperary County Council',
  KERRY:'Kerry County Council', MAYO:'Mayo County Council', CLARE:'Clare County Council', LOUTH:'Louth County Council', LAOIS:'Laois County Council',
  KILKENNY:'Kilkenny County Council', OFFALY:'Offaly County Council', CAVAN:'Cavan County Council', ROSCOMMON:'Roscommon County Council', WESTMEATH:'Westmeath County Council',
  MONAGHAN:'Monaghan County Council', SLIGO:'Sligo County Council', CARLOW:'Carlow County Council', LONGFORD:'Longford County Council', LEITRIM:'Leitrim County Council'
};
const AGILE = {
  CORKCOCO:{ client:'CORKCOCO' }, CORKCITY:{ client:'CORKCITY' }, WEXFORD:{ client:'WEXFORD' }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const addDays = (date, days) => { const next = new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+days); return next.toISOString().slice(0,10); };
const esc = (value) => String(value ?? '').replaceAll("'", "''");
async function fetchJson(url, headers={}) {
  let lastError;
  for (let attempt=1; attempt<=5; attempt++) {
    try {
      const response=await fetch(url,{headers:{'User-Agent':'Public records data worker',...headers},signal:AbortSignal.timeout(30000)});
      if(response.ok){const json=await response.json();if(json?.error)throw new Error(json.error.message||JSON.stringify(json.error));return json;}
      lastError=new Error(`HTTP ${response.status}`);
      if(!RETRYABLE.has(response.status))break;
      const retryAfter=Number(response.headers.get('retry-after'));
      if(Number.isFinite(retryAfter)&&retryAfter>0) await sleep(Math.min(retryAfter*1000,30000));
    } catch(error){lastError=error;}
    if(attempt<5) await sleep(attempt*1000);
  }
  throw lastError||new Error('request failed');
}

async function fetchNational(input){
  const sourceName=SOURCE_NAMES[input.local_authority_code];
  if(!sourceName) throw new Error('unsupported_national_authority');
  const rows=[]; let offset=0;
  while(true){
    const where=[`PlanningAuthority = '${esc(sourceName)}'`,`ReceivedDate >= DATE '${input.from}'`,`ReceivedDate < DATE '${addDays(input.to,1)}'`].join(' AND ');
    const params=new URLSearchParams({where,outFields:'*',returnGeometry:'false',resultOffset:String(offset),resultRecordCount:'2000',orderByFields:'ReceivedDate DESC, ApplicationNumber DESC',f:'json'});
    const json=await fetchJson(`${ARC_QUERY}?${params}`);
    const page=(json.features||[]).map((f)=>f.attributes||{});
    rows.push(...page);
    if(!json.exceededTransferLimit||page.length<2000)break;
    offset+=2000;
  }
  return rows;
}

function windows(from,to,size=7){const result=[];let cursor=from;while(cursor<=to){let end=addDays(cursor,size-1);if(end>to)end=to;result.push({from:cursor,to:end});cursor=addDays(end,1);}return result;}
async function fetchAgile(input){
  const config=AGILE[input.local_authority_code];
  if(!config) throw new Error('unsupported_agile_authority');
  const headers={'x-client':config.client,'x-product':'CITIZENPORTAL','x-service':'PA'};
  const byRef=new Map();
  for(const window of windows(input.from,input.to,7)){
    for(const status of ['registered','determined']){
      const params=new URLSearchParams({registrationDateFrom:`${window.from}T00:00:00Z`,registrationDateTo:`${window.to}T23:59:59Z`,status});
      const json=await fetchJson(`${AGILE_SEARCH}?${params}`,headers);
      for(const row of json.results||[]){if(row?.reference)byRef.set(String(row.reference).trim().toUpperCase(),row);}
    }
  }
  return [...byRef.values()];
}

const client=new Client({connectionString,ssl:{rejectUnauthorized:false}});await client.connect();
let selected=0,completed=0,deferred=0,totalRows=0;
try{
  const {rows}=await client.query(`select id,input from work_items where job_type='active_planning_recent_range' and status='pending' and applied_at is null and available_at<=now() order by id limit $1`,[LIMIT]);
  selected=rows.length;
  for(const item of rows){
    try{
      const sourceRows=item.input.source_type==='agile'?await fetchAgile(item.input):await fetchNational(item.input);
      await client.query(`update work_items set status='completed',result=$2::jsonb,completed_at=now(),attempts=attempts+1,last_error=null,updated_at=now() where id=$1`,[item.id,JSON.stringify({ok:true,rows:sourceRows,row_count:sourceRows.length})]);
      completed++; totalRows+=sourceRows.length;
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await client.query(`update work_items set attempts=attempts+1,last_error=$2,available_at=now()+interval '30 minutes',updated_at=now() where id=$1`,[item.id,message.slice(0,500)]);
      deferred++;
    }
  }
  console.log(JSON.stringify({selected,completed,deferred,totalRows},null,2));
}finally{await client.end().catch(()=>{});}
