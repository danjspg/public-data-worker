import pg from 'pg';
import { fetchEplanApplication } from './eplan-source.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.EPLAN_WORKER_LIMIT || 12000), 12000));
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.EPLAN_WORKER_CONCURRENCY || 6), 8));
const PACE_MS = Math.max(100, Number(process.env.EPLAN_WORKER_PACE_MS || 250));
const TIME_BUDGET_MS = Math.max(60_000, Number(process.env.EPLAN_WORKER_TIME_BUDGET_MS || 70 * 60 * 1000));
const startedAt = Date.now();
const TRACKED_FIELDS = [
  'status','decision_text','valid_date','decision_date','decision_due_date','final_grant_date',
  'further_information_requested_date','further_information_received_date','withdrawal_date',
  'appeal_lodged_date','appeal_decision_date','expiry_date'
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function comparable(value){return value===undefined||value===null||value===''?null:String(value).trim();}
function statusComparable(value){
  const comparableValue=comparable(value);
  return comparableValue===null?null:comparableValue.normalize('NFKC').toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
}
function lifecycleDelta(input,result){
  const delta={};
  for(const field of TRACKED_FIELDS){
    const incoming=field==='status'?statusComparable(result?.[field]):comparable(result?.[field]);
    const existing=field==='status'?statusComparable(input?.[field]):comparable(input?.[field]);
    if(incoming!==null&&incoming!==existing)delta[field]=result[field];
  }
  return delta;
}
function normaliseSourceStatus(value){
  const key=statusComparable(value);
  if(!key)return 'unknown';
  if(['pre validation','pre reg','unregistered application','validation'].includes(key))return 'pre_validation';
  if(['new application','new application set up','registered','registered application','application registered','registration','complete application','valid'].includes(key))return 'registered';
  if(['officer allocation','referral','consultee referral','assessment period','planner assignment','planner assessment','planners report','recommendation review','recommended decision','recommended decision entered','managers order','publication required','provisional recommendation','application under review','application under consideration','awaiting recommendation'].includes(key))return 'under_assessment';
  if(['further information','further information requested','additional information','additional information requested','request additional information','ai requested','decision request a.i.','request ai approval','ai request approved','significant ai requested','clarification of ai requested','cai requested','additional information approval required','ai referral','cai consultees','sai referral','sai consultees'].includes(key))return 'further_information_requested';
  if(['further information received','additional information received','ai received','cai received','ai not significant'].includes(key))return 'further_information_received';
  if(['decision','decision made','decided','decided...','decision notice issued','decision issued','decision following a.i.','decision review','refused','refused application','permission refused','refuse permission','granted','grant','permission granted','grant permission','conditional','conditionally granted','granted (conditional)','granted (unconditional)'].includes(key))return 'decision_made';
  if(['final grant','final grant review'].includes(key))return 'final_grant';
  if(['appealed','appeal lodged','application appealed','application under appeal','appealed financial','decision appealed','leave to appeal','planner rpt to abp','planners report to acp','appeal report sent to abp','appeal comments due','file to acp'].includes(key))return 'appealed';
  if(key==='appeal decided')return 'appeal_decided';
  if(['withdrawn','application withdrawn','withdraw application','declare application withdrawn','declared withdrawn','planning application withdrawn','deemed withdrawal','deemed withdrawn','withdrawal of application on appeal'].includes(key))return 'withdrawn';
  if(['invalid','invalid application','invalidate application','declare application invalid','invalid details sent to applicant','invalid site notice','invalid due to site notice','invalid case closed','incomplete application','incompleted app','incompleted','incompleted application'].includes(key))return 'invalid';
  if(['finalised','application closed','application finalised','pac report & file closed','pac meeting & file closed','application archived'].includes(key))return 'finalised';
  return 'unknown';
}
function decisionStatus(value){
  const key=statusComparable(value);
  if(!key||['n/a','null','no data'].includes(key))return 'unknown';
  if(/\bwithdraw/.test(key))return 'withdrawn';
  if(/\b(?:invalid|invalidate|incomplete|incompleted)\b/.test(key))return 'invalid';
  if(key.includes('request additional information')||key.includes('additional information requested')||key.includes('clarification of additional information')||key.includes('request ai')||key.includes('req ai'))return 'further_information_requested';
  if(/\b(?:grant|granted|refuse|refused|refusal|conditional|unconditional|approve|approved|approval)\b/.test(key))return 'decision_made';
  return 'unknown';
}
function resolveSourceLifecycle(result){
  const raw=normaliseSourceStatus(result?.status);
  const decision=decisionStatus(result?.decision_text);
  if(result?.appeal_decision_date)return 'appeal_decided';
  if(['appeal_decided','appealed','withdrawn','invalid','final_grant'].includes(raw))return raw;
  if(['withdrawn','invalid'].includes(decision))return decision;
  if(raw==='finalised')return 'finalised';
  if(result?.appeal_lodged_date)return 'appealed';
  if(result?.withdrawal_date)return 'withdrawn';
  if(result?.final_grant_date)return 'final_grant';
  if(decision==='decision_made'||raw==='decision_made'||result?.decision_date)return 'decision_made';
  if(raw==='under_assessment')return 'under_assessment';
  if(result?.further_information_received_date)return 'further_information_received';
  if(decision==='further_information_requested')return 'further_information_requested';
  if(raw==='further_information_received')return 'further_information_received';
  if(raw==='further_information_requested')return 'further_information_requested';
  if(result?.further_information_requested_date)return 'further_information_requested';
  return raw;
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let processed = 0, completed = 0, deferred = 0, failed = 0, fieldChanges = 0, lifecycleChanges = 0, rawStatusChanges = 0, stateRecorded = 0;
let stoppedForTimeBudget = false;

async function persistFetched(item,result){
  try {
    if (!result.ok && result.reason === 'fetch_error') {
      await client.query(`
        update work_items
        set status='pending', result=null, available_at=now()+interval '30 minutes', last_error=$2, completed_at=null, updated_at=now()
        where id=$1
      `,[item.id,String(result.error || result.reason).slice(0,500)]);
      deferred += 1;
      return;
    }

    const delta=result.ok ? lifecycleDelta(item.input,result) : {};
    const changeDetected=Object.keys(delta).length>0;
    const sourceResolvedStatus=result.ok?resolveSourceLifecycle(result):null;
    const previousResolvedStatus=comparable(item.input?.normalized_status);
    const lifecycleChangeDetected=Boolean(sourceResolvedStatus&&sourceResolvedStatus!=='unknown'&&sourceResolvedStatus!==previousResolvedStatus);
    const rawStatusChangeDetected=Object.hasOwn(delta,'status');
    const consumeInWorker=item.job_type==='eplan_active_lifecycle' && (!result.ok || !changeDetected);
    const checkedAt=new Date().toISOString();
    const enrichedResult={...result,change_detected:changeDetected,lifecycle_change_detected:lifecycleChangeDetected,status_change_detected:lifecycleChangeDetected,raw_status_change_detected:rawStatusChangeDetected,source_resolved_status:sourceResolvedStatus,previous_normalized_status:previousResolvedStatus,delta,checked_at:checkedAt,source_type:'eplan'};
    await client.query('begin');
    try {
      await client.query(`
        update work_items
        set status='completed', result=$2::jsonb,
            applied_at=case when $3 then now() else applied_at end,
            completed_at=now(), last_error=null, updated_at=now()
        where id=$1
      `, [item.id, JSON.stringify(enrichedResult), consumeInWorker]);
      if(item.job_type==='eplan_active_lifecycle' && item.input?.application_id){
        await client.query(`
          insert into source_sync_state(job_family,application_key,last_checked_at,last_seen_change_at,metadata,updated_at)
          values(
            'eplan_active_lifecycle',$1,$2::timestamptz,
            case when $3 then $2::timestamptz else null::timestamptz end,
            jsonb_build_object(
              'source_type','eplan',
              'last_source_status',case when $4 then 'found' else 'unavailable' end,
              'last_source_error',case when $4 then null else $5::text end,
              'reference',$6::text,
              'authority',$7::text,
              'pending_prod_change',$3::boolean,
              'lifecycle_change_detected',$8::boolean,
              'status_change_detected',$8::boolean,
              'source_resolved_status',$9::text,
              'previous_normalized_status',$10::text
            ),now()
          )
          on conflict(job_family,application_key) do update
          set last_checked_at=excluded.last_checked_at,
              last_seen_change_at=case when $3 then excluded.last_checked_at else source_sync_state.last_seen_change_at end,
              metadata=coalesce(source_sync_state.metadata,'{}'::jsonb)||excluded.metadata,
              updated_at=now()
        `,[String(item.input.application_id),checkedAt,changeDetected,result.ok,result.reason||null,item.input.reference||null,item.input.local_authority_code||null,lifecycleChangeDetected,sourceResolvedStatus,previousResolvedStatus]);
        stateRecorded += 1;
      }
      await client.query('commit');
    } catch (stateError) {
      await client.query('rollback').catch(()=>{});
      throw stateError;
    }
    completed += 1;
    if(changeDetected)fieldChanges += 1;
    if(lifecycleChangeDetected)lifecycleChanges += 1;
    if(rawStatusChangeDetected)rawStatusChanges += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.query(`
      update work_items
      set status='pending', available_at=now()+interval '30 minutes', last_error=$2, completed_at=null, updated_at=now()
      where id=$1
    `, [item.id, message.slice(0,500)]).catch(()=>{});
    deferred += 1;
  }
}

try {
  const { rows } = await client.query(`
    select id, job_type, input
    from work_items
    where job_type in ('eplan_lifecycle','eplan_active_lifecycle')
      and status = 'pending'
      and applied_at is null
      and available_at <= now()
    order by case when job_type='eplan_active_lifecycle' then 0 else 1 end, id
    limit $1
  `, [LIMIT]);

  for(let offset=0;offset<rows.length;offset+=CONCURRENCY){
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      stoppedForTimeBudget = true;
      break;
    }

    const chunk=rows.slice(offset,offset+CONCURRENCY);
    for(const item of chunk){
      processed += 1;
      await client.query("update work_items set status='running', leased_at=now(), attempts=attempts+1, updated_at=now() where id=$1", [item.id]);
    }

    const fetched=await Promise.all(chunk.map(async(item,index)=>{
      if(index>0)await sleep(index*PACE_MS);
      try{return await fetchEplanApplication(item.input.local_authority_code,item.input.reference);}
      catch(error){return {ok:false,reason:'fetch_error',error:String(error)};}
    }));

    for(let index=0;index<chunk.length;index++)await persistFetched(chunk[index],fetched[index]);
  }

  console.log(JSON.stringify({ selected: rows.length, processed, completed, changed:lifecycleChanges, lifecycleChanges, rawStatusChanges, fieldChanges, deferred, failed, stateRecorded, concurrency:CONCURRENCY, paceMs:PACE_MS, timeBudgetMs:TIME_BUDGET_MS, stoppedForTimeBudget }, null, 2));
} finally {
  await client.end().catch(() => {});
}
