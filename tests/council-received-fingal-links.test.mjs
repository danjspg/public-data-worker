import test from "node:test";
import assert from "node:assert/strict";
import {fingalReceivedWeeklyLinks} from "../src/council-received-fingal-links.mjs";

const row=(week,links)=>`<tr><td>week ${week}</td><td>${links.map(url=>`<a href="${url}">View</a>`).join(" ")}</td></tr>`;
const received=(week,suffix="")=>`/system/files/planning-weekly-lists/2026%20Week%20${week}/applications-received${suffix}.doc`;

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
 const result=fingalReceivedWeeklyLinks(row(42,["/system/files/planning-weekly-lists/2026%20Week%2042/decisions-made.doc"])+row(43,[received(43)]));
 assert.equal(result.documents.length,1);
 assert.deepEqual(result.skipped,[{week:42,reason:"missing_received_document",candidate_count:0}]);
});

test("never permit a matching off-council received link",()=>{
 assert.throws(()=>fingalReceivedWeeklyLinks(row(42,["https://example.org/system/files/planning-weekly-lists/2026%20Week%2042/applications-received.doc"])),/hostname mismatch/);
});

test("exclude 2025 archive documents even where their week numbers match 2026",()=>{
 const prior="/system/files/planning-weekly-lists/2025%20Week%2052/applications-received.doc";
 const result=fingalReceivedWeeklyLinks(row(52,[prior])+row(43,[received(43)]));
 assert.deepEqual(result.documents.map(x=>x.week_ending),["2026-10-25"]);
 assert.deepEqual(result.skipped,[]);
});

test("reject a link whose official 2026 folder disagrees with the table week",()=>{
 const result=fingalReceivedWeeklyLinks(row(42,[received(43)]));
 assert.equal(result.documents.length,0);
 assert.deepEqual(result.skipped,[{week:42,reason:"mismatched_received_document_week",candidate_count:1}]);
});

test("ignore historical weeks below week 31",()=>{
 const result=fingalReceivedWeeklyLinks(row(30,[received(30)])+row(43,[received(43)]));
 assert.equal(result.documents.length,1);
 assert.equal(result.skipped.length,0);
});
