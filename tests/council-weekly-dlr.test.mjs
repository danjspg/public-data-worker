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

test("ignore non-application reference markers inside council PDF prose, without weakening official row count",()=>{
 const text="PLANNING APPLICATIONS RECEIVED FOR WEEK 41 2026\n"+
 "DATED 04/10/2026 TO 10/10/2026\n- Total Application Registered = 2\n"+
 item("D26A/0738/WEB","05/10/2026").replace("Proposal: Construction of a substantial purpose built commercial premises with accompanying access and related works.",
 "Proposal: Construction of a substantial purpose built commercial premises with accompanying access and related works.\nReg. Ref.: referenced in the narrative only")+
 "\n"+item("DZ26A/0750/WEB","07/10/2026")+
 "\nEND OF PLANNING APPLICATIONS RECEIVED FOR WEEK 41 2026";
 const parsed=parseDlrReceived(text,url);
 assert.equal(parsed.headers,2);
 assert.equal(parsed.applications.length,2);
});

test("a real reference cited in proposal prose does not add a registration",()=>{
 const text="PLANNING APPLICATIONS RECEIVED FOR WEEK 32 2026\n"+
 "- Total Application Registered = 2\n"+
 item("D26B/0442/WEB","03/08/2026").replace("Proposal: Construction",
 "Proposal: Amendments to an earlier application Reg. Ref.: D25B/0546/WEB to include proposed works.\nConstruction")+
 "\n"+item("D26B/0443/WEB","05/08/2026")+
 "\nEND OF PLANNING APPLICATIONS RECEIVED FOR WEEK 32 2026";
 const parsed=parseDlrReceived(text,url);
 assert.equal(parsed.headers,2);
 assert.equal(parsed.applications.length,2);
 assert.match(parsed.applications[0].proposal,/D25B\/0546\/WEB/);
});

test("a genuine extra registration still fails the official count",()=>{
 const text="PLANNING APPLICATIONS RECEIVED FOR WEEK 32 2026\n"+
 "- Total Application Registered = 1\n"+item("D26B/0442/WEB","03/08/2026")+
 "\n"+item("D26B/0443/WEB","05/08/2026")+
 "\nEND OF PLANNING APPLICATIONS RECEIVED FOR WEEK 32 2026";
 assert.throws(()=>parseDlrReceived(text,url),/actual register count/);
});

test("week ending at the recovery cutoff may contain only older registrations",()=>{
 const text="PLANNING APPLICATIONS RECEIVED FOR WEEK 31 2026\n"+
 "- Total Application Registered = 10\n"+
 Array.from({length:10},(_,i)=>item("D26B/"+String(400+i).padStart(4,"0")+"/WEB","31/07/2026")).join("\n")+
 "\nEND OF PLANNING APPLICATIONS RECEIVED FOR WEEK 31 2026";
 const parsed=parseDlrReceived(text,url);
 assert.equal(parsed.headers,10);
 assert.equal(parsed.applications.length,0);
 assert.equal(parsed.beforeCutoff,10);
});

test("quarantine an explicitly labelled out-of-week RED III addendum only",()=>{
 assert.equal(dlrDate("25-Aug-2026"),"2026-08-25");
 const header="PLANNING APPLICATIONS RECEIVED FOR WEEK 34 2026\nDATED 16/08/2026 TO 22/08/2026\n- Total Application Registered = 1\n";
 const tail="\nEND OF PLANNING APPLICATIONS RECEIVED FOR WEEK 34 2026";
 const main=item("D26A/0621/WEB","21/08/2026");
 const addendum=item("D26A/0632/WEB","25-Aug-2026").replace("Beacon Square","Renewable Energy Directive (RED III), Beacon Square");
 const parsed=parseDlrReceived(header+main+"\n"+addendum+tail,url);
 assert.equal(parsed.headers,1);
 assert.equal(parsed.addendumCount,1);
 assert.deepEqual(parsed.applications.map(x=>x.reference),["D26A/0621/WEB"]);
 assert.throws(()=>parseDlrReceived(header+main+"\n"+item("D26A/0632/WEB","25-Aug-2026")+tail,url),/actual register count/);
});
