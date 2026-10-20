import pg from "pg";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as callback} from "node:child_process";
import {promisify} from "node:util";
import {FINGAL_INDEX,fingalWeeklyLinks,parseFingalWeeklyText,parseFingalLegacyText} from "./council-weekly-fingal.mjs";
const exec=promisify(callback),{Client}=pg;
const CUTOFF="2026-08-01",JOB="council_weekly_decisions",DRY=process.argv.includes("--dry-run");
const LIMIT=Math.max(1,Math.min(15,Number(process.env.COUNCIL_FINGAL_LIMIT||12)));
async function fetchCouncil(raw,binary=false){
 const u=new URL(raw);
 if(u.protocol!=="https:"||u.hostname!=="www.fingal.ie")throw Error("Invalid Fingal source");
 const r=await fetch(u,{signal:AbortSignal.timeout(30000),headers:{"User-Agent":"OpenList council weekly source audit"}});
 if(!r.ok)throw Error("Fingal source HTTP "+r.status);
 const data=Buffer.from(await r.arrayBuffer());
 if(binary&&(data.length<1000||data.length>14000000))throw Error("Suspicious Word document size");
 return binary?data:data.toString("utf8");
}
async function extract(url,week){
 const bytes=await fetchCouncil(url,true),sha256=createHash("sha256").update(bytes).digest("hex");
 const dir=await mkdtemp(join(tmpdir(),"fingal-week-"));
 try{
  const file=join(dir,"council.doc");await writeFile(file,bytes);
  const {stdout}=await exec("antiword",["-w","0",file],{timeout:30000,maxBuffer:20000000});
  const parsed=Number(week)<=38?parseFingalLegacyText(stdout,url):parseFingalWeeklyText(stdout,url);
  if(parsed.tableRows>=15&&parsed.decisions.length<4)throw Error("Suspiciously low outcome coverage");
  return {sha256,...parsed};
 }finally{await rm(dir,{recursive:true,force:true});}
}
const docs=fingalWeeklyLinks(await fetchCouncil(FINGAL_INDEX));
if(DRY){
 const preview=[];
 for(const item of docs.slice(0,3)){
  const p=await extract(item.url,item.week);
  preview.push({week:item.week,totalRows:p.tableRows,decisions:p.decisions.length,refused:p.decisions.filter(x=>x.decision_text==="Refused").length,
    invalidOrOther:p.excluded,sample:p.decisions.slice(0,8)});
 }
 console.log(JSON.stringify({dryRun:true,discovered:docs.length,preview},null,2));
 process.exit(0);
}
if(!process.env.WORKER_DATABASE_URL)throw Error("WORKER_DATABASE_URL missing");
const db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
let seeded=0,completed=0,failed=0;const reports=[];
try{
 for(const doc of docs){
  const hash=createHash("sha256").update(doc.url).digest("hex").slice(0,24);
  const key="FINGAL:"+hash;
  const weekEnding=new Date(Date.UTC(2026,0,4+(doc.week-1)*7)).toISOString().slice(0,10);
  const inserted=await db.query("insert into work_items(job_type,work_key,input,status,available_at,updated_at) values($1,$2,$3::jsonb,'pending',now(),now()) on conflict(job_type,work_key) do nothing returning id",
    [JOB,key,JSON.stringify({authority:"FINGAL",url:doc.url,week:doc.week,week_ending:weekEnding})]);
  seeded+=inserted.rowCount;
 }
 const {rows}=await db.query("select id,input,attempts from work_items where job_type=$1 and input->>'authority'='FINGAL' and status='pending' and available_at<=now() and applied_at is null order by (input->>'week')::integer desc limit $2",[JOB,LIMIT]);
 for(const item of rows){
  try{
   const p=await extract(item.input.url,item.input.week);
   const result={ok:true,authority:"FINGAL",url:item.input.url,sha256:p.sha256,week_ending:item.input.week_ending,
    decisions:p.decisions,total:p.tableRows,parsed:p.decisions.length,excluded:p.excluded,parser_version:1,source_format:Number(item.input.week)<=38?"legacy_date_first":"new_table",checked_at:new Date().toISOString()};
   await db.query("update work_items set status='completed',result=$2::jsonb,attempts=attempts+1,completed_at=now(),last_error=null,updated_at=now() where id=$1",[item.id,JSON.stringify(result)]);
   completed++;reports.push({week:item.input.week,count:p.decisions.length});
   await new Promise(resolve=>setTimeout(resolve,750));
  }catch(error){
   failed++;const attempts=Number(item.attempts||0)+1;
   await db.query("update work_items set attempts=$2,status=case when $2>=3 then 'failed' else 'pending' end,available_at=now()+interval '8 hours',last_error=$3,updated_at=now() where id=$1",
     [item.id,attempts,String(error.message||error).slice(0,450)]);
   reports.push({week:item.input.week,error:String(error.message||error).slice(0,160)});
  }
 }
 console.log(JSON.stringify({discovered:docs.length,seeded,completed,failed,reports},null,2));
 if(failed&&!completed)process.exitCode=1;
}finally{await db.end();}
