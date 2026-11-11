// Read-only Cork City Council ArcGIS map audit. No Agile, no database writes.
// Bounded public metadata queries, and at most two sample records per date field.
// Do not print names, full descriptions or property addresses.
const APP_ID="041f0ee1d0644bd191a897e67da5334b";
const PORTAL="https://www.arcgis.com/sharing/rest/content/items/";
let requests=0;
function allowed(url){
 const u=new URL(url);
 if(u.protocol!=="https:" ||
   !(u.hostname==="www.arcgis.com"||u.hostname.endsWith(".arcgis.com")||
     u.hostname==="gis.corkcity.ie"||u.hostname==="maps.corkcity.ie"||
     u.hostname==="gis.corkcity.ie"||u.hostname==="corkcityco.maps.arcgis.com"))
   throw Error("Non-ArcGIS/Cork City source rejected: "+u.hostname);
 return u;
}
async function json(url){
 const u=allowed(url);
 if(++requests>22)throw Error("Read-only query cap reached");
 const res=await fetch(u,{redirect:"error",signal:AbortSignal.timeout(18000),
  headers:{"Accept":"application/json","User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"}});
 if(res.status===403||res.status===429)throw Error("Stop on council/ArcGIS HTTP "+res.status);
 if(!res.ok)throw Error("HTTP "+res.status+" "+u.hostname);
 const data=await res.json();
 if(data?.error)throw Error("ArcGIS "+data.error.code+" "+String(data.error.message).slice(0,120));
 return data;
}
const fmt=ts=>ts?new Date(ts).toISOString().slice(0,10):null;
const report={readOnly:true,appId:APP_ID,requests:0,maps:[],layers:[],errors:[]};
function examine(node,from,layerEntries,mapIds,depth=0){
 if(!node||typeof node!=="object"||depth>10)return;
 if(Array.isArray(node)){for(const n of node.slice(0,90))examine(n,from,layerEntries,mapIds,depth+1);return;}
 if(typeof node.url==="string"&&/\/(?:MapServer|FeatureServer)(?:\/\d+)?(?:$|\?)/i.test(node.url))
   layerEntries.push({name:node.title||node.name||node.label||node.id||"",url:node.url,from});
 for(const [key,value] of Object.entries(node)){
  if((key==="itemId"||key==="webmap"||key==="webmapId"||key==="mapId"||key==="webMapId")&&
    typeof value==="string"&&/^[a-f0-9]{32}$/i.test(value))mapIds.add(value);
  if(typeof value==="object"&&value)examine(value,from,layerEntries,mapIds,depth+1);
 }
}
const entries=[],mapIds=new Set();
try{
 const item=await json(PORTAL+APP_ID+"?f=json");
 report.app={type:item.type,title:item.title,owner:item.owner,modified:fmt(item.modified),created:fmt(item.created)};
 const appData=await json(PORTAL+APP_ID+"/data?f=json");
 examine(appData,"application",entries,mapIds);
 report.config={topLevelKeys:Object.keys(appData).slice(0,30),webMapIds:[...mapIds].slice(0,5),serviceReferences:entries.length};
}catch(e){report.errors.push({stage:"app",error:String(e.message||e)});}
for(const id of [...mapIds].filter(x=>x!==APP_ID).slice(0,3)){
 try{
  const m=await json(PORTAL+id+"?f=json"),data=await json(PORTAL+id+"/data?f=json");
  report.maps.push({id,title:m.title,modified:fmt(m.modified),owner:m.owner,layerCount:data.operationalLayers?.length||0});
  examine(data,"webmap:"+id,entries,new Set());
 }catch(e){report.errors.push({stage:"webmap",id,error:String(e.message||e)})}
}
const candidates=[...new Map(entries.map(e=>[e.url,e])).values()];
report.candidateServices=candidates.slice(0,22).map(x=>({name:String(x.name).slice(0,85),url:x.url,from:x.from}));
let targets=candidates.filter(x=>/planning|apas|application|enquiry/i.test(x.name));
if(!targets.length)targets=candidates.slice(0,5);
for(const target of targets.slice(0,7)){
 const u=new URL(target.url);
 const path=u.pathname.replace(/\/$/,"");
 try{
  const service=await json(u.origin+path+"?f=json");
  const layers=Array.isArray(service.layers)?service.layers:
     service.id!=null?[{id:service.id,name:service.name}]:[];
  const selected=layers.filter(l=>/planning|apas|application|enquiry/i.test(l.name||""));
  const toInspect=(selected.length?selected:layers).slice(0,5);
  for(const layer of toInspect){
   try{
    const base=/\/\d+$/.test(path)?u.origin+path:u.origin+path+"/"+layer.id;
    const meta=/\/\d+$/.test(path)?service:await json(base+"?f=json");
    const fields=(meta.fields||[]).map(f=>({name:f.name,type:f.type}));
    const dateFields=fields.filter(f=>/date|received|register|submitted|created/i.test(f.name)).slice(0,6);
    const refs=fields.filter(f=>/ref|app.*num|plan.*num/i.test(f.name)).slice(0,3);
    const stat={name:layer.name,url:base,geometry:meta.geometryType,
      lastEdit:fmt(meta.editingInfo?.lastEditDate),dataLastEdit:fmt(meta.editingInfo?.dataLastEditDate),
      fields:fields.slice(0,45),dateFields:dateFields.map(x=>x.name),refFields:refs.map(x=>x.name),samples:[]};
    for(const df of dateFields.slice(0,2)){
     const q=new URL(base+"/query");
     for(const [k,v] of Object.entries({f:"json",where:"1=1",
       outFields:[df.name,...refs.map(x=>x.name)].join(","),returnGeometry:"false",
       resultRecordCount:"2",orderByFields:df.name+" DESC"}))q.searchParams.set(k,v);
     try{
      const data=await json(q);
      stat.samples.push({sort:df.name,rows:(data.features||[]).slice(0,2).map(x=>{
       const a=x.attributes||{},d=a[df.name];
       return {date:typeof d==="number"?fmt(d):d,
        refs:refs.map(ref=>String(a[ref.name]??"").slice(0,35))};
      })});
     }catch(e){stat.samples.push({sort:df.name,error:String(e.message||e).slice(0,130)})}
    }
    report.layers.push(stat);
   }catch(e){report.errors.push({stage:"layer",layer:layer.name,error:String(e.message||e).slice(0,130)})}
  }
 }catch(e){report.errors.push({stage:"service",name:target.name,error:String(e.message||e).slice(0,130)})}
}
report.requests=requests;
console.log(JSON.stringify(report,null,2));
