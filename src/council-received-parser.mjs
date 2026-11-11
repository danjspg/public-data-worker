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
// A South Dublin PDF can repeat a full legal header mid-sentence when a
// description crosses pages. Removing only the fully matched page furniture
// prevents false planning text; an incomplete header makes the row ineligible.
const SOUTH_DUBLIN_PAGE_FURNITURE=/APPLICATIONS RECEIVED LIST\s+Page\s+\d+\s+Of\s+\d+\s+Under Section 34 of the Act,[\s\S]*?Reg\.\s*Ref\.\s+Date Received\s+Application Type\s+Submission Type/gi;
export function cleanSouthDublinField(value){
 const cleaned=norm(String(value||"").replace(SOUTH_DUBLIN_PAGE_FURNITURE," "));
 return /APPLICATIONS RECEIVED LIST|Under Section 34 of the Act|The use of the personal details of planning applicants/i.test(cleaned)?null:cleaned;
}

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
   application_type:norm(h[3]),location:cleanSouthDublinField(field(body,"Location",["Description","Applicant"])),
   proposal:cleanSouthDublinField(field(body,"Description",["Applicant","Location"])),source_url:url};
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

/**
 * Conservative extractor for Dublin City's official five-area weekly DOCX.
 * Accept only application headers immediately followed by APPLICATION TYPE;
 * cited historical references, FI notices and decisions are excluded by
 * mandatory new registration dates within the document's publication week.
 * Never infer missing date, address, type or proposal metadata.
 */
export function parseDublinCityReceived(text,url,weekEnding) {
 const raw=String(text||"").replace(/\r/g,"").replace(/\f/g,"\n");
 const markers=[...raw.matchAll(/(?<![A-Za-z0-9])((?:WEBDSDZ|WEB|DSDZ|LRD)?\d{3,5}\/26)\s*APPLICATION\s*TYPE\b/gi)];
 if(!markers.length||markers.length>500)throw Error("Dublin City official DOCX application headings unavailable");
 if(!/^2026-\d{2}-\d{2}$/.test(weekEnding)||Number.isNaN(Date.parse(weekEnding+"T00:00:00Z")))
  throw Error("Dublin City official document week unavailable");
 const weekStart=new Date(Date.parse(weekEnding+"T00:00:00Z")-6*86400000).toISOString().slice(0,10);
 const applications=[],seen=new Map();let skipped=0;
 for(let i=0;i<markers.length;i++){
  const ref=markers[i][1].toUpperCase();
  const section=raw.slice(markers[i].index+markers[i][0].length,markers[i+1]?.index??raw.length);
  // Flattened DOCX runs often join the final postcode character directly
  // onto the field label (e.g. "D04 N7KSRegistration DATE"). Do not
  // require word boundaries around REGISTRATION DATE, including after the year.
  const dateMark=/REGISTRATION\s*DATE\s*([0-3]\d\/[01]\d\/20\d{2})/i.exec(section);
  if(!dateMark||dateMark.index>500){skipped++;continue;}
  const received=receivedDate(dateMark[1]);
  if(!received||received<weekStart||received>weekEnding){skipped++;continue;}
  const meta=section.slice(0,dateMark.index);
  const appType=/^\s*(Permission\s+and\s+Retention|Permission\s+for\s+Retention|Permission|Retention)\b/i.exec(meta);
  if(!appType){skipped++;continue;}
  const location=norm(meta.slice(appType[0].length).replace(/^\s*(?:Site\s+Address|Location|Address)\s*:?\s*/i,""));
  if(location.length<7||location.length>1200||!/(?:\b\d{1,4}\b|\bDublin\b|\bD0?[1-9]\d?\b|\bRoad\b|\bStreet\b|\bLane\b|\bAvenue\b|\bPark\b|\bSquare\b|\bQuay\b)/i.test(location)){
   skipped++;continue;
  }
  const remainder=section.slice(dateMark.index+dateMark[0].length);
  const proposals=[...remainder.matchAll(/\bPROPOSAL\s*:\s*/gi)];
  if(proposals.length!==1){skipped++;continue;}
  const textAfter=remainder.slice(proposals[0].index+proposals[0][0].length);
  const proposal=norm(textAfter.split(/_{15,}/)[0]).slice(0,3001);
  // Never treat a following heading, council footer, or an FI-only notice as a proposal.
  if(proposal.length<24||proposal.length>3000||
    /\b(?:APPLICATIONS RECEIVED|DECISIONS FOR WEEK|APPEALS NOTIFIED|REGISTRATION DATE|PROPOSAL\s*:)\b/i.test(proposal)){
    skipped++;continue;
  }
  const application_type=appType[1].replace(/\s+/g," ").toLowerCase().replace(/\b\w/g,x=>x.toUpperCase());
  const row={reference:ref,web_reference:ref,registration_date:received,application_type,
   location,proposal,source_url:url};
  const previous=seen.get(ref);
  if(previous && JSON.stringify(previous)!==JSON.stringify(row))
   throw Error("Conflicting Dublin City received rows "+ref);
  if(!previous){seen.set(ref,row);applications.push(row);}
 }
 return {applications,headers:markers.length,skipped,candidate_references:[]};
}
