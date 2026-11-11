import test from "node:test";
import assert from "node:assert/strict";
import {receivedDate,parseWexfordReceived,parseSouthDublinReceived,cleanSouthDublinField,parseDublinCityReceived,fingalReceivedCandidates,dublinCityReceivedCandidates} from "../src/council-received-parser.mjs";
test("reject impossible calendar dates",()=>{assert.equal(receivedDate("05/10/2026"),"2026-10-05");assert.equal(receivedDate("9 Oct 2026"),"2026-10-09");assert.equal(receivedDate("31/02/2026"),null);});
test("Wexford valid original applications only, not cited older references",()=>{
 const sample="Valid Applications Received from 05 Oct 2026 To 11 Oct 2026\n"+
 "20261289W 05/10/2026 Permission New applicant\nLocation : Townparks, Wexford Urban\nProposal: Construction of an apartment complex with road access, cites 20220212\nEIA Status: N/A\n"+
 "20261290W 06/10/2026 Permission for Retention Another applicant\nLocation : Greenpark, Gorey\nProposal: Retention of an existing detached single storey utility building\nEIA Status: N/A";
 const r=parseWexfordReceived(sample,"https://www.wexfordcoco.ie/test.pdf");
 assert.equal(r.applications.length,2);assert.deepEqual(r.applications.map(x=>x.reference),["20261289","20261290"]);
 assert.equal(r.applications[0].registration_date,"2026-10-05");assert.ok(!Object.hasOwn(r.applications[0],"applicant_name"));
});
test("South Dublin new application only, not further-information submissions",()=>{
 const sample="APPLICATIONS RECEIVED LIST Page 1 Of 8\n"+
 "SD26A/0152W 06 Oct 2026 Permission Additional Information\nApplicant: Name\nLocation: Test Road, Dublin 24\nDescription: An older application with new documents for review.\n"+
 "SD26A/0240W 08 Oct 2026 Permission New Application\nApplicant: Applicant\nLocation: Whitehall Road West, Perrystown, Dublin\nDescription: Change of use of retail unit to coffee shop with food takeaway.\n"+
 "SD26B/0449W 06 Oct 2026 Permission and Retention New Application\nApplicant: Applicant\nLocation: Ballyroan Heights, Rathfarnham, Dublin\nDescription: Retention of existing extension and alterations to roof and access.\n"+
 "SD25A/0288W 08 Oct 2026 Permission and Retention Clarification of Additional Information\nApplicant: Applicant\nLocation: Naas Road, Dublin\nDescription: An amendment to an old planning application.";
 const r=parseSouthDublinReceived(sample,"https://planning.southdublin.ie/Home/ViewWeeklyListDocument/3969");
 assert.equal(r.headers,4);assert.deepEqual(r.applications.map(x=>x.reference),["SD26A/0240W","SD26B/0449W"]);assert.equal(r.skipped,2);
});
test("Word references are discovery-only, never create speculative rows",()=>{
 assert.equal(fingalReceivedCandidates("F26A/0899E F26A/0900E F26A/0899E").candidate_references.length,2);
 assert.equal(fingalReceivedCandidates("F26A/0899E").applications.length,0);
 assert.equal(dublinCityReceivedCandidates("WEB3458/26Application TYPE WEB1315/26Additional").candidate_references.length,2);
 assert.equal(dublinCityReceivedCandidates("WEB3458/26").applications.length,0);
});
test("South Dublin page headers are stripped without losing planning proposal content",()=>{
 const stamp="APPLICATIONS RECEIVED LIST Page 5 Of 9 Under Section 34 of the Act, the applications for permission may be granted permission, subject to or without conditions, or refused. The use of the personal details of planning applicants, including for marketing purposes, may be unlawful under the Data Protection Acts 1988 to 2003 and may result in action by the Data Protection Commissioner against the sender, including prosecution. Reg. Ref. Date Received Application Type Submission Type";
 assert.equal(cleanSouthDublinField("Construction of a new "+stamp+" warehouse with vehicular access."),"Construction of a new warehouse with vehicular access.");
 assert.equal(cleanSouthDublinField("Construction of a new APPLICATIONS RECEIVED LIST Page 5 Of 9 without footer"),null);
 const sample="APPLICATIONS RECEIVED LIST Page 1 Of 9\n"+
   "SD26A/0260W 09 Nov 2026 Permission New Application\n"+
   "Applicant: Applicant\nLocation: Whitehall Road, Dublin 12\n"+
   "Description: Construction of a new "+stamp+" warehouse and associated roadway in Dublin.\n";
 const result=parseSouthDublinReceived(sample,"https://planning.southdublin.ie/Home/ViewWeeklyListDocument/4050");
 assert.equal(result.applications.length,1);
 assert.equal(result.applications[0].proposal,"Construction of a new warehouse and associated roadway in Dublin.");
});

test("Dublin City DOCX received parser requires same-week registration and exact header metadata",()=>{
 const url="https://www.dublincity.ie/sites/default/files/2026-11/a1-wpl-44-26.docx";
 const input="WEEK 44 APPLICATIONS RECEIVED\n"+
 "WEB3621/26Application TYPE PermissionApplicant Name Sample Property HoldingsLocation 13 South Dock Road, Dublin 4, D04 N7KS"+
 "Registration DATE 27/10/2026Additional INFORMATION PROPOSAL: Construction of a substantial new warehouse with associated vehicular access.\n"+
 "__________________________________________________________________________\n"+
 "WEB2700/26Application TYPE Retention PermissionApplicant Name Example CoLocation 9 Quayside Street, Dublin 2"+
 "Registration DATE 17/09/2026Additional INFORMATION PROPOSAL: Old case sends new additional information about a warehouse.\n"+
 "__________________________________________________________________________\n"+
 "WEB3622/26Application TYPE Retention PermissionApplicant Name A CorpLocation 12 Example Park, Dublin 4"+
 "Registration DATE 28/10/2026Additional INFORMATION PROPOSAL: Retention of alterations to a protected structure with associated works.\n"+
 "__________________________________________________________________________\n"+
 "The applicant also cites 1921/26 but there is no Application TYPE header.";
 const r=parseDublinCityReceived(input,url,"2026-11-01");
 assert.deepEqual(r.applications.map(x=>x.reference),["WEB3621/26","WEB3622/26"]);
 assert.equal(r.headers,3);
 assert.equal(r.applications[0].registration_date,"2026-10-27");
 assert.equal(r.applications[1].application_type,"Retention");
 assert.equal(r.applications[0].source_url,url);
 assert.equal(r.applications[0].proposal,"Construction of a substantial new warehouse with associated vehicular access.");
});
test("Dublin City received parser never fabricates missing location or proposal",()=>{
 const url="https://www.dublincity.ie/test.docx";
 const input="WEB4000/26Application TYPE Permission 30 Main Street, Dublin 2 Registration DATE 26/10/2026 Additional Information no proposal\n"+
 "WEB4001/26Application TYPE Permission Registration DATE 26/10/2026 PROPOSAL: Construction of a sizeable residential development with access.\n"+
 "WEB4002/26Application TYPE PermissionApplicant Name PersonLocation 9 Quay Street, Dublin 1 Registration DATE 26/10/2026 PROPOSAL: Works to a large residence with new entrances and landscaping.";
 const r=parseDublinCityReceived(input,url,"2026-11-01");
 assert.deepEqual(r.applications.map(x=>x.reference),["WEB4002/26"]);
});

test("Dublin City DOCX decisions do not create spurious new applications",()=>{
 const url="https://www.dublincity.ie/sites/default/files/2026-11/a1-wpl-44-26.docx";
 const input="WEB5000/26Application TYPE PermissionDecision MadeLocation 13 Quay Street, Dublin 1 Registration DATE 28/10/2026 PROPOSAL: Extensive development of a new building with access.\n"+
 "WEB5001/26Application TYPE PermissionApplicant Name Builder LtdLocation 14 Quay Street, Dublin 1 Registration DATE 28/10/2026 PROPOSAL: Construction of a large dwelling with ancillary vehicular access.";
 const r=parseDublinCityReceived(input,url,"2026-11-01");
 assert.deepEqual(r.applications.map(x=>x.reference),["WEB5001/26"]);
 assert.equal(r.applications[0].location,"14 Quay Street, Dublin 1");
 assert.equal(Object.hasOwn(r.applications[0],"applicant_name"),false);
});
