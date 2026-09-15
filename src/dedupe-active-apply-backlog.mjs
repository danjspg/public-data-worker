import pg from 'pg';
import { activeAgileSignature, activeExactSignature } from './meaningful-source-signature.mjs';

const { Client } = pg;
const connectionString=process.env.WORKER_DATABASE_URL;
if(!connectionString) throw new Error('WORKER_DATABASE_URL is required');
const LIMIT=Math.max(1,Math.min(Number(process.env.ACTIVE_BACKLOG_DEDUPE_LIMIT||20000),30000));
const client=new Client({connectionString,ssl:{rejectUnauthorized:false}});
await client.connect();

const configs=[
  {jobType:'active_planning_exact',signature:activeExactSignature},
  {jobType:'active_planning_agile_detail',signature:activeAgileSignature},
];
const report={};
try{
  for(const config of configs){
    const latestApplied=await client.query(`
      select distinct on (input->>'application_id')
             input->>'application_id' as application_key,
             result,applied_at
      from work_items
      where job_type=$1
        and applied_at is not null
        and input ? 'application_id'
        and result is not null
      order by input->>'application_id',id desc
    `,[config.jobType]);

    let baselinesSeeded=0;
    for(const row of latestApplied.rows){
      const signature=config.signature(row.result);
      if(!signature||!row.application_key)continue;
      await client.query(`
        insert into source_sync_state(
          job_family,application_key,last_applied_signature,last_applied_at,last_checked_at,updated_at
        )
        values($1,$2,$3,$4,$4,now())
        on conflict(job_family,application_key) do update
        set last_applied_signature=excluded.last_applied_signature,
            last_applied_at=greatest(source_sync_state.last_applied_at,excluded.last_applied_at),
            last_checked_at=greatest(source_sync_state.last_checked_at,excluded.last_checked_at),
            updated_at=now()
      `,[config.jobType,row.application_key,signature,row.applied_at]);
      baselinesSeeded++;
    }

    const {rows}=await client.query(`
      select i.id,i.input,i.result,s.last_applied_signature
      from work_items i
      left join source_sync_state s
        on s.job_family=i.job_type
       and s.application_key=i.input->>'application_id'
      where i.job_type=$1
        and i.status='completed'
        and i.applied_at is null
      order by i.id
      limit $2
    `,[config.jobType,LIMIT]);

    let consumed=0,changed=0,noBaseline=0,missing=0;
    for(const item of rows){
      const current=config.signature(item.result);
      const previous=item.last_applied_signature || null;
      if(!current){
        missing++;
        await client.query(`
          update work_items
          set result=coalesce(result,'{}'::jsonb) || $2::jsonb,
              applied_at=now(),last_error=null,updated_at=now()
          where id=$1 and applied_at is null
        `,[item.id,JSON.stringify({change_detected:false,checked_at:new Date().toISOString(),dedupe_reason:'no_source_record'})]);
        consumed++;
        continue;
      }
      if(!previous){noBaseline++;continue;}
      if(current!==previous){changed++;continue;}
      await client.query(`
        update work_items
        set result=coalesce(result,'{}'::jsonb) || $2::jsonb,
            applied_at=now(),last_error=null,updated_at=now()
        where id=$1 and applied_at is null
      `,[item.id,JSON.stringify({source_signature:current,change_detected:false,checked_at:new Date().toISOString(),dedupe_reason:'matches_last_successfully_applied_source'})]);
      consumed++;
    }
    report[config.jobType]={baselines_seeded:baselinesSeeded,selected:rows.length,consumed,changed,no_baseline:noBaseline,missing};
  }
  console.log(JSON.stringify({ok:true,...report},null,2));
}finally{await client.end().catch(()=>{})}
