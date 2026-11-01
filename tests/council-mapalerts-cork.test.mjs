import test from "node:test";
import assert from "node:assert/strict";
import {mapalertsDate,discoverCorkMapalertWeeks,parseCorkMapalertsReceived,parseCorkMapalertsDecisions} from "../src/council-mapalerts-cork.mjs";
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

test("Cork MapAlerts decisions require dated evidence and never invent outcomes",()=>{
 let html='<html><h2>Weekly Planning Alert, 19/10/2026</h2>'+
 '<p>New and decided planning application updates issued by Cork County Council on 19/10/2026</p>';
 const cases=[
  ["26/2169","Decision Made","Oct 15, 2026","Aug 14, 2026"],
  ["26/2170","Refused","Oct 16, 2026","Aug 14, 2026"],
  ["26/2171","Granted (Conditional)","Oct 16, 2026","Aug 14, 2026"],
  ["26/2172","Decision Made","N/A","Aug 14, 2026"],
  ["26/2173","Application Received","N/A","Oct 14, 2026"],
 ];
 for(const [ref,decision,date,received] of cases){
  html+='<h3>Permission // Test development site, County Cork</h3>'+
   '<p>Construction of a dwelling</p><p>File Number: '+ref+'</p>'+
   '<p>Received: '+received+'</p><p>Decision Date: '+date+'</p>'+
   '<p>Decision: '+decision+'</p>';
 }
 const parsed=parseCorkMapalertsDecisions(html,url);
 assert.equal(parsed.total,5);
 assert.deepEqual(parsed.decisions.map(x=>x.reference),["26/2169","26/2170","26/2171"]);
 assert.deepEqual(parsed.decisions.map(x=>x.decision_text),["Decision Made","Refused","Granted (Conditional)"]);
 assert.equal(parsed.decisions[0].decision_date,"2026-10-15");
 assert.throws(()=>parseCorkMapalertsDecisions("<html>not the council</html>",url));
});

test("weekly Decision Made with explicit N/A date publishes status only",()=>{
 let html="<html><h2>Weekly Planning Alert, 26/10/2026</h2>"+
 "<p>New and decided planning application updates issued by Cork County Council on 26/10/2026</p>";
 for(const [reference,decision] of [["26/1926","Decision Made"],["26/1927","Application Received"]]){
  html+="<h3>Permission // Some location, Co. Cork</h3>"+
   "<p>Construction of dwelling house and ancillary works.</p>"+
   "<p>File Number: "+reference+"</p><p>Received: Jul 20, 2026</p>"+
   "<p>Decision Date: N/A</p><p>Decision: "+decision+"</p>";
 }
 const result=parseCorkMapalertsDecisions(html,url);
 assert.equal(result.total,2);
 assert.equal(result.decisions.length,1);
 assert.equal(result.statusOnly,1);
 assert.equal(result.decisions[0].reference,"26/1926");
 assert.equal(result.decisions[0].decision_text,"Decision Made");
 assert.equal(result.decisions[0].decision_date,null);
 assert.equal(result.decisions[0].observed_week,"2026-10-26");
});
