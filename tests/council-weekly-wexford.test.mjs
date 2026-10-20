import test from "node:test";
import assert from "node:assert/strict";
import {
  findWexfordDecisionLinks,
  parseWexfordDecisionText,
  canonicalWexfordReference,
  planWexfordDecisionUpdate,
} from "../src/council-weekly-wexford.mjs";

const officialDocument = "https://www.wexfordcoco.ie/sites/default/files/content/Planning/PlanningLists/Applications%20Decided%20w.e%2011.10.2026.pdf";
const sample = [
  "PLANNING SECTION",
  "Weekly Planning Applications Decided - Members List from 05 Oct 2026 to 11 Oct 2026",
  "20260353W 23 Mar 2026 07 Oct 2026 Enniscorthy Refused",
  "Municipal District",
  "Applicant : Valentine & Vania Ogwueleka",
  "Location : Coolnahorna, Marshalstown",
  "Proposal : Permission to erect a dwelling house",
  "20260901W 08 Jul 2026 09 Oct 2026 Wexford Municipal Granted subject to conditions",
  "District",
  "Applicant : Ciara Connick",
  "20261091W 17 Aug 2026 09 Oct 2026 Gorey - Refused",
  "Kilmuckridge Municipal District",
  "Applicant : Martin Lappin",
  "20261100W 19 Aug 2026 09 Oct 2026 Gorey - Granted subject to conditions",
  "Kilmuckridge Municipal District",
  "Applicant : Padraig Moriarty",
  "20261106W 20 Aug 2026 09 Oct 2026 Rosslare Municipal Granted subject to conditions",
  "Applicant : David Waters",
  "Total No. of Records : 22"
].join("\n");

test("Wexford council archive locator selects only official decision PDFs", () => {
  const html = [
    "<h2>Planning Applications Decided</h2>",
    '<a href="/sites/default/files/content/Planning/PlanningLists/Applications%20Decided%20w.e%2004.10.2026.pdf">04/10/2026</a>',
    '<a href="/sites/default/files/content/Planning/PlanningLists/Applications%20Decided%20w.e%2011.10.2026.pdf">11/10/2026</a>',
    '<a href="https://malicious.test/Applications%20Decided.pdf">Not official</a>',
    "<h2>Extension of Duration Decided</h2>",
    '<a href="/sites/default/files/content/Planning/PlanningLists/Applications%20Decided%20w.e%2020.10.2026.pdf">Wrong category</a>'
  ].join("");
  const links = findWexfordDecisionLinks(html);
  assert.equal(links.length,2);
  assert.equal(links[1],officialDocument);
});

test("five independently verified Wexford missed decisions parse with date and result", () => {
  const parsed = parseWexfordDecisionText(sample,officialDocument);
  assert.equal(parsed.total,22);
  assert.deepEqual(parsed.decisions.map(x=>[x.reference,x.decisionDate,x.decisionText]),[
    ["20260353","2026-10-07","Refused"],
    ["20260901","2026-10-09","Granted (Conditional)"],
    ["20261091","2026-10-09","Refused"],
    ["20261100","2026-10-09","Granted (Conditional)"],
    ["20261106","2026-10-09","Granted (Conditional)"],
  ]);
});

test("Wexford trailing W aliases only valid numbered application references", () => {
  assert.equal(canonicalWexfordReference("20261091W"),"20261091");
  assert.equal(canonicalWexfordReference("20261091"),"20261091");
  assert.equal(canonicalWexfordReference("EXD01430"),null);
});

test("later lifecycle and conflicting outcomes are quarantined", () => {
  const incoming={decisionDate:"2026-10-09",decisionText:"Refused"};
  const app={reference:"20261091",registration_date:"2026-08-17",normalized_status:"registered",decision_date:null,decision_text:null};
  assert.equal(planWexfordDecisionUpdate(app,incoming).action,"update");
  assert.equal(planWexfordDecisionUpdate({...app,normalized_status:"final_grant"},incoming).action,"later_lifecycle");
  assert.equal(planWexfordDecisionUpdate({...app,decision_text:"Granted (Conditional)"},incoming).action,"outcome_conflict");
  assert.equal(planWexfordDecisionUpdate({...app,decision_text:"REQUEST ADDITIONAL INFORMATION"},incoming).action,"update");
  assert.equal(planWexfordDecisionUpdate({...app,decision_date:"2026-10-10"},incoming).action,"newer_decision");
  assert.equal(planWexfordDecisionUpdate({...app,decision_date:"2026-10-09",decision_text:"Refused",normalized_status:"decision_made"},incoming).action,"unchanged");
});

test("fail closed on malformed or unrecognised official documents", () => {
  assert.throws(()=>parseWexfordDecisionText("Wexford news",officialDocument));
  assert.throws(()=>parseWexfordDecisionText("Weekly Planning Applications Decided 20261091W 17 Aug 2026 09 Oct 2026 Refused Applicant : Name",officialDocument));
});
