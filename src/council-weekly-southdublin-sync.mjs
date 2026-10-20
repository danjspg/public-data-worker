// South Dublin council decisions: official weekly PDF -> staged Neon work items.
// Only Aug 2026 onwards. No Agile API and no Supabase credentials or writes.
import pg from "pg";
import { createHash } from "node:crypto";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
import {SOUTH_DUBLIN_INDEX,findSouthDublinDecisionDocuments,parseSouthDublinDecisions} from "./council-weekly-southdublin.mjs";
const exec=promisify(cb);
const {Client}=pg;
const CUTOFF="2026-08-01",JOB="council_weekly_decisions";
const LIMIT=Math.max(1,Math.min(20,Number(process.env.COUNCIL_SOUTHDUBLIN_LIMIT||15)));
const DRY=process.argv.includes("--dry-run");
function official(value){
 const u=new URL(value);
 if(u.protocol!=="https:"||u.hostname!=="planning.southdublin.ie")throw Error("Not an official South Dublin URL");
 return u.href;
}
async function get(url,pdf=false){
 const res=await fetch(official(url),{headers:{"User-Agent":"OpenList official council weekly decisions audit"},signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw Error("South Dublin HTTP "+res.status);
 if(!pdf)return res.text();
 const b=Buffer.from(await res.arrayBuffer());
 if(b.length<500||b.length>20000000||b.subarray(0,5).toString()!=="%PDF-")throw Error("Invalid PDF file");
 return b;
}
function dateFromText(date){
 const m=String(date).match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);
 if(!m)return null;
 const iso=m[3]+"-"+m[2]+"-"+m[1],actual=new Date(iso+"T00:00:00Z");
 return Number.isNaN(actual.getTime())||actual.toISOString().slice(0,10)!==iso?null:iso;
}
function documentWeeks(html,base){
 const links=findSouthDublinDecisionDocuments(html,base),result=[];
 for(const url of links){
   const rawHref=url.replace("https://planning.southdublin.ie","");
   const candidates=[rawHref,url,rawHref.replaceAll("&","&amp;")];
   const indices=candidates.map(s=>html.indexOf(s)).filter(n=>n>=0);
   if(!indices.length)throw Error("Cannot locate original link in council HTML "+url);
   const at=Math.min(...indices);
   const before=html.slice(Math.max(0,at-650),at);
   const dates=[...before.matchAll(/\b\d{2}\/\d{2}\/20\d{2}\b/g)];
   const week=dateFromText(dates.at(-1)?.[0]);
   if(!week)throw Error("Cannot independently verify list week date "+url);
   if(week>=CUTOFF)result.push({url,week});
 }
 return result;
}
const docs=[];
for(let page=1;page<=3;page++){
 const base=SOUTH_DUBLIN_INDEX+(page===1?"":"?p="+page);
 const html=await get(base);
 const found=documentWeeks(html,base);
 docs.push(...found);
 if(found.length===0)break;
}
const unique=[...new Map(docs.map(d=>[d.url,d])).values()]
 .sort((a,b)=>b.week.localeCompare(a.week));
if(unique.length<5||unique.length>45)throw Error("Unexpected recent South Dublin decision document count "+unique.length);
async function extract(url){
 const bytes=await get(url,true);
 const sha256=createHash("sha256").update(bytes).digest("hex");
 const dir=await mkdtemp(join(tmpdir(),"council-southdublin-"));
 try{
   const path=join(dir,"doc.pdf");await writeFile(path,bytes);
   const errors=[];
   for(const mode of ["-raw","-layout"]){
     try{
       const {stdout}=await exec("pdftotext",[mode,"-enc","UTF-8",path,"-"],{timeout:30000,maxBuffer:20000000});
       const records=parseSouthDublinDecisions(stdout,url);
       if(records.some(r=>r.decision_date<CUTOFF)) {
         // Older decisions may appear, but publication must not inherit them.
         return {sha256,records:records.filter(r=>r.decision_date>=CUTOFF)};
       }
       return {sha256,records};
     }catch(e){errors.push(mode+":"+String(e.message||e).slice(0,200));}
   }
   throw Error(errors.join("; "));
 }finally{await rm(dir,{recursive:true,force:true});}
}
if(DRY){
 const samples=[];
 for(const doc of unique.slice(0,3)){
   const {records}=await extract(doc.url);
   samples.push({week:doc.week,url:doc.url,decisions:records.length,refusals:records.filter(x=>x.decision_text==="Refused").length});
 }
 console.log(JSON.stringify({dryRun:true,cutoff:CUTOFF,documents:unique.length,preview:samples},null,2));
 process.exit(0);
}
if(!process.env.WORKER_DATABASE_URL)throw Error("WORKER_DATABASE_URL required");
const db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
let seeded=0,completed=0,failed=0;
const reports=[];
try{
 for(const d of unique){
  const hash=createHash("sha256").update(d.url).digest("hex").slice(0,24);
  const key="SOUTHDUBLIN:"+hash;
  const q=await db.query("insert into work_items(job_type,work_key,input,status,available_at,updated_at) values($1,$2,$3::jsonb,'pending',now(),now()) on conflict(job_type,work_key) do nothing returning id",
   [JOB,key,JSON.stringify({authority:"SOUTHDUBLIN",url:d.url,week_ending:d.week})]);
  seeded+=q.rowCount;
 }
 const {rows}=await db.query("select id,input,attempts from work_items where job_type=$1 and status='pending' and applied_at is null and available_at<=now() and input->>'authority'='SOUTHDUBLIN' and input->>'week_ending'>=$2 order by input->>'week_ending' desc,id desc limit $3",[JOB,CUTOFF,LIMIT]);
 for(const item of rows){
  try{
   const {records,sha256}=await extract(item.input.url);
   if(!records.length)throw Error("No matching recent decisions");
   const result={ok:true,authority:"SOUTHDUBLIN",url:item.input.url,sha256,
    week_ending:item.input.week_ending,decisions:records.map(r=>({reference:r.reference,decision_date:r.decision_date,decision_text:r.decision_text,registration_date:null,source_url:r.source_url})),
    total:records.length,parser_version:1,checked_at:new Date().toISOString()};
   await db.query("update work_items set status='completed',result=$2::jsonb,attempts=attempts+1,completed_at=now(),last_error=null,updated_at=now() where id=$1",[item.id,JSON.stringify(result)]);
   completed++;reports.push({week:item.input.week_ending,decisions:records.length});
   await new Promise(resolve=>setTimeout(resolve,750));
  }catch(e){
   const tries=Number(item.attempts||0)+1;
   await db.query("update work_items set attempts=$2,status=case when $2>=3 then 'failed' else 'pending' end,available_at=now()+interval '8 hours',last_error=$3,updated_at=now() where id=$1",[item.id,tries,String(e.message||e).slice(0,400)]);
   failed++;reports.push({week:item.input.week_ending,error:String(e.message||e).slice(0,140)});
  }
 }
 console.log(JSON.stringify({found:unique.length,seeded,completed,failed,reports},null,2));
 if(failed&&!completed)process.exitCode=1;
}finally{await db.end();}
