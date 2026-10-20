// Worker-side source parser: Wexford County Council's own weekly decision lists.
// Parser is deliberately strict: never infer a grant/refusal from generic status text.
export const WEXFORD_INDEX =
  "https://www.wexfordcoco.ie/planning/planning-applications/planning-lists/planning-lists-for-2026";

export function canonicalWexfordReference(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  return /^20\d{6}W?$/.test(raw) ? raw.replace(/W$/, "") : null;
}

export function findWexfordDecisionLinks(html, base = WEXFORD_INDEX) {
  const source = String(html || "");
  const begin = source.search(/Planning Applications Decided/i);
  if (begin < 0) throw new Error("Wexford decision-list section missing");
  const endRel = source.slice(begin).search(/Extension of Duration Decided/i);
  if (endRel < 0) throw new Error("Wexford decision-list section has no end marker");
  const section = source.slice(begin, begin + endRel);
  const links = [];
  for (const match of section.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1].replace(/&amp;/g, "&");
    const url = new URL(href, base);
    if (url.protocol !== "https:" || url.hostname !== "www.wexfordcoco.ie") continue;
    if (!/\.pdf$/i.test(url.pathname)) continue;
    const name = decodeURIComponent(url.pathname).toLowerCase();
    if (!name.includes("applications decided")) continue;
    if (!links.includes(url.href)) links.push(url.href);
  }
  if (!links.length) throw new Error("No official Wexford decision PDFs found");
  return links;
}

const MONTHS = new Map(
  ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    .map((month,index) => [month.toLowerCase(),index])
);

export function parseCouncilDate(value) {
  const m = String(value || "").trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m || !MONTHS.has(m[2].toLowerCase())) return null;
  const day = Number(m[1]), month = MONTHS.get(m[2].toLowerCase()), year = Number(m[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0,10);
}

export function parseWexfordDecisionText(text, sourceUrl) {
  const original = String(text || "").replace(/\u00a0/g, " ");
  if (!/Weekly Planning Applications Decided/i.test(original)) {
    throw new Error("Unexpected Wexford PDF type: decisions heading missing");
  }
  const reported = original.match(/Total\s+No\.\s+of\s+Records\s*:\s*(\d+)/i);
  if (!reported) throw new Error("Missing official total count in Wexford PDF");
  // Raw extraction may add line breaks between table cells. Flatten only the
  // heading region, ending each row at the unambiguous "Applicant :" marker.
  const flattened = original.replace(/\s+/g, " ");
  const row = /\b(20\d{6}W?)\s+(\d{1,2}\s+[A-Za-z]{3}\s+20\d{2})\s+(\d{1,2}\s+[A-Za-z]{3}\s+20\d{2})\s+([\s\S]*?)(?=Applicant\s*:)/gi;
  const decisions = [];
  const seen = new Map();
  for (const match of flattened.matchAll(row)) {
    const reference = canonicalWexfordReference(match[1]);
    const applicationDate = parseCouncilDate(match[2]);
    const decisionDate = parseCouncilDate(match[3]);
    const heading = match[4].trim();
    if (!reference || !applicationDate || !decisionDate || heading.length > 260) continue;
    if (decisionDate < applicationDate) continue;
    let decisionText = null;
    if (/\bRefused\b/i.test(heading)) decisionText = "Refused";
    else if (/\bGranted subject to conditions\b/i.test(heading)) decisionText = "Granted (Conditional)";
    else if (/\bGranted\b/i.test(heading)) decisionText = "Granted";
    if (!decisionText) continue;
    const item = { reference, applicationDate, decisionDate, decisionText, sourceUrl };
    const prior = seen.get(reference);
    if (prior && (prior.decisionDate !== decisionDate || prior.decisionText !== decisionText)) {
      throw new Error("Conflicting Wexford decisions in document for " + reference);
    }
    if (!prior) { seen.set(reference,item); decisions.push(item); }
  }
  const total = Number(reported[1]);
  if (total < 1 || total > 500 || !decisions.length || decisions.length > total) {
    throw new Error("Suspicious Wexford PDF extraction: " + decisions.length + "/" + total);
  }
  return { total, decisions };
}

const LATER_STAGES = new Set([
  "final_grant","appealed","appeal_decided","withdrawn","invalid"
]);

export function planWexfordDecisionUpdate(existing, incoming) {
  if (!existing) return { action:"missing" };
  if (LATER_STAGES.has(existing.normalized_status)) return { action:"later_lifecycle" };
  if (existing.registration_date && existing.registration_date > incoming.decisionDate) {
    return { action:"date_conflict" };
  }
  if (existing.decision_date && existing.decision_date > incoming.decisionDate) {
    return { action:"newer_decision" };
  }
  const oldOutcome = String(existing.decision_text || "").toLowerCase().trim();
  const oldIsRefusal = /\brefus(ed|al)\b/.test(oldOutcome);
  const newIsRefusal = incoming.decisionText === "Refused";
  const oldIsActualDecision = /\b(refus(ed|al)|grant(ed)?|permission)\b/.test(oldOutcome);
  if (oldIsActualDecision && oldIsRefusal !== newIsRefusal) {
    return { action:"outcome_conflict" };
  }
  if (existing.decision_date === incoming.decisionDate &&
      oldIsRefusal === newIsRefusal &&
      oldOutcome && oldOutcome !== "n/a" &&
      existing.normalized_status === "decision_made") {
    return { action:"unchanged" };
  }
  return {
    action:"update",
    fields:{
      status:"Decision Made",
      normalized_status:"decision_made",
      decision_text:incoming.decisionText,
      decision_date:incoming.decisionDate,
      status_source:"wexford_weekly_decisions"
    }
  };
}
