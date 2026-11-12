// Read-only discovery of openly published Cork County Council ArcGIS catalogue.
// Does not query or work around protected Planning Enquiry utility service.
// Only public ArcGIS Online catalogue search and independently listed services.
const portal="https://www.arcgis.com/sharing/rest/";
const webmapId="4de7ae1068524c51a9209676757ca5a1";
const queries=[
 "owner:CorkCoAdminEur AND planning",
 "owner:CorkCoAdminEur AND (application OR enquiry OR register OR records)",
 "owner:CorkCoAdminEur AND type:\"Feature Service\"",
 "\"Cork County Council\" AND planning AND type:\"Feature Service\"",
 "\"Cork County\" AND \"Planning Applications\"",
 "PlanningRecordsUpdt",
 "Planning Application Cork",
 "owner:CorkCoAdminEur AND type:\"Map Service\""
];
let calls=0;
function allowed(url){const u=new URL(url);
 if(u.protocol!=="https:"||!((u.hostname==="www.arcgis.com")||
 (u.hostname==="services.arcgis.com")||
 /^services(?:-eu)?\d*\.arcgis\.com$/.test(u.hostname)||
 u.hostname.endsWith(".corkcoco.ie")))
 throw Error("Off-allowlist ArcGIS/council host "+u.hostname);
 return u;
}
async function json(url){
 const u=allowed(url);
 if(++calls>38)throw Error("Public source query cap reached");
 const res=await fetch(u,{redirect:"error",signal:AbortSignal.timeout(14000),headers:{
  "Accept":"application/json","User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"
 }});
 if(res.status===429)throw Error("STOP ArcGIS portal rate limit HTTP 429");
 if(res.status===403)return {blocked:403};
 if(!res.ok)throw Error("HTTP "+res.status+" "+u.hostname);
 const raw=await res.text();if(raw.length>1800000)throw Error("Oversized ArcGIS catalogue response");
 const d=JSON.parse(raw);if(d.error)throw Error("ArcGIS "+d.error.code+" "+String(d.error.message).slice(0,120));
 return d;
}
const date=ms=>typeof ms==="number"?new Date(ms).toISOString().slice(0,10):null;
const view=x=>({id:x.id,title:x.title,owner:x.owner,type:x.type,url:x.url||null,modified:date(x.modified),orgId:x.orgId||null,
  snippet:String(x.snippet||x.description||"").replace(/<[^>]*>/g,"").replace(/\s+/g," ").slice(0,130)});
const report={readOnly:true,queries:[],totalUniqueItems:0,items:[],serviceChecks:[],errors:[]};
const match=new Map();
try{
 const map=await json(portal+"content/items/"+webmapId+"?f=json");
 report.webmap=view(map);
}catch(e){report.errors.push({step:"webmap",message:String(e.message||e)})}
for(const [i,q] of queries.entries()){
 try{
  const u=new URL(portal+"search");
  for(const [k,v] of Object.entries({f:"json",q,num:"100",sortField:"modified",sortOrder:"desc"}))u.searchParams.set(k,v);
  const d=await json(u);
  const items=d.results||[];
  report.queries.push({q,total:d.total,returned:items.length,nextStart:d.nextStart,
   relevantItems:items.filter(x=>/planning|application|APAS|records|enquiry|permit/i.test(x.title||"")).slice(0,22).map(view)});
  for(const x of items){if(!match.has(x.id))match.set(x.id,x)}
 }catch(e){report.errors.push({step:"search:"+i,message:String(e.message||e).slice(0,200)})}
}
report.totalUniqueItems=match.size;
report.items=[...match.values()].filter(x=>/planning|application|APAS|records|enquiry|permit/i.test(x.title||"") &&
 !/development plan|zoning|strategic|protected|archaeol|flood|health|transport|enforcement|photograph|policy|boundary|land use|rural housing/i.test(x.title||"")).slice(0,65).map(view);
const candidates=[...match.values()].filter(x=>
 /planning|application|APAS|records|enquiry/i.test(x.title||"") &&
 (/Feature Service|Map Service/i.test(x.type||""))&&
 typeof x.url==="string" &&
 /\/(?:FeatureServer|MapServer)(?:\/\d+)?(?:$|\?)/i.test(x.url)
).sort((a,b)=>{
 const score=x=>(/cork county|planning (application|records|point|site)|planning records|planning enquir/i.test(x.title||"")?20:0)+(x.owner==="CorkCoAdminEur"?5:0);
 return score(b)-score(a)||b.modified-a.modified
}).slice(0,13);
for(const item of candidates){
 const entry={title:item.title,id:item.id,owner:item.owner,url:item.url,modified:date(item.modified)};
 try{
  const u=allowed(item.url);
  const meta=await json(u.origin+u.pathname+(u.search?"&f=json":"?f=json"));
  if(meta.blocked){entry.blocked=403;report.serviceChecks.push(entry);continue}
  const name=meta.name||meta.serviceDescription||"";
  const layers=meta.layers||[{id:meta.id||0,name:meta.name||"layer"}];
  entry.layerNames=layers.slice(0,8).map(x=>x.name||x.id);
  entry.dataLastEdit=date(meta.editingInfo?.dataLastEditDate);
  entry.fields=(meta.fields||[]).map(x=>x.name).slice(0,65);
  if(!meta.fields&&layers.length&&calls<35){
   const m=await json(u.origin+u.pathname.replace(/\/$/,"")+"/"+layers[0].id+"?f=json");
   if(m.blocked){entry.blocked=403}
   else{entry.fields=(m.fields||[]).map(x=>x.name).slice(0,65);entry.dataLastEdit=date(m.editingInfo?.dataLastEditDate);}
  }
 }catch(e){entry.error=String(e.message||e).slice(0,150)}
 report.serviceChecks.push(entry);
}
report.calls=calls;
console.log(JSON.stringify(report,null,2));
