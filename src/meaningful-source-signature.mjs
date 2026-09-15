import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value ?? null;
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function pick(source, fields) {
  const out = {};
  for (const field of fields) out[field] = source?.[field] ?? null;
  return out;
}

const ACTIVE_EXACT_FIELDS = [
  'OBJECTID','ApplicationNumber','ApplicationType','DevelopmentDescription','DevelopmentAddress',
  'DevelopmentPostcode','ApplicantForename','ApplicantSurname','ApplicationStatus','Decision',
  'ReceivedDate','DecisionDate','DecisionDueDate','GrantDate','ExpiryDate','FIRequestDate',
  'FIRecDate','WithdrawnDate','AppealSubmittedDate','AppealDecisionDate','ITMEasting','ITMNorthing',
  'LinkAppDetails','PlanningAuthority'
];

const ACTIVE_AGILE_FIELDS = [
  'fullProposal','decisionDueDate','statusOwner','statusDescription','statusNonOwner','decisionText',
  'decisionDate','finalGrantDate','furtherInfoRequestedDate','furtherInfoReceivedDate',
  'withdrawnDate','appealLodgedDate','appealDecisionDate'
];

const ACP_FIELDS = [
  'ABPCASEID','DEVDESC','DEVADDRESS','LODGEDON','DECISION','DECIDED_ON',
  'LINKABPWEB','PLANINGATY','CATEGORY'
];

function activeExactSignature(result) {
  if (!result?.found || !result?.attributes) return null;
  return digest(pick(result.attributes, ACTIVE_EXACT_FIELDS));
}

function activeAgileSignature(result) {
  if (!result?.found || !result?.detail) return null;
  return digest(pick(result.detail, ACTIVE_AGILE_FIELDS));
}

function appealSignature(result) {
  if (!result?.attributes) return null;
  return digest({
    attributes: pick(result.attributes, ACP_FIELDS),
    planning_authority_case_reference: result.planning_authority_case_reference ?? null,
    source_url: result.source_url ?? null,
  });
}

export { activeAgileSignature, activeExactSignature, appealSignature };
