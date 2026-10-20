// Fingal County Council weekly decisions, parsed from official Word .doc reports.
// Only literal grant/refusal statuses are published; invalid/FI/appeals are excluded.
export const FINGAL_INDEX="https://www.fingal.ie/ga/council/service/planning-weekly-lists";
export const FINGAL_CUTOFF="2026-08-01";
const refPattern="(?:FW?\\d{2}[AB]\\/\\d{4}E?|LRD\\d{4}\\/S3E?)";
export const FINGAL_REFERENCE=new RegExp("^"+refPattern+"$","i");

export function fingalIsoDate(value){
 const m=String(value).match(new RegExp("^([0-9]{2})/([0-9]{2})/(20[0-9]{2})$"));
 if(!m)return null;
 const iso=m[3]+"-"+m[2]+"-"+m[1],d=new Date(iso+"T00:00:00Z");
 return Number.isNaN(d.valueOf())||d.toISOString().slice(0,10)!==iso?null:iso;
}

export function fingalWeeklyLinks(html,index=FINGAL_INDEX,cutoffWeek=32){
 const found=[],year=2026;
 for(const row of String(html).matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)){
  const match=row[0].match(/\bweek\s*(\d{1,2})\b/i);
  if(!match||Number(match[1])<cutoffWeek)continue;
  const week=Number(match[1]);
  const links=[...row[0].matchAll(/href\s*=\s*["']([^"']+\.doc(?:\?[^"']*)?)["']/gi)];
  const decisionLinks=links.map(m=>new URL(m[1].replace(/&amp;/g,"&"),index))
   .filter(u=>u.protocol==="https:"&&u.hostname==="www.fingal.ie"&&
    /decisions?\W*made/i.test(decodeURIComponent(u.pathname))&&
    !/appeals?/i.test(decodeURIComponent(u.pathname)));
  if(decisionLinks.length!==1)throw Error("Fingal ambiguous decisions link in week "+week+": "+decisionLinks.length);
  found.push({url:decisionLinks[0].href,year,week});
 }
 const dedup=[...new Map(found.map(x=>[x.url,x])).values()].sort((a,b)=>b.week-a.week);
 if(dedup.length<1||dedup.length>35)throw Error("Unexpected Fingal weekly decision archive size "+dedup.length);
 return dedup;
}

export function parseFingalWeeklyText(raw,url,cutoff=FINGAL_CUTOFF){
 const text=String(raw||"").replace(/\u00a0/g," ");
 if(!/\bDECISION\b/i.test(text))throw Error("Fingal Word report lacks decision headings");
 const line=new RegExp("^\\s*("+refPattern+")\\s+(\\d{2}\\/\\d{2}\\/20\\d{2})\\s+(?:PERMISSION|RETENTION|OUTLINE|APPROVAL)\\b","gim");
 const matches=[...text.matchAll(line)];
 if(matches.length<5)throw Error("Fingal document lacks expected application table rows");
 const decisions=[],seen=new Map();
 let excluded=0;
 for(let i=0;i<matches.length;i++){
  const hit=matches[i],ref=hit[1].toUpperCase(),date=fingalIsoDate(hit[2]);
  if(!date||date<cutoff){excluded++;continue;}
  const next=matches[i+1]?.index??text.length;
  // Heading/status area precedes the application description. The status may
  // wrap to a separate line, but must occur close to the row's reference.
  const body=text.slice(hit.index+hit[0].length,Math.min(next,hit.index+hit[0].length+260));
  // Recognise explicit council outcomes, never the bare word "Permission".
  const statuses=[...body.matchAll(/\b(?:REFUSE\s+(?:PERMISSION|RETENTION)|REFUSED|GRANT\s+(?:PERMISSION|RETENTION|OUTLINE)|GRANTED\s+SUBJECT\s+TO\s+CONDITIONS|INVALID\s+APPLICATION|REQUEST\s+ADDITIONAL\s+INFORMATION)\b/gi)];
  if(!statuses.length){excluded++;continue;}
  const first=statuses[0];
  const status=first[0].toUpperCase();
  if(status.startsWith("INVALID")||status.startsWith("REQUEST")){excluded++;continue;}
  const isRefused=/^REFUS/.test(status);
  const alternatives=statuses.slice(1,3).filter(m=>/^REFUS/.test(m[0].toUpperCase())!==isRefused);
  // Mixed grant and refusal terminology could be part of the description.
  if(alternatives.length){excluded++;continue;}
  const record={reference:ref,decision_date:date,decision_text:isRefused?"Refused":"Granted",registration_date:null,source_url:url};
  const prior=seen.get(ref);
  if(prior&&(prior.decision_date!==date||prior.decision_text!==record.decision_text))throw Error("Conflicting Fingal records "+ref);
  if(!prior){seen.set(ref,record);decisions.push(record);}
 }
 if(!decisions.length)throw Error("Fingal text yielded no explicit grant/refusal decisions");
 return {decisions,tableRows:matches.length,excluded};
}


// August–September Word reports place decision date BEFORE the reference and
// line-wrap application type and outcome around it. Keep this parser separate
// from the newer tabular format. Reject truncated reference tokens and
// descriptions that mention old approvals.
export function parseFingalLegacyText(raw,url,cutoff=FINGAL_CUTOFF){
 const input=String(raw||"").replace(/\u00a0/g," ");
 if(!/\bDECISION\b/i.test(input))throw Error("Missing official Fingal decision header");
 const dates=[...input.matchAll(/(?<![0-9])([0-3][0-9]\/[01][0-9]\/2026)(?![0-9])/g)];
 if(dates.length<5)throw Error("Legacy report lacks decision date rows");
 const entries=[],seen=new Map();let excluded=0;
 const refRx=new RegExp("(?<![A-Za-z0-9/])("+refPattern+")(?![A-Za-z0-9/])","gim");
 for(let i=0;i<dates.length;i++){
  const found=dates[i],date=fingalIsoDate(found[1]);
  if(!date||date<cutoff){excluded++;continue;}
  const segment=input.slice(found.index+found[0].length,
    Math.min(dates[i+1]?.index??input.length,found.index+found[0].length+550));
  const refs=[...segment.matchAll(refRx)];
  if(!refs.length){excluded++;continue;}
  // The principal application number occurs near the council date, before
  // applicant/address text and any cited prior planning numbers.
  const ref=refs[0];
  if(ref.index>190){excluded++;continue;}
  const following=segment.slice(ref.index+ref[0].length,ref.index+ref[0].length+170);
  const status=[...following.matchAll(/\b(?:REFUSE(?:\s+PERMISSION)?|GRANT(?:\s+(?:PERMISSION|RETENTION|OUTLINE))?|INVALID\s+APPLICATION|REQUEST\s+ADDITIONAL\s+INFORMATION)\b/gi)];
  if(!status.length||status[0].index>95){excluded++;continue;}
  const first=status[0][0].toUpperCase();
  if(first.startsWith("INVALID")||first.startsWith("REQUEST")){excluded++;continue;}
  const refused=first.startsWith("REFUS");
  // Only accept one decision polarity in the near-header region.
  const opposite=status.slice(1).some(m=>m.index<110&&m[0].toUpperCase().startsWith("REFUS")!==refused);
  if(opposite){excluded++;continue;}
  const record={reference:ref[1].toUpperCase(),decision_date:date,
   decision_text:refused?"Refused":"Granted",registration_date:null,source_url:url};
  const prior=seen.get(record.reference);
  if(prior&&(prior.decision_date!==record.decision_date||prior.decision_text!==record.decision_text))
   throw Error("Conflicting Fingal decisions "+record.reference);
  if(!prior){seen.set(record.reference,record);entries.push(record);}
 }
 if(!entries.length)throw Error("Legacy Fingal report has no verified grant/refusal rows");
 return {decisions:entries,tableRows:dates.length,excluded};
}
