import pg from 'pg';
import { TED_SEARCH_URL, fetchJson, normalizeTedNotice, sha256, stageProcurement } from './procurement-common.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');
const LOOKBACK_DAYS = Math.max(2, Math.min(Number(process.env.TED_LOOKBACK_DAYS || 7), 60));
const PAGE_LIMIT = Math.max(20, Math.min(Number(process.env.TED_PAGE_LIMIT || 200), 250));
const MAX_PAGES = Math.max(1, Math.min(Number(process.env.TED_MAX_PAGES || 50), 200));
const NORMALIZATION_VERSION = 'ted-v2';

function ymd(date) { return date.toISOString().slice(0, 10).replaceAll('-', ''); }
function startDate() { const d = new Date(); d.setUTCDate(d.getUTCDate() - LOOKBACK_DAYS); return d; }

const fields = [
  'publication-number','publication-date','notice-title','notice-type','procedure-identifier',
  'buyer-name','buyer-identifier','buyer-country','contract-nature','classification-cpv','deadline',
  'description-proc','estimated-value-proc','estimated-value-cur-proc','total-value','total-value-cur',
  'winner-name','winner-identifier','winner-decision-date','contract-conclusion-date','place-of-performance'
];

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let pages = 0, seen = 0, staged = 0, unchanged = 0;
try {
  const query = `buyer-country=IRL AND publication-date=(${ymd(startDate())} <> ${ymd(new Date())})`;
  let token;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = { query, fields, limit: PAGE_LIMIT, scope: 'ALL', checkQuerySyntax: false, paginationMode: 'ITERATION', onlyLatestVersions: false };
    if (token) body.iterationNextToken = token;
    const payload = await fetchJson(TED_SEARCH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    if (payload?.timedOut) throw new Error('TED search timed out');
    const notices = Array.isArray(payload?.notices) ? payload.notices : [];
    pages += 1;
    if (!notices.length) break;
    for (const raw of notices) {
      seen += 1;
      const record = normalizeTedNotice(raw);
      record.source_hash = sha256({ normalization: NORMALIZATION_VERSION, raw });
      const stateKey = `procurement:ted:${record.source_notice_id || record.source_record_key}`;
      const prior = await client.query('select fingerprint from source_state where source_key=$1', [stateKey]);
      if (prior.rows[0]?.fingerprint === record.source_hash) {
        unchanged += 1;
        await client.query('update source_state set last_seen_at=now(),updated_at=now() where source_key=$1', [stateKey]);
        continue;
      }
      await stageProcurement(client, 'procurement_ted_notice', record);
      await client.query(`insert into source_state(source_key,fingerprint,state,first_seen_at,last_seen_at,updated_at)
        values($1,$2,$3::jsonb,now(),now(),now()) on conflict(source_key) do update set fingerprint=excluded.fingerprint,state=excluded.state,last_seen_at=now(),updated_at=now()`,
        [stateKey, record.source_hash, JSON.stringify({ publication_date: record.publication_date, source_record_key: record.source_record_key, normalization: NORMALIZATION_VERSION })]);
      staged += 1;
    }
    token = payload.iterationNextToken;
    if (!token || notices.length < PAGE_LIMIT) break;
  }
  await client.query(`insert into source_state(source_key,fingerprint,state,first_seen_at,last_seen_at,updated_at)
    values('procurement:ted',$1,$2::jsonb,now(),now(),now()) on conflict(source_key) do update set fingerprint=excluded.fingerprint,state=excluded.state,last_seen_at=now(),updated_at=now()`,
    [new Date().toISOString(), JSON.stringify({ status: 'ready', lookback_days: LOOKBACK_DAYS, pages, seen, staged, unchanged, normalization: NORMALIZATION_VERSION })]);
  console.log(JSON.stringify({ query, normalization: NORMALIZATION_VERSION, pages, seen, staged, unchanged }, null, 2));
} finally {
  await client.end().catch(() => {});
}
