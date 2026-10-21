// Cork County Council's public MapAlerts weekly lists; independent of Agile API.
// Strict new-application parser: grant/refusal/Decision Made is never a new record.
export const CORK_MAPALERTS_INDEX="https://mapalerts.corkcoco.ie/en/alerts?view=form";
export const CORK_MAPALERTS_CUTOFF="2026-08-01";
const MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
const ENTITIES={amp:"&",quot:'"',apos:"'",nbsp:" ",lt:"<",gt:">",ndash:"–",mdash:"—",rsquo:"’",ldquo:"“",rdquo:"”",euro:"€"};
export function decodeCouncilHtml(value) {
 return String(value||"").replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi,(s,n,w)=>{
  if(n){const v=n.toLowerCase().startsWith("x")?parseInt(n.slice(1),16):parseInt(n,10);return v>=32&&v<=0x10ffff?String.fromCodePoint(v):" ";}
  return ENTITIES[w.toLowerCase()]??s;
 });
}
const clean=value=>decodeCouncilHtml(String(value||"").replace(/<[^>]*>/g," "))
 .replace(/\s+/g," ").trim();
export function mapalertsDate(value){
 const s=String(value||"").trim();
 let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/);
 if(!m)m=s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})$/);
 let day,month,year;
 if(!m)return null;
 if(/^\d/.test(m[1])){day=Number(m[1]);month=Number(m[2]);year=Number(m[3]);}
 else {day=Number(m[2]);month=MONTHS[m[1].slice(0,3).toLowerCase()];year=Number(m[3]);}
 if(!month)return null;
 const date=new Date(Date.UTC(year,month-1,day));
 return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?
  date.toISOString().slice(0,10):null;
}
export function discoverCorkMapalertWeeks(html,base=CORK_MAPALERTS_INDEX){
 const urls=new Map();
 for(const match of String(html||"").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
  const href=match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  if(!href)continue;
  const text=clean(match[2]);
  const m=text.match(/Weekly Planning Alert,\s*(\d{1,2}\/\d{1,2}\/20\d{2})/i);
  if(!m)continue;
  const week_ending=mapalertsDate(m[1]);
  if(!week_ending||week_ending<CORK_MAPALERTS_CUTOFF)continue;
  const url=new URL(decodeCouncilHtml(href),base);
  if(url.protocol!=="https:"||url.hostname!=="mapalerts.corkcoco.ie"||
     !/^\/(?:en\/|ga\/)?alerts\/item$/i.test(url.pathname)||!url.searchParams.has("ref"))continue;
  urls.set(url.searchParams.get("ref"),{url:url.href,week_ending,authority:"CORKCOCO",type:"html"});
 }
 return [...urls.values()].sort((a,b)=>b.week_ending.localeCompare(a.week_ending));
}
function asLines(html){
 // Preserve h3/field boundaries and separately use title as a reliable row start.
 return decodeCouncilHtml(String(html||"")
   .replace(/<script\b[\s\S]*?<\/script>/gi," ")
   .replace(/<style\b[\s\S]*?<\/style>/gi," ")
   .replace(/<br\b[^>]*\/?>/gi,"\n")
   .replace(/<\/(?:p|h[1-6]|li|article|section|div|tr|ul|ol)>/gi,"\n")
   .replace(/<(?:h[1-6]|p|li|article|section|tr)\b[^>]*>/gi,"\n")
   .replace(/<[^>]+>/g," "))
   .replace(/\r/g,"").split("\n").map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
}
export function parseCorkMapalertsReceived(html,url,cutoff=CORK_MAPALERTS_CUTOFF){
 const lines=asLines(html);
 const header=lines.findIndex(l=>/^Weekly Planning Alert,\s*\d{1,2}\/\d{1,2}\/20\d{2}$/i.test(l));
 if(header<0||!lines.some(l=>/New and decided planning application updates issued by Cork County Council/i.test(l)))
  throw Error("Not a Cork County weekly planning alert");
 const applicationRows=[];
 let skipped=0,found=0;
 // A row is anchored by "File Number", cross-checked with the preceding
 // Permission // Location heading, followed by an explicit "Application Received".
 for(let i=header+1;i<lines.length;i++){
  const number=lines[i].match(/^File Number:\s*(\d{2}\/\d{4,6})\s*$/i);
  if(!number)continue;
  found++;
  const start=Math.max(header+1,i-14);
  let heading=-1;
  for(let j=i-1;j>=start;j--)if(/^(Permission(?:\s+for\s+Retention|\s+Consequent)?|Retention)\s*\/\/\s*(.+)$/i.test(lines[j])){heading=j;break;}
  if(heading<0){skipped++;continue;}
  const headingMatch=lines[heading].match(/^(Permission(?:\s+for\s+Retention|\s+Consequent)?|Retention)\s*\/\/\s*(.+)$/i);
  const after=lines.slice(i+1,Math.min(i+12,lines.length));
  const status=after.find(x=>/^Status:\s*/i.test(x))?.replace(/^Status:\s*/i,"");
  const received=after.find(x=>/^Received:\s*/i.test(x))?.replace(/^Received:\s*/i,"");
  const decision=after.find(x=>/^Decision:\s*/i.test(x))?.replace(/^Decision:\s*/i,"");
  const decisionDate=after.find(x=>/^Decision Date:\s*/i.test(x))?.replace(/^Decision Date:\s*/i,"");
  const registration_date=mapalertsDate(received);
  const location=headingMatch[2].trim();
  const proposal=lines.slice(heading+1,i).filter(x=>!/^Applicant:\s*/i.test(x)).join(" ").trim();
  const application_type=headingMatch[1];
  const reference=number[1];
  // Do NOT treat administrative follow-ups and previously decided cases as new.
  if(!registration_date||registration_date<cutoff||
     !/^\s*Application Received\s*$/i.test(decision||"")||
     (decisionDate&&!/^(?:N\/A|-|None)$/i.test(decisionDate))||
     !status||status.toLowerCase()!==application_type.toLowerCase()||
     location.length<7||proposal.length<22||proposal.length>3000||
     location.length>1000||/\b(?:view on cork county council planning system|cookie preferences)\b/i.test(proposal)){
    skipped++;continue;
  }
  applicationRows.push({reference,web_reference:reference,registration_date,
   application_type,location,proposal,source_url:url});
 }
 if(found<5||applicationRows.length<3)throw Error("Cork weekly alert has too few valid application records");
 const seen=new Map();
 for(const row of applicationRows){
  const old=seen.get(row.reference);
  if(old&&(old.registration_date!==row.registration_date||
     old.proposal!==row.proposal))throw Error("Conflicting Cork alert entries "+row.reference);
  seen.set(row.reference,row);
 }
 return {applications:[...seen.values()],headers:found,skipped,week:mapalertsDate(lines[header].split(",").slice(1).join(",").trim())};
}
