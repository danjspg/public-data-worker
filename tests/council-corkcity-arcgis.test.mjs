import test from "node:test";
import assert from "node:assert/strict";
import {CORKCITY_APAS_URL,parseCorkCityAPAS,weekEndingForDay,chunkByWeek} from "../src/council-corkcity-arcgis.mjs";
const date=(y,m,d)=>Date.UTC(y,m-1,d);
const row={PlanningRefNo:"26/45157",recievedDate:date(2026,11,7),FileYear:2026,appType:"Permission",
 location:"13 Riverside Road, Cork City",
 description:"Construction of a substantial extension to the existing detached house and ancillary site works.",
 applicantName:"Never copy this field",appStatus:"Prepare Acknowledgement Letter"};
const opts={cutoff:"2026-08-01",today:"2026-11-11"};
test("only complete council registrations are admitted and applicant names never copied",()=>{
 const r=parseCorkCityAPAS([{attributes:row}],opts);
 assert.equal(r.applications.length,1);
 assert.equal(r.applications[0].registration_date,"2026-11-07");
 assert.equal(r.applications[0].source_url,CORKCITY_APAS_URL);
 assert.equal(Object.hasOwn(r.applications[0],"applicant_name"),false);
 assert.equal(Object.hasOwn(r.applications[0],"applicantName"),false);
});
test("unsupported type, missing descriptions and future dates are quarantined",()=>{
 const r=parseCorkCityAPAS([
 {attributes:{...row,appType:"Unknown Planning Type"}},
 {attributes:{...row,description:"Short"}},
 {attributes:{...row,recievedDate:date(2026,11,25)}},
 {attributes:{...row,PlanningRefNo:"26/45158",recievedDate:date(2026,11,6),appType:"RETENTION"}}
 ],opts);
 assert.deepEqual(r.applications.map(x=>x.reference),["26/45158"]);
 assert.equal(r.applications[0].application_type,"Retention");
 assert.deepEqual(r.skipped,{unknownType:1,invalid:2,duplicate:0});
});
test("duplicate polygons do not create duplicates, conflicting data fails closed",()=>{
 const r=parseCorkCityAPAS([{attributes:row},{attributes:row}],opts);
 assert.equal(r.applications.length,1);
 assert.equal(r.skipped.duplicate,1);
 assert.throws(()=>parseCorkCityAPAS([{attributes:row},{attributes:{...row,description:"A different long proposal is now recorded for the same planning application."}}],opts),/Conflicting council ArcGIS records/);
});
test("partial calendar weeks cannot carry future publication dates",()=>{
 assert.equal(weekEndingForDay("2026-11-07","2026-11-11"),"2026-11-08");
 assert.equal(weekEndingForDay("2026-11-11","2026-11-11"),"2026-11-11");
 const parsed=parseCorkCityAPAS([
 {attributes:{...row,PlanningRefNo:"26/45158",recievedDate:date(2026,11,11)}},
 {attributes:row},
 {attributes:{...row,PlanningRefNo:"26/45159",recievedDate:date(2026,11,6)}}
 ],opts);
 const chunks=chunkByWeek(parsed.applications,"2026-11-11",2);
 assert.deepEqual(chunks.map(x=>({week:x.week_ending,count:x.applications.length})),[
 {week:"2026-11-11",count:1},{week:"2026-11-08",count:2}]);
});

test("Cork City outline permission is preserved as its official database value",()=>{
 const r=parseCorkCityAPAS([{attributes:{...row,appType:"OUTLINE PERMISSION"}}],opts);
 assert.equal(r.applications[0].application_type,"OUTLINE PERMISSION");
});
