import pg from "pg";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as callback} from "node:child_process";
import {promisify} from "node:util";
import {DUBLIN_CITY_INDEX,dublinDocLinks,dublinDocxXmlText,parseDublinCityDecisions} from "./council-weekly-dublincity.mjs";
const exec=promisify(callback),{Client}=pg;
const JOB="council_weekly_decisions",DRY=process.argv.includes("--dry-run");
const LIMIT=Math.max(1,Math.min(15,Number(process.env.COUNCIL_DUBLINCITY_LIMIT||12)));
async function fetchCouncil(raw,binary=false){
 const url=new URL(raw);
 if(url.protocol!=="https:"||url.hostname!=="www.dublincity.ie")throw Error("Not an official Dublin City council URL");
 const res=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{"User-Agent":"OpenList council weekly planning decisions"}});
 if(!res.ok)throw Error("Dublin City HTTP "+res.status);
 const bytes=Buffer.from(await res.arrayBuffer());
 if(binary&&(bytes.length<500||bytes.length>17000000||bytes.subarray(0,2).toString()!=="PK"))throw Error("Invalid DOCX");
 return binary?bytes:bytes.toString("utf8");
}
async function extract(url){
 const bytes=await fetchCouncil(url,true);
 const sha256=createHash("sha256").update(bytes).digest("hex");
 const dir=await mkdtemp(join(tmpdir(),"dublin-council-week-"));
 try{
  const file=join(dir,"council.docx");await writeFile(file,bytes);
  const {stdout}=await exec("unzip",["-p",file,"word/document.xml"],{timeout:30000,maxBuffer:25000000});
  const parsed=parseDublinCityDecisions(dublinDocxXmlText(stdout),url);
  // Report low coverage rather than fabricating updates.
  if(parsed.markers>=10&&parsed.decisions.length<1)throw Error("Dublin City decisions not recognised in official file");
  return {...parsed,sha256};
 }finally{await rm(dir,{recursive:true,force:true});}
}
const docs=dublinDocLinks(await fetchCouncil(DUBLIN_CITY_INDEX));
if(DRY){
 const preview=[];
 for(const item of docs.slice(0,5)){
  const x=await extract(item.url);
  preview.push({area:item.area,week:item.week,rows:x.markers,explicitDecisions:x.decisions.length,excluded:x.excluded,refusals:x.decisions.filter(v=>v.decision_text==="Refused").length,
   sample:x.decisions.slice(0,6)});
 }
 console.log(JSON.stringify({dryRun:true,documents:docs.length,preview},null,2));
 process.exit(0);
}
if(!process.env.WORKER_DATABASE_URL)throw Error("Missing worker DB connection");
const db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
let seeded=0,completed=0,failed=0;const reports=[];
try{
 for(const doc of docs){
  const key="DUBLINCITY:"+createHash("sha256").update(doc.url).digest("hex").slice(0,24);
  const week_ending=new Date(Date.UTC(2026,0,4+(doc.week-1)*7)).toISOString().slice(0,10);
  const q=await db.query("insert into work_items(job_type,work_key,input,status,available_at,updated_at) values($1,$2,$3::jsonb,'pending',now(),now()) on conflict(job_type,work_key) do nothing returning id",
    [JOB,key,JSON.stringify({authority:"DUBLINCITY",url:doc.url,area:doc.area,week:doc.week,week_ending})]);
  seeded+=q.rowCount;
 }
 const {rows}=await db.query("select id,input,attempts from work_items where job_type=$1 and input->>'authority'='DUBLINCITY' and status='pending' and available_at<=now() and applied_at is null order by (input->>'week')::integer desc,(input->>'area')::integer asc limit $2",[JOB,LIMIT]);
 for(const item of rows){
  try{
   const parsed=await extract(item.input.url);
   if(!parsed.decisions.length)throw Error("No explicit decisions found");
   const result={ok:true,authority:"DUBLINCITY",url:item.input.url,sha256:parsed.sha256,
    week_ending:item.input.week_ending,area:item.input.area,decisions:parsed.decisions,total:parsed.markers,parsed:parsed.decisions.length,
    excluded:parsed.excluded,parser_version:1,checked_at:new Date().toISOString()};
   await db.query("update work_items set status='completed',result=$2::jsonb,attempts=attempts+1,completed_at=now(),last_error=null,updated_at=now() where id=$1",[item.id,JSON.stringify(result)]);
   completed++;reports.push({area:item.input.area,week:item.input.week,records:parsed.decisions.length});
   await new Promise(resolve=>setTimeout(resolve,750));
  }catch(error){
   failed++;const tries=Number(item.attempts||0)+1;
   await db.query("update work_items set attempts=$2,status=case when $2>=3 then 'failed' else 'pending' end,available_at=now()+interval '8 hours',last_error=$3,updated_at=now() where id=$1",[item.id,tries,String(error.message||error).slice(0,450)]);
   reports.push({area:item.input.area,week:item.input.week,error:String(error.message||error).slice(0,180)});
  }
 }
 console.log(JSON.stringify({discovered:docs.length,seeded,completed,failed,reports},null,2));
 if(failed&&!completed)process.exitCode=1;
}finally{await db.end();}
