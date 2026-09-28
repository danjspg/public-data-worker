import pg from 'pg';
import { fetchEplanApplication } from './eplan-source.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.EPLAN_WORKER_LIMIT || 200), 500));
const DELAY_MS = Math.max(300, Number(process.env.EPLAN_WORKER_DELAY_MS || 750));
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
let processed = 0, completed = 0, deferred = 0, failed = 0, changed = 0;
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

  for (const [index, item] of rows.entries()) {
    processed += 1;
    await client.query("update work_items set status='running', leased_at=now(), attempts=attempts+1, updated_at=now() where id=$1", [item.id]);
    try {
      const result = await fetchEplanApplication(item.input.local_authority_code, item.input.reference);
      if (!result.ok && result.reason === 'fetch_error') {
        await client.query(`
          update work_items
          set status='pending', result=null, available_at=now()+interval '30 minutes', last_error=$2, completed_at=null, updated_at=now()
          where id=$1
        `,[item.id,String(result.error || result.reason).slice(0,500)]);
        deferred += 1;
      } else {
        const delta=result.ok ? lifecycleDelta(item.input,result) : {};
        const changeDetected=Object.keys(delta).length>0;
        const consumeInWorker=item.job_type==='eplan_active_lifecycle' && (!result.ok || !changeDetected);
        const enrichedResult={...result,change_detected:changeDetected,delta,checked_at:new Date().toISOString(),source_type:'eplan'};
        await client.query(`
          update work_items
          set status='completed', result=$2::jsonb,
              applied_at=case when $3 then now() else applied_at end,
              completed_at=now(), last_error=null, updated_at=now()
          where id=$1
        `, [item.id, JSON.stringify(enrichedResult), consumeInWorker]);
        completed += 1; if(changeDetected)changed += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query(`
        update work_items
        set status='pending', available_at=now()+interval '30 minutes', last_error=$2, completed_at=null, updated_at=now()
        where id=$1
      `, [item.id, message.slice(0,500)]);
      deferred += 1;
    }
    if (index < rows.length - 1) await sleep(DELAY_MS);
  }
  console.log(JSON.stringify({ selected: rows.length, processed, completed, changed, deferred, failed }, null, 2));
} finally {
  await client.end().catch(() => {});
}
