import test from "node:test";
import assert from "node:assert/strict";
import {receivedDate,parseWexfordReceived,parseSouthDublinReceived,fingalReceivedCandidates,dublinCityReceivedCandidates} from "../src/council-received-parser.mjs";
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