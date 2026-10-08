import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
test("recent discovery keeps three days of compact cohort identity",async()=>{
 const code=await readFile(new URL("../src/prune-worker-history.mjs",import.meta.url),"utf8")
 assert.ok(code.includes("active_planning_recent_range') then greatest($1::int,3)"))
 for(const field of ["local_authority_code","queued_for_date","source_policy_version","source_type","fallback","ok"])
  assert.ok(code.includes(field),`missing retained cohort field ${field}`)
 assert.ok(code.includes("lifecycle_observation_compacted"))
})

test("applied ACP case signatures survive compaction for future no-change detection",async()=>{
 const prune=await readFile(new URL("../src/prune-worker-history.mjs",import.meta.url),"utf8")
 const appeals=await readFile(new URL("../src/current-appeals.mjs",import.meta.url),"utf8")
 assert.ok(prune.includes("when w.job_type='acp_current_case' then"))
 assert.ok(prune.includes("'source_signature',w.result->'source_signature'"))
 assert.ok(appeals.includes("prior?.result?.source_signature || appealSignature(prior?.result)"))
})
