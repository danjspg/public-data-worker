// Stage official DLR weekly received applications in worker Neon (no Agile API).
import pg from "pg";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
import {DLR_WEEKLY_INDEX,discoverDlrWeeks,parseDlrReceived} from "./council-weekly-dlr.mjs";
const exec=promisify(cb),{Client}=pg;
const JOB="council_weekly_received";
const DRY=process.argv.includes("--dry-run");
const LIMIT=Math.max(1,Math.min(15,Number(process.env.DLR_WEEKLY_DOCUMENT_LIMIT||11)));
async function official(url,binary=false){
 const u=new URL(url);
 if(u.protocol!=="https:"||u.hostname!=="www.dlrcoco.ie")throw Error("Non-council document URL");
 const r=await fetch(u,{headers:{"User-Agent":"OpenList council weekly planning register"},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error("DLR HTTP "+r.status);
 const b=Buffer.from(await r.arrayBuffer());
 if(b.length>22000000||(binary&&(b.length<600||b.subarray(0,5).toString()!=="%PDF-")))throw Error("Invalid council PDF");
 return binary?b:b.toString("utf8");
}
const docs=discoverDlrWeeks(await official(DLR_WEEKLY_INDEX));
async function parse(doc){
 const bytes=await official(doc.url,true),sha256=createHash("sha256").update(bytes).digest("hex");
 const dir=await mkdtemp(join(tmpdir(),"dlr-received-"));
 try{
  const file=join(dir,"weekly.pdf");
  await writeFile(file,bytes);
  const {stdout}=await exec("pdftotext",["-raw",file,"-"],{timeout:30000,maxBuffer:24000000});
  const p=parseDlrReceived(stdout,doc.url);
  if(p.applications.length<3&&p.headers>=10)throw Error("Unexpected low DLR received coverage");
  return {sha256,parsed:p};
 }finally{await rm(dir,{force:true,recursive:true});}
}
if(DRY){
 const reports=[];
 for(const d of docs.slice(0,3)){
  const p=await parse(d);
  reports.push({week:d.week,official:p.parsed.officialTotal,applications:p.parsed.applications.length,excluded:p.parsed.skipped,
   refs:p.parsed.applications.slice(0,15).map(x=>({reference:x.reference,date:x.registration_date}))});
 }
 console.log(JSON.stringify({dryRun:true,docs:docs.length,reports},null,2));process.exit(0);
}
if(!process.env.WORKER_DATABASE_URL)throw Error("Worker DB missing");
const db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
let seeded=0,completed=0,failed=0;const reports=[];
try{
 for(const d of docs){
  const key="DLR:"+createHash("sha256").update(d.url).digest("hex").slice(0,24);
  const r=await db.query("insert into work_items(job_type,work_key,input,status,available_at,updated_at) values($1,$2,$3::jsonb,'pending',now(),now()) on conflict(job_type,work_key) do nothing returning id",
   [JOB,key,JSON.stringify(d)]);
  seeded+=r.rowCount;
 }
 const {rows}=await db.query("select id,input,attempts from work_items where job_type=$1 and input->>'authority'='DLR' and status='pending' and applied_at is null and available_at<=now() order by input->>'week_ending' desc limit $2",
  [JOB,LIMIT]);
 for(const job of rows){
  try{
   const p=await parse(job.input);
   const result={ok:true,authority:"DLR",url:job.input.url,week_ending:job.input.week_ending,
    sha256:p.sha256,applications:p.parsed.applications,headers:p.parsed.headers,
    skipped:p.parsed.skipped,parser_version:1,source:"dlrcoco_official_weekly_pdf",
    checked_at:new Date().toISOString()};
   await db.query("update work_items set status='completed',result=$2::jsonb,attempts=attempts+1,completed_at=now(),last_error=null,updated_at=now() where id=$1",
    [job.id,JSON.stringify(result)]);
   completed++;reports.push({week:job.input.week,applications:p.parsed.applications.length,excluded:p.parsed.skipped});
   await new Promise(resolve=>setTimeout(resolve,750));
  }catch(e){
   failed++;const attempts=Number(job.attempts||0)+1;
   await db.query("update work_items set attempts=$2,status=case when $2>=3 then 'failed' else 'pending' end,available_at=now()+interval '8 hours',last_error=$3,updated_at=now() where id=$1",
    [job.id,attempts,String(e.message||e).slice(0,500)]);
   reports.push({week:job.input.week,error:String(e.message||e).slice(0,180)});
  }
 }
 console.log(JSON.stringify({discovered:docs.length,seeded,completed,failed,reports},null,2));
 if(failed&&!completed)process.exitCode=1;
}finally{await db.end();}
