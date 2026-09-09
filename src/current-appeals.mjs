import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const ARC_LAYER = 'https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3';
const PAGE_SIZE = 2000;
const ENRICH_LIMIT = Math.max(0, Math.min(Number(process.env.ACP_CURRENT_ENRICH_LIMIT || 500), 2000));
const ENRICH_DELAY_MS = Math.max(0, Number(process.env.ACP_CURRENT_ENRICH_DELAY_MS || 150));
const USER_AGENT = 'Public records data worker';
const REQUIRED = ['ABPCASEID','DEVDESC','DEVADDRESS','LODGEDON','DECISION','DECIDED_ON','LINKABPWEB','PLANINGATY','CATEGORY','UPDATED_ON'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim() || null;
function decodeHtml(value) {
  return String(value || '').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');
}
function pageText(html) {
  return decodeHtml(html).replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ')
    .replace(/<br\s*\/?>/gi,'\n').replace(/<\/(?:p|div|li|tr|dt|dd|h[1-6]|section|article)>/gi,'\n')
    .replace(/<[^>]+>/g,' ').replace(/[ \t]+/g,' ').replace(/\n\s+/g,'\n').replace(/\n{2,}/g,'\n').trim();
}
function labelledValue(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const match = text.match(new RegExp(`(?:${escaped})\\s*:?\\s*(?:\\n\\s*)?([^\\n]{1,180})`,'i'));
  return clean(match?.[1]);
}
function parseCasePage(html) {
  return { planningAuthorityCaseReference: labelledValue(pageText(html), ['Planning Authority Case Reference','Planning Authority Reference','PA Case Reference']) };
}
function canonicalCaseUrl(caseNumber, suppliedUrl) {
  const supplied = clean(suppliedUrl);
  if (supplied?.startsWith('https://www.pleanala.ie/')) return supplied;
  const numeric = String(caseNumber || '').match(/\d{5,}/)?.[0];
  return numeric ? `https://www.pleanala.ie/en-ie/case/${numeric}` : supplied;
}
async function fetchJson(url, retries = 4) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(attempt * 1500);
    }
  }
  throw lastError;
}
async function fetchHtml(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(25000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(attempt * 1500);
    }
  }
  throw lastError;
}
function preferred(current, candidate) {
  if (!current) return candidate;
  const cu = clean(current.UPDATED_ON) || '', nu = clean(candidate.UPDATED_ON) || '';
  if (nu !== cu) return nu > cu ? candidate : current;
  return Number(candidate.OBJECTID) > Number(current.OBJECTID) ? candidate : current;
}
async function sourceSnapshot() {
  const metadata = await fetchJson(`${ARC_LAYER}?f=json`);
  const names = new Set((metadata.fields || []).map((field) => field.name));
  const missing = REQUIRED.filter((name) => !names.has(name));
  if (metadata.objectIdField !== 'OBJECTID' || missing.length) throw new Error(`ACP schema mismatch: objectId=${metadata.objectIdField}; missing=${missing.join(',')}`);
  const byCase = new Map();
  let sourceRecordCount = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const params = new URLSearchParams({ where:'1=1', outFields:'OBJECTID,ABPCASEID,DEVDESC,DEVADDRESS,LODGEDON,DECISION,DECIDED_ON,LINKABPWEB,PLANINGATY,CATEGORY,UPDATED_ON', returnGeometry:'false', orderByFields:'OBJECTID ASC', resultOffset:String(offset), resultRecordCount:String(PAGE_SIZE), f:'json' });
    const data = await fetchJson(`${ARC_LAYER}/query?${params}`);
    const features = data.features || [];
    sourceRecordCount += features.length;
    for (const feature of features) {
      const attrs = feature.attributes || {};
      const caseNumber = clean(attrs.ABPCASEID);
      if (caseNumber) byCase.set(caseNumber, preferred(byCase.get(caseNumber), attrs));
    }
    if (features.length < PAGE_SIZE) break;
  }
  return { metadata, sourceRecordCount, cases:[...byCase.values()] };
}
function enrichmentCandidates(cases) {
  const appeals = cases.filter((row) => /^Appeals/i.test(clean(row.CATEGORY) || '') && canonicalCaseUrl(row.ABPCASEID,row.LINKABPWEB));
  const open = appeals.filter((row) => !row.DECIDED_ON).sort((a,b) => Number(b.UPDATED_ON || b.LODGEDON || 0) - Number(a.UPDATED_ON || a.LODGEDON || 0));
  const decided = appeals.filter((row) => row.DECIDED_ON).sort((a,b) => Number(b.DECIDED_ON || 0) - Number(a.DECIDED_ON || 0));
  return [...open, ...decided].slice(0, ENRICH_LIMIT);
}
async function upsertJob(client, values) {
  await client.query(`insert into worker_jobs(job_key,cursor,last_started_at,last_completed_at,last_status,last_error,updated_at)
    values('acp-current-refresh',$1::jsonb,$2,$3,$4,$5,now())
    on conflict(job_key) do update set cursor=excluded.cursor,last_started_at=excluded.last_started_at,last_completed_at=excluded.last_completed_at,last_status=excluded.last_status,last_error=excluded.last_error,updated_at=now()`,
    [JSON.stringify(values.cursor || {}), values.startedAt || null, values.completedAt || null, values.status || null, values.error || null]);
}
async function stageCases(client, cases, refs) {
  let staged = 0;
  for (let offset = 0; offset < cases.length; offset += 250) {
    const batch = cases.slice(offset, offset + 250).map((attrs) => {
      const caseNumber = clean(attrs.ABPCASEID);
      return { work_key:caseNumber, input:{ acp_case_number:caseNumber }, result:{ attributes:attrs, planning_authority_case_reference:refs.get(caseNumber) || null, source_url:canonicalCaseUrl(caseNumber,attrs.LINKABPWEB) } };
    });
    const result = await client.query(`
      with incoming as (select * from jsonb_to_recordset($1::jsonb) as x(work_key text,input jsonb,result jsonb))
      insert into work_items(job_type,work_key,input,result,status,completed_at,updated_at)
      select 'acp_current_case',work_key,input,result,'completed',now(),now() from incoming
      on conflict(job_type,work_key) do update set input=excluded.input,result=excluded.result,status='completed',completed_at=now(),
        applied_at=case when work_items.result is distinct from excluded.result then null else work_items.applied_at end,
        last_error=null,updated_at=now()
    `, [JSON.stringify(batch)]);
    staged += result.rowCount || batch.length;
  }
  return staged;
}

const client = new Client({ connectionString, ssl:{rejectUnauthorized:false} });
await client.connect();
const startedAt = new Date().toISOString();
try {
  await upsertJob(client,{startedAt,status:'running'});
  const { metadata, sourceRecordCount, cases } = await sourceSnapshot();
  const candidates = enrichmentCandidates(cases);
  const refs = new Map();
  let enriched = 0, enrichmentFailures = 0;
  for (const [index,row] of candidates.entries()) {
    const caseNumber = clean(row.ABPCASEID);
    const url = canonicalCaseUrl(caseNumber,row.LINKABPWEB);
    try {
      const html = await fetchHtml(url);
      const ref = html ? parseCasePage(html).planningAuthorityCaseReference : null;
      if (ref) { refs.set(caseNumber,ref); enriched += 1; }
    } catch (error) {
      enrichmentFailures += 1;
      console.warn(`ACP detail ${caseNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (index < candidates.length - 1 && ENRICH_DELAY_MS) await sleep(ENRICH_DELAY_MS);
  }
  const staged = await stageCases(client,cases,refs);
  const cursor = { source_record_count:sourceRecordCount, unique_cases:cases.length, enriched, enrichment_attempted:candidates.length, enrichment_failures:enrichmentFailures, source_last_edit_at: metadata.editingInfo?.lastEditDate ? new Date(metadata.editingInfo.lastEditDate).toISOString() : null };
  await upsertJob(client,{cursor,startedAt,completedAt:new Date().toISOString(),status:'complete',error:enrichmentFailures ? `${enrichmentFailures} detail lookups failed; core source snapshot staged` : null});
  console.log(JSON.stringify({ ...cursor, staged },null,2));
} catch (error) {
  await upsertJob(client,{startedAt,completedAt:new Date().toISOString(),status:'failed',error:error instanceof Error ? error.message : String(error)}).catch(()=>{});
  throw error;
} finally {
  await client.end().catch(()=>{});
}
