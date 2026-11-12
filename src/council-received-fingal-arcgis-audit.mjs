// Read-only Fingal County Council ArcGIS source audit.
// Queries only Fingal's public ArcGIS map metadata and at most three anonymised
// application reference/date samples per promising layer. No Agile access, no writes.
const ORG="CI1e5PKQXvJgmJK8";
const BASE="https://services5.arcgis.com/"+ORG+"/arcgis/rest/services/";
const layerServices=[
 "Planning_Applications_New_FCC/FeatureServer/0",
 "Planning_Applications_All/FeatureServer/0",
 "Planning_Applications_AGOL_WEB/FeatureServer/0",
 "Fingal_Planning_Applications/FeatureServer/0",
 "PlanningApplicationsFingal/FeatureServer/0",
 "Planning_Applications_Pending/FeatureServer/0",
 "Planning_Applications_Decided_Archived/FeatureServer/0",
 "Planning_Applications_Not_Assigned/FeatureServer/0",
 "Planning_Applications_On_Appeal/FeatureServer/0"
];
const ITEM="fce64680d727452388c3e6b6037866a6";
let calls=0;
async function fetchJson(url){
 const u=new URL(url);
 if(u.protocol!=="https:" ||
   !(u.hostname==="services5.arcgis.com"||
     u.hostname==="www.arcgis.com"))throw Error("Unapproved source host");
 if(calls++>=22)throw Error("Read-only request budget exceeded");
 const res=await fetch(u,{signal:AbortSignal.timeout(17000),redirect:"error",
 headers:{"Accept":"application/json","User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"}});
 if(res.status===403||res.status===429)throw Error("Council/public-data restriction HTTP "+res.status);
 if(!res.ok)throw Error("HTTP "+res.status);
 const raw=await res.text();
 if(raw.length>650000)throw Error("Oversized metadata response");
 const data=JSON.parse(raw);
 if(data.error)throw Error("ArcGIS "+data.error.code+" "+String(data.error.message).slice(0,180));
 return data;
}
const report={readOnly:true,authority:"FINGAL",source:"Official Fingal ArcGIS",layers:[],errors:[]};
try{
 const item=await fetchJson("https://www.arcgis.com/sharing/rest/content/items/"+ITEM+"?f=json");
 report.item={title:item.title,url:item.url,modified:item.modified&&new Date(item.modified).toISOString(),
  type:item.type,owner:item.owner,descriptionFieldClaims:/Planning_Reference|REGISTRATION_DATE/i.test(item.description||"")};
}catch(e){report.errors.push({item:ITEM,error:String(e.message||e)})}
const directory=await fetchJson(BASE+"?f=json");
report.directory={
 planningServices:(directory.services||[]).filter(x=>/plan.*app|app.*plan|apas/i.test(x.name||""))
 .map(x=>({name:x.name,type:x.type})).slice(0,18),
 count:(directory.services||[]).length
};
const dynamicallyFound=(directory.services||[]).filter(x=>/plan.*app|app.*plan|apas/i.test(x.name||""))
 .slice(0,3).map(x=>x.name+"/"+x.type+"/0");
for(const path of [...new Set([...layerServices,...dynamicallyFound])].slice(0,12)){
 const url=BASE+path,entry={service:path};
 try{
  const meta=await fetchJson(url+"?f=json");
  entry.name=meta.name;entry.countExactKnown=meta.maxRecordCount;
  entry.fields=(meta.fields||[]).map(f=>({name:f.name,type:f.type})).slice(0,70);
  entry.dataLastEdit=meta.editingInfo?.dataLastEditDate?new Date(meta.editingInfo.dataLastEditDate).toISOString():null;
  entry.lastEdit=meta.editingInfo?.lastEditDate?new Date(meta.editingInfo.lastEditDate).toISOString():null;
  const refFields=(meta.fields||[]).filter(f=>/PLANNING_REFERENCE|PLANNING_REF|FILE_REF|APP_REF|REFERENCE|FILE_NUM/i.test(f.name)).slice(0,3);
  const dateFields=(meta.fields||[]).filter(f=>/REGISTRATION_DATE|DATE_RECEIV|RECEIVED_DATE|RECEIVED|DATE_REG|SUBMISSION_DATE|RECIEVED_DATE/i.test(f.name)).slice(0,3);
  entry.references=refFields.map(x=>x.name);entry.dates=dateFields.map(x=>({name:x.name,type:x.type}));
  if(refFields.length&&dateFields.length){
   const field=dateFields[0],ref=refFields[0];
   const q=new URL(url+"/query");
   for(const [k,v] of Object.entries({f:"json",where:"1=1",outFields:[ref.name,field.name].join(","),
     returnGeometry:"false",orderByFields:field.name+" DESC",resultRecordCount:"3"}))q.searchParams.set(k,v);
   const data=await fetchJson(q);
   entry.samples=(data.features||[]).map(x=>({
     ref:String(x.attributes?.[ref.name]||"").slice(0,32),
     receivedDate:typeof x.attributes?.[field.name]==="number"?
       new Date(x.attributes[field.name]).toISOString().slice(0,10):
       String(x.attributes?.[field.name]||"").slice(0,32)
   }));
  }else if(refFields.length){
   const ref=refFields[0];
   const q=new URL(url+"/query");
   for(const [k,v] of Object.entries({f:"json",where:"1=1",outFields:ref.name,
     returnGeometry:"false",orderByFields:"OBJECTID DESC",resultRecordCount:"3"}))q.searchParams.set(k,v);
   try{const data=await fetchJson(q);entry.samples=(data.features||[]).map(x=>({ref:String(x.attributes?.[ref.name]||"").slice(0,32)}));}
   catch(e){entry.queryError=String(e.message||e)}
  }else if((meta.fields||[]).length<=4){
   entry.onlyGeometryFields=true;
  }
 }catch(e){entry.error=String(e.message||e).slice(0,220)}
 report.layers.push(entry);
}
const LIVE=BASE+"PlanningApplicationsFingal/FeatureServer/0";
report.liveCoverage={};
for(const [label,params] of [
 ["count",{where:"REGISTRATION_DATE >= TIMESTAMP '2026-08-01 00:00:00'",returnCountOnly:"true"}],
 ["sample",{where:"REGISTRATION_DATE >= TIMESTAMP '2026-08-01 00:00:00'",
 outFields:"PLANNING_REFERENCE,REGISTRATION_DATE,LOCATION,DESCRIPTION,CURRENT_STATUS,DECISION_DATE",
 orderByFields:"REGISTRATION_DATE DESC",returnGeometry:"false",resultRecordCount:"900"}]
]){
 const u=new URL(LIVE+"/query");
 for(const [k,v] of Object.entries({f:"json",...params}))u.searchParams.set(k,v);
 try{
 const d=await fetchJson(u);
 if(label==="count")report.liveCoverage.count=d.count;
 else {
  const seen=new Map(),stat=new Map(),types={dateMiss:0,locationMiss:0,descriptionMiss:0,refMiss:0,refDuplicate:0,conflict:0},fresh=[];
  for(const f of d.features||[]){
   const a=f.attributes||{};
   const date=typeof a.REGISTRATION_DATE==="number"?new Date(a.REGISTRATION_DATE).toISOString().slice(0,10):null;
   const ref=String(a.PLANNING_REFERENCE||"");
   const status=String(a.CURRENT_STATUS||"").slice(0,50);
   stat.set(status,(stat.get(status)||0)+1);
   if(!date)types.dateMiss++;
   if(String(a.LOCATION||"").trim().length<7)types.locationMiss++;
   if(String(a.DESCRIPTION||"").trim().length<24)types.descriptionMiss++;
   if(!/^(?:FW?|LRD)\d{2}[AB]\/\d{4}E?$/i.test(ref))types.refMiss++;
   if(seen.has(ref)){
    types.refDuplicate++;
    const prior=seen.get(ref);
    if(prior.date!==date||prior.status!==status)types.conflict++;
   }else seen.set(ref,{date,status});
   if(fresh.length<5)fresh.push({ref,date,status,decision:a.DECISION_DATE?new Date(a.DECISION_DATE).toISOString().slice(0,10):null});
  }
  report.liveCoverage={...report.liveCoverage,received:(d.features||[]).length,exceeded:d.exceededTransferLimit===true,
    distinct:seen.size,latest:fresh[0]?.date||null,highest:fresh,checks:types,statuses:[...stat].sort((a,b)=>b[1]-a[1]).slice(0,15)};
 }
 }catch(e){report.liveCoverage[label]={error:String(e.message||e)}}
}
report.calls=calls;
console.log(JSON.stringify(report,null,2));
