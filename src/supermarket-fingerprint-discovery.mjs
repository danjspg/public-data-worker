// Discover likely supermarket/foodstore planning records from the worker corpus and queue them for targeted commercial classification.
import pg from 'pg';
const { Client } = pg;
const WORKER_DATABASE_URL = process.env.WORKER_DATABASE_URL;
if (!WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required');
const LIMIT=Math.max(1,Math.min(Number(process.env.SUPERMARKET_DISCOVERY_LIMIT||500),2000));
const YEARS=Math.max(1,Math.min(Number(process.env.SUPERMARKET_DISCOVERY_YEARS||8),15));
const db=new Client({connectionString:WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
try {
  const cutoff=new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear()-YEARS);
  // The worker's durable planning corpus is represented by planning-related work_items. Search all JSON text so this catches
  // named operators as well as unnamed supermarket fingerprints such as discount foodstore/off-licence/trolley terminology.
  const {rows}=await db.query(`
    with candidates as (
      select distinct on (coalesce(input->>'application_id', work_key))
        coalesce(input->>'application_id', work_key) as application_key,
        work_key, input,
        coalesce(input->>'registration_date','') as registration_date,
        lower(coalesce(input::text,'') || ' ' || coalesce(result::text,'')) as haystack
      from work_items
      where created_at >= $1
        and input is not null
        and (
          lower(input::text) ~ '(supermarket|foodstore|food store|discount food|grocery|off[- ]?licen[cs]e|trolley|lidl|aldi|tesco|dunnes|supervalu|super valu)'
          or lower(coalesce(result::text,'')) ~ '(retail\\.(supermarket|discount-supermarket))'
        )
      order by coalesce(input->>'application_id', work_key), created_at desc
    )
    select * from candidates order by registration_date desc nulls last limit $2`,[cutoff,LIMIT]);
  let queued=0, existing=0, unusable=0;
  for(const row of rows){
    const i=row.input||{};
    if(!i.reference || !i.local_authority_code){unusable++;continue;}
    const key=`commercial_classifier_active:${i.application_id||row.application_key}`;
    const payload={...i,queue_source:'targeted-supermarket-fingerprint'};
    const r=await db.query(`insert into work_items(job_type,work_key,status,input,created_at,updated_at) values('commercial_classifier_active',$1,'pending',$2::jsonb,now(),now()) on conflict (job_type,work_key) do nothing returning work_key`,[key,JSON.stringify(payload)]);
    if(r.rowCount) queued++; else existing++;
  }
  console.log(JSON.stringify({ok:true,years:YEARS,candidates:rows.length,queued,existing,unusable,limit:LIMIT},null,2));
} finally { await db.end(); }
