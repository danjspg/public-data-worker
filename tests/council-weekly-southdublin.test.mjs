import test from "node:test";
import assert from "node:assert/strict";
import {findSouthDublinDecisionDocuments,findSouthDublinRecentWeeks,parseSouthDublinDecisions} from "../src/council-weekly-southdublin.mjs";
const url="https://planning.southdublin.ie/Home/ViewWeeklyListDocument/3970";
test("South Dublin index accepts only official decision document links",()=>{
 const html='<a href="/Home/ViewWeeklyListDocument/3970">2 Decisions Made</a><a href="/Home/ViewWeeklyListDocument/3971">3 Appeals Notified</a><a href="https://evil.example/Home/ViewWeeklyListDocument/9999">2 Decisions Made</a>';
 assert.deepEqual(findSouthDublinDecisionDocuments(html),[url]);
});
test("South Dublin wrapped references and alternative status layouts",()=>{
 const document=[
  "LIST OF DECISIONS MADE Page 1 Of 6 Reg. Ref. Decision Decision Date",
  "SD26A/0062 Grant Permission 06/10/2026 W",
  "Applicant: Edward Jones Location: Raheen",
  "SD26A/0194 Grant Permission 06/10/2026",
  "Applicant: Hui Huang Location: Clondalkin",
  "Refuse Permission 09/10/2026 for Retention SD26B/0392 W",
  "Applicant: Claire Healy Location: Rathfarnham",
  "Request Additional Information 09/10/2026 SD26B/0379 W",
  "Applicant: Kate O Driscoll"
 ].join("\n");
 const list=parseSouthDublinDecisions(document,url);
 assert.deepEqual(list.map(x=>[x.reference,x.decision_date,x.decision_text]),[
  ["SD26A/0062W","2026-10-06","Granted"],
  ["SD26A/0194","2026-10-06","Granted"],
  ["SD26B/0392W","2026-10-09","Refused"],
 ]);
});
test("reject unexpected South Dublin content",()=>assert.throws(()=>parseSouthDublinDecisions("random text",url)));

test("South Dublin weekly archive discovery applies August 2026 cutoff",()=>{
 const html=[
  "<table>",
  '<tr><td>09/10/2026</td><td><a href="/Home/ViewWeeklyListDocument/3970">2 Decisions Made</a></td></tr>',
  '<tr><td>07/08/2026</td><td><a href="/Home/ViewWeeklyListDocument/3890">2 Decisions Made</a></td></tr>',
  '<tr><td>31/07/2026</td><td><a href="/Home/ViewWeeklyListDocument/3800">2 Decisions Made</a></td></tr>',
  "</table>"
 ].join("");
 const docs=findSouthDublinRecentWeeks(html);
 assert.deepEqual(docs,[
  {url:"https://planning.southdublin.ie/Home/ViewWeeklyListDocument/3970",week:"2026-10-09"},
  {url:"https://planning.southdublin.ie/Home/ViewWeeklyListDocument/3890",week:"2026-08-07"},
 ]);
});
