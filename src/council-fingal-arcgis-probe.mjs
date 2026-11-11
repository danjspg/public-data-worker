// Read-only, bounded official Fingal open-data freshness probe.
// Logs only registration-date ranges, reference IDs and field-presence checks.
const endpoint="https://services5.arcgis.com/CI1e5PKQXvJgmJK8/arcgis/rest/services/Planning_Applications_New_FCC/FeatureServer/0/query";
async function query(where,count=8){
 const url=new URL(endpoint);
 for(const [k,v] of Object.entries({where,outFields:"PLANNING_REFERENCE,REGISTRATION_DATE,LOCATION,DESCRIPTION,CURRENT_STATUS,MORE_INFORMATION",orderByFields:"REGISTRATION_DATE DESC",resultRecordCount:String(count),returnGeometry:"false",f:"json"}))url.searchParams.set(k,v);
 const response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(12000),
  headers:{"User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)","Accept":"application/json"}});
 if(!response.ok)throw Error("Fingal official open data HTTP "+response.status);
 const json=await response.json();
 if(json?.error)throw Error("ArcGIS error "+json.error.code+" "+String(json.error.message).slice(0,80));
 if(!Array.isArray(json?.features)||json.features.length>count)throw Error("Unexpected Fingal data response");
 return json.features.map(x=>x.attributes||{});
}
const raw=await query("1=1");
const recent=await query("REGISTRATION_DATE >= TIMESTAMP '2026-10-20 00:00:00'",12).catch(error=>({error:String(error.message||error)}));
const summarize=rows=>Array.isArray(rows)?rows.map(x=>({
 reference:String(x.PLANNING_REFERENCE||"").slice(0,30),
 registered:x.REGISTRATION_DATE==null?null:new Date(x.REGISTRATION_DATE).toISOString().slice(0,10),
 locationChars:String(x.LOCATION||"").length,
 proposalChars:String(x.DESCRIPTION||"").length,
 status:String(x.CURRENT_STATUS||"").slice(0,30),
 infoHost:(()=>{try{return new URL(x.MORE_INFORMATION).hostname}catch{return null}})()
})) : rows;
console.log(JSON.stringify({readOnly:true,endpointHost:new URL(endpoint).hostname,
 firstCount:raw.length,sample:summarize(raw),recent:summarize(recent)},null,2));
