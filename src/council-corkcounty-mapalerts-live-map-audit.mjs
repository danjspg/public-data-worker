// Passive read-only inspection of Cork County's existing public live-alert map.
// No fetching private data endpoints, no scraping listings or applicant content.
// Stop on access restrictions and print only publicly referenced JS/route metadata.
const base="https://mapalerts.corkcoco.ie";
let requests=0;
async function get(path){
 const u=new URL(path,base);
 if(u.protocol!=="https:"||!["mapalerts.corkcoco.ie","www.mapalerts.corkcoco.ie"].includes(u.hostname))
  throw Error("Non-council host");
 if(++requests>5)throw Error("Request budget reached");
 const r=await fetch(u,{redirect:"error",signal:AbortSignal.timeout(12000),headers:{
  "User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)","Accept":"text/html,*/*;q=0.7"
 }});
 if(r.status===403||r.status===429)throw Error("Stop on MapAlerts HTTP "+r.status);
 if(!r.ok)throw Error("MapAlerts HTTP "+r.status);
 const body=await r.text();if(body.length>1500000)throw Error("Oversized council map source");
 return body;
}
const report={readOnly:true,source:"Cork County Council MapAlerts live map",pages:[],scripts:[],requests:0,errors:[]};
for(const path of ["/en/gismap?view=form","/en/gismap"]){
 try{
  const html=await get(path);
  const all=[...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
   .map(m=>m[1]).filter(x=>!/^https?:\/\/(?:maps\.googleapis|ajax\.googleapis|cdn\.)/i.test(x));
  const near=[...html.matchAll(/.{0,100}(?:planning|api\/|geojson|xhr|marker|gismap|alertType).{0,120}/gi)]
   .map(m=>m[0].replace(/<[^>]*>/g,"").replace(/\s+/g," ").slice(0,140));
  report.pages.push({path,bytes:html.length,scriptUrls:all.slice(0,20),
    publicMapMentions:near.slice(0,14)});
  for(const src of all){
   const u=new URL(src,new URL(path,base));
   if(["mapalerts.corkcoco.ie","www.mapalerts.corkcoco.ie"].includes(u.hostname)&&
      /(?:gismap|planning|alerts|map|app)\w*\.js/i.test(u.pathname)&&
      !report.scripts.some(x=>x.url===u.href))
    report.scripts.push({url:u.href});
  }
 }catch(e){report.errors.push({path,error:String(e.message||e).slice(0,150)})}
}
for(const script of report.scripts.slice(0,2)){
 try{
  const js=await get(script.url);
  script.bytes=js.length;
  script.apiRoutes=[...new Set([...js.matchAll(/["'](\/(?:api|gismap|alerts|map|ajax|planning)[^"' ]{0,140})["']/gi)]
   .map(x=>x[1]))].slice(0,18);
  script.planningContext=[...js.matchAll(/.{0,80}planning.{0,110}/gi)]
   .map(x=>x[0].replace(/\s+/g," ").slice(0,150)).slice(0,7);
 }catch(e){script.error=String(e.message||e).slice(0,140)}
}
report.requests=requests;
console.log(JSON.stringify(report,null,2));
