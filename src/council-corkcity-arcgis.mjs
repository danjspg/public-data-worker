// Official Cork City Council public ArcGIS planning-application registration source.
// Data is independently published by Cork City Council, not the Agile Citizens Portal.
export const CORKCITY_APAS_URL="https://services-eu1.arcgis.com/f0ZQOHXBIeLonX0V/arcgis/rest/services/PlanningPolygonAPAS_view/FeatureServer/0";
export const CORKCITY_REF=/^\d{2}\/\d{4,6}$/;
const date=/^\d{4}-\d\d-\d\d$/;
const norm=x=>String(x??"").replace(/\s+/g," ").trim();

export function arcgisDay(value){
 if(typeof value!=="number"||!Number.isFinite(value))return null;
 const v=new Date(value);
 return Number.isNaN(v.getTime())?null:v.toISOString().slice(0,10);
}
function appType(value){
 const t=norm(value).toLowerCase();
 if(t==="permission")return "Permission";
 if(t==="retention"||t==="retention permission")return "Retention";
 if(t==="permission for retention")return "Permission for Retention";
 if(t==="permission and retention")return "Permission and Retention";
 if(t==="permission consequent")return "Permission Consequent";
 if(t==="outline permission")return "OUTLINE PERMISSION";
 return null; // Outline and unknown types are quarantined, not relabelled.
}
export function parseCorkCityAPAS(features,{cutoff,today,sourceUrl=CORKCITY_APAS_URL}){
 if(sourceUrl!==CORKCITY_APAS_URL||!date.test(cutoff)||!date.test(today)||
  !Array.isArray(features)||features.length>1000)throw Error("Untrusted Cork City ArcGIS input");
 const apps=[],seen=new Map(),skipped={unknownType:0,invalid:0,duplicate:0},types=new Map();
 for(const item of features){
  const a=item?.attributes;
  if(!a||typeof a!=="object"){skipped.invalid++;continue;}
  const reference=norm(a.PlanningRefNo).toUpperCase();
  const registration_date=arcgisDay(a.recievedDate); // Historical API spelling.
  const application_type=appType(a.appType);
  types.set(norm(a.appType)||"(empty)",(types.get(norm(a.appType)||"(empty)")||0)+1);
  const location=norm(a.location),proposal=norm(a.description);
  if(!application_type){skipped.unknownType++;continue;}
  if(!CORKCITY_REF.test(reference)||!registration_date||
     registration_date<cutoff||registration_date>today||
     Number(reference.slice(0,2))!==Number(registration_date.slice(2,4))||
     (a.FileYear!=null&&Number(a.FileYear)!==Number(registration_date.slice(0,4)))||
     location.length<7||location.length>3000||
     proposal.length<24||proposal.length>3000){
    skipped.invalid++;continue;
  }
  const row={reference,web_reference:reference,registration_date,
   application_type,location,proposal,source_url:sourceUrl};
  const prior=seen.get(reference);
  if(prior){
   if(JSON.stringify(prior)!==JSON.stringify(row))
     throw Error("Conflicting council ArcGIS records for "+reference);
   skipped.duplicate++;continue;
  }
  seen.set(reference,row);apps.push(row);
 }
 apps.sort((a,b)=>b.registration_date.localeCompare(a.registration_date)||a.reference.localeCompare(b.reference));
 return {applications:apps,headers:features.length,skipped,types:[...types.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15)};
}
export function weekEndingForDay(received,today){
 if(!date.test(received)||!date.test(today))throw Error("Invalid council calendar date");
 const base=Date.parse(received+"T00:00:00Z");
 if(!Number.isFinite(base)||new Date(base).toISOString().slice(0,10)!==received||received>today)
  throw Error("Untrusted council registration date");
 const weekday=new Date(base).getUTCDay();
 const sunday=new Date(base+((7-weekday)%7)*86400000).toISOString().slice(0,10);
 return sunday>today?today:sunday; // Current partial week cannot carry a future date.
}
export function chunkByWeek(applications,today,chunkSize=25){
 if(chunkSize<1||chunkSize>30)throw Error("Invalid weekly document size");
 const m=new Map();
 for(const app of applications){
  const wk=weekEndingForDay(app.registration_date,today);
  if(!m.has(wk))m.set(wk,[]);
  m.get(wk).push(app);
 }
 const chunks=[];
 for(const [week_ending,apps] of [...m].sort((a,b)=>b[0].localeCompare(a[0])))
  for(let i=0;i<apps.length;i+=chunkSize)
   chunks.push({week_ending,applications:apps.slice(i,i+chunkSize)});
 return chunks;
}
