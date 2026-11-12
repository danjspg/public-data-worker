// Read-only pilot for reusing OpenList's national-ArcGIS alert source.
// No Agile requests, user records, database writes, or alert delivery.
// Public dataset: https://data.gov.ie/dataset/national-planning-applications (CC BY 4.0).
const URL_BASE = "https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query";

export const TARGETS = Object.freeze({
  WEXFORD: {
    authority: "Wexford County Council",
    references: ["20261093", "20260767"],
  },
  DUBLINCITY: {
    authority: "Dublin City Council",
    references: ["WEB1886/26", "WEB2308/26"],
  },
});

const SOURCE_FIELDS = [
  "ApplicationNumber", "PlanningAuthority", "ReceivedDate", "ApplicationStatus",
  "Decision", "DecisionDate", "DecisionDueDate", "GrantDate",
  "FIRequestDate", "FIRecDate", "WithdrawnDate",
];

function clean(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function date(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const result = new Date(number);
  return Number.isNaN(result.getTime()) ? null : result.toISOString().slice(0, 10);
}

export function requestUrl(reference) {
  const escaped = String(reference).replaceAll("'", "''");
  const params = new URLSearchParams({
    where: "ApplicationNumber = '" + escaped + "'",
    outFields: SOURCE_FIELDS.join(","),
    returnGeometry: "false",
    resultRecordCount: "10",
    f: "json",
  });
  return URL_BASE + "?" + params.toString();
}

export async function fetchOne(code, reference, fetchImpl = fetch) {
  const config = TARGETS[code];
  if (!config || !config.references.includes(reference)) throw new Error("Unexpected pilot council or reference");
  const response = await fetchImpl(requestUrl(reference), {
    headers: { "User-Agent": "openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error("SOURCE_ACCESS_STOP_HTTP_" + response.status);
  }
  if (!response.ok) throw new Error("NATIONAL_ARCGIS_HTTP_" + response.status);
  const json = await response.json();
  if (json.error) throw new Error("NATIONAL_ARCGIS_SOURCE_ERROR");
  const matches = (json.features || [])
    .map((item) => item.attributes || {})
    .filter((row) => clean(row.ApplicationNumber) === clean(reference))
    .filter((row) => clean(row.PlanningAuthority) === clean(config.authority));
  if (matches.length !== 1) {
    return { council: code, reference, result: matches.length ? "ambiguous" : "not_found" };
  }
  const row = matches[0];
  return {
    council: code,
    reference,
    result: "matched",
    status: String(row.ApplicationStatus || "").trim() || null,
    decision: String(row.Decision || "").trim() || null,
    receivedDate: date(row.ReceivedDate),
    decisionDate: date(row.DecisionDate),
    decisionDueDate: date(row.DecisionDueDate),
    grantDate: date(row.GrantDate),
    furtherInformationRequestedDate: date(row.FIRequestDate),
    furtherInformationReceivedDate: date(row.FIRecDate),
    withdrawalDate: date(row.WithdrawnDate),
  };
}

export async function run({ fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const startedAt = new Date().toISOString();
  const samples = [];
  const failures = [];
  for (const [code, config] of Object.entries(TARGETS)) {
    for (const ref of config.references) {
      try {
        samples.push(await fetchOne(code, ref, fetchImpl));
      } catch (error) {
        const reason = String(error.message || error);
        failures.push({ council: code, reference: ref, error: reason.slice(0, 120) });
        if (reason.startsWith("SOURCE_ACCESS_STOP_")) {
          return { dryRun: true, stoppedOnAccessRestriction: true, startedAt, samples, failures };
        }
      }
      await sleep(1200);
    }
  }
  return {
    dryRun: true,
    stoppedOnAccessRestriction: false,
    startedAt,
    samples,
    failures,
    matchedByCouncil: Object.fromEntries(
      Object.keys(TARGETS).map((code) => [
        code, samples.filter((item) => item.council === code && item.result === "matched").length,
      ]),
    ),
  };
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
  if (result.stoppedOnAccessRestriction || result.failures.length ||
      Object.values(result.matchedByCouncil).some((value) => value === 0)) {
    process.exitCode = 1;
  }
}
