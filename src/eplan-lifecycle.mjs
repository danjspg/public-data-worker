import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.EPLAN_WORKER_LIMIT || 200), 300));
const DELAY_MS = Math.max(500, Number(process.env.EPLAN_WORKER_DELAY_MS || 1000));
const EPLAN_BASE_URL = 'https://www.eplanning.ie';
const AUTHORITIES = {
  CARLOW: 'CarlowCC', CAVAN: 'CavanCC', CLARE: 'ClareCC', DONEGAL: 'DonegalCC', GALWAYCOCO: 'GalwayCC',
  GALWAYCITY: 'GalwayCity', KILDARE: 'KildareCC', KILKENNY: 'KilkennyCC', KERRY: 'KerryCC', LAOIS: 'LaoisCC',
  LIMERICK: 'LimerickCCC', LEITRIM: 'LeitrimCC', LONGFORD: 'LongfordCC', LOUTH: 'LouthCC', MAYO: 'MayoCC',
  MEATH: 'MeathCC', MONAGHAN: 'MonaghanCC', WATERFORD: 'WaterfordCCC', OFFALY: 'OffalyCC', ROSCOMMON: 'RoscommonCC',
  SLIGO: 'SligoCC', TIPPERARY: 'TipperaryCC', WESTMEATH: 'WestmeathCC', WICKLOW: 'WicklowCC',
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normaliseReference = (value) => String(value || '').trim().replace(/\s+/g, '').toUpperCase();
function htmlText(value) {
  return String(value || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim();
}
function parseIrishDate(value) {
  const m = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}
function detailFields(html) {
  const fields = new Map();
  for (const row of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    for (const pair of row[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
      const label = htmlText(pair[1]).replace(/:$/, '').toLowerCase();
      if (label && !fields.has(label)) fields.set(label, htmlText(pair[2]));
    }
  }
  return fields;
}
function tabFields(html, tabId) {
  const escaped = String(tabId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tab = String(html).match(new RegExp(`<div\\b[^>]*\\bid=["']${escaped}["'][^>]*>[\\s\\S]*?<table\\b[^>]*>([\\s\\S]*?)<\\/table>`, 'i'));
  return detailFields(tab?.[1] || '');
}
function parseApplication(html, expectedReference) {
  const fields = detailFields(html);
  const decision = tabFields(html, 'Decision');
  const appeal = tabFields(html, 'Appeal');
  const fileNumber = normaliseReference(fields.get('file number'));
  if (!fileNumber || fileNumber !== normaliseReference(expectedReference)) return { ok: false, reason: 'reference_mismatch', fileNumber: fileNumber || null };
  const date = (map, key) => parseIrishDate(map.get(key));
  const text = (map, key) => htmlText(map.get(key)) || null;
  return {
    ok: true,
    fileNumber,
    status: text(fields, 'planning status'),
    further_information_requested_date: date(fields, 'further info requested'),
    further_information_received_date: date(fields, 'further info received'),
    decision_due_date: date(fields, 'decision due date'),
    decision_date: date(decision, 'decision date') || date(fields, 'decision date'),
    decision_text: text(decision, 'decision type') || text(fields, 'decision type') || text(decision, 'decision description'),
    final_grant_date: date(decision, 'grant date'),
    withdrawal_date: date(fields, 'withdrawn date'),
    appeal_lodged_date: date(fields, 'appeal date'),
    appeal_decision_date: date(appeal, 'decision date'),
    expiry_date: date(fields, 'expiry date'),
  };
}
async function fetchApplication(authorityCode, reference) {
  const path = AUTHORITIES[authorityCode];
  if (!path) return { ok: false, reason: 'unsupported_authority' };
  const url = `${EPLAN_BASE_URL}/${path}/AppFileRefDetails/${encodeURIComponent(normaliseReference(reference))}/0`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Public records data worker' }, signal: controller.signal });
      if (response.status === 404) return { ok: false, reason: 'not_found', url };
      if (response.ok) return { ...parseApplication(await response.text(), reference), url };
      lastError = new Error(`HTTP ${response.status}`);
      if (![408,425,429,500,502,503,504].includes(response.status)) break;
    } catch (error) { lastError = error; }
    finally { clearTimeout(timer); }
    if (attempt < 2) await sleep((attempt + 1) * 1000);
  }
  return { ok: false, reason: 'fetch_error', error: String(lastError), url };
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let processed = 0, completed = 0, failed = 0;
try {
  const { rows } = await client.query(`
    select id, input
    from work_items
    where job_type = 'eplan_lifecycle'
      and status = 'pending'
      and applied_at is null
      and available_at <= now()
    order by id
    limit $1
  `, [LIMIT]);

  for (const [index, item] of rows.entries()) {
    processed += 1;
    await client.query("update work_items set status='running', leased_at=now(), attempts=attempts+1, updated_at=now() where id=$1", [item.id]);
    try {
      const result = await fetchApplication(item.input.local_authority_code, item.input.reference);
      await client.query(`update work_items set status='completed', result=$2::jsonb, completed_at=now(), last_error=null, updated_at=now() where id=$1`, [item.id, JSON.stringify(result)]);
      completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.query(`update work_items set status='failed', last_error=$2, completed_at=now(), updated_at=now() where id=$1`, [item.id, message.slice(0,500)]);
      failed += 1;
    }
    if (index < rows.length - 1) await sleep(DELAY_MS);
  }
  console.log(JSON.stringify({ selected: rows.length, processed, completed, failed }, null, 2));
  if (failed > Math.max(10, Math.floor(processed * 0.1))) process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
