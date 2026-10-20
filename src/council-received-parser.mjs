// Official council weekly applications-received records.
// Names are deliberately omitted; AI submissions are not new registrations.
export const CUTOFF="2026-08-01";
const MONTHS=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
export function receivedDate(v){
 let m=String(v||"").trim().match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);let y,mon,day;
 if(m){day=+m[1];mon=+m[2]-1;y=+m[3];}
 else {m=String(v||"").trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(20\d{2})$/);
  if(!m||!MONTHS.includes(m[2].toLowerCase()))return null;
  day=+m[1];mon=MONTHS.indexOf(m[2].toLowerCase());y=+m[3];}
 const d=new Date(Date.UTC(y,mon,day));
 return d.getUTCFullYear()===y&&d.getUTCMonth()===mon&&d.getUTCDate()===day?d.toISOString().slice(0,10):null;
}
const norm=x=>String(x||"").replace(/\s+/g," ").trim();
function field(body,label,endLabels){
 const m=new RegExp("(?:^|\\n)\\s*"+label+"\\s*:\\s*","im").exec(body);
 if(!m)return "";
 const rest=body.slice(m.index+m[0].length);
 const end=new RegExp("\\n\\s*(?:"+endLabels.join("|")+")\\s*:","im").exec(rest);
 return norm(end?rest.slice(0,end.index):rest).slice(0,3000);
}
function complete(x){return x.registration_date>=CUTOFF && x.registration_date<=new Date(Date.now()+86400000).toISOString().slice(0,10)
 && x.location?.length>=7&&x.proposal?.length>=24;}
export function parseWexfordReceived(text,url){
 const raw=String(text||"").replace(/\r/g,"").replace(/\f/g,"\n");
 if(!/Valid Applications Received from/i.test(raw))throw Error("Unexpected Wexford received PDF");
 const hits=[...raw.matchAll(/(?<![A-Za-z0-9])(20\d{6}W)\s+(\d{2}\/\d{2}\/20\d{2})\b/gim)];
 if(!hits.length)throw Error("No Wexford application headers");
 const applications=[],seen=new Set();let skipped=0;
 for(let i=0;i<hits.length;i++){
  const h=hits[i],date=receivedDate(h[2]);
  const body=raw.slice(h.index+h[0].length,hits[i+1]?.index??raw.length);
  // PDF text sometimes wraps application type and applicant into separate columns;
  // the reference+date pair is a stronger header boundary than type alone.
  const beforeLocation=body.split(/\bLocation\s*:/i)[0].slice(0,240);
  const applicationType=/\b(Permission\s+and\s+Retention|Permission\s+for\s+Retention|Permission|Retention)\b/i.exec(beforeLocation)?.[1];
  const x={reference:h[1].slice(0,-1).toUpperCase(),web_reference:h[1].toUpperCase(),registration_date:date,
   application_type:norm(applicationType),location:field(body,"Location",["Proposal","EIA Status"]),
   proposal:field(body,"Proposal",["EIA Status","Location"]),source_url:url};
  if(!date||!applicationType||!complete(x)||seen.has(x.reference)){skipped++;continue;}
  seen.add(x.reference);applications.push(x);
 }
 return {applications,headers:hits.length,skipped};
}
export function parseSouthDublinReceived(text,url){
 const raw=String(text||"").replace(/\r/g,"").replace(/\f/g,"\n");
 if(!/APPLICATIONS RECEIVED LIST/i.test(raw))throw Error("Unexpected South Dublin received PDF");
 const header=/^(SDZ?\d{2}[AB]\/\d{4}W?)\s+(\d{1,2}\s+[A-Za-z]{3}\s+20\d{2})\s+(Permission(?: and Retention)?|Retention)\s+(New Application|Additional Information|Clarification of Additional Information|Significant Additional Information)\s*$/gim;
 const hits=[...raw.matchAll(header)];if(!hits.length)throw Error("No South Dublin received headers");
 const applications=[],seen=new Set();let skipped=0;
 for(let i=0;i<hits.length;i++){
  const h=hits[i],date=receivedDate(h[2]);
  if(!date||date<CUTOFF||h[4].toLowerCase()!=="new application"){skipped++;continue;}
  const body=raw.slice(h.index+h[0].length,hits[i+1]?.index??raw.length);
  const x={reference:h[1].toUpperCase(),web_reference:h[1].toUpperCase(),registration_date:date,
   application_type:norm(h[3]),location:field(body,"Location",["Description","Applicant"]),
   proposal:field(body,"Description",["Applicant","Location"]),source_url:url};
  if(!complete(x)||seen.has(x.reference)){skipped++;continue;}
  seen.add(x.reference);applications.push(x);
 }
 return {applications,headers:hits.length,skipped};
}
export function fingalReceivedCandidates(text){
 const references=[...new Set([...String(text||"").matchAll(/\b(?:FW?\d{2}[AB]\/\d{4}E?|LRD\d{4}\/S3E?)\b/gi)].map(x=>x[0].toUpperCase()))];
 return {applications:[],candidate_references:references,headers:references.length,skipped:references.length};
}
export function dublinCityReceivedCandidates(text){
 const references=[...new Set([...String(text||"").matchAll(/(?<![A-Za-z0-9])(?:WEBDSDZ|WEB|DSDZ|LRD)?\d{3,5}\/26(?!\d)/gi)].map(x=>x[0].toUpperCase()))];
 return {applications:[],candidate_references:references,headers:references.length,skipped:references.length};
}
