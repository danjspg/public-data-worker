// Dublin City Council's official five-area weekly .docx source.
// Parse structured APPLICATION ... outcome ... DATE fields, never description text.
export const DUBLIN_CITY_INDEX="https://www.dublincity.ie/planning-and-land-use/find-planning-application/weeks-planning-applications-and-decisions";
export const DUBLIN_CITY_CUTOFF="2026-08-01";
const ref="(?:WEBDSDZ|WEB|DSDZ|LRD)?[0-9]{3,5}/(?:2[0-6]|20[0-2][0-6])";
export const DUBLIN_CITY_REF=new RegExp("^"+ref+"$","i");
export function dublinIsoDate(value){
 const m=String(value||"").match(new RegExp("^([0-9]{2})/([0-9]{2})/(20[0-9]{2})$"));
 if(!m)return null;
 const iso=m[3]+"-"+m[2]+"-"+m[1],dt=new Date(iso+"T00:00:00Z");
 return Number.isNaN(dt.valueOf())||dt.toISOString().slice(0,10)!==iso?null:iso;
}
export function dublinDocLinks(html,index=DUBLIN_CITY_INDEX,minWeek=32){
 const docs=[];
 for(const m of String(html).matchAll(/href\s*=\s*["']([^"']+\.docx)["']/gi)){
  const url=new URL(m[1].replace(/&amp;/g,"&"),index);
  if(url.protocol!=="https:"||url.hostname!=="www.dublincity.ie"||!url.pathname.startsWith("/sites/default/files/"))continue;
  const file=decodeURIComponent(url.pathname).match(/\/a([1-5])-wpl-(\d{1,2})-26(?:_\d+)?\.docx$/i);
  if(!file||Number(file[2])<minWeek)continue;
  docs.push({url:url.href,area:Number(file[1]),week:Number(file[2])});
 }
 const unique=[...new Map(docs.map(x=>[x.url,x])).values()].sort((a,b)=>b.week-a.week||a.area-b.area);
 if(unique.length<5||unique.length>80)throw Error("Invalid Dublin City archive size "+unique.length);
 return unique;
}
export function dublinDocxXmlText(xml){
 // XML entities and fragments combine words; retain paragraph boundaries.
 const text=String(xml||"").replace(/<w:tab\b[^>]*\/>/g,"\t").replace(/<\/w:p>/g,"\n")
  .replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<")
  .replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'");
 if(text.length<400||!/\bAPPLICATION/i.test(text))throw Error("Dublin City DOCX text invalid");
 return text;
}
export function parseDublinCityDecisions(text,url,cutoff=DUBLIN_CITY_CUTOFF){
 const input=String(text||"");
 const regex=new RegExp("(?<![A-Za-z0-9])("+ref+")(?![0-9])\\s*APPLICATION\\b","gi");
 const markers=[...input.matchAll(regex)];
 if(markers.length<3)throw Error("Dublin City DOCX lacks planning record markers");
 let excluded=0;
 const records=[],seen=new Map();
 for(const hit of markers){
  const refNum=hit[1].toUpperCase();
  // Decision is immediately before DATE in the official record header. No
  // searches in body/description or across the next application.
  const head=input.slice(hit.index+hit[0].length,hit.index+hit[0].length+270);
  const dateMarker=head.match(new RegExp("\\bDATE\\s*([0-9]{2}/[0-9]{2}/20[0-9]{2})","i"));
  if(!dateMarker){excluded++;continue;}
  const beforeDate=head.slice(0,dateMarker.index);
  const date=dublinIsoDate(dateMarker[1]);
  if(!date||date<cutoff){excluded++;continue;}
  // Real DOCX record headers use GRANT, GRANT PERMISSION or REFUSE.
  // FI, INVAL, registration notices and appeals remain excluded.
  if(/\b(?:ADDITIONAL INFORMATION|INVALID|WITHDRAWN|REGISTRATION|APPEAL)\b/i.test(beforeDate)){
   excluded++;continue;
  }
  const matches=[...beforeDate.matchAll(/\b(GRANT(?:\s+(?:PERMISSION|RETENTION))?|REFUSE(?:\s+PERMISSION)?)\b/gi)];
  if(matches.length!==1){excluded++;continue;}
  const decision_text=/^REFUS/i.test(matches[0][1])?"Refused":"Granted";
  const next={reference:refNum,decision_date:date,decision_text,registration_date:null,source_url:url};
  const old=seen.get(refNum);
  if(old&&(old.decision_date!==date||old.decision_text!==decision_text))throw Error("Conflicting Dublin City decisions for "+refNum);
  if(!old){seen.set(refNum,next);records.push(next);}
 }
 return {decisions:records,markers:markers.length,excluded};
}
