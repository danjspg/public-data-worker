import assert from "node:assert/strict"
import test from "node:test"
import { nationalAdmissionLookbackDays } from "../src/national-admission-window.mjs"

const agileAuthorities={CORKCOCO:{},DLR:{},FINGAL:{},DUBLINCITY:{}}
test("Monday blocked Agile-family sources get a 90-day national replay",()=>{
  for (const code of Object.keys(agileAuthorities)) {
    assert.equal(nationalAdmissionLookbackDays({
      authorityCode:code,agileAuthorities,agileAccessBlocked:true,utcDayOfWeek:1,regularDays:21,
    }),90)
  }
})
test("ePlan authorities never get national detail backfill",()=>{
  assert.equal(nationalAdmissionLookbackDays({
    authorityCode:"MEATH",agileAuthorities,agileAccessBlocked:true,utcDayOfWeek:1,regularDays:21,
  }),21)
})
test("normal days stay on low-cost lookback",()=>{
  assert.equal(nationalAdmissionLookbackDays({
    authorityCode:"DLR",agileAuthorities,agileAccessBlocked:true,utcDayOfWeek:5,regularDays:21,
  }),21)
})
test("restored Agile access disables the national catch-up",()=>{
  assert.equal(nationalAdmissionLookbackDays({
    authorityCode:"DLR",agileAuthorities,agileAccessBlocked:false,utcDayOfWeek:1,regularDays:21,
  }),21)
})
