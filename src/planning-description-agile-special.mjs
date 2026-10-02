import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const CLAIM_LIMIT = Math.max(1, Math.min(Number(process.env.DESCRIPTION_SPECIAL_WORKER_LIMIT || 500), 1000));
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.DESCRIPTION_SPECIAL_AGILE_CONCURRENCY || 2), 6));
const MAX_RUNTIME_MS = Math.max(5 * 60_000, Math.min(Number(process.env.DESCRIPTION_SPECIAL_MAX_RUNTIME_MS || 35 * 60_000), 50 * 60_000));
const SEARCH_URL = 'https://planningapi.agileapplications.ie/api/application/search';
const DETAIL_URL = 'https://planningapi.agileapplications.ie/api/application';
const SEARCH_STATUSES = ['registered','determined'];
const RETRYABLE = new Set([408,425,429,500,502,503,504]);
const SPECIAL_AUTHORITIES = ['DLR','FINGAL','WEXFORD'];
const CONFIG = {
  DLR: { client: 'DLR' },
  FINGAL: { client: 'FG' },
  WEXFORD: { client: 'WEXFORD' },
};

const startedAt = Date.now();
const timeRemaining = () => Date.now() - startedAt < MAX_RUNTIME_MS;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const normaliseReference = (value) => clean(value).replace(/\s+/g, '').toUpperCase();
const headersFor = (config) => ({
  'User-Agent': 'Public records data worker',
  'x-client': config.client,
  'x-product': 'CITIZENPORTAL',
  'x-service': 'PA',
});

function isTransient(message) {
  return /HTTP (408|425|429|500|502|503|504)|timeout|abort|fetch failed|ECONN|socket|temporar|rate limit|too many/i.test(String(message || ''));
}

async function fetchJson(url, config, { allowNotFound = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: headersFor(config),
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return await response.json();
      if (response.status === 404 && allowNotFound) return null;
      lastError = new Error(`HTTP ${response.status}`);
      if (!RETRYABLE.has(response.status)) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 30000));
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await sleep(Math.min(10000, attempt * 1000));
  }
  throw lastError || new Error('Agile request failed');
}

async function resolveReference(input, config) {
  const expected = normaliseReference(input.reference);
  if (!expected) throw new Error('missing_reference');

  const sourceUrlId = String(input.source_url || '').match(/\/application-details\/(\d+)/)?.[1];
  if (sourceUrlId && Number.isInteger(Number(sourceUrlId))) return Number(sourceUrlId);

  const directParams = new URLSearchParams({ query: String(input.reference).trim() });
  const direct = await fetchJson(`${SEARCH_URL}?${directParams}`, config);
  const directMatch = (direct?.results || []).find((row) => normaliseReference(row?.reference) === expected);
  if (Number.isInteger(directMatch?.id)) return directMatch.id;

  const registrationDate = String(input.registration_date || '').slice(0, 10);
  if (registrationDate) {
    for (const status of SEARCH_STATUSES) {
      const params = new URLSearchParams({
        registrationDateFrom: `${registrationDate}T00:00:00Z`,
        registrationDateTo: `${registrationDate}T23:59:59Z`,
        status,
      });
      const data = await fetchJson(`${SEARCH_URL}?${params}`, config);
      const match = (data?.results || []).find((row) => normaliseReference(row?.reference) === expected);
      if (Number.isInteger(match?.id)) return match.id;
    }
  }

  throw new Error('reference_not_found');
}

async function loadProposal(input, config) {
  const expected = normaliseReference(input.reference);
  const detailId = await resolveReference(input, config);
  const detail = await fetchJson(`${DETAIL_URL}/${detailId}`, config, { allowNotFound: true });
  if (!detail) throw new Error('detail_not_found');
  if (normaliseReference(detail.reference) !== expected) throw new Error('reference_mismatch');
  return {
    proposal: clean(detail.fullProposal) || null,
    detailId,
  };
}

async function deferItem(client, itemId, message) {
  await client.query(`
    update work_items
    set status='pending', attempts=attempts+1, last_error=$2,
        available_at=now() + interval '30 minutes', completed_at=null, updated_at=now()
    where id=$1
  `, [itemId, String(message).slice(0, 500)]);
}

async function failItem(client, itemId, message) {
  await client.query(`
    update work_items
    set status='failed', attempts=attempts+1, last_error=$2, completed_at=now(), updated_at=now()
    where id=$1
  `, [itemId, String(message).slice(0, 500)]);
}

async function runConcurrent(items, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      if (!timeRemaining()) return;
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let selected = 0;
let completed = 0;
let deferred = 0;
let failed = 0;
let recoveredLegacy = 0;
const byAuthority = {};

try {
  // Older runs sent DLR/Fingal through the generic worker and used stale Wexford detail IDs.
  // Re-open those known failures. reference_not_found is retried only a few times so genuinely
  // unavailable historical records do not churn forever.
  const recovered = await client.query(`
    update work_items
    set status='pending', available_at=now(), completed_at=null, last_error=null, updated_at=now()
    where job_type='planning_description'
      and applied_at is null
      and status='failed'
      and (
        (input->>'local_authority_code' in ('DLR','FINGAL') and coalesce(last_error,'')='unsupported_authority')
        or (input->>'local_authority_code'='WEXFORD' and coalesce(last_error,'')='HTTP 404')
        or (input->>'local_authority_code' = any($1::text[]) and coalesce(last_error,'')='reference_not_found' and attempts < 4)
      )
  `, [SPECIAL_AUTHORITIES]);
  recoveredLegacy = recovered.rowCount || 0;

  while (timeRemaining()) {
    const { rows } = await client.query(`
      select id,input
      from work_items
      where job_type='planning_description'
        and status='pending'
        and applied_at is null
        and available_at <= now()
        and input->>'local_authority_code' = any($2::text[])
      order by coalesce((input->>'registration_date')::date, date '1900-01-01') desc, id
      limit $1
    `, [CLAIM_LIMIT, SPECIAL_AUTHORITIES]);

    if (!rows.length) break;
    selected += rows.length;

    await runConcurrent(rows, async (item) => {
      const code = item.input.local_authority_code;
      const config = CONFIG[code];
      byAuthority[code] ||= { selected: 0, completed: 0, deferred: 0, failed: 0 };
      byAuthority[code].selected += 1;
      try {
        const source = await loadProposal(item.input, config);
        await client.query(
          `update work_items
           set status='completed', result=$2::jsonb, completed_at=now(), last_error=null,
               attempts=attempts+1, updated_at=now()
           where id=$1`,
          [item.id, JSON.stringify({
            ok: true,
            proposal: source.proposal,
            source: 'agile_detail',
            resolved_by: 'reference',
            detail_id: source.detailId,
          })]
        );
        completed += 1;
        byAuthority[code].completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTransient(message)) {
          await deferItem(client, item.id, message);
          deferred += 1;
          byAuthority[code].deferred += 1;
        } else {
          await failItem(client, item.id, message);
          failed += 1;
          byAuthority[code].failed += 1;
        }
      } finally {
        await sleep(150);
      }
    });
  }

  const { rows: remainingRows } = await client.query(`
    select count(*)::int as count
    from work_items
    where job_type='planning_description'
      and status='pending'
      and applied_at is null
      and available_at <= now()
      and input->>'local_authority_code' = any($1::text[])
  `, [SPECIAL_AUTHORITIES]);
  const remainingReady = Number(remainingRows[0]?.count || 0);
  const stoppedForTime = remainingReady > 0 && !timeRemaining();

  console.log(JSON.stringify({
    recoveredLegacy,
    selected,
    completed,
    deferred,
    failed,
    remainingReady,
    stoppedForTime,
    runtimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    concurrency: CONCURRENCY,
    byAuthority,
  }, null, 2));

  // A non-empty backlog after the bounded runtime is normal catch-up progress, not a job failure.
  // Only fail the workflow when there is a meaningful permanent-error rate.
  if (failed > Math.max(25, Math.floor(selected * 0.1))) process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
