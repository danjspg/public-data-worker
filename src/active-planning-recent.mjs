import pg from 'pg';
import { AGILE_AUTHORITIES, NATIONAL_SOURCE_NAMES, planningSourceForAuthority } from './planning-source-registry.mjs';
import { fetchEplanApplication, fetchEplanReceivedReferences } from './eplan-source.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.ACTIVE_RECENT_WORKER_LIMIT || 40), 100));
const RECENT_DAYS = Math.max(7, Math.min(Number(process.env.ACTIVE_RECENT_DAYS || 21), 42));
const SOURCE_POLICY_VERSION = 'first-party-v3';
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const AGILE_SEARCH = 'https://planningapi.agileapplications.ie/api/application/search';
const AGILE_DETAIL = 'https://planningapi.agileapplications.ie/api/application';
const RETRYABLE = new Set([408,425,429,500,502,503,504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const addDays = (date, days) => { const next = new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate()+days); return next.toISOString().slice(0,10); };
const esc = (value) => String(value ?? '').replaceAll("'", "''");
const normaliseReference = (value) => String(value || '').trim().replace(/\s+/g,'').toUpperCase();

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
  const sourceName=NATIONAL_SOURCE_NAMES[input.local_authority_code];
  if(!sourceName) throw new Error('unsupported_national_authority');
  const rows=[]; let offset=0;
  while(true){
    const where=[`PlanningAuthority = '${esc(sourceName)}'`,`ReceivedDate >= DATE '${input.from}'`,`ReceivedDate < DATE '${addDays(input.to,1)}'`].join(' AND ');
    const params=new URLSearchParams({where,outFields:'*',returnGeometry:'false',resultOffset:String(offset),resultRecordCount:'2000',orderByFields:'ReceivedDate DESC, ApplicationNumber DESC',f:'json'});
    const json=await fetchJson(`${ARC_QUERY}?${params}`);
    const page=(json.features||[]).map((f)=>f.attributes||{}); rows.push(...page);
    if(!json.exceededTransferLimit||page.length<2000)break; offset+=2000;
  }
  return rows;
}
function windows(from,to,size=7){const result=[];let cursor=from;while(cursor<=to){let end=addDays(cursor,size-1);if(end>to)end=to;result.push({from:cursor,to:end});cursor=addDays(end,1);}return result;}
async function mapConcurrent(items,limit,mapper){
  const output=new Array(items.length); let next=0;
  async function worker(){while(true){const i=next++;if(i>=items.length)return;output[i]=await mapper(items[i],i);}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));
  return output;
}
function needsAgileProposalDetail(row){
  const proposal=String(row?.proposal||'').replace(/\s+/g,' ').trim();
  if(!proposal)return true;
  // Agile search currently returns a short preview for many authorities (commonly
  // around 70-80 characters). Do not persist that preview as the authoritative
  // planning description. Short legitimate descriptions are cheap to verify too.
  return proposal.length<=140;
}
async function hydrateAgileProposal(row,headers){
  if(!needsAgileProposalDetail(row))return row;
  const id=Number(row?.id);
  if(!Number.isInteger(id))return row;
  try{
    const detail=await fetchJson(`${AGILE_DETAIL}/${id}`,headers);
    if(!detail||normaliseReference(detail.reference)!==normaliseReference(row.reference)){
      throw new Error('Agile detail reference mismatch');
    }
    const fullProposal=String(detail.fullProposal||'').replace(/\s+/g,' ').trim();
    const detailProposal=String(detail.proposal||'').replace(/\s+/g,' ').trim();
    return {
      ...row,
      ...detail,
      proposal:fullProposal||detailProposal||row.proposal||null,
      fullProposal:fullProposal||null,
      proposalHydratedFromDetail:Boolean(fullProposal),
    };
  }catch(error){
    return {
      ...row,
      proposalHydrationError:String(error instanceof Error?error.message:error).slice(0,300),
    };
  }
}
async function fetchAgile(input){
  const config=AGILE_AUTHORITIES[input.local_authority_code];
  if(!config) throw new Error('unsupported_agile_authority');
  const headers={'x-client':config.client,'x-product':'CITIZENPORTAL','x-service':'PA'};
  const byRef=new Map();
  for(const window of windows(input.from,input.to,7)){
    for(const status of ['registered','determined']){
      const params=new URLSearchParams({registrationDateFrom:`${window.from}T00:00:00Z`,registrationDateTo:`${window.to}T23:59:59Z`,status});
      const json=await fetchJson(`${AGILE_SEARCH}?${params}`,headers);
      for(const row of json.results||[]){if(row?.reference)byRef.set(String(row.reference).trim().toUpperCase(),row);}
    }
    // South Dublin exemption declarations (ED references) are omitted when the
    // Agile endpoint is filtered to registered/determined. A small unfiltered
    // request over the same seven-day window captures those rows without changing
    // discovery behaviour for the other Agile authorities.
    if(input.local_authority_code==='SOUTHDUBLIN'){
      const params=new URLSearchParams({registrationDateFrom:`${window.from}T00:00:00Z`,registrationDateTo:`${window.to}T23:59:59Z`});
      const json=await fetchJson(`${AGILE_SEARCH}?${params}`,headers);
      for(const row of json.results||[]){if(row?.reference)byRef.set(String(row.reference).trim().toUpperCase(),row);}
    }
  }
  return mapConcurrent([...byRef.values()],6,async(row)=>{const hydrated=await hydrateAgileProposal(row,headers);await sleep(50);return hydrated;});
}
async function fetchEplanRecent(input){
  const requestedDays=Math.max(7,Math.min(42,Math.ceil((new Date(`${input.to}T00:00:00Z`)-new Date(`${input.from}T00:00:00Z`))/86400000)+1));
  const listing=await fetchEplanReceivedReferences(input.local_authority_code,requestedDays);
  const details=await mapConcurrent(listing.references,4,async(ref)=>{const result=await fetchEplanApplication(input.local_authority_code,ref);await sleep(100);return result;});
  const rows=details.filter((row)=>row?.ok&&row.registration_date&&row.registration_date>=input.from&&row.registration_date<=input.to);
  return {rows, listing};
}
async function fetchPreferred(input){
  const preferred=planningSourceForAuthority(input.local_authority_code);
  if(!preferred)throw new Error('unsupported_planning_authority');
  try{
    if(preferred.family==='agile')return {rows:await fetchAgile(input),source_type:'agile',source_preferred:'agile',fallback:false};
    if(preferred.family==='eplan'){const found=await fetchEplanRecent(input);return {rows:found.rows,source_type:'eplan',source_preferred:'eplan',fallback:false,listing:found.listing};}
    return {rows:await fetchNational(input),source_type:'national',source_preferred:'national',fallback:false};
  }catch(error){
    if(preferred.family==='national')throw error;
    const rows=await fetchNational(input);
    return {rows,source_type:'national',source_preferred:preferred.family,fallback:true,fallback_reason:String(error instanceof Error?error.message:error).slice(0,500)};
  }
}

const client=new Client({connectionString,ssl:{rejectUnauthorized:false}});await client.connect();
let selected=0,completed=0,deferred=0,totalRows=0,firstParty=0,fallbacks=0,seeded=0,alreadySeeded=0;
const bySource={agile:0,eplan:0,national:0};
const rowsBySource={agile:0,eplan:0,national:0};
const fallbackAuthorities=[];
const authorityStats=[];
try{
  // Recent discovery is worker-owned. Production no longer needs to tell the worker
  // which authority/source to inspect; the public registry is the source of truth.
  const today=new Date().toISOString().slice(0,10);
  const from=addDays(today,-(RECENT_DAYS-1));
  for(const authority of Object.keys(NATIONAL_SOURCE_NAMES)){
    const input={local_authority_code:authority,from,to:today,queued_for_date:today,source_policy:'first-party-preferred',source_policy_version:SOURCE_POLICY_VERSION};
    const inserted=await client.query(`
      insert into work_items(job_type,work_key,input,status,available_at,updated_at)
      values('active_planning_recent_range',$1,$2::jsonb,'pending',now(),now())
      on conflict(job_type,work_key) do nothing
      returning id
    `,[`${authority}:${today}:${SOURCE_POLICY_VERSION}`,JSON.stringify(input)]);
    if(inserted.rowCount)seeded++;else alreadySeeded++;
  }

  const {rows}=await client.query(`select id,input from work_items where job_type='active_planning_recent_range' and status='pending' and applied_at is null and available_at<=now() order by id desc limit $1`,[LIMIT]);
  selected=rows.length;
  for(const item of rows){
    try{
      const fetched=await fetchPreferred(item.input);
      const result={ok:true,rows:fetched.rows,row_count:fetched.rows.length,source_type:fetched.source_type,source_preferred:fetched.source_preferred,fallback:fetched.fallback,fallback_reason:fetched.fallback_reason||null,listing:fetched.listing||null,checked_at:new Date().toISOString(),source_policy_version:SOURCE_POLICY_VERSION};
      await client.query(`update work_items set status='completed',result=$2::jsonb,completed_at=now(),attempts=attempts+1,last_error=null,updated_at=now() where id=$1`,[item.id,JSON.stringify(result)]);
      completed++;totalRows+=fetched.rows.length;
      bySource[fetched.source_type]=(bySource[fetched.source_type]||0)+1;
      rowsBySource[fetched.source_type]=(rowsBySource[fetched.source_type]||0)+fetched.rows.length;
      if(fetched.source_type!=='national')firstParty++;
      if(fetched.fallback){fallbacks++;fallbackAuthorities.push({authority:item.input.local_authority_code,preferred:fetched.source_preferred,reason:fetched.fallback_reason});}
      authorityStats.push({authority:item.input.local_authority_code,source:fetched.source_type,preferred:fetched.source_preferred,fallback:fetched.fallback,rows:fetched.rows.length,listing_refs:fetched.listing?.references?.length??null,pages_checked:fetched.listing?.pages_checked??null});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await client.query(`update work_items set attempts=attempts+1,last_error=$2,available_at=now()+interval '30 minutes',updated_at=now() where id=$1`,[item.id,message.slice(0,500)]);
      deferred++;
      authorityStats.push({authority:item.input.local_authority_code,source:null,error:message.slice(0,200)});
    }
  }
  console.log(JSON.stringify({seeded,alreadySeeded,selected,completed,deferred,totalRows,firstParty,fallbacks,bySource,rowsBySource,fallbackAuthorities,authorityStats},null,2));
}finally{await client.end().catch(()=>{});}
