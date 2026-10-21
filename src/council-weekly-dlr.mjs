// Dún Laoghaire-Rathdown official weekly council PDF lists.
// All parsing is limited to "APPLICATIONS RECEIVED" section and source PDF.
export const DLR_WEEKLY_INDEX="https://www.dlrcoco.ie/weekly-planning-lists/weekly-planning-lists";
export const DLR_RECOVERY_CUTOFF="2026-08-01";
export const DLR_REF=/^(?:D|DZ|LRD)\d{2}[A-Z]\/\d{4}(?:\/WEB)?$/i;
const clean=s=>String(s||"").replace(/\s+/g," ").trim();
export function dlrDate(raw){
 const m=String(raw||"").match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);
 if(!m)return null;
 const d=new Date(Date.UTC(+m[3],+m[2]-1,+m[1]));
 const iso=d.toISOString().slice(0,10);
 return (d.getUTCFullYear()===+m[3]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[1])?iso:null;
}
export function discoverDlrWeeks(html,base=DLR_WEEKLY_INDEX){
 const docs=new Map();
 // Official archive has structured titles "Weekly List No 41" adjacent to a
 // single PDF download anchor. Don't derive URLs from guessed file names.
 const re=/Weekly List\s+No\.?\s*(\d{1,2})\s*<\/[^>]+>[\s\S]{0,500}?<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi;
 for(const m of String(html||"").matchAll(re)){
  const week=Number(m[1]);
  if(week<31||week>53)continue;
  const url=new URL(m[2].replace(/&amp;/g,"&"),base);
  if(url.protocol!=="https:"||url.hostname!=="www.dlrcoco.ie"||
   !url.pathname.toLowerCase().endsWith(".pdf"))continue;
  const week_ending=new Date(Date.UTC(2026,0,3+week*7)).toISOString().slice(0,10);
  docs.set(week,{url:url.href,week,week_ending,authority:"DLR"});
 }
 const arr=[...docs.values()].sort((a,b)=>b.week-a.week);
 if(arr.length<5||arr.length>30)throw Error("DLR official weekly archive expected 5–30 recent PDFs, got "+arr.length);
 return arr;
}
function field(section,label,nextLabels){
 const pattern=new RegExp("(?:^|\\n)\\s*"+label+"\\s*:\\s*","im");
 const match=pattern.exec(section);
 if(!match)return null;
 const after=section.slice(match.index+match[0].length);
 const end=new RegExp("\\n\\s*(?:"+nextLabels.join("|")+")\\s*:","im").exec(after);
 return clean(end?after.slice(0,end.index):after);
}
export function parseDlrReceived(text,url,cutoff=DLR_RECOVERY_CUTOFF){
 const raw=String(text||"").replace(/\r/g,"").replace(/\f/g,"\n");
 const a=raw.search(/PLANNING APPLICATIONS RECEIVED FOR WEEK\s+\d{1,2}\s+2026/i);
 const b=raw.search(/END OF PLANNING APPLICATIONS RECEIVED FOR WEEK/i);
 if(a<0||b<a)throw Error("DLR weekly received section missing");
 const section=raw.slice(a,b);
 const total=Number(section.match(/Total Application Registered\s*=\s*(\d+)/i)?.[1]);
 if(!Number.isInteger(total)||total<1||total>250)throw Error("DLR official list has no valid total");
 const pieces=section.split(/\bReg\.\s*Ref\.\s*:\s*/i).slice(1);
 if(pieces.length!==total)throw Error("DLR actual list row count "+pieces.length+" != official "+total);
 let excluded=0;const applications=[],seen=new Map();
 for(const piece of pieces){
  const ref=piece.match(/^\s*([A-Z]{1,4}\d{2}[A-Z]\/\d{4}(?:\/WEB)?)/i)?.[1]?.toUpperCase();
  const date=dlrDate(field(piece,"App Rec’d Date",["Applicant Name","Location"]));
  const location=field(piece,"Location",["Proposal","Application Type"]);
  const proposal=field(piece,"Proposal",["Application Type","Further Information"]);
  const application_type=field(piece,"Application Type",["Further Information","Clarification FI Recd","Link"]);
  const further=field(piece,"Further Information",["Clarification FI Recd","Link"]);
  const clarification=field(piece,"Clarification FI Recd",["Link"]);
  // Current weekly list also includes old cases submitting FI. They have an old
  // initial received date and an explicit "Further Information" entry.
  if(!ref||!DLR_REF.test(ref)||!date||date<cutoff||
     !location||location.length<7||location.length>2000||
     !proposal||proposal.length<24||proposal.length>3000||
     !/^(?:Permission|Permission for Retention|Permission \(SDZ\)|Permission \(LRD\))$/i.test(application_type||"")||
     (further&&further.trim())||(clarification&&clarification.trim())){
    excluded++;continue;
  }
  const row={reference:ref,web_reference:ref,registration_date:date,
    application_type,location,proposal,source_url:url};
  const old=seen.get(ref);
  if(old&&(old.registration_date!==date||old.proposal!==proposal))throw Error("Conflicting DLR row "+ref);
  if(!old){seen.set(ref,row);applications.push(row);}
 }
 return {applications,headers:pieces.length,skipped:excluded,officialTotal:total};
}
