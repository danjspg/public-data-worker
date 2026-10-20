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
for(const row of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)){
 const week=row[0].match(/\bweek\s*(\d{1,2})\b/i);
 if(!week||Number(week[1])<32)continue;
 const links=[...row[0].matchAll(/href\s*=\s*["']([^"']+\.doc(?:\?[^"']*)?)["']/gi)];
 const urls=links.map(match=>new URL(match[1].replace(/&amp;/g,"&"),INDEX))
   .filter(u=>u.hostname==="www.fingal.ie" && /decisions?\W*made/i.test(decodeURIComponent(u.pathname))
     && !/appeals?/i.test(decodeURIComponent(u.pathname)));
 if(urls.length!==1)throw Error("Fingal week "+week[1]+" decision link ambiguous: "+urls.length);
 docs.push({url:urls[0].href,week:Number(week[1])});
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
   const allowed=/^(?:GRANT|PERMISSION|REFUSE|REFUSED|REFUSAL|INFORMATION|ADDITIONAL|DECISION|DATE|APPLICATION|MADE|INVALID|NOTIFIED|REG|REF|REQUEST|CONDITIONS|RECEIVED)$/i;
   const diagnostic=refs.slice(0,5).map(ref=>{
     const at=stdout.indexOf(ref);
     const nearby=stdout.slice(Math.max(0,at-65),at+100);
     const redacted=nearby.replace(/[A-Za-z]{2,}/g,token=>allowed.test(token)?token.toUpperCase():"x");
     return {ref,around:redacted.replace(/\s+/g," ").slice(0,165)};
   });
   reports.push({week:doc.week,url:doc.url,bytes:bytes.length,chars:stdout.length,uniqueReferences:refs.length,dateHits,
     sampleReferences:refs.slice(0,15),diagnostic,grantMentions:(stdout.match(/\bGRANT(?:ED)?\b/gi)||[]).length,
     refusalMentions:(stdout.match(/\bREFUS(?:ED|AL)\b/gi)||[]).length});
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({researchOnly:true,cutoff:"2026-08-01",discovered:docs.length,documents:reports},null,2));
