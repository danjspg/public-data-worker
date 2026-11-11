// Bounded, daily independent council source: Cork City public ArcGIS FeatureServer.
// No Agile request, cookies, identity spoofing, retries on 403/429 or proxying.
import pg from "pg";
import {createHash} from "node:crypto";
import {CORKCITY_APAS_URL,parseCorkCityAPAS,chunkByWeek} from "./council-corkcity-arcgis.mjs";
const DRY=process.argv.includes("--dry-run");
const TODAY=new Date().toISOString().slice(0,10);
const start=new Date(Date.parse(TODAY+"T00:00:00Z")-100*86400000).toISOString().slice(0,10);
const CUTOFF=start<"2026-08-01"?"2026-08-01":start;
const MAX=1000;
let networkCalls=0;
async function query(params){
 const u=new URL(CORKCITY_APAS_URL+"/query");
 for(const [k,v] of Object.entries({f:"json",where:"recievedDate >= TIMESTAMP '"+CUTOFF+" 00:00:00'",...params}))
  u.searchParams.set(k,v);
 if(++networkCalls>2)throw Error("Council ArcGIS read cap reached");
 const res=await fetch(u,{redirect:"error",signal:AbortSignal.timeout(18000),
  headers:{"Accept":"application/json","User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"}});
 if(res.status===403||res.status===429)throw Error("Council ArcGIS source refused public request HTTP "+res.status);
 if(!res.ok)throw Error("Cork City official ArcGIS HTTP "+res.status);
 const bytes=await res.text();
 if(bytes.length>4500000)throw Error("Oversized official ArcGIS response");
 const data=JSON.parse(bytes);
 if(data?.error)throw Error("Official ArcGIS query refused: "+String(data.error.message).slice(0,130));
 return data;
}
const count=await query({returnCountOnly:"true"});
if(!Number.isSafeInteger(count.count)||count.count<1||count.count>=MAX)
 throw Error("Cork City source empty or exceeds bounded page: "+count.count);
const response=await query({
 outFields:"PlanningRefNo,recievedDate,location,description,appType,appStatus,FileYear",
 orderByFields:"recievedDate DESC",
 resultRecordCount:String(MAX),
 returnGeometry:"false"
});
if(response.exceededTransferLimit===true||!Array.isArray(response.features)||
 response.features.length!==count.count)throw Error("Official council ArcGIS page incomplete; do not stage");
const parsed=parseCorkCityAPAS(response.features,{cutoff:CUTOFF,today:TODAY});
const latest=parsed.applications[0]?.registration_date;
if(!latest)throw Error("No verified current council registrations");
const age=(Date.parse(TODAY+"T00:00:00Z")-Date.parse(latest+"T00:00:00Z"))/86400000;
if(age>35)throw Error("Council ArcGIS application data stale by "+age+" days");
const chunks=chunkByWeek(parsed.applications,TODAY,25);
if(chunks.length>50)throw Error("Unexpectedly many ArcGIS weekly source jobs");
const summary={dryRun:DRY,source:CORKCITY_APAS_URL,cutoff:CUTOFF,today:TODAY,
 totalSourceFeatures:count.count,verified:parsed.applications.length,
 latestReceived:latest,ageDays:age,skipped:parsed.skipped,types:parsed.types,
 documentChunks:chunks.length,staged:0,alreadyStaged:0,networkCalls,
 samples:parsed.applications.slice(0,5).map(x=>({ref:x.reference,date:x.registration_date,type:x.application_type}))};
if(!DRY){
 if(!process.env.WORKER_DATABASE_URL)throw Error("WORKER_DATABASE_URL required");
 const {Client}=pg,db=new Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
 await db.connect();
 try{
  for(const {week_ending,applications} of chunks){
   const digest=createHash("sha256").update(JSON.stringify(applications)).digest("hex");
   const work_key="CORKCITY_ARCGIS_V1:"+week_ending+":"+digest.slice(0,18);
   const input={authority:"CORKCITY",url:CORKCITY_APAS_URL,week_ending,
     type:"arcgis",source_id:"corkcity-apas-public-v1"};
   const result={ok:true,authority:"CORKCITY",url:CORKCITY_APAS_URL,week_ending,
     parser_version:3,sha256:digest,headers:applications.length,skipped:0,
     applications,checked_at:new Date().toISOString()};
   const q=await db.query("insert into work_items(job_type,work_key,input,status,result,completed_at,updated_at) values('council_weekly_received',$1,$2::jsonb,'completed',$3::jsonb,now(),now()) on conflict(job_type,work_key) do nothing returning id",
    [work_key,JSON.stringify(input),JSON.stringify(result)]);
   if(q.rowCount===1)summary.staged++;
   else summary.alreadyStaged++;
  }
 }finally{await db.end()}
}
console.log(JSON.stringify(summary,null,2));
