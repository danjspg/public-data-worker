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
    const {rows}=await client.query(`
      select i.id,i.input,i.result,prev.result as previous_result
      from work_items i
      left join lateral (
        select p.result
        from work_items p
        where p.job_type=i.job_type
          and p.applied_at is not null
          and p.id<i.id
          and p.input->>'application_id'=i.input->>'application_id'
        order by p.id desc
        limit 1
      ) prev on true
      where i.job_type=$1
        and i.status='completed'
        and i.applied_at is null
      order by i.id
      limit $2
    `,[config.jobType,LIMIT]);

    let consumed=0,changed=0,noBaseline=0,missing=0;
    for(const item of rows){
      const current=config.signature(item.result);
      const previous=config.signature(item.previous_result);
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
    report[config.jobType]={selected:rows.length,consumed,changed,no_baseline:noBaseline,missing};
  }
  console.log(JSON.stringify({ok:true,...report},null,2));
}finally{await client.end().catch(()=>{})}
