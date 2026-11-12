// Independently published, public Fingal County Council ArcGIS registrations.
// This feature layer has an authoritative registration date/reference/location/
// description. It does NOT have an application-type field or reliable live
// lifecycle status, so neither is inferred.
export const FINGAL_ARCGIS_URL="https://services5.arcgis.com/CI1e5PKQXvJgmJK8/arcgis/rest/services/PlanningApplicationsFingal/FeatureServer/0";
export const FINGAL_REF=/^(?:FW?\d{2}[AB]\/\d{4}E?(?:\/R[1-9])?|LRD\d{4}\/S3E?|CU\/\d{2}\/\d{3})$/;
const ISO=/^\d{4}-\d\d-\d\d$/;
function clean(v){return String(v??"").replace(/[\u0000-\u001F]/g," ").replace(/\s+/g," ").trim()}
function dateValue(value){
 if(typeof value!=="number"||!Number.isFinite(value))return null;
 const d=new Date(value);
 return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}
function yearOfReference(ref){
 const m=ref.match(/^(?:FW?(\d{2})[AB]\/|CU\/(\d{2})\/)/);
 return m?Number(m[1]||m[2]):null;
}
export function parseFingalArcGIS(features,{cutoff,today,sourceUrl=FINGAL_ARCGIS_URL}){
 if(sourceUrl!==FINGAL_ARCGIS_URL||!ISO.test(cutoff)||!ISO.test(today)||
    !Array.isArray(features)||features.length>900)throw Error("Untrusted Fingal source batch");
 const applications=[],seen=new Map(),skipped={invalid:0,duplicate:0};
 for(const entry of features){
  const a=entry?.attributes;
  if(!a||typeof a!=="object"){skipped.invalid++;continue}
  const reference=clean(a.PLANNING_REFERENCE).toUpperCase(),
    registration_date=dateValue(a.REGISTRATION_DATE),
    location=clean(a.LOCATION),proposal=clean(a.DESCRIPTION);
  const refYear=yearOfReference(reference);
  if(!FINGAL_REF.test(reference)||!registration_date||
     registration_date<cutoff||registration_date>today||
     (refYear!==null&&refYear!==Number(registration_date.slice(2,4)))||
     location.length<7||location.length>3000||
     proposal.length<24||proposal.length>3000){
    skipped.invalid++;continue;
  }
  // application_type is deliberately null: Fingal's open ArcGIS layer does not publish it.
  // A registration record must not be represented as a verified current decision.
  const row={reference,web_reference:reference,registration_date,
   application_type:null,location,proposal,source_url:sourceUrl};
  if(seen.has(reference)){
   if(JSON.stringify(seen.get(reference))!==JSON.stringify(row))
    throw Error("Conflicting public Fingal ArcGIS records for "+reference);
   skipped.duplicate++;continue;
  }
  seen.set(reference,row);applications.push(row);
 }
 applications.sort((a,b)=>b.registration_date.localeCompare(a.registration_date)||a.reference.localeCompare(b.reference));
 return {applications,headers:features.length,skipped};
}
export function fingalWeekEnding(received,today){
 if(!ISO.test(received)||!ISO.test(today))throw Error("Untrusted council date");
 const t=Date.parse(received+"T00:00:00Z");
 if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==received||received>today)
  throw Error("Untrusted council registration date");
 const end=new Date(t+((7-new Date(t).getUTCDay())%7)*86400000).toISOString().slice(0,10);
 return end>today?today:end;
}
export function groupFingalByWeek(applications,today,chunkSize=25){
 if(!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>25)
  throw Error("Invalid Fingal source batch size");
 const weeks=new Map();
 for(const item of applications){
  const week=fingalWeekEnding(item.registration_date,today);
  if(!weeks.has(week))weeks.set(week,[]);
  weeks.get(week).push(item);
 }
 const output=[];
 for(const [week_ending,records] of [...weeks].sort((a,b)=>b[0].localeCompare(a[0])))
  for(let i=0;i<records.length;i+=chunkSize)
   output.push({week_ending,applications:records.slice(i,i+chunkSize)});
 return output;
}
