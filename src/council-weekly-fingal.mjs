// Fingal County Council weekly decisions, parsed from official Word .doc reports.
// Only literal grant/refusal statuses are published; invalid/FI/appeals are excluded.
export const FINGAL_INDEX="https://www.fingal.ie/ga/council/service/planning-weekly-lists";
export const FINGAL_CUTOFF="2026-08-01";
const refPattern="(?:FW?\\d{2}[AB]\\/\\d{4}E?|LRD\\d{4}\\/S3E?)";
export const FINGAL_REFERENCE=new RegExp("^"+refPattern+"$","i");

export function fingalIsoDate(value){
 const m=String(value).match(/^(\\d{2})\\/(\\d{2})\\/(20\\d{2})$/);
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
