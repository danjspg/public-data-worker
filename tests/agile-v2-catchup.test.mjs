import test from "node:test";
import assert from "node:assert/strict";
import {runCatchup,planCatchup,BOT_USER_AGENT} from "../src/agile-v2-catchup.mjs";

test("blocked access never connects or requests",async()=>{
  const result=await runCatchup({env:{AGILE_ACCESS_BLOCKED:"true"},connect:async()=>{throw Error("must not connect")}});
  assert.equal(result.status,"blocked");
  assert.equal(result.requested,0);
});
test("explicitly authorised but disabled stays dry",async()=>{
  const result=await runCatchup({env:{AGILE_ACCESS_BLOCKED:"false",AGILE_V2_ACCESS_AUTHORISED:"true",AGILE_V2_LIVE_ENABLED:"false"}});
  assert.equal(result.status,"dry_run_only");
});
test("even enabled flags cannot accidentally reach Agile",async()=>{
  await assert.rejects(runCatchup({env:{AGILE_ACCESS_BLOCKED:"false",AGILE_V2_ACCESS_AUTHORISED:"true",AGILE_V2_LIVE_ENABLED:"true"}}),/live transport is not configured/);
});
test("bounded, deduplicated, authority-specific selection",()=>{
  const rows=[{id:1,input:{local_authority_code:"CORKCITY",reference:"A"}},{id:2,input:{local_authority_code:"CORKCITY",reference:"A"}},{id:3,input:{local_authority_code:"FINGAL",reference:"B"}}];
  assert.deepEqual(planCatchup(rows,{authority:"CORKCITY"}),[{id:1,authority:"CORKCITY",reference:"A"}]);
  assert.throws(()=>planCatchup(rows,{limit:6}),/1..5/);
  assert.match(BOT_USER_AGENT,/openlist-bot\/2\.0/);
});
