import test from "node:test";
import assert from "node:assert/strict";
import {mapalertsDate,discoverCorkMapalertWeeks,parseCorkMapalertsReceived} from "../src/council-mapalerts-cork.mjs";
const url="https://mapalerts.corkcoco.ie/en/alerts/item?view=form&ref=abcedf0123456789";
test("find official weeks and reject off-domain alerts",()=>{
 const html='<a href="/en/alerts/item?view=form&amp;ref=abcedf0123456789">Weekly Planning Alert, 19/10/2026</a>'+
 '<a href="https://evil.test/alerts/item?ref=x">Weekly Planning Alert, 12/10/2026</a>'+
 '<a href="/en/alerts/item?ref=old">Weekly Planning Alert, 20/07/2026</a>';
 assert.deepEqual(discoverCorkMapalertWeeks(html).map(x=>x.week_ending),["2026-10-19"]);
});
test("MapAlerts original applications only; no decision-made update becomes new case",()=>{
 let html="<html><h2>Weekly Planning Alert, 19/10/2026</h2>"+
 "<p>New and decided planning application updates issued by Cork County Council on 19/10/2026</p>";
 for(const [ref,decision,received] of [["26/2560","Application Received","Oct 03, 2026"],["26/2561","Application Received","Oct 03, 2026"],["26/2562","Application Received","Oct 04, 2026"],["26/2563","Application Received","Oct 05, 2026"],["26/2169","Decision Made","Aug 14, 2026"]]){
 html+='<h3>Permission // Ardagh East, Rosscarbery, Co. Cork, P85 FT62</h3>'+
 '<p>Construction of a proposed dwelling and a separate single-storey ancillary structure with on-site treatment system and associated site works</p>'+
 '<ul><li>Applicant: N/A</li><li>File Number: '+ref+'</li><li>Status: Permission</li>'+
 '<li>Received: '+received+'</li><li>Decision Date: N/A</li><li>Decision: '+decision+'</li>'+
 '<li><a href="https://planning.agileapplications.ie/corkcoco/record">View on Cork County Council Planning System</a></li></ul>';
 }
 const result=parseCorkMapalertsReceived(html,url);
 assert.equal(result.headers,5);assert.equal(result.applications.length,4);
 assert.deepEqual(result.applications.map(x=>x.reference),["26/2560","26/2561","26/2562","26/2563"]);
 assert.equal(result.applications[0].registration_date,"2026-10-03");
 assert.ok(!("applicant_name" in result.applications[0]));
 assert.equal(result.skipped,1);
});
test("council month and dates reject invalid inputs",()=>{
 assert.equal(mapalertsDate("Oct 03, 2026"),"2026-10-03");
 assert.equal(mapalertsDate("3/10/2026"),"2026-10-03");
 assert.equal(mapalertsDate("Feb 30, 2026"),null);
});
test("non-council page and decisions-only source fail closed",()=>{
 assert.throws(()=>parseCorkMapalertsReceived("<html>Wrong source</html>",url));
});
