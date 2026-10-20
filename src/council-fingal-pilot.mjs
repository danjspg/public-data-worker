// Read-only compatibility probe of Fingal County Council's official weekly DOC lists.
// The council publishes Word .doc, not PDFs; no worker queue or production writes.
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(cb);
const INDEX="https://www.fingal.ie/ga/council/service/planning-weekly-lists";
async function fetchCouncil(url){
 const u=new URL(url);
 if(u.protocol!=="https:"||u.hostname!=="www.fingal.ie")throw Error("Nonofficial Fingal URL");
 const res=await fetch(u,{signal:AbortSignal.timeout(30000),headers:{"User-Agent":"OpenList council planning weekly lists audit"}});
 if(!res.ok)throw Error("Council HTTP "+res.status);
 return Buffer.from(await res.arrayBuffer());
}
const html=(await fetchCouncil(INDEX)).toString("utf8");
const docs=[];
for(const match of html.matchAll(/href\s*=\s*["']([^"']+\.doc(?:\?[^"']*)?)["']/gi)){
 const candidate=new URL(match[1].replace(/&amp;/g,"&"),INDEX);
 const decoded=decodeURIComponent(candidate.pathname);
 if(candidate.hostname!=="www.fingal.ie"||!decoded.includes("planning-weekly-lists/2026 Week "))continue;
 if(!/\/decisions-made[^/]*\.doc$/i.test(decoded))continue;
 const week=decoded.match(/20(26)\s*Week\s*(\d{1,2})/i);
 if(!week || Number(week[2])<32)continue;
 if(!docs.some(d=>d.url===candidate.href))docs.push({url:candidate.href,week:Number(week[2])});
}
docs.sort((a,b)=>b.week-a.week);
if(docs.length<5||docs.length>25)throw Error("Fingal weekly DOC discovery unexpected count: "+docs.length);
const reports=[];
for(const doc of docs.slice(0,3)){
 const bytes=await fetchCouncil(doc.url);
 if(bytes.length<200||bytes.length>12000000)throw Error("Invalid Fingal weekly DOC size");
 const dir=await mkdtemp(join(tmpdir(),"fingal-doc-"));
 try{
   const file=join(dir,"fingal.doc");
   await writeFile(file,bytes);
   const {stdout}=await exec("antiword",["-w","0",file],{timeout:30000,maxBuffer:20000000});
   const refs=[...new Set([...stdout.matchAll(/\b(?:FW?\d{2}A\/\d{4}E?|LRD\d{4}\/S3E?|FW?\d{2}B\/\d{4}E?)\b/gi)].map(x=>x[0].toUpperCase()))];
   const dateHits=[...stdout.matchAll(/\b(?:[0-3]?\d\/[01]?\d\/20\d{2}|[0-3]?\d-[01]?\d-20\d{2})\b/g)].length;
   reports.push({week:doc.week,url:doc.url,bytes:bytes.length,chars:stdout.length,uniqueReferences:refs.length,dateHits,
     sampleReferences:refs.slice(0,15),grantMentions:(stdout.match(/\bGRANT(?:ED)?\b/gi)||[]).length,
     refusalMentions:(stdout.match(/\bREFUS(?:ED|AL)\b/gi)||[]).length});
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({researchOnly:true,cutoff:"2026-08-01",discovered:docs.length,documents:reports},null,2));
