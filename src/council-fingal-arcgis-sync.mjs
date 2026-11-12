// Daily bounded Fingal source stage via council-owned public ArcGIS.
// No Agile requests, no requests for names, no production writes.
import pg from "pg";
import {createHash} from "node:crypto";
import {FINGAL_ARCGIS_URL,parseFingalArcGIS,groupFingalByWeek} from "./council-fingal-arcgis.mjs";
const DRY=process.argv.includes("--dry-run");
const TODAY=new Date().toISOString().slice(0,10);
const DAY_MS=86400000,first=new Date(Date.parse(TODAY+"T00:00:00Z")-100*DAY_MS).toISOString().slice(0,10);
const CUTOFF=first<"2026-08-01"?"2026-08-01":first;
const MAX=900;
let networkCalls=0;
async function query(params){
 if(++networkCalls>2)throw Error("Fingal ArcGIS request limit exceeded");
 const url=new URL(FINGAL_ARCGIS_URL+"/query");
 for(const [key,value] of Object.entries({
  f:"json",where:"REGISTRATION_DATE >= TIMESTAMP '"+CUTOFF+" 00:00:00'",...params
 }))url.searchParams.set(key,String(value));
 const res=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(18000),
  headers:{"Accept":"application/json",
   "User-Agent":"openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)"}});
 if(res.status===403||res.status===429)throw Error("Official Fingal ArcGIS source refused HTTP "+res.status);
 if(!res.ok)throw Error("Official Fingal ArcGIS source returned HTTP "+res.status);
 const body=await res.text();
 if(body.length>5000000)throw Error("Oversized Fingal public source response");
 const data=JSON.parse(body);
 if(data?.error)throw Error("Fingal public ArcGIS query failed: "+String(data.error.message).slice(0,120));
 return data;
}
const total=await query({returnCountOnly:"true"});
if(!Number.isSafeInteger(total.count)||total.count<=0||total.count>MAX)
 throw Error("Fingal source records exceed safe page size or empty: "+total.count);
const response=await query({outFields:"PLANNING_REFERENCE,REGISTRATION_DATE,LOCATION,DESCRIPTION",
 orderByFields:"REGISTRATION_DATE DESC",resultRecordCount:String(MAX),returnGeometry:"false"});
if(response.exceededTransferLimit===true||!Array.isArray(response.features)||
 response.features.length!==total.count)throw Error("Fingal official source page incomplete");
const parsed=parseFingalArcGIS(response.features,{cutoff:CUTOFF,today:TODAY});
if(parsed.skipped.invalid>0)throw Error("Quarantined incomplete Fingal source rows: "+parsed.skipped.invalid);
const latest=parsed.applications[0]?.registration_date;
if(!latest)throw Error("No validated current Fingal registrations");
const ageDays=(Date.parse(TODAY+"T00:00:00Z")-Date.parse(latest+"T00:00:00Z"))/DAY_MS;
if(ageDays>35)throw Error("Fingal registration source is stale by "+ageDays+" days");
const chunks=groupFingalByWeek(parsed.applications,TODAY);
if(chunks.length>55)throw Error("Unexpectedly many Fingal weekly batches");
const summary={dryRun:DRY,authority:"FINGAL",source:FINGAL_ARCGIS_URL,cutoff:CUTOFF,
 totalFeatures:total.count,verified:parsed.applications.length,latestRegistration:latest,
 ageDays,skipped:parsed.skipped,chunks:chunks.length,networkCalls,
 staged:0,alreadyStaged:0,examples:parsed.applications.slice(0,6)
 .map(x=>({reference:x.reference,date:x.registration_date,application_type:x.application_type}))};
if(!DRY){
 if(!process.env.WORKER_DATABASE_URL)throw Error("WORKER_DATABASE_URL required");
 const db=new pg.Client({connectionString:process.env.WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
 await db.connect();
 try{
  for(const {week_ending,applications} of chunks){
   const sha256=createHash("sha256").update(JSON.stringify(applications)).digest("hex");
   const work_key="FINGAL_ARCGIS_V1:"+week_ending+":"+sha256.slice(0,18);
   const input={authority:"FINGAL",url:FINGAL_ARCGIS_URL,week_ending,
    type:"arcgis",source_id:"fingal-planning-applications-public-v1"};
   const result={ok:true,authority:"FINGAL",url:FINGAL_ARCGIS_URL,week_ending,
    parser_version:3,sha256,headers:applications.length,applications,
    checked_at:new Date().toISOString()};
   const {rowCount}=await db.query("insert into work_items(job_type,work_key,input,status,result,completed_at,updated_at) values('council_weekly_received',$1,$2::jsonb,'completed',$3::jsonb,now(),now()) on conflict(job_type,work_key) do nothing returning id",
     [work_key,JSON.stringify(input),JSON.stringify(result)]);
   if(rowCount)summary.staged++;else summary.alreadyStaged++;
  }
 }finally{await db.end()}
}
console.log(JSON.stringify(summary,null,2));
