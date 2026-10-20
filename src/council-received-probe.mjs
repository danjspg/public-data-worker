// Read-only check of four official council "applications received" formats.
// Sensitive applicant names and full freeform descriptions are deliberately omitted.
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile as cb} from "node:child_process";
import {promisify} from "node:util";
import {dublinDocLinks,dublinDocxXmlText,DUBLIN_CITY_INDEX} from "./council-weekly-dublincity.mjs";
import {FINGAL_INDEX} from "./council-weekly-fingal.mjs";
const exec=promisify(cb);
const WEXFORD="https://www.wexfordcoco.ie/planning/planning-applications/planning-lists/planning-lists-for-2026";
const SOUTH="https://planning.southdublin.ie/Home/WeeklyLists";
async function fetchSource(url){
 const u=new URL(url);
 if(u.protocol!=="https:"||!["www.wexfordcoco.ie","planning.southdublin.ie","www.fingal.ie","www.dublincity.ie"].includes(u.hostname))throw Error("Untrusted council source");
 const r=await fetch(u,{signal:AbortSignal.timeout(35000),headers:{"User-Agent":"OpenList official weekly applications audit"}});
 if(!r.ok)throw Error("Council source returned "+r.status+" "+u.hostname);
 return Buffer.from(await r.arrayBuffer());
}
async function convert(url,mode){
 const bytes=await fetchSource(url);
 const dir=await mkdtemp(join(tmpdir(),"council-received-probe-"));
 try{
  const file=join(dir,mode==="pdf"?"source.pdf":mode==="doc"?"source.doc":"source.docx");
  await writeFile(file,bytes);
  if(mode==="pdf"){
   if(bytes.subarray(0,5).toString()!=="%PDF-")throw Error("Source is not PDF");
   const {stdout}=await exec("pdftotext",["-raw",file,"-"],{timeout:30000,maxBuffer:15000000});return stdout;
  }
  if(mode==="doc"){
   const {stdout}=await exec("antiword",["-w","0",file],{timeout:30000,maxBuffer:15000000});return stdout;
  }
  if(bytes.subarray(0,2).toString()!=="PK")throw Error("Source is not DOCX");
  const {stdout}=await exec("unzip",["-p",file,"word/document.xml"],{timeout:30000,maxBuffer:15000000});
  return dublinDocxXmlText(stdout);
 }finally{await rm(dir,{recursive:true,force:true});}
}
function getLinks(html,start,end,filter,base){
 const a=html.search(start),b=a>=0?html.slice(a).search(end):-1;
 if(a<0||b<0)throw Error("Cannot identify council section");
 const segment=html.slice(a,a+b);
 const links=[...segment.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)]
  .map(m=>new URL(m[1].replace(/&amp;/g,"&"),base).href).filter(filter);
 if(!links.length)throw Error("Section contains no document links");
 return [...new Set(links)];
}
const wexHtml=(await fetchSource(WEXFORD)).toString("utf8");
const wex=getLinks(wexHtml,/Valid Planning Applications Received/i,/Invalid Planning Applications Received/i,
 u=>u.includes("wexfordcoco.ie")&&/\.pdf$/i.test(new URL(u).pathname),WEXFORD);
const sdHtml=(await fetchSource(SOUTH)).toString("utf8");
const south=[...sdHtml.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
 .filter(m=>/1\s+Applications Received/i.test(m[2].replace(/<[^>]+>/g,"")))
 .map(m=>new URL(m[1].replace(/&amp;/g,"&"),SOUTH).href);
const fingalHtml=(await fetchSource(FINGAL_INDEX)).toString("utf8");
const fingalRow=[...fingalHtml.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
 .find(m=>/\bweek\s*41\b/i.test(m[0]));
if(!fingalRow)throw Error("No Fingal week 41");
const fingalLinks=[...fingalRow[0].matchAll(/href\s*=\s*["']([^"']+\.doc(?:\?[^"']*)?)["']/gi)]
 .map(m=>new URL(m[1].replace(/&amp;/g,"&"),FINGAL_INDEX).href);
const dublinHtml=(await fetchSource(DUBLIN_CITY_INDEX)).toString("utf8");
const dublin=dublinDocLinks(dublinHtml);
const probes=[
 {council:"WEXFORD",url:wex.at(-1),mode:"pdf"},
 {council:"SOUTHDUBLIN",url:south[0],mode:"pdf"},
 {council:"FINGAL",url:fingalLinks[0],mode:"doc"},
 {council:"DUBLINCITY",url:dublin[0].url,mode:"docx"}
];
const safe=x=>x.replace(/\b[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*\b/g,word=>
 /^(?:APPLICATION|APPLICATIONS|RECEIVED|VALID|PERMISSION|RETENTION|NEW|DATE|REGISTERED|REG|REF|TYPE|DESCRIPTION|PROPOSAL|LOCATION|DECISION|ADDITIONAL|INFORMATION|SUBMISSION|WEEK|OF|FROM|TO|APPLICANT|COMMERCIAL|DOMESTIC|GRANT|REFUSE|FILE|NOTIFICATION|ADDRESS|PUBLIC|PLANNING|REPORT|AND)$/i.test(word)?word.toUpperCase():"x");
const report=[];
for(const probe of probes){
 if(!probe.url)throw Error("No "+probe.council+" applications received URL");
 const text=await convert(probe.url,probe.mode);
 const refExp={
  WEXFORD:/\b20\d{6}W?\b/g,
  SOUTHDUBLIN:/\bSDZ?\d{2}[AB]\/\d{4}W?\b/gi,
  FINGAL:/\b(?:FW?\d{2}[AB]\/\d{4}E?|LRD\d{4}\/S3E?)\b/gi,
  DUBLINCITY:/(?<![A-Za-z0-9])(?:WEBDSDZ|WEB|DSDZ|LRD)?\d{3,5}\/26(?!\d)/gi
 }[probe.council];
 const refs=[...new Set([...text.matchAll(refExp)].map(m=>m[0]))];
 const contexts=refs.slice(0,5).map(ref=>{
  const at=text.indexOf(ref);
  return {ref,maskedContext:safe(text.slice(Math.max(0,at-90),at+220)).replace(/\s+/g," ").slice(0,250)};
 });
 report.push({council:probe.council,source:probe.url,bytesOfExtractedText:text.length,uniqueReferences:refs.length,
  sampleReferences:refs.slice(0,10),maskedHeader:safe(text.slice(0,650)).replace(/\s+/g," ").slice(0,500),
  contexts});
}
console.log(JSON.stringify({readOnly:true,wexfordDocLinks:wex.length,southDublinOnFirstPage:south.length,report},null,2));
