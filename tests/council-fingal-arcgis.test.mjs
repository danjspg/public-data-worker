import assert from "node:assert/strict";
import test from "node:test";
import {FINGAL_ARCGIS_URL,parseFingalArcGIS,fingalWeekEnding,groupFingalByWeek} from "../src/council-fingal-arcgis.mjs";
const d=(year,month,day)=>Date.UTC(year,month-1,day);
const base={PLANNING_REFERENCE:"FW26A/0414E",REGISTRATION_DATE:d(2026,11,6),
 LOCATION:"5 Sycamore Lawn, Castleknock, Dublin 15",
 DESCRIPTION:"Amendments to roof profile and a new side gable window and associated works.",
 APPLICANT_NAME:"Must not be copied",CURRENT_STATUS:"Current status not assigned in APAS"};
const opts={cutoff:"2026-08-01",today:"2026-11-12"};
test("registration is preserved without inferring type, status or applicant names",()=>{
 const r=parseFingalArcGIS([{attributes:base}],opts);
 assert.deepEqual(r.applications[0],{
 reference:"FW26A/0414E",web_reference:"FW26A/0414E",registration_date:"2026-11-06",
 application_type:null,location:base.LOCATION,proposal:base.DESCRIPTION,source_url:FINGAL_ARCGIS_URL});
});
test("recognises official LRD, CU and revision reference formats",()=>{
 const attrs=["LRD0109/S3E","CU/26/003","F26A/0817E/R3","FW26A/0422"].map(ref=>({
 attributes:{...base,PLANNING_REFERENCE:ref,REGISTRATION_DATE:d(2026,10,12)}}));
 const r=parseFingalArcGIS(attrs,opts);
 assert.equal(r.applications.length,4);assert.equal(r.skipped.invalid,0);
});
test("reject incomplete, mismatched-year and future records",()=>{
 const r=parseFingalArcGIS([
 {attributes:{...base,PLANNING_REFERENCE:"F25A/0123"}},
 {attributes:{...base,DESCRIPTION:"Short"}},
 {attributes:{...base,REGISTRATION_DATE:d(2026,11,23)}},
 {attributes:{...base,LOCATION:"x"}},{attributes:base}],opts);
 assert.equal(r.applications.length,1);assert.equal(r.skipped.invalid,4);
});
test("duplicate geometry is deduplicated but conflicts fail closed",()=>{
 const r=parseFingalArcGIS([{attributes:base},{attributes:base}],opts);
 assert.equal(r.applications.length,1);assert.equal(r.skipped.duplicate,1);
 assert.throws(()=>parseFingalArcGIS([{attributes:base},
 {attributes:{...base,DESCRIPTION:"A different large-scale proposed renovation of this property."}}],opts),/Conflicting public Fingal ArcGIS records/);
});
test("reject alternate source URL and unbounded batches",()=>{
 assert.throws(()=>parseFingalArcGIS([],{...opts,sourceUrl:"https://untrusted.example"}),/Untrusted/);
 assert.throws(()=>parseFingalArcGIS(new Array(901).fill({attributes:base}),opts),/Untrusted/);
});
test("weekly groups cap records and use current partial-week ending",()=>{
 const applications=parseFingalArcGIS([{attributes:base},
 {attributes:{...base,PLANNING_REFERENCE:"F26A/0978E",REGISTRATION_DATE:d(2026,11,5)}},
 {attributes:{...base,PLANNING_REFERENCE:"F26A/0980E",REGISTRATION_DATE:d(2026,11,12)}}],opts).applications;
 assert.equal(fingalWeekEnding("2026-11-06","2026-11-12"),"2026-11-08");
 assert.equal(fingalWeekEnding("2026-11-12","2026-11-12"),"2026-11-12");
 assert.deepEqual(groupFingalByWeek(applications,"2026-11-12").map(x=>({week:x.week_ending,n:x.applications.length})),[
 {week:"2026-11-12",n:1},{week:"2026-11-08",n:2}]);
});
