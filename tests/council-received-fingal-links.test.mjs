import test from "node:test";
import assert from "node:assert/strict";
import {fingalReceivedWeeklyLinks} from "../src/council-received-fingal-links.mjs";

const row=(week,links)=>`<tr><td>week ${week}</td><td>${links.map(url=>`<a href="${url}">View</a>`).join(" ")}</td></tr>`;
const received=(week,suffix="")=>`/sites/default/files/2026-10/week-${week}-applications-received${suffix}.doc`;

test("one verified received DOC per week remains eligible",()=>{
 const result=fingalReceivedWeeklyLinks(row(42,[received(42)]));
 assert.equal(result.documents.length,1);
 assert.equal(result.documents[0].week_ending,"2026-10-18");
 assert.equal(result.documents[0].url,"https://www.fingal.ie"+received(42));
 assert.deepEqual(result.skipped,[]);
});

test("duplicate identical official links are de-duplicated, not treated as ambiguity",()=>{
 const url=received(42);
 const result=fingalReceivedWeeklyLinks(row(42,[url,url]));
 assert.equal(result.documents.length,1);
 assert.equal(result.skipped.length,0);
});

test("two different received DOCs in one week are skipped, but other official weeks proceed",()=>{
 const result=fingalReceivedWeeklyLinks(row(42,[received(42),received(42,"-revised")])+row(43,[received(43)]));
 assert.deepEqual(result.documents.map(x=>x.week_ending),["2026-10-25"]);
 assert.deepEqual(result.skipped,[{week:42,reason:"ambiguous_received_documents",candidate_count:2}]);
});

test("missing received link logs a gap without aborting other documents",()=>{
 const result=fingalReceivedWeeklyLinks(row(42,["/sites/default/files/week-42-decisions-made.doc"])+row(43,[received(43)]));
 assert.equal(result.documents.length,1);
 assert.deepEqual(result.skipped,[{week:42,reason:"missing_received_document",candidate_count:0}]);
});

test("never permit a matching off-council received link",()=>{
 assert.throws(()=>fingalReceivedWeeklyLinks(row(42,["https://example.org/applications-received.doc"])),/hostname mismatch/);
});

test("ignore historical weeks below week 31",()=>{
 const result=fingalReceivedWeeklyLinks(row(30,[received(30)])+row(43,[received(43)]));
 assert.equal(result.documents.length,1);
 assert.equal(result.skipped.length,0);
});
