// Twice-weekly official council received-list discovery. Stages in Neon only.
// Production publication is a distinct, guarded, create-only reconciliation job.
import pg from "pg";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
import {CUTOFF,parseWexfordReceived,parseSouthDublinReceived,
 fingalReceivedCandidates,dublinCityReceivedCandidates,receivedDate} from "./council-received-parser.mjs";
import {dublinDocLinks,dublinDocxXmlText,DUBLIN_CITY_INDEX} from "./council-weekly-dublincity.mjs";
import {FINGAL_INDEX} from "./council-weekly-fingal.mjs";
const exec=promisify(cb),{Client}=pg;
const WEXFORD="https://www.wexfordcoco.ie/planning/planning-applications/planning-lists/planning-lists-for-2026";
const SOUTH="https://planning.southdublin.ie/Home/WeeklyLists";
const JOB="council_weekly_received",DRY=process.argv.includes("--dry-run");
const LIMIT=Math.max(1,Math.min(20,Number(process.env.COUNCIL_RECEIVED_DOCUMENT_LIMIT||12)));
const HOST={WEXFORD:"www.wexfordcoco.ie",SOUTHDUBLIN:"planning.southdublin.ie",FINGAL:"www.fingal.ie",DUBLINCITY:"www.dublincity.ie"};
function official(url,authority) {
 const u=new URL(url);
 if(u.protocol!=="https:"||u.hostname!==HOST[authority])throw Error("Nonofficial council source rejected");
 return u.href;
}
async function source(url,authority,binary=false){
 const r=await fetch(official(url,authority),{signal:AbortSignal.timeout(35000),
  headers:{"User-Agent":"OpenList public council weekly planning source verification"}});
 if(!r.ok)throw Error(authority+" HTTP "+r.status);
 const b=Buffer.from(await r.arrayBuffer());
 if(b.length>18000000)throw Error("Oversized council document");
 return binary?b:b.toString("utf8");
}
function wexfordLinks(html){
 const start=html.search(/Valid Planning Applications Received/i),other=html.search(/Invalid Planning Applications Received/i);
 if(start<0||other<start)throw Error("Wexford valid-list archive section missing");
 const segment=html.slice(start,other);
 const links=[...segment.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)]
  .map(m=>new URL(m[1].replace(/&amp;/g,"&"),WEXFORD).href)
  .filter(u=>new URL(u).hostname===HOST.WEXFORD&&/\.pdf$/i.test(new URL(u).pathname));
 // Filter by published weekly ending date from official filename.
 const docs=links.map(url=>{
  const m=decodeURIComponent(url).match(/week\s+ending\s+(\d{2})\.(\d{2})\.(\d{2,4})/i);
  if(!m)return null;
  const year=m[3].length===2?"20"+m[3]:m[3];
  return {url,week_ending:receivedDate(m[1]+"/"+m[2]+"/"+year),authority:"WEXFORD",type:"pdf"};
 }).filter(x=>x?.week_ending>=CUTOFF);
 if(!docs.length)throw Error("No current Wexford valid received documents");
 return docs;
}
function southLinks(html,base){
 const found=[];
 for(const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  if(!/1\s+Applications Received/i.test(m[2].replace(/<[^>]+>/g,"")))continue;
  const u=new URL(m[1].replace(/&amp;/g,"&"),base);
  if(u.hostname!==HOST.SOUTHDUBLIN||!/^\/Home\/ViewWeeklyListDocument\/\d+$/.test(u.pathname))continue;
  const before=html.slice(Math.max(0,m.index-500),m.index);
  const dates=[...before.matchAll(/(\d{2}\/\d{2}\/20\d{2})/g)];
  const week_ending=receivedDate(dates.at(-1)?.[1]);
  if(!week_ending)throw Error("Cannot associate South Dublin PDF with a council publication date");
  if(week_ending>=CUTOFF)found.push({url:u.href,week_ending,authority:"SOUTHDUBLIN",type:"pdf"});
 }
 return found;
}
function fingalLinks(html){
 const found=[];
 for(const m of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)){
  const wk=m[0].match(/\bweek\s*(\d{1,2})\b/i);
  if(!wk||Number(wk[1])<31)continue; // Week 31 ends 7 August 2026.
  const links=[...m[0].matchAll(/href\s*=\s*["']([^"']+\.doc(?:\?[^"']*)?)["']/gi)];
  const received=links.filter(x=>/applications?\W*received/i.test(decodeURIComponent(x[1])));
  if(received.length!==1)throw Error("Fingal applications link ambiguous, week "+wk[1]);
  const url=new URL(received[0][1].replace(/&amp;/g,"&"),FINGAL_INDEX);
  if(url.hostname!==HOST.FINGAL)throw Error("Fingal source hostname mismatch");
  const week_ending=new Date(Date.UTC(2026,0,4+(Number(wk[1])-1)*7)).toISOString().slice(0,10);
  found.push({url:url.href,week_ending,authority:"FINGAL",type:"doc"});
 }
 return found;
}
function dublinLinks(html){
 return dublinDocLinks(html).map(x=>({
  url:x.url,week_ending:new Date(Date.UTC(2026,0,4+(x.week-1)*7)).toISOString().slice(0,10),
  authority:"DUBLINCITY",area:x.area,type:"docx"
 })).filter(x=>x.week_ending>=CUTOFF);
}
async function discover(){
 const docs=[...wexfordLinks(await source(WEXFORD,"WEXFORD"))];
 for(let page=1;page<=3;page++){
  const url=SOUTH+(page===1?"":"?p="+page);
  const found=southLinks(await source(url,"SOUTHDUBLIN"),url);
  docs.push(...found);
  if(!found.length)break;
 }
 docs.push(...fingalLinks(await source(FINGAL_INDEX,"FINGAL")));
 docs.push(...dublinLinks(await source(DUBLIN_CITY_INDEX,"DUBLINCITY")));
 const all=[...new Map(docs.map(x=>[x.authority+":"+x.url,x])).values()]
  .sort((a,b)=>b.week_ending.localeCompare(a.week_ending));
 for(const name of Object.keys(HOST))if(!all.some(x=>x.authority===name))throw Error("No received documents found for "+name);
 return all;
}
async function parseDocument(doc){
 const b=await source(doc.url,doc.authority,true);
 const sha256=createHash("sha256").update(b).digest("hex");
 if(b.length<500)throw Error("Short source document");
 const expected=doc.type==="pdf"?"%PDF-":doc.type==="docx"?"PK":null;
 if(expected&&b.subarray(0,expected.length).toString()!==expected)throw Error("Wrong file format");
 const dir=await mkdtemp(join(tmpdir(),"council-received-"));
 try{
  const name=join(dir,"source."+doc.type);await writeFile(name,b);
  let text;
  if(doc.type==="pdf")({stdout:text}=await exec("pdftotext",["-raw",name,"-"],{timeout:30000,maxBuffer:24000000}));
  else if(doc.type==="doc")({stdout:text}=await exec("antiword",["-w","0",name],{timeout:30000,maxBuffer:24000000}));
  else {
   const {stdout:xml}=await exec("unzip",["-p",name,"word/document.xml"],{timeout:30000,maxBuffer:24000000});
   text=dublinDocxXmlText(xml);
  }
  const parsed={
   WEXFORD:()=>parseWexfordReceived(text,doc.url),
   SOUTHDUBLIN:()=>parseSouthDublinReceived(text,doc.url),
   FINGAL:()=>fingalReceivedCandidates(text),
   DUBLINCITY:()=>dublinCityReceivedCandidates(text)
  }[doc.authority]();
  if(parsed.headers<1||parsed.headers>1000)throw Error("Unrecognised or oversized list");
  // Never allow metadata-incomplete Word candidates into automatic publication.
  return {sha256,parsed};
 }finally{await rm(dir,{recursive:true,force:true});}
}
const docs=await discover();
if(DRY){
 const preview=[];
 for(const council of Object.keys(HOST)){
  const doc=docs.find(x=>x.authority===council);
  const {parsed}=await parseDocument(doc);
  preview.push({council,week:doc.week_ending,url:doc.url,headers:parsed.headers,
   complete:parsed.applications.length,skipped:parsed.skipped,
   candidates:parsed.candidate_references?.length||0,
   // No applicant names, addresses or descriptions in CI logging.
   samples:parsed.applications.slice(0,6).map(x=>({ref:x.reference,date:x.registration_date,type:x.application_type}))});
 }
 console.log(JSON.stringify({dryRun:true,discoveredDocuments:docs.length,preview},null,2));
 process.exit(0);
}
if(!process.env.WORKER_DATABASE_URL)throw Error("WORKER_DATABASE_URL required");
const db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
let seeded=0,completed=0,failed=0;const report=[];
try{
 for(const doc of docs){
  const key=doc.authority+":"+createHash("sha256").update(doc.url).digest("hex").slice(0,24);
  const q=await db.query("insert into work_items(job_type,work_key,input,status,available_at,updated_at) values($1,$2,$3::jsonb,'pending',now(),now()) on conflict(job_type,work_key) do nothing returning id",
   [JOB,key,JSON.stringify(doc)]);
  seeded+=q.rowCount;
 }
 const {rows}=await db.query("select id,input,attempts from work_items where job_type=$1 and status='pending' and applied_at is null and available_at<=now() and input->>'week_ending' >= $2 order by input->>'week_ending' desc,id desc limit $3",[JOB,CUTOFF,LIMIT]);
 for(const item of rows){
  try{
   const {sha256,parsed}=await parseDocument(item.input);
   const result={ok:true,authority:item.input.authority,url:item.input.url,week_ending:item.input.week_ending,
    sha256,applications:parsed.applications,candidate_references:parsed.candidate_references||[],
    headers:parsed.headers,skipped:parsed.skipped,parser_version:1,checked_at:new Date().toISOString()};
   // Candidate-only documents are acknowledged in the worker: no production
   // application can be safely created from bare, possibly cited references.
   const candidateOnly=parsed.applications.length===0;
   await db.query("update work_items set status='completed',result=$2::jsonb,completed_at=now(),attempts=attempts+1,applied_at=case when $3 then now() else applied_at end,last_error=null,updated_at=now() where id=$1",
    [item.id,JSON.stringify(result),candidateOnly]);
   completed++;report.push({authority:item.input.authority,week:item.input.week_ending,complete:parsed.applications.length,candidates:parsed.candidate_references?.length||0});
   await new Promise(resolve=>setTimeout(resolve,700));
  }catch(error){
   const attempts=Number(item.attempts||0)+1;
   await db.query("update work_items set attempts=$2,status=case when $2>=3 then 'failed' else 'pending' end,available_at=now()+interval '8 hours',last_error=$3,updated_at=now() where id=$1",
    [item.id,attempts,String(error.message||error).slice(0,500)]);
   failed++;report.push({authority:item.input.authority,error:String(error.message||error).slice(0,140)});
  }
 }
 console.log(JSON.stringify({discovered:docs.length,seeded,completed,failed,report},null,2));
 if(failed&&!completed)process.exitCode=1;
}finally{await db.end();}
