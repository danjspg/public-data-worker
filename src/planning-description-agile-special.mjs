import pg from 'pg';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const CLAIM_LIMIT = Math.max(1, Math.min(Number(process.env.DESCRIPTION_SPECIAL_WORKER_LIMIT || 500), 1000));
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.DESCRIPTION_SPECIAL_AGILE_CONCURRENCY || 2), 6));
const MAX_RUNTIME_MS = Math.max(5 * 60_000, Math.min(Number(process.env.DESCRIPTION_SPECIAL_MAX_RUNTIME_MS || 35 * 60_000), 50 * 60_000));
const SEARCH_URL = 'https://planningapi.agileapplications.ie/api/application/search';
const DETAIL_URL = 'https://planningapi.agileapplications.ie/api/application';
const WEXFORD_LIST_ROOT = 'https://www.wexfordcoco.ie/planning/planning-applications/planning-lists';
const WEXFORD_PDF_RECORD_VERSION = 3;
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
const normaliseReference = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headersFor = (config) => ({
  'User-Agent': 'Public records data worker',
  'x-client': config.client,
  'x-product': 'CITIZENPORTAL',
  'x-service': 'PA',
});

const wexfordYearPageCache = new Map();
const wexfordPdfTextCache = new Map();

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

async function fetchPublic(url, kind = 'text') {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'OpenList public records data worker (+https://www.openlist.ie)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        if (!RETRYABLE.has(response.status)) break;
      } else if (kind === 'buffer') {
        return Buffer.from(await response.arrayBuffer());
      } else {
        return await response.text();
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await sleep(Math.min(8000, attempt * 1000));
  }
  throw lastError || new Error('Public council request failed');
}

async function resolveReference(input, config) {
  const expected = normaliseReference(input.reference);
  if (!expected) throw new Error('missing_reference');

  const directParams = new URLSearchParams({ reference: String(input.reference).trim() });
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

function htmlDecode(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(value) {
  return htmlDecode(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function dateFromLabel(label) {
  const match = String(label || '').match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function extractSection(html, heading, nextHeading) {
  const start = html.toLowerCase().indexOf(heading.toLowerCase());
  if (start < 0) return '';
  const rest = html.slice(start + heading.length);
  const end = nextHeading ? rest.toLowerCase().indexOf(nextHeading.toLowerCase()) : -1;
  return end >= 0 ? rest.slice(0, end) : rest;
}

function pdfLinksFromSection(section, pageUrl) {
  const links = [];
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of section.matchAll(anchor)) {
    const label = stripTags(match[2]);
    const endDate = dateFromLabel(label);
    if (endDate === null) continue;
    const href = htmlDecode(match[1]);
    try {
      const url = new URL(href, pageUrl).toString();
      if (/\.pdf(?:$|[?#])/i.test(url)) links.push({ endDate, url });
    } catch {}
  }
  return links;
}

async function wexfordListLinks(year) {
  if (wexfordYearPageCache.has(year)) return wexfordYearPageCache.get(year);
  const pageUrl = `${WEXFORD_LIST_ROOT}/planning-lists-for-${year}`;
  const html = await fetchPublic(pageUrl);
  const valid = extractSection(html, 'Valid Planning Applications Received', 'Invalid Planning Applications Received');
  const invalid = extractSection(html, 'Invalid Planning Applications Received', 'Invalid Due to Site Notice');
  const siteNotice = extractSection(html, 'Invalid Due to Site Notice', 'Planning Applications Decided');
  const links = [
    ...pdfLinksFromSection(valid, pageUrl),
    ...pdfLinksFromSection(invalid, pageUrl),
    ...pdfLinksFromSection(siteNotice, pageUrl),
  ];
  wexfordYearPageCache.set(year, links);
  return links;
}

async function pdfText(url) {
  if (wexfordPdfTextCache.has(url)) return wexfordPdfTextCache.get(url);
  const buffer = await fetchPublic(url, 'buffer');
  const parsed = await pdfParse(buffer);
  const text = String(parsed?.text || '');
  wexfordPdfTextCache.set(url, text);
  return text;
}

function extractWexfordProposal(text, reference) {
  const normalized = normaliseReference(reference);
  if (!normalized) return null;
  const base = normalized.endsWith('W') ? normalized.slice(0, -1) : normalized;

  // pdf-parse can collapse table-cell whitespace, so do not require spaces around the
  // planning number. The full 8-digit reference remains specific enough to locate the row.
  const refPattern = new RegExp(`${escapeRegex(base)}W?`, 'i');
  const refMatch = refPattern.exec(text);
  if (!refMatch) return null;

  const tail = text.slice(refMatch.index + refMatch[0].length, refMatch.index + 16000);
  const proposalMarker = /Proposal\s*:\s*/i.exec(tail);
  if (!proposalMarker) return null;
  const proposalTail = tail.slice(proposalMarker.index + proposalMarker[0].length);

  // Stop at the next table record, not simply at the end of the PDF. pdf-parse sometimes
  // collapses the planning-number and date cells completely (20260136W05 Feb 2026), so zero
  // whitespace is permitted there. A planning reference in prose will not match unless it is
  // immediately followed by an application-date shape.
  const nextRecord = /\b(?:20\d{6}W?|EXD\d{5,})\s*(?:\d{1,2}\s+[A-Za-z]{3}\s+20\d{2}|\d{1,2}[/-]\d{1,2}[/-]20\d{2})/i.exec(proposalTail);
  const totalMarker = /\bTotal\s+No\.?\s+of\b/i.exec(proposalTail);
  const eiaMarker = /\bEIA\s*Status\s*:/i.exec(proposalTail);
  const boundaries = [nextRecord?.index, totalMarker?.index, eiaMarker?.index]
    .filter((value) => Number.isInteger(value) && value >= 0);
  const end = boundaries.length ? Math.min(...boundaries) : Math.min(proposalTail.length, 5000);
  const proposal = clean(proposalTail.slice(0, end));
  return proposal || null;
}

async function wexfordPlanningListProposal(input) {
  const registration = String(input.registration_date || '').slice(0, 10);
  const timestamp = Date.parse(`${registration}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  const year = Number(registration.slice(0, 4));
  if (!Number.isInteger(year) || year < 2024) return null;

  const links = await wexfordListLinks(year);
  const candidates = links
    .filter(({ endDate }) => endDate >= timestamp && endDate - timestamp <= 14 * 86400000)
    .sort((a, b) => a.endDate - b.endDate);

  for (const { url } of candidates) {
    try {
      const text = await pdfText(url);
      const proposal = extractWexfordProposal(text, input.reference);
      if (proposal) return { proposal, sourceUrl: url };
    } catch {
      // Some historical council PDFs have malformed xref/token structures. A bad sibling
      // list must not block trying the valid/invalid/site-notice alternatives for that week.
    }
  }
  return null;
}

async function loadProposal(input, config) {
  const expected = normaliseReference(input.reference);

  // Wexford's council planning lists are the most stable authoritative description source.
  // Prefer them before touching legacy Citizen Portal route IDs, which can 404 or rate-limit.
  let wexfordListError = null;
  if (config.client === 'WEXFORD') {
    try {
      const councilList = await wexfordPlanningListProposal(input);
      if (councilList) {
        return {
          proposal: councilList.proposal,
          detailId: null,
          source: 'wexford_planning_list_pdf',
          resolvedBy: 'registration_week',
          sourceUrl: councilList.sourceUrl,
        };
      }
    } catch (error) {
      wexfordListError = error;
    }
  }

  const sourceUrlId = String(input.source_url || '').match(/\/application-details\/(\d+)/)?.[1];
  if (sourceUrlId && Number.isInteger(Number(sourceUrlId))) {
    try {
      const routeDetail = await fetchJson(`${DETAIL_URL}/${Number(sourceUrlId)}`, config, { allowNotFound: true });
      if (routeDetail && normaliseReference(routeDetail.reference) === expected) {
        return {
          proposal: clean(routeDetail.fullProposal) || null,
          detailId: Number(sourceUrlId),
          source: 'agile_detail',
          resolvedBy: 'portal_route_id',
        };
      }
    } catch (error) {
      if (config.client !== 'WEXFORD') throw error;
    }
  }

  let apiError = null;
  try {
    const detailId = await resolveReference(input, config);
    const detail = await fetchJson(`${DETAIL_URL}/${detailId}`, config, { allowNotFound: true });
    if (!detail) throw new Error('detail_not_found');
    if (normaliseReference(detail.reference) !== expected) throw new Error('reference_mismatch');
    return {
      proposal: clean(detail.fullProposal) || null,
      detailId,
      source: 'agile_detail',
      resolvedBy: 'reference',
    };
  } catch (error) {
    apiError = error;
  }

  if (wexfordListError && isTransient(wexfordListError instanceof Error ? wexfordListError.message : String(wexfordListError))) {
    throw wexfordListError;
  }
  throw apiError || wexfordListError || new Error('reference_not_found');
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
let reprocessedPdf = 0;
const byAuthority = {};

try {
  // Re-open any earlier Wexford PDF results produced before strict record boundaries were
  // introduced. They are worker-only/unapplied rows, so this repairs them before publication.
  const reprocess = await client.query(`
    update work_items
    set status='pending', result=null, completed_at=null, last_error=null,
        available_at=now(), updated_at=now()
    where job_type='planning_description'
      and applied_at is null
      and status='completed'
      and result->>'source'='wexford_planning_list_pdf'
      and coalesce(nullif(result->>'record_boundary_version','')::int,0) < $1
  `, [WEXFORD_PDF_RECORD_VERSION]);
  reprocessedPdf = reprocess.rowCount || 0;

  // Older runs sent DLR/Fingal through the generic worker and used stale Wexford detail IDs.
  // Re-open those known failures. The bounded attempt ceiling prevents genuinely unavailable
  // historical records from churning indefinitely after the corrected source paths are tried.
  const recovered = await client.query(`
    update work_items
    set status='pending', available_at=now(), completed_at=null, last_error=null, updated_at=now()
    where job_type='planning_description'
      and applied_at is null
      and status='failed'
      and (
        (input->>'local_authority_code' in ('DLR','FINGAL') and coalesce(last_error,'')='unsupported_authority')
        or (input->>'local_authority_code'='WEXFORD' and coalesce(last_error,'')='HTTP 404')
        or (input->>'local_authority_code' = any($1::text[]) and coalesce(last_error,'') in ('reference_not_found','detail_not_found','bad XRef entry','Command token too long: 128') and attempts < 8)
      )
  `, [SPECIAL_AUTHORITIES]);
  recoveredLegacy = recovered.rowCount || 0;

  // A prior Agile-first run may have deferred Wexford on HTTP 429 before reaching the council-list
  // source. The corrected list-first path can safely retry those rows immediately.
  await client.query(`
    update work_items
    set available_at=now(), last_error=null, updated_at=now()
    where job_type='planning_description'
      and applied_at is null
      and status='pending'
      and input->>'local_authority_code'='WEXFORD'
      and coalesce(last_error,'')='HTTP 429'
  `);

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
            source: source.source || 'agile_detail',
            resolved_by: source.resolvedBy || 'reference',
            detail_id: source.detailId ?? null,
            source_url: source.sourceUrl || null,
            record_boundary_version: source.source === 'wexford_planning_list_pdf' ? WEXFORD_PDF_RECORD_VERSION : null,
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
    reprocessedPdf,
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

  if (failed > Math.max(25, Math.floor(selected * 0.1))) process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
