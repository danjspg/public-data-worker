// Public ArcGIS search across Cork County's organisation and viewer configurations.
// This diagnostic never accesses protected utility.arcgis.com endpoints or Agile.
const REST="https://www.arcgis.com/sharing/rest/";
const opts={redirect:"error",signal:AbortSignal.timeout(17000),headers:{
 "Accept":"application/json","User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"
}};
const queries=[
 "orgid:FxGqwVH8IzS7QaUY AND planning",
 "orgid:FxGqwVH8IzS7QaUY AND type:\"Feature Service\" AND planning",
 "owner:CorkCoAdmin AND planning",
 "owner:CorkCoAdmin AND type:\"Feature Service\"",
 "owner:CorkCoAdminEur AND type:\"Feature Service\"",
 "title:\"Planning Applications\" AND Cork",
 "title:\"PlanningRecords\"",
];
const unique=new Map(),errors=[],report={readOnly:true,orgId:"FxGqwVH8IzS7QaUY",queries:[],viewers:[],services:[],errors};
let calls=0,throttled=false;
async function get(url,large=false){
 if(throttled)throw Error("ArcGIS 429 encountered, stop");
 const u=new URL(url);
 if(u.protocol!=="https:"||!(u.hostname==="www.arcgis.com"||
  u.hostname==="services-eu1.arcgis.com"||u.hostname==="corkcocoeur.maps.arcgis.com"))
 throw Error("Disallowed host "+u.hostname);
 if(++calls>32)throw Error("Read-only rate cap");
 const r=await fetch(u,{...opts,signal:AbortSignal.timeout(17000)});
 if(r.status===429){throttled=true;throw Error("STOP: ArcGIS HTTP 429")}
 if(r.status===403)return {blocked:403};
 if(!r.ok)throw Error("HTTP "+r.status);
 const body=await r.text();
 if(body.length>(large?3800000:1700000))throw Error("Large public service response");
 const d=JSON.parse(body);if(d.error)throw Error("ArcGIS "+d.error.code+": "+String(d.error.message).slice(0,140));
 return d;
}
const date=m=>typeof m==="number"?new Date(m).toISOString().slice(0,10):null;
const simple=x=>({title:x.title,owner:x.owner,type:x.type,url:x.url||null,modified:date(x.modified),id:x.id});
for(const q of queries){
 for(let start=1;start<=201;start+=100){
  // Only paginate large feature-service result sets; other terms need one page.
  if(start>1&&!/owner:CorkCoAdminEur AND type:"Feature Service"/.test(q))break;
  const u=new URL(REST+"search");
  for(const [k,v] of Object.entries({f:"json",q,num:"100",start:String(start),
   sortField:"modified",sortOrder:"desc"}))u.searchParams.set(k,v);
  try{
   const d=await get(u);
   const items=d.results||[];
   for(const item of items)unique.set(item.id,item);
   report.queries.push({q,start,total:d.total,returned:items.length,
    planningItems:items.filter(x=>/plan|applic|register|record|permit/i.test(x.title||"")).slice(0,40).map(simple)});
   if(d.nextStart<0)break;
  }catch(e){errors.push({step:"search "+q,message:String(e.message||e)});break}
 }
}
report.uniqueCount=unique.size;
report.allCandidateItemTitles=[...unique.values()].filter(x=>/planning|application|records|enquiry|permit/i.test(x.title||""))
 .map(simple).slice(0,80);
const viewers=[
 {id:"b1b8ba0ee5964d469806e69d3276d8da",label:"2026 Planning Viewer experience"},
 {id:"dfde5aadb9694f51a898766520abebf3",label:"2023 Planning Enquiry web map"},
 {id:"f3c7b9ac63e54312af3df3571f0bf877",label:"2026 Planning Counter app"}
];
function collect(data,seen={urls:new Set(),ids:new Set()}){
 const stack=[data],visited=new WeakSet();
 let count=0;
 while(stack.length&&count++<20000){
  const obj=stack.pop();
  if(!obj||typeof obj!=="object"||visited.has(obj))continue;
  visited.add(obj);
  for(const [key,val] of Object.entries(obj)){
   if(typeof val==="string"){
    if(/^(?:webmap|webmapid|itemid|webmapid|portalitemid|mapid)$/i.test(key)&&/^[a-f0-9]{32}$/i.test(val))seen.ids.add(val);
    if(/^https:\/\/[^ ]+\/(?:FeatureServer|MapServer)(?:\/\d+)?(?:$|\?)/i.test(val))seen.urls.add(val);
   }else if(val&&typeof val==="object")stack.push(val);
  }
 }
 return {urls:[...seen.urls].slice(0,25),itemIds:[...seen.ids].slice(0,24)};
}
for(const viewer of viewers){
 const entry={...viewer};
 try{
  const item=await get(REST+"content/items/"+viewer.id+"?f=json");
  entry.owner=item.owner;entry.type=item.type;entry.modified=date(item.modified);
  const data=await get(REST+"content/items/"+viewer.id+"/data?f=json",true);
  const nodes=collect(data);
  Object.assign(entry,nodes);
 }catch(e){entry.error=String(e.message||e).slice(0,170)}
 report.viewers.push(entry);
}
try{
 const services=await get("https://services-eu1.arcgis.com/FxGqwVH8IzS7QaUY/arcgis/rest/services?f=json");
 report.services=[...(services.services||[])].filter(x=>/plan|application|records|permit|enquiry|register/i.test(x.name||"")).slice(0,80)
 .map(x=>({name:x.name,type:x.type}));
 report.serviceTotal=(services.services||[]).length;
}catch(e){report.errors.push({step:"official service directory",error:String(e.message||e).slice(0,150)})}
report.calls=calls;
console.log(JSON.stringify(report,null,2));
