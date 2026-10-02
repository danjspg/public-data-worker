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
function lifecycleDelta(input,result){
  const delta={};
  for(const field of TRACKED_FIELDS){
    const incoming=comparable(result?.[field]);
    const existing=comparable(input?.[field]);
    if(incoming!==null&&incoming!==existing)delta[field]=result[field];
  }
  return delta;
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let processed = 0, completed = 0, deferred = 0, failed = 0, changed = 0, stateRecorded = 0;
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
    const consumeInWorker=item.job_type==='eplan_active_lifecycle' && (!result.ok || !changeDetected);
    const checkedAt=new Date().toISOString();
    const enrichedResult={...result,change_detected:changeDetected,delta,checked_at:checkedAt,source_type:'eplan'};
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
              'pending_prod_change',$3::boolean
            ),now()
          )
          on conflict(job_family,application_key) do update
          set last_checked_at=excluded.last_checked_at,
              last_seen_change_at=case when $3 then excluded.last_checked_at else source_sync_state.last_seen_change_at end,
              metadata=coalesce(source_sync_state.metadata,'{}'::jsonb)||excluded.metadata,
              updated_at=now()
        `,[String(item.input.application_id),checkedAt,changeDetected,result.ok,result.reason||null,item.input.reference||null,item.input.local_authority_code||null]);
        stateRecorded += 1;
      }
      await client.query('commit');
    } catch (stateError) {
      await client.query('rollback').catch(()=>{});
      throw stateError;
    }
    completed += 1;
    if(changeDetected)changed += 1;
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

  console.log(JSON.stringify({ selected: rows.length, processed, completed, changed, deferred, failed, stateRecorded, concurrency:CONCURRENCY, paceMs:PACE_MS, timeBudgetMs:TIME_BUDGET_MS, stoppedForTimeBudget }, null, 2));
} finally {
  await client.end().catch(() => {});
}
