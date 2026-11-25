// Received-applications links from Fingal's PUBLIC weekly council list.
// Never guess which of multiple distinct source documents is authoritative.
// A malformed week is an explicit coverage gap, not a reason to abandon
// staging independently verified documents from the other councils.
import {FINGAL_INDEX} from "./council-weekly-fingal.mjs";

export function fingalReceivedWeeklyLinks(html, index=FINGAL_INDEX){
 const documents=[],skipped=[];
 for(const row of String(html).matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)){
  const wk=row[0].match(/\bweek\s*(\d{1,2})\b/i);
  if(!wk||Number(wk[1])<31)continue; // Week 31 ends 7 August 2026.
  // The archive contains many years with identical week numbers. Accept only
  // explicit 2026 week folders; do not relabel a 2025 Word document as 2026.
  if(!/\/2026(?:%20|\s)+Week(?:%20|\s)+\d{1,2}/i.test(row[0]))continue;
  const week=Number(wk[1]);
  const candidates=[];
  for(const m of row[0].matchAll(/href\s*=\s*["']([^"']+\.doc(?:\?[^"']*)?)["']/gi)){
   const value=m[1].replace(/&amp;/g,"&");
   if(!/applications?\W*received/i.test(decodeURIComponent(value)))continue;
   const url=new URL(value,index);
   if(url.protocol!=="https:"||url.hostname!=="www.fingal.ie")
    throw Error("Fingal source hostname mismatch");
   const documentWeek=decodeURIComponent(url.pathname).match(/\/2026\s+Week\s+(\d{1,2})\//i);
   if(!documentWeek||Number(documentWeek[1])!==week){
    // Wrong-week links cannot be admitted as received records.
    candidates.push("invalid-week:"+url.href);
    continue;
   }
   candidates.push(url.href);
  }
  // Identical repeated HTML links are not ambiguous. Two DIFFERENT documents
  // are ambiguous: do not select arbitrarily or infer that either is a complete list.
  const unique=[...new Set(candidates)];
  if(unique.length!==1||unique[0]?.startsWith("invalid-week:")){
   skipped.push({week,reason:unique.some(x=>x.startsWith("invalid-week:"))?"mismatched_received_document_week":unique.length?"ambiguous_received_documents":"missing_received_document",candidate_count:unique.length});
   continue;
  }
  const week_ending=new Date(Date.UTC(2026,0,4+(week-1)*7)).toISOString().slice(0,10);
  documents.push({url:unique[0],week_ending,authority:"FINGAL",type:"doc"});
 }
 return {documents,skipped};
}
