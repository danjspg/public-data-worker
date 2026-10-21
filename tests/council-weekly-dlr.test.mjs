import test from "node:test";
import assert from "node:assert/strict";
import {parseDlrReceived,dlrDate} from "../src/council-weekly-dlr.mjs";
const url="https://www.dlrcoco.ie/sites/dlrcoco/files/2026-10/WeeklyList_No41_2026_0.pdf";
const item=(ref,date,fi="")=>[
 "______","Reg. Ref.: "+ref,"App Rec’d Date: "+date,"Applicant Name: Person",
 "Location: Beacon Square, Sandyford, Dublin 18",
 "Proposal: Construction of a substantial purpose built commercial premises with accompanying access and related works.",
 "Application Type: Permission",
 ...(fi?["Further Information: Additional Information "+fi]:[]),
 "Link: https://planning.agileapplications.ie/dunlaoghaire/application-details/107058"
].join("\n");
test("Extract new received rows but ignore old FI submissions",()=>{
 const text="PLANNING APPLICATIONS RECEIVED FOR WEEK 41 2026\n"+
 "DATED 04/10/2026 TO 10/10/2026\n- Total Application Registered = 3\n"+
 item("D26A/0738/WEB","05/10/2026")+"\n"+
 item("D26A/0487/WEB","29/06/2026","09/10/2026")+"\n"+
 item("DZ26A/0750/WEB","07/10/2026")+
 "\nEND OF PLANNING APPLICATIONS RECEIVED FOR WEEK 41 2026\nPLANNING DECISIONS FOR WEEK 41 2026";
 const r=parseDlrReceived(text,url);
 assert.deepEqual(r.applications.map(x=>x.reference),["D26A/0738/WEB","DZ26A/0750/WEB"]);
 assert.equal(r.headers,3);
});
test("bad dates and mismatched source counts fail",()=>{
 assert.equal(dlrDate("31/02/2026"),null);
 assert.throws(()=>parseDlrReceived("missing official register",url));
});
