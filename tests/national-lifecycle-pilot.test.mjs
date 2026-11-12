import test from "node:test";
import assert from "node:assert/strict";
import { requestUrl, fetchOne, run } from "../src/national-lifecycle-pilot.mjs";

function reply(features = [], status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ features }) };
}

test("requests only specific application references from public national data", () => {
  const url = new URL(requestUrl("WEB1886/26"));
  assert.equal(url.hostname, "services.arcgis.com");
  assert.match(url.searchParams.get("where"), /ApplicationNumber = 'WEB1886\/26'/);
  assert.equal(url.searchParams.get("returnGeometry"), "false");
});

test("matches exact reference AND council before accepting result", async () => {
  const fetchImpl = async () => reply([{ attributes: {
    ApplicationNumber: "20261093", PlanningAuthority: "Dublin City Council",
    ApplicationStatus: "Approved",
  } }]);
  assert.equal((await fetchOne("WEXFORD", "20261093", fetchImpl)).result, "not_found");
});

test("parses status and dates without side effects", async () => {
  const fetchImpl = async () => reply([{ attributes: {
    ApplicationNumber: "20261093", PlanningAuthority: "Wexford County Council",
    ApplicationStatus: "Further Information Requested",
    DecisionDate: null,
    FIRequestDate: Date.UTC(2026, 10, 1),
  } }]);
  const data = await fetchOne("WEXFORD", "20261093", fetchImpl);
  assert.equal(data.result, "matched");
  assert.equal(data.status, "Further Information Requested");
  assert.equal(data.furtherInformationRequestedDate, "2026-11-01");
  assert.equal(data.decisionDate, null);
});

test("rejects ambiguous matches", async () => {
  const candidate = { ApplicationNumber: "20261093", PlanningAuthority: "Wexford County Council" };
  const fetchImpl = async () => reply([{attributes:candidate},{attributes:candidate}]);
  assert.equal((await fetchOne("WEXFORD", "20261093", fetchImpl)).result,"ambiguous");
});

test("stops immediately on 403 without further requests", async () => {
  let requests = 0;
  const result = await run({
    fetchImpl: async () => { requests++; return reply([],403); },
    sleep: async () => {},
  });
  assert.equal(requests, 1);
  assert.equal(result.stoppedOnAccessRestriction, true);
});

test("stops immediately on 429 without further requests", async () => {
  let requests = 0;
  const result = await run({
    fetchImpl: async () => { requests++; return reply([],429); },
    sleep: async () => {},
  });
  assert.equal(requests, 1);
  assert.equal(result.stoppedOnAccessRestriction, true);
});
