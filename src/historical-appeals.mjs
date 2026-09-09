import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const JOB_KEY = 'historical-appeal-reference-catchup';
const SOURCE_KEY_PREFIX = 'appeal:';
const ARC_LAYER = 'https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3';
const BATCH_SIZE = Math.max(1, Math.min(Number(process.env.CATCHUP_BATCH_SIZE || 300), 500));
const LOOKUP_DELAY_MS = Math.max(500, Number(process.env.CATCHUP_DELAY_MS || 750));
const USER_AGENT = 'Public records data worker';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function cleanText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function pageText(html) {
  return decodeHtml(String(html || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|dt|dd|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function labelledValue(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = text.match(new RegExp(`(?:${escaped})\\s*:?\\s*(?:\\n\\s*)?([^\\n]{1,180})`, 'i'));
  return cleanText(match?.[1]);
}

function parseCasePage(html) {
  const text = pageText(html);
  return {
    planningAuthorityCaseReference: labelledValue(text, [
      'Planning Authority Case Reference',
      'Planning Authority Reference',
      'PA Case Reference',
    ]),
  };
}

function canonicalCaseUrl(caseNumber, suppliedUrl) {
  const supplied = cleanText(suppliedUrl);
  if (supplied?.startsWith('https://www.pleanala.ie/')) return supplied;
  const numeric = String(caseNumber || '').match(/\d{5,}/)?.[0];
  return numeric ? `https://www.pleanala.ie/en-ie/case/${numeric}` : supplied;
}

async function fetchJson(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(attempt * 1500);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchHtml(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(attempt * 1500);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchSourceBatch(offset) {
  const params = new URLSearchParams({
    where: "CATEGORY LIKE 'Appeals%' AND DECIDED_ON IS NOT NULL",
    outFields: 'ABPCASEID,LINKABPWEB,DECIDED_ON,UPDATED_ON,CATEGORY',
    returnGeometry: 'false',
    orderByFields: 'DECIDED_ON DESC,OBJECTID DESC',
    resultOffset: String(offset),
    resultRecordCount: String(BATCH_SIZE),
    f: 'json',
  });
  const payload = await fetchJson(`${ARC_LAYER}/query?${params}`);
  if (payload.error) throw new Error(`ArcGIS query failed: ${payload.error.message || JSON.stringify(payload.error)}`);
  return payload.features || [];
}

async function upsertJob(client, values) {
  await client.query(`
    insert into worker_jobs (job_key, cursor, last_started_at, last_completed_at, last_status, last_error, updated_at)
    values ($1, $2::jsonb, $3, $4, $5, $6, now())
    on conflict (job_key) do update set
      cursor = excluded.cursor,
      last_started_at = coalesce(excluded.last_started_at, worker_jobs.last_started_at),
      last_completed_at = coalesce(excluded.last_completed_at, worker_jobs.last_completed_at),
      last_status = excluded.last_status,
      last_error = excluded.last_error,
      updated_at = now()
  `, [JOB_KEY, JSON.stringify(values.cursor || {}), values.lastStartedAt || null, values.lastCompletedAt || null, values.status || null, values.error || null]);
}

async function stageResult(client, row, lookupStatus, planningReference = null, errorMessage = null) {
  const caseNumber = cleanText(row.ABPCASEID);
  if (!caseNumber) return false;
  const sourceKey = `${SOURCE_KEY_PREFIX}${caseNumber}`;
  const state = {
    acp_case_number: caseNumber,
    source_url: canonicalCaseUrl(caseNumber, row.LINKABPWEB),
    decision_date: row.DECIDED_ON ? new Date(row.DECIDED_ON).toISOString().slice(0, 10) : null,
    source_updated_at: row.UPDATED_ON ? new Date(row.UPDATED_ON).toISOString() : null,
    category: cleanText(row.CATEGORY),
    lookup_status: lookupStatus,
    planning_authority_case_reference: planningReference,
    lookup_error: errorMessage ? String(errorMessage).slice(0, 500) : null,
  };
  const currentFingerprint = fingerprint(state);

  const existing = await client.query('select fingerprint, state from source_state where source_key = $1', [sourceKey]);
  const before = existing.rows[0]?.state || null;
  const previousFingerprint = existing.rows[0]?.fingerprint || null;

  await client.query(`
    insert into source_state (source_key, fingerprint, state, first_seen_at, last_seen_at, updated_at)
    values ($1, $2, $3::jsonb, now(), now(), now())
    on conflict (source_key) do update set
      fingerprint = excluded.fingerprint,
      state = excluded.state,
      last_seen_at = now(),
      updated_at = now()
  `, [sourceKey, currentFingerprint, JSON.stringify(state)]);

  if (planningReference && previousFingerprint !== currentFingerprint) {
    await client.query(`
      insert into change_events (source_key, event_type, before_state, after_state)
      values ($1, 'historical_appeal_reference', $2::jsonb, $3::jsonb)
    `, [sourceKey, JSON.stringify(before), JSON.stringify(state)]);
    return true;
  }
  return false;
}

async function main() {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const startedAt = new Date().toISOString();

  try {
    const jobResult = await client.query('select cursor, last_status from worker_jobs where job_key = $1', [JOB_KEY]);
    const current = jobResult.rows[0];
    if (current?.last_status === 'complete' && process.env.RESET_WORKER_CURSOR !== 'true') {
      console.log(JSON.stringify({ status: 'complete', message: 'Historical catch-up already completed. Set RESET_WORKER_CURSOR=true to rescan.' }, null, 2));
      return;
    }

    const offset = Number(current?.cursor?.offset || 0);
    await upsertJob(client, { cursor: { offset }, lastStartedAt: startedAt, status: 'running', error: null });

    const features = await fetchSourceBatch(offset);
    let found = 0;
    let notFound = 0;
    let failed = 0;
    let events = 0;

    for (const [index, feature] of features.entries()) {
      const row = feature.attributes || {};
      const caseNumber = cleanText(row.ABPCASEID);
      const url = canonicalCaseUrl(caseNumber, row.LINKABPWEB);
      if (!caseNumber || !url) continue;

      try {
        const html = await fetchHtml(url);
        if (!html) {
          await stageResult(client, row, 'not_found');
          notFound += 1;
        } else {
          const parsed = parseCasePage(html);
          if (parsed.planningAuthorityCaseReference) {
            const emitted = await stageResult(client, row, 'found', parsed.planningAuthorityCaseReference);
            if (emitted) events += 1;
            found += 1;
          } else {
            await stageResult(client, row, 'not_found');
            notFound += 1;
          }
        }
      } catch (error) {
        failed += 1;
        await stageResult(client, row, 'failed', null, error instanceof Error ? error.message : String(error));
        console.warn(`Case ${caseNumber} failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (index < features.length - 1) await sleep(LOOKUP_DELAY_MS);
    }

    const complete = features.length < BATCH_SIZE;
    const nextOffset = complete ? offset + features.length : offset + BATCH_SIZE;
    await upsertJob(client, {
      cursor: { offset: nextOffset },
      lastStartedAt: startedAt,
      lastCompletedAt: new Date().toISOString(),
      status: complete ? 'complete' : 'ready',
      error: failed ? `${failed} source lookups failed in latest batch` : null,
    });

    console.log(JSON.stringify({ offset, attempted: features.length, found, notFound, failed, stagedEvents: events, nextOffset, complete }, null, 2));
  } catch (error) {
    await upsertJob(client, {
      cursor: {},
      lastStartedAt: startedAt,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

await main();
