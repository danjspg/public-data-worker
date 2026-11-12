// Read-only official-source diagnostic. Never stage data, request Agile or
// print applicant names, addresses, descriptions, geometries or private fields.
// Limit 28 public metadata/date/sample queries, no redirects, stop on 403/429.
const WEBMAP="4de7ae1068524c51a9209676757ca5a1";
const NATIONAL="https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0";
let requests=0;
const approved=host=>host==="www.arcgis.com"||
 /^(?:services\d*|services-eu\d+|corkcoadmin(?:eur)?)\.arcgis\.com$/.test(host)||
 host.endsWith(".maps.arcgis.com")||
 host.endsWith(".arcgis.com")||
 host.endsWith(".corkcoco.ie");
async function json(url){
 const u=new URL(url);
 if(u.protocol!=="https:"||!approved(u.hostname))throw Error("Non-ArcGIS/non-council source rejected: "+u.hostname);
 if(++requests>28)throw Error("Read-only council probe budget exceeded");
 const r=await fetch(u,{redirect:"error",signal:AbortSignal.timeout(18000),
  headers:{"Accept":"application/json","User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"}});
 if(r.status===403||r.status===429)throw Error("Public source refused request HTTP "+r.status);
 if(!r.ok)throw Error("HTTP "+r.status+" host="+u.hostname);
 const raw=await r.text();
 if(raw.length>850000)throw Error("Oversized public ArcGIS metadata");
 const result=JSON.parse(raw);
 if(result?.error)throw Error("ArcGIS "+result.error.code+": "+String(result.error.message).slice(0,120));
 return result;
}
const report={readOnly:true,webmap:WEBMAP,sources:[],errors:[],national:{}};
const ms=x=>typeof x==="number"&&Number.isFinite(x)?new Date(x).toISOString().slice(0,10):null;
function selectFields(l){
 return (l.fields||[]).filter(f=>/ref|app.*num|received|regist|date|type|desc|address|location|status|decision|appeal/i.test(f.name))
 .map(f=>({field:f.name,type:f.type})).slice(0,30);
}
const layers=[];
try{
 const item=await json("https://www.arcgis.com/sharing/rest/content/items/"+WEBMAP+"?f=json");
 report.mapInfo={title:item.title,owner:item.owner,modified:ms(item.modified)};
 const data=await json("https://www.arcgis.com/sharing/rest/content/items/"+WEBMAP+"/data?f=json");
 report.webMapLayerCount=(data.operationalLayers||[]).length;
 for(const layer of data.operationalLayers||[]){
   const url=layer.url||layer.layerUrl||layer.featureLayer?.url;
   if(!url)continue;
   const name=layer.title||layer.name||layer.id||"";
   if(/plann|applic|site|point|county/i.test(name)||/plann/i.test(url))
    layers.push({name:name.slice(0,110),url});
 }
 report.mapPlanningLayerReferences=layers.slice(0,16);
}catch(e){report.errors.push({stage:"webmap",error:String(e.message||e).slice(0,170)})}
let candidates=layers.filter(l=>/planning (points?|sites?)|planning application/i.test(l.name)).slice(0,3);
if(!candidates.length)candidates=layers.filter(l=>/plann/i.test(l.name)).slice(0,3);
for(const layer of candidates){
 const entry={name:layer.name,url:layer.url};
 try{
  const meta=await json(layer.url+(/^.*\?/.test(layer.url)?"&":"?")+"f=json");
  entry.layerName=meta.name;
  entry.fields=selectFields(meta);
  entry.dataLastEdit=ms(meta.editingInfo?.dataLastEditDate);
  entry.maxRecordCount=meta.maxRecordCount;
  entry.dateFields=(meta.fields||[]).filter(f=>/receiv|regist|app.*date/i.test(f.name)).map(f=>f.name).slice(0,5);
  entry.referenceFields=(meta.fields||[]).filter(f=>/ref|app.*num/i.test(f.name)).map(f=>f.name).slice(0,5);
  if(entry.dateFields.length&&entry.referenceFields.length){
   const q=new URL(layer.url+"/query");
   for(const [k,v] of Object.entries({f:"json",where:"1=1",returnGeometry:"false",resultRecordCount:"4",
    outFields:[entry.referenceFields[0],entry.dateFields[0]].join(","),
    orderByFields:entry.dateFields[0]+" DESC"}))q.searchParams.set(k,v);
   try{
    const response=await json(q);
    entry.latest=(response.features||[]).map(x=>{
     const a=x.attributes||{},date=a[entry.dateFields[0]];
     return {reference:String(a[entry.referenceFields[0]]||"").slice(0,36),
     registrationDate:ms(date)||String(date||"").slice(0,26)};
    });
   }catch(e){entry.queryError=String(e.message||e).slice(0,170)}
  }
 }catch(e){entry.error=String(e.message||e).slice(0,170)}
 report.sources.push(entry);
}
try{
 const meta=await json(NATIONAL+"?f=json");
 report.national.meta={name:meta.name,dataLastEdit:ms(meta.editingInfo?.dataLastEditDate),
  maxRecordCount:meta.maxRecordCount,fields:selectFields(meta)};
 for(const [key,where] of [
 ["county","PlanningAuthority = 'Cork County Council'"],
 ["countyRecent","PlanningAuthority = 'Cork County Council' AND ReceivedDate >= TIMESTAMP '2026-10-01 00:00:00'"],
 ["corkLike","PlanningAuthority LIKE '%Cork%' AND ReceivedDate >= TIMESTAMP '2026-11-01 00:00:00'"]
 ]){
  const u=new URL(NATIONAL+"/query");
  for(const [k,v] of Object.entries({f:"json",where,returnCountOnly:"true"}))u.searchParams.set(k,v);
  try{const r=await json(u);report.national[key]={count:r.count}}
  catch(e){report.national[key]={error:String(e.message||e).slice(0,160)}}
 }
 for(const [key,where] of [
 ["exactCounty","PlanningAuthority = 'Cork County Council'"],
 ["corkNames","PlanningAuthority LIKE '%Cork%'"]
 ]){
  const q=new URL(NATIONAL+"/query");
  for(const [k,v] of Object.entries({f:"json",where,returnGeometry:"false",
   outFields:"PlanningAuthority,ApplicationNumber,ReceivedDate,ApplicationType,ApplicationStatus",
   orderByFields:"ReceivedDate DESC",resultRecordCount:"5"}))q.searchParams.set(k,v);
  try{
   const r=await json(q);
   report.national[key]={samples:(r.features||[]).map(x=>{
    const a=x.attributes||{};
    return {authority:String(a.PlanningAuthority||"").slice(0,60),
    reference:String(a.ApplicationNumber||"").slice(0,35),
    receivedDate:ms(a.ReceivedDate),type:String(a.ApplicationType||"").slice(0,50),
    status:String(a.ApplicationStatus||"").slice(0,70)};
   })};
  }catch(e){report.national[key]={error:String(e.message||e).slice(0,160)}}
 }
}catch(e){report.errors.push({stage:"national",error:String(e.message||e).slice(0,180)})}
report.requests=requests;
console.log(JSON.stringify(report,null,2));
