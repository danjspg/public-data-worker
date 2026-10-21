// Cork County Council public MapAlerts -> durable worker staging.
// No Agile API usage and no production database credentials.
import pg from "pg";
import {createHash} from "node:crypto";
import {CORK_MAPALERTS_INDEX,discoverCorkMapalertWeeks,parseCorkMapalertsReceived} from "./council-mapalerts-cork.mjs";
const {Client}=pg;
const JOB="council_weekly_received",DRY=process.argv.includes("--dry-run");
const DOC_LIMIT=Math.max(1,Math.min(8,Number(process.env.CORK_MAPALERTS_DOCUMENT_LIMIT||6)));
const CUTOFF="2026-08-01";
async function official(url){
 const u=new URL(url);
 if(u.protocol!=="https:"||u.hostname!=="mapalerts.corkcoco.ie"||
    !(u.pathname==="/en/alerts"||u.pathname==="/alerts"||u.pathname==="/ga/alerts"||
      /^\/(?:en\/|ga\/)?alerts\/item$/i.test(u.pathname)))throw Error("Untrusted Cork County MapAlerts URL");
 const r=await fetch(u,{headers:{"User-Agent":"OpenList weekly planning registers research"},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error("MapAlerts HTTP "+r.status);
 const html=await r.text();
 if(html.length<1200||html.length>9_000_000)throw Error("Unusual council document length");
 return html;
}
async function discover(){
 // The current official alert index exposes its latest weeks; its pagination
 // query may return the same entries, so never assume pagination succeeds.
 const docs=new Map();
 let previous="";
 for(let page=0;page<4;page++){
  const u=new URL(CORK_MAPALERTS_INDEX);
  if(page)u.searchParams.set("page",String(page));
  const found=discoverCorkMapalertWeeks(await official(u.href),u.href);
  const signature=found.map(x=>x.url).join("|");
  if(page&&signature===previous)break;
  previous=signature;
  for(const d of found)if(d.week_ending>=CUTOFF)docs.set(new URL(d.url).searchParams.get("ref"),d);
  if(found.length===0)break;
 }
 const out=[...docs.values()].sort((a,b)=>b.week_ending.localeCompare(a.week_ending));
 if(!out.length||out.length>40)throw Error("Unexpected MapAlerts weekly publication count: "+out.length);
 return out;
}
const docs=await discover();
if(DRY){
 const preview=[];
 for(const d of docs.slice(0,3)){
  const html=await official(d.url),sha=createHash("sha256").update(html).digest("hex");
  const result=parseCorkMapalertsReceived(html,d.url);
  preview.push({week:d.week_ending,sha256:sha,headers:result.headers,newApplications:result.applications.length,
   otherEventsExcluded:result.skipped,samples:result.applications.slice(0,12).map(x=>({reference:x.reference,date:x.registration_date,type:x.application_type}))});
 }
 console.log(JSON.stringify({dryRun:true,discovered:docs.length,preview},null,2));process.exit(0);
}
if(!process.env.WORKER_DATABASE_URL)throw Error("WORKER_DATABASE_URL required");
const db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
let seeded=0,complete=0,failed=0;
const report=[];
try{
 for(const d of docs){
  const workKey="CORKCOCO:MAPALERTS:"+createHash("sha256").update(d.url).digest("hex").slice(0,24);
  const inserted=await db.query(
   "insert into work_items(job_type,work_key,input,status,available_at,updated_at) values($1,$2,$3::jsonb,'pending',now(),now()) on conflict(job_type,work_key) do nothing returning id",
   [JOB,workKey,JSON.stringify(d)]);
  seeded+=inserted.rowCount;
 }
 const {rows}=await db.query(
  "select id,input,attempts from work_items where job_type=$1 and status='pending' and applied_at is null and available_at<=now() and input->>'authority'='CORKCOCO' and input->>'week_ending'>=$2 order by input->>'week_ending' desc,id desc limit $3",
  [JOB,CUTOFF,DOC_LIMIT]);
 for(const job of rows){
  try{
   const html=await official(job.input.url),sha256=createHash("sha256").update(html).digest("hex");
   const parsed=parseCorkMapalertsReceived(html,job.input.url);
   if(parsed.week!==job.input.week_ending)throw Error("Official alert publication week mismatch");
   const result={ok:true,authority:"CORKCOCO",url:job.input.url,week_ending:job.input.week_ending,
    sha256,applications:parsed.applications,headers:parsed.headers,skipped:parsed.skipped,
    parser_version:1,source:"cork_county_mapalerts_weekly",checked_at:new Date().toISOString()};
   await db.query(
    "update work_items set status='completed',result=$2::jsonb,attempts=attempts+1,completed_at=now(),last_error=null,updated_at=now() where id=$1",
    [job.id,JSON.stringify(result)]);
   complete++;report.push({week:job.input.week_ending,applications:parsed.applications.length,otherEvents:parsed.skipped});
   await new Promise(resolve=>setTimeout(resolve,700));
  }catch(e){
   failed++;const attempts=Number(job.attempts||0)+1;
   await db.query("update work_items set attempts=$2,status=case when $2>=3 then 'failed' else 'pending' end,available_at=now()+interval '8 hours',last_error=$3,updated_at=now() where id=$1",
    [job.id,attempts,String(e.message||e).slice(0,500)]);
   report.push({week:job.input.week_ending,error:String(e.message||e).slice(0,170)});
  }
 }
 console.log(JSON.stringify({seeded,complete,failed,discovered:docs.length,report},null,2));
 if(failed&&!complete)process.exitCode=1;
}finally{await db.end();}
