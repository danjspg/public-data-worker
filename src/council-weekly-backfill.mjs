import pg from 'pg';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile as cb} from 'node:child_process';
import {promisify} from 'node:util';
import {findWexfordDecisionLinks,parseWexfordDecisionText} from './council-weekly-wexford.mjs';
const exec=promisify(cb), {Client}=pg, JOB='council_weekly_decisions';
const START=Math.max(2010,Math.min(new Date().getUTCFullYear(),Number(process.env.COUNCIL_BACKFILL_FROM_YEAR||2024)));
const LIMIT=Math.max(1,Math.min(25,Number(process.env.COUNCIL_WEEKLY_FETCH_LIMIT||12)));
const INDEX=year=>'https://www.wexfordcoco.ie/planning/planning-applications/planning-lists/planning-lists-for-'+year;
const started=Date.now();
function urlCheck(raw){const u=new URL(raw);if(u.protocol!=='https:'||u.hostname!=='www.wexfordcoco.ie')throw Error('Invalid official URL '+raw);return u.href;}
async function fetchOfficial(raw,pdf=false){
 const res=await fetch(urlCheck(raw),{headers:{'User-Agent':'OpenList public planning council weekly lists'},signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw Error('Council HTTP '+res.status);
 if(!pdf)return res.text();
 const bytes=Buffer.from(await res.arrayBuffer());
 if(bytes.length<500||bytes.length>15000000||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid council PDF');
 return bytes;
}
async function extract(url){
 const bytes=await fetchOfficial(url,true),sha256=createHash('sha256').update(bytes).digest('hex');
 const dir=await mkdtemp(join(tmpdir(),'council-weekly-'));
 try {
   const path=join(dir,'source.pdf');await writeFile(path,bytes);
   const errs=[];
   for(const mode of ['-raw','-layout'])try {
      const {stdout}=await exec('pdftotext',[mode,'-enc','UTF-8',path,'-'],{timeout:30000,maxBuffer:20000000});
      const parsed=parseWexfordDecisionText(stdout,url);
      if(parsed.total>=10&&parsed.decisions.length<5)throw Error('Low extraction coverage');
      return {...parsed,sha256};
   }catch(e){errs.push(mode+':'+String(e.message||e).slice(0,140));}
   throw Error(errs.join('; '));
 }finally{await rm(dir,{recursive:true,force:true});}
}
function weekEnding(url){
 const m=decodeURIComponent(url).match(/w\.e\s*(\d{1,2})\.(\d{1,2})\.(20\d{2})/i);
 return m?m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'):null;
}
async function discover(){
 const docs=[],years=[];
 for(let year=new Date().getUTCFullYear();year>=START;year--){
   const html=await fetchOfficial(INDEX(year));
   const links=findWexfordDecisionLinks(html,INDEX(year));
   docs.push(...links.map(url=>({url,week:weekEnding(url),year})));
   years.push({year,documents:links.length});
 }
 return {years,docs:[...new Map(docs.map(d=>[d.url,d])).values()]
  .sort((a,b)=>String(b.week||'').localeCompare(String(a.week||'')))};
}
const {years,docs}=await discover();
if(process.argv.includes('--dry-run')){
 const recent=[];
 for(const doc of docs.slice(0,3)){const p=await extract(doc.url);recent.push({week:doc.week,total:p.total,parsed:p.decisions.length,url:doc.url});}
 console.log(JSON.stringify({dryRun:true,years,indexed:docs.length,recent},null,2));process.exit(0);
}
if(!process.env.WORKER_DATABASE_URL)throw Error('WORKER_DATABASE_URL required');
const db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();let seeded=0,complete=0,failed=0;const reports=[];
try{
 for(const {url,week,year} of docs){
   const key='WEXFORD:'+createHash('sha256').update(url).digest('hex').slice(0,24);
   const r=await db.query("insert into work_items(job_type,work_key,input,status,available_at,updated_at) values($1,$2,$3::jsonb,'pending',now(),now()) on conflict(job_type,work_key) do nothing returning id",
    [JOB,key,JSON.stringify({authority:'WEXFORD',url,week_ending:week,archive_year:year})]);seeded+=r.rowCount;
 }
 const {rows}=await db.query("select id,input,attempts from work_items where job_type=$1 and status='pending' and applied_at is null and available_at<=now() and input->>'authority'='WEXFORD' order by input->>'week_ending' desc nulls last,id desc limit $2",[JOB,LIMIT]);
 for(const item of rows){
   if(Date.now()-started>25*60*1000)break;
   try{
     const p=await extract(item.input.url);
     const decisions=p.decisions.map(d=>({reference:d.reference,decision_date:d.decisionDate,decision_text:d.decisionText,registration_date:d.applicationDate,source_url:d.sourceUrl}));
     const result={ok:true,authority:'WEXFORD',url:item.input.url,week_ending:item.input.week_ending,sha256:p.sha256,total:p.total,decisions,parser_version:1,checked_at:new Date().toISOString()};
     await db.query("update work_items set status='completed',result=$2::jsonb,attempts=attempts+1,completed_at=now(),last_error=null,updated_at=now() where id=$1",[item.id,JSON.stringify(result)]);
     complete++;reports.push({week:item.input.week_ending,parsed:decisions.length,total:p.total});
     await new Promise(resolve=>setTimeout(resolve,700)); // Keep bulk historical council downloads deliberately paced.
   }catch(e){
     const attempts=Number(item.attempts||0)+1;
     await db.query("update work_items set attempts=$2,status=case when $2>=4 then 'failed' else 'pending' end,available_at=now()+interval '12 hours',last_error=$3,updated_at=now() where id=$1",[item.id,attempts,String(e.message||e).slice(0,500)]);
     failed++;reports.push({week:item.input.week_ending,error:String(e.message||e).slice(0,150)});
   }
 }
 const counts=await db.query("select status,count(*)::integer as n from work_items where job_type=$1 and input->>'authority'='WEXFORD' group by status",[JOB]);
 console.log(JSON.stringify({indexed:docs.length,years,seeded,complete,failed,queue:counts.rows,reports},null,2));
 if(failed&&!complete)process.exitCode=1;
}finally{await db.end();}
