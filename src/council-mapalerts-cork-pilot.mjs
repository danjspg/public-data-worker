import {CORK_MAPALERTS_INDEX,discoverCorkMapalertWeeks,parseCorkMapalertsReceived} from "./council-mapalerts-cork.mjs";
async function get(url){
 const u=new URL(url);
 if(u.hostname!=="mapalerts.corkcoco.ie"||u.protocol!=="https:")throw Error("Untrusted Cork council URL");
 const res=await fetch(u,{headers:{"User-Agent":"OpenList council planning weekly public verification"},signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw Error("Cork MapAlerts HTTP "+res.status);
 const html=await res.text();
 if(html.length<1500||html.length>10_000_000)throw Error("Cork council HTML abnormal size");
 return html;
}
const docs=new Map();
const pages=[];
for(let page=0;page<4;page++){
 const url=new URL(CORK_MAPALERTS_INDEX);
 if(page)url.searchParams.set("page",String(page));
 const html=await get(url.href);
 const found=discoverCorkMapalertWeeks(html,url.href);
 pages.push({page,found:found.length,earliest:found.at(-1)?.week_ending,latest:found[0]?.week_ending});
 for(const x of found)docs.set(new URL(x.url).searchParams.get("ref"),x);
 if(page>0&&!found.length)break;
}
const selected=[...docs.values()].sort((a,b)=>b.week_ending.localeCompare(a.week_ending));
const previews=[];
for(const d of selected.slice(0,3)){
 try{
  const parsed=parseCorkMapalertsReceived(await get(d.url),d.url);
  previews.push({week:d.week_ending,url:d.url,headers:parsed.headers,complete:parsed.applications.length,skipped:parsed.skipped,
   refs:parsed.applications.slice(0,18).map(x=>({reference:x.reference,date:x.registration_date,type:x.application_type}))});
 }catch(e){previews.push({week:d.week_ending,url:d.url,error:String(e.message||e)});}
}
console.log(JSON.stringify({dryRun:true,pages,indexed:selected.length,preview:previews},null,2));
if(!previews.length||previews.some(p=>p.error))process.exitCode=1;
