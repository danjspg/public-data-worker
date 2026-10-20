// Independent official South Dublin County Council weekly decision-list parser.
// Use only for worker-side research until real documents pass end-to-end QA.
export const SOUTH_DUBLIN_INDEX="https://planning.southdublin.ie/Home/WeeklyLists";
export function findSouthDublinDecisionDocuments(html,base=SOUTH_DUBLIN_INDEX){
 const docs=[];
 for(const m of String(html||"").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
   const label=m[2].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
   if(!/\b2\s+Decisions Made\b/i.test(label))continue;
   const u=new URL(m[1].replace(/&amp;/g,"&"),base);
   if(u.protocol!=="https:"||u.hostname!=="planning.southdublin.ie"||
     !/^\/Home\/ViewWeeklyListDocument\/\d+$/i.test(u.pathname))continue;
   if(!docs.includes(u.href))docs.push(u.href);
 }
 if(!docs.length)throw Error("South Dublin decision-list links not found");
 return docs;
}
export function parseSouthDublinDecisions(text,url){
 const raw=String(text||"").replace(/\u00a0/g," ");
 if(!/LIST OF DECISIONS MADE/i.test(raw) || !/Reg\.\s*Ref\./i.test(raw))throw Error("Unexpected South Dublin PDF format");
 const sections=raw.split(/Applicant\s*:/i);
 const results=[],seen=new Map();
 for(let i=0;i<sections.length-1;i++){
   const header=sections[i].slice(-450).replace(/\s+/g," ");
   const refs=[...header.matchAll(/\b(SDZ?\d{2}[AB]\/\d{4})(W?)\b/gi)];
   if(!refs.length)continue;
   const refMatch=refs.at(-1);
   const pos=refMatch.index;
   const nearby=header.slice(Math.max(0,pos-155),Math.min(header.length,pos+200));
   const outcomes=[...nearby.matchAll(/\b(Grant Permission|Granted(?:\s+Permission)?|Refuse Permission|Refused)\b/gi)];
   if(!outcomes.length)continue;
   const outcome=outcomes.at(-1)[1];
   const isRefusal=/refus/i.test(outcome);
   const dates=[...nearby.matchAll(/\b(\d{2})\/(\d{2})\/(20\d{2})\b/g)];
   if(!dates.length)continue;
   const date=dates.at(-1);
   const iso=date[3]+"-"+date[2]+"-"+date[1];
   const check=new Date(iso+"T00:00:00Z");
   if(Number.isNaN(check.getTime())||check.toISOString().slice(0,10)!==iso)continue;
   let ref=refMatch[1]+refMatch[2];
   const after=header.slice(pos+refMatch[0].length);
   if(!ref.endsWith("W")&&(/\bW\s*$/.test(after)||/^\s*W\b/.test(after)))ref+="W";
   ref=ref.toUpperCase();
   const decision_text=isRefusal?"Refused":"Granted";
   const previous=seen.get(ref);
   if(previous&&(previous.decision_date!==iso||previous.decision_text!==decision_text)){
     throw Error("South Dublin conflicting outcomes for "+ref);
   }
   if(!previous){
     const row={reference:ref,decision_date:iso,decision_text,source_url:url};
     results.push(row);seen.set(ref,row);
   }
 }
 if(results.length<3)throw Error("South Dublin extracted fewer than three decisions");
 return results;
}

export function findSouthDublinRecentWeeks(html,base=SOUTH_DUBLIN_INDEX,cutoff="2026-08-01"){
 const docs=[];
 for(const url of findSouthDublinDecisionDocuments(html,base)){
   const u=new URL(url);
   const variants=[u.pathname,url];
   const positions=variants.map(v=>html.indexOf(v)).filter(n=>n>=0);
   if(!positions.length)throw Error("Official South Dublin list reference could not be verified: "+url);
   const before=html.slice(Math.max(0,Math.min(...positions)-650),Math.min(...positions));
   const dates=[...before.matchAll(/\b(\d{2})\/(\d{2})\/(20\d{2})\b/g)];
   const hit=dates.at(-1);
   if(!hit)throw Error("Missing source week date for "+url);
   const week=hit[3]+"-"+hit[2]+"-"+hit[1];
   const d=new Date(week+"T00:00:00Z");
   if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==week)throw Error("Invalid council week date: "+week);
   if(week>=cutoff) docs.push({url,week});
 }
 return docs;
}
