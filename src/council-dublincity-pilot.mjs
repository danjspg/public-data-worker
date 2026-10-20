// Read-only Dublin City Council weekly DOCX compatibility check.
// Fetches only the five official Area documents from the latest week. No database writes.
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
const exec=promisify(cb);
const INDEX="https://www.dublincity.ie/planning-and-land-use/find-planning-application/weeks-planning-applications-and-decisions";
async function council(url){
 const u=new URL(url);
 if(u.protocol!=="https:"||!["www.dublincity.ie","dublincity.ie"].includes(u.hostname))throw Error("Untrusted Dublin City URL");
 const r=await fetch(u,{signal:AbortSignal.timeout(30000),headers:{"User-Agent":"OpenList council planning published weekly lists"}});
 if(!r.ok)throw Error("Dublin City HTTP "+r.status);
 return Buffer.from(await r.arrayBuffer());
}
const html=(await council(INDEX)).toString("utf8");
const docs=[];
for(const m of html.matchAll(/href\s*=\s*["']([^"']+\.docx)["']/gi)){
 const url=new URL(m[1].replace(/&amp;/g,"&"),INDEX);
 const decoded=decodeURIComponent(url.pathname);
 if(!/^\/sites\/default\/files\//.test(decoded))continue;
 const hit=decoded.match(/\/a([1-5])-wpl-(\d{1,2})-26(?:_\d+)?\.docx$/i);
 if(!hit || Number(hit[2])<32)continue;
 if(url.hostname!=="www.dublincity.ie")continue;
 docs.push({url:url.href,area:Number(hit[1]),week:Number(hit[2])});
}
if(docs.length<10||docs.length>60)throw Error("Unexpected official Dublin City DOCX coverage: "+docs.length);
docs.sort((a,b)=>b.week-a.week||a.area-b.area);
const newestWeek=docs[0].week;
const current=docs.filter(d=>d.week===newestWeek);
if(current.length!==5)throw Error("Current Dublin City week does not include all five electoral areas");
function paragraphs(xml){
 const text=xml.replace(/<w:tab\b[^>]*\/>/g,"\t")
  .replace(/<\/w:p>/g,"\n")
  .replace(/<[^>]+>/g,"")
  .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&apos;/g,"'");
 return text;
}
const reports=[];
for(const doc of current){
 const bytes=await council(doc.url);
 if(bytes.length<500||bytes.length>15000000||bytes.subarray(0,2).toString()!=="PK")throw Error("Invalid official DOCX");
 const dir=await mkdtemp(join(tmpdir(),"dublin-weekly-"));
 try{
  const path=join(dir,"source.docx");await writeFile(path,bytes);
  const {stdout:xml}=await exec("unzip",["-p",path,"word/document.xml"],{timeout:30000,maxBuffer:20000000});
  const text=paragraphs(xml);
  const refs=[...new Set([...text.matchAll(/(?<![A-Za-z0-9])(?:WEBDSDZ|WEB|DSDZ|LRD)?\d{3,5}\/26(?!\d)/gi)].map(x=>x[0].toUpperCase()))];
  const redactedWindows=[...text.matchAll(/(?:WEB|LRD|REF(?:ERENCE)?|REG(?:ISTRATION)?)[^\n]{0,45}/gi)]
   .slice(0,12).map(m=>m[0].replace(/[A-Za-z]{2,}/g,t=>/^(WEB|LRD|REF|REFERENCE|REG|REGISTRATION)$/i.test(t)?t.toUpperCase():"x").replace(/\s+/g," ").slice(0,65));
  const safe=(value)=>value.replace(/[A-Za-z][A-Za-z'-]*/g,word=>
   /^(GRANT|GRANTED|REFUSE|REFUSED|REFUSAL|PERMISSION|DECISION|INVALID|APPLICATION|INFORMATION|ADDITIONAL|DATE|REG|REF|RECEIVED|WITHDRAWN|FINAL|CONDITIONS|REQUEST|MADE|FILE|REGISTERED|SUBJECT|TO|OF|NOTIFIED|RETENTION|DECISIONS|APPEALS|NEW|APPLICATIONS)$/i.test(word)?word.toUpperCase():"x");
  const windows=refs.slice(0,6).map(ref=>{
    const at=text.indexOf(ref);
    return {ref,window:safe(text.slice(Math.max(0,at-120),at+330)).slice(0,450)};
  });
  const sectionMatches=[...text.matchAll(/.{0,25}(?:DECISION|GRANT|REFUSE|APPLICATIONS|NOTIFICATIONS).{0,35}/gi)]
    .slice(0,8).map(m=>safe(m[0]).replace(/\s+/g," "));
  const documentHeader=safe(text.slice(0,1500)).replace(/\n{3,}/g,"\n\n");
  const outcomeSamples=[...text.matchAll(/\b(?:GRANT(?:ED)?(?:\s+PERMISSION)?|REFUS(?:E|ED|AL)(?:\s+PERMISSION)?|INVALID\s+APPLICATION)\b/gi)]
    .slice(0,14).map(m=>({term:m[0].toUpperCase(),sample:safe(text.slice(Math.max(0,m.index-100),m.index+110)).replace(/\s+/g," ").slice(0,220)}));
  reports.push({area:doc.area,week:doc.week,url:doc.url,xmlChars:xml.length,textChars:text.length,
   sampleRefs:refs.slice(0,10),referenceCount:refs.length,redactedWindows,windows,sectionMatches,documentHeader,outcomeSamples,
   grantMentions:(text.match(/\bGRANT(?:ED)?\b/gi)||[]).length,
   refuseMentions:(text.match(/\bREFUS(?:ED|AL)\b/gi)||[]).length,
   decisionHeadings:(text.match(/DECISIONS?\s+(?:MADE|GRANTED|REFUSED)/gi)||[]).length});
 }finally{await rm(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({readOnly:true,latestWeek:newestWeek,availableRecentDocuments:docs.length,reports},null,2));
