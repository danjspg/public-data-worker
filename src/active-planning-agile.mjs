import pg from 'pg';
import { activeAgileSignature } from './meaningful-source-signature.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.ACTIVE_AGILE_WORKER_LIMIT || 1000), 5000));
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.ACTIVE_AGILE_CONCURRENCY || 6), 8));
const TIME_BUDGET_MS = Math.max(60_000, Number(process.env.ACTIVE_AGILE_TIME_BUDGET_MS || 50 * 60 * 1000));
const startedAt = Date.now();
const DETAIL_URL = 'https://planningapi.agileapplications.ie/api/application';
const SEARCH_URL = 'https://planningapi.agileapplications.ie/api/application/search';
const RETRYABLE = new Set([408,425,429,500,502,503,504]);
const CONFIG = {
  CORKCOCO: { client: 'CORKCOCO', tenant: 'corkcoco', detailIdFromSourceUrl: false },
  CORKCITY: { client: 'CORKCITY', tenant: 'corkcity', detailIdFromSourceUrl: false },
  DUBLINCITY: { client: 'DCC', tenant: 'dublincity', detailIdFromSourceUrl: false },
  DLR: { client: 'DLR', tenant: 'dunlaoghaire', detailIdFromSourceUrl: false },
  FINGAL: { client: 'FG', tenant: 'fingal', detailIdFromSourceUrl: false },
  SOUTHDUBLIN: { client: 'SD', tenant: 'southdublin', detailIdFromSourceUrl: false },
  WEXFORD: { client: 'WEXFORD', tenant: 'wexford', detailIdFromSourceUrl: true },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normaliseReference = (value) => String(value || '').trim().replace(/\s+/g,'').toUpperCase();
const headersFor = (config) => ({
  'User-Agent': 'Public records data worker',
  'x-client': config.client,
  'x-product': 'CITIZENPORTAL',
  'x-service': 'PA',
});
function sourceDetailId(input, config) {
  if (config.detailIdFromSourceUrl) {
    const match = String(input.source_url || '').match(/\/application-details\/(\d+)/);
    if (match) return Number(match[1]);
  }
  const sourceId = Number(input.source_application_id);
  return Number.isInteger(sourceId) ? sourceId : null;
}
function sourceIdTrusted(input, config) {
  const sourceUrl=String(input.source_url||'').toLowerCase();
  return sourceUrl.includes(`planning.agileapplications.ie/${config.tenant}/`) || sourceUrl.includes('planningapi.agileapplications.ie/');
}
async function fetchJson(url,config){
  let lastError;
  for(let attempt=1;attempt<=5;attempt++){
    try{
      const response=await fetch(url,{headers:headersFor(config),signal:AbortSignal.timeout(30000)});
      if(response.ok)return await response.json();
      if(response.status===404)return null;
      lastError=new Error(`HTTP ${response.status}`);
      if(!RETRYABLE.has(response.status))break;
    }catch(error){lastError=error;}
    if(attempt<5)await sleep(attempt*1000);
  }
  throw lastError||new Error('Agile request failed');
}
async function fetchDetailById(id,config){
  if(!Number.isInteger(id))return null;
  return fetchJson(`${DETAIL_URL}/${id}`,config);
}
async function resolveReference(input,config){
  const expected=normaliseReference(input.reference);
  if(!expected)return null;
  const params=new URLSearchParams({query:String(input.reference).trim()});
  const data=await fetchJson(`${SEARCH_URL}?${params}`,config);
  const match=(data?.results||[]).find((row)=>normaliseReference(row?.reference)===expected);
  return Number.isInteger(match?.id)?{id:match.id,search:match}:null;
}
async function fetchDetail(input, config) {
  const expected=normaliseReference(input.reference);
  const candidateId=sourceDetailId(input,config);
  let resolvedBy='source_id';
  let id=candidateId;
  if(!id || !sourceIdTrusted(input,config)){
    const resolved=await resolveReference(input,config);
    if(!resolved)return {found:false,reason:'reference_not_found',detail_id:null,resolved_by:'reference'};
    id=resolved.id;resolvedBy='reference';
  }
  let detail=await fetchDetailById(id,config);
  if(detail && normaliseReference(detail.reference)===expected){
    return {found:true,detail_id:id,detail,resolved_by:resolvedBy,source_id_changed:candidateId!==id};
  }
  const resolved=await resolveReference(input,config);
  if(!resolved)return {found:false,reason:detail?'reference_mismatch':'not_found',detail_id:id,resolved_by:resolvedBy};
  detail=await fetchDetailById(resolved.id,config);
  if(!detail || normaliseReference(detail.reference)!==expected){
    return {found:false,reason:'reference_mismatch',detail_id:resolved.id,resolved_by:'reference'};
  }
  return {found:true,detail_id:resolved.id,detail,resolved_by:'reference',source_id_changed:candidateId!==resolved.id};
}

async function prepareItem(item) {
  const config = CONFIG[item.input.local_authority_code];
  if (!config) return { item, unsupported: true };
  try {
    const result = await fetchDetail(item.input, config);
    const baseResult={ ok:true, ...result };
    const sourceSignature=activeAgileSignature(baseResult);
    const previousSignature=item.previous_source_signature || null;
    const hasBaseline=Boolean(previousSignature);
    return {
      item, result, baseResult, sourceSignature,
      baselineMissing:Boolean(result.found && sourceSignature && !hasBaseline),
      changeDetected:Boolean(result.found && sourceSignature && hasBaseline && sourceSignature!==previousSignature),
      nothingToApply:Boolean(!result.found || (sourceSignature && hasBaseline && sourceSignature===previousSignature)),
      checkedAt:new Date().toISOString(),
    };
  } catch (error) {
    return { item, error };
  }
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let selected = 0, completed = 0, missing = 0, deferred = 0, resolvedByReference=0, remappedIds=0;
let stoppedForTimeBudget = false;
try {
  const { rows } = await client.query(`
    select i.id,i.input,i.attempts,
           case when s.metadata->>'signature_version'='agile-v2'
                then coalesce(s.metadata->>'last_seen_source_signature',s.last_applied_signature)
                else null end as previous_source_signature
    from work_items i
    left join source_sync_state s
      on s.job_family='active_planning_agile_detail'
     and s.application_key=i.input->>'application_id'
    where i.job_type='active_planning_agile_detail'
      and i.status='pending'
      and i.applied_at is null
      and i.available_at <= now()
    order by i.id
    limit $1
  `, [LIMIT]);
  selected = rows.length;

  for (let offset=0; offset<rows.length; offset+=CONCURRENCY) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      stoppedForTimeBudget = true;
      break;
    }
    const prepared = await Promise.all(rows.slice(offset,offset+CONCURRENCY).map(prepareItem));
    for (const work of prepared) {
      const item=work.item;
      if(work.unsupported){
        await client.query(`update work_items set status='failed',last_error='unsupported_agile_authority',completed_at=now(),updated_at=now() where id=$1`,[item.id]);
        deferred += 1;
        continue;
      }
      if(work.error){
        const message=work.error instanceof Error?work.error.message:String(work.error);
        await client.query(`update work_items set attempts=attempts+1,last_error=$2,available_at=now()+interval '30 minutes',updated_at=now() where id=$1`,[item.id,message.slice(0,500)]);
        deferred += 1;
        continue;
      }
      const {result,baseResult,sourceSignature,baselineMissing,changeDetected,nothingToApply,checkedAt}=work;
      // Retry transient source absences once within the same daily work item.
      // Do not retry reference mismatches: those need investigation, not repeated requests.
      if (!result.found && ['reference_not_found','not_found'].includes(result.reason) && Number(item.attempts || 0) < 1) {
        await client.query(`update work_items set attempts=attempts+1,last_error=$2,available_at=now()+interval '30 minutes',updated_at=now() where id=$1`,[item.id,`source_temporarily_unavailable:${result.reason}`]);
        deferred += 1;
        continue;
      }
      if(result.resolved_by==='reference')resolvedByReference++;
      if(result.source_id_changed)remappedIds++;
      await client.query('begin');
      try {
        await client.query(`
          update work_items
          set status='completed', result=$2::jsonb,
              applied_at=case when $3 then now() else null end,
              completed_at=now(), last_error=null, attempts=attempts+1, updated_at=now()
          where id=$1
        `,[item.id,JSON.stringify({...baseResult,source_signature:sourceSignature,change_detected:changeDetected,baseline_missing:baselineMissing,requires_prod_baseline_validation:baselineMissing,checked_at:checkedAt}),nothingToApply]);
        await client.query(`
          insert into source_sync_state(job_family,application_key,last_checked_at,last_seen_change_at,metadata,updated_at)
          values(
            'active_planning_agile_detail',$1,$2::timestamptz,
            case when $3 then $2::timestamptz else null::timestamptz end,
            case when $4::text is null
                 then jsonb_build_object('last_source_status','missing','last_source_error',coalesce($6::text,'source_not_found'))
                 else jsonb_build_object('signature_version','agile-v2','last_seen_source_signature',$4::text,'last_source_status','found','last_source_error',null,'resolved_detail_id',$7::bigint,'resolved_by',$8::text)
                      || case when $5 then jsonb_build_object('baseline_missing',true,'pending_prod_change',false)
                              when $3 then jsonb_build_object('baseline_missing',false,'pending_prod_change',true)
                              else '{}'::jsonb end
            end,now()
          )
          on conflict(job_family,application_key) do update
          set last_checked_at=excluded.last_checked_at,
              last_seen_change_at=case when $3 then excluded.last_checked_at else source_sync_state.last_seen_change_at end,
              metadata=coalesce(source_sync_state.metadata,'{}'::jsonb)||excluded.metadata,
              updated_at=now()
        `,[String(item.input.application_id),checkedAt,changeDetected,sourceSignature,baselineMissing,result.reason||null,result.detail_id||null,result.resolved_by||null]);
        await client.query('commit');
      } catch (stateError) {
        await client.query('rollback').catch(()=>{});
        throw stateError;
      }
      if(result.found)completed += 1; else missing += 1;
    }
    if(offset+CONCURRENCY<rows.length)await sleep(150);
  }
  console.log(JSON.stringify({ selected, completed, missing, deferred, resolvedByReference, remappedIds, concurrency:CONCURRENCY, timeBudgetMs:TIME_BUDGET_MS, stoppedForTimeBudget }, null, 2));
} finally {
  await client.end().catch(() => {});
}
