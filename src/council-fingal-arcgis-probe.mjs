// Read-only, bounded official Fingal open-data capability and freshness probe.
// No authentication, proxy or alternate client identity. Never log applicant data.
const root="https://services5.arcgis.com/CI1e5PKQXvJgmJK8/arcgis/rest/services/Planning_Applications_New_FCC/FeatureServer/0";
const agent="openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)";
async function get(url){
 const response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(14000),
  headers:{"User-Agent":agent,"Accept":"application/json"}});
 if(!response.ok)throw Error("Official ArcGIS HTTP "+response.status);
 return response.json();
}
const metadata=await get(root+"?f=json");
console.log(JSON.stringify({metadata:{name:metadata.name,type:metadata.type,maxRecordCount:metadata.maxRecordCount,
 fields:(metadata.fields||[]).map(x=>x.name),advancedQueryCapabilities:metadata.advancedQueryCapabilities,
 supportsAdvancedQueries:metadata.advancedQueryCapabilities?.supportsOrderBy, lastEditDate:metadata.editingInfo?.lastEditDate}},null,2));
async function query(label,options={}){
 const url=new URL(root+"/query");
 for(const [k,v] of Object.entries({where:"1=1",outFields:"PLANNING_REFERENCE,REGISTRATION_DATE,LOCATION,DESCRIPTION,CURRENT_STATUS,MORE_INFORMATION",resultRecordCount:"5",returnGeometry:"false",f:"json",...options}))url.searchParams.set(k,v);
 try{
  const json=await get(url);
  if(json?.error)throw Error("ArcGIS "+json.error.code+" "+String(json.error.message).slice(0,80)+" "+String(json.error.details||"").slice(0,180));
  if(!Array.isArray(json?.features))throw Error("Missing features array");
  if(json.features.length>5)throw Error("Unexpected feature count");
  const sample=json.features.map(x=>{const a=x.attributes||{};return {
    reference:String(a.PLANNING_REFERENCE||"").slice(0,24),
    registered:a.REGISTRATION_DATE==null?null:new Date(a.REGISTRATION_DATE).toISOString().slice(0,10),
    locationChars:String(a.LOCATION||"").length,proposalChars:String(a.DESCRIPTION||"").length,
    status:String(a.CURRENT_STATUS||"").slice(0,30)}});
  console.log(JSON.stringify({label,ok:true,sample,exceededTransferLimit:json.exceededTransferLimit}));
 }catch(error){console.log(JSON.stringify({label,ok:false,error:String(error.message||error).slice(0,260)}));}
}
await query("basic");
await query("order",{orderByFields:"REGISTRATION_DATE DESC"});
await query("since_timestamp",{where:"REGISTRATION_DATE >= TIMESTAMP '2026-10-20 00:00:00'"});
await query("since_date",{where:"REGISTRATION_DATE >= DATE '2026-10-20'"});
