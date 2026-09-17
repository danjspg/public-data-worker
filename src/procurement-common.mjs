import crypto from 'node:crypto';

export const OGP_CSV_URL = 'https://assets.gov.ie/static/documents/4d482e0e/Public_Procurement_Opendata_Dataset.csv';
export const TED_SEARCH_URL = 'https://api.ted.europa.eu/v3/notices/search';
export const USER_AGENT = 'Public records data worker';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}
export function scalar(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length ? scalar(value[0]) : null;
  if (typeof value === 'object') {
    const preferred = value.eng ?? value.en ?? value.gle ?? value.ga;
    if (preferred != null) return scalar(preferred);
    const first = Object.values(value)[0];
    return first == null ? null : scalar(first);
  }
  const text = String(value).trim();
  return text || null;
}
export function arrayOfText(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.values(item).flatMap((v) => arrayOfText(v));
    const s = scalar(item);
    return s ? [s] : [];
  }))];
}
export function dateOnly(value) {
  const s = scalar(value);
  if (!s) return null;
  const iso = s.match(/(20\d{2}|19\d{2})[-/]?(\d{2})[-/]?(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const eu = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](20\d{2}|19\d{2})/);
  if (eu) return `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}
export function timestamp(value) {
  const s = scalar(value);
  if (!s) return null;
  const eu = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](20\d{2}|19\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (eu) {
    const iso = `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}T${(eu[4] || '00').padStart(2, '0')}:${eu[5] || '00'}:${eu[6] || '00'}Z`;
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
export function numberValue(value) {
  const s = scalar(value);
  if (!s) return null;
  let cleaned = s.replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
  if (cleaned.includes(',') && !cleaned.includes('.')) {
    const parts = cleaned.split(',');
    cleaned = parts.length === 2 && parts[1].length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join('');
  } else cleaned = cleaned.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
export async function fetchText(url, timeoutMs = 60000) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = new TextDecoder('utf-8').decode(bytes);
      if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(bytes);
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}
export async function fetchJson(url, options = {}, timeoutMs = 60000) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((h) => h.trim().replace(/^\uFEFF/, ''));
  return rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
export function normalizedKey(key) { return key.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
export function pick(row, aliases) {
  const lookup = new Map(Object.entries(row).map(([k, v]) => [normalizedKey(k), v]));
  for (const alias of aliases) {
    const value = lookup.get(normalizedKey(alias));
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}
function splitList(value) {
  const s = scalar(value);
  if (!s) return [];
  return [...new Set(s.split(/[;|]+/).map((v) => v.trim()).filter(Boolean))];
}
export function normalizeOgpRow(row, rowIndex) {
  const noticeId = pick(row, ['Tender ID','Notice ID','NoticeID','Contract Notice ID','RFT ID','RFTID','Competition ID','ID']);
  const procedureId = pick(row, ['Parent Agreement ID','Procedure ID','ProcedureID','RFT ID','RFTID','Competition ID']);
  const title = pick(row, ['Tender/Contract Name','Title','Tender Title','Contract Title','RFT Title','Competition Title','Notice Title']);
  const publicationDate = dateOnly(pick(row, ['Notice Published Date / Contract Created Date','Publication Date','Published Date','Date Published','Notice Publication Date','Publish Date']));
  const buyerName = pick(row, ['Name of Client Contracting Authority','Buyer Name','Contracting Authority','Organisation Name','Organization Name','Authority Name','Purchaser Name']);
  const winnerRaw = pick(row, ['Awarded Suppliers','Supplier Name','Successful Supplier','Winner Name','Contractor Name','Awarded Supplier']);
  const winners = splitList(winnerRaw);
  const awardDate = dateOnly(pick(row, ['Award Published','Award Date','Contract Award Date','Date Awarded']));
  const deadline = timestamp(pick(row, ['Tender Submission Deadline','Deadline','Closing Date','Response Deadline','Tender Deadline','Closing Date and Time']));
  const mainCpv = pick(row, ['Main Cpv Code','Main CPV Code','CPV','CPV Code','Main CPV','CPVCode']);
  const extraCpv = pick(row, ['Additional CPV Codes on CFT','Additional CPV Codes','Additional CPV']);
  const cpvCodes = [...new Set([mainCpv, ...(extraCpv ? extraCpv.split(/[;,|\s]+/) : [])].filter(Boolean))];
  const estimatedValue = numberValue(pick(row, ['Sum of Notice Estimated Value (€)','Sum of Notice Estimated Value','Estimated Value','Estimated Contract Value','Tender Value','EstimatedValue']));
  const awardedValue = numberValue(pick(row, ['Sum of Awarded Value (€)','Sum of Awarded Value','Award Value','Contract Value','Value of Contract','Awarded Value']));
  const currency = pick(row, ['Currency','Value Currency','Contract Currency']) || 'EUR';
  const description = pick(row, ['Description','Contract Description','Tender Description','Short Description','Main Cpv Code Description']);
  const noticeType = pick(row, ['Competition Type','Procedure','Notice Type','Type of Notice','Procedure Type','Tender Type']);
  const sourceUrl = pick(row, ['TED CAN Link','TED Notice Link','URL','Notice URL','Tender URL','eTenders URL','Link']);
  const identity = noticeId || procedureId || `${publicationDate || awardDate || 'undated'}:${buyerName || 'unknown'}:${title || 'untitled'}:${rowIndex}`;
  const kind = winners.length || awardDate || awardedValue != null ? 'award' : (/prior|pin/i.test(noticeType || '') ? 'prior_information' : 'notice');
  const normalized = {
    source: 'ogp_etenders', source_record_key: `ogp:${sha256(identity).slice(0, 32)}`,
    source_notice_id: noticeId, source_procedure_id: procedureId, record_kind: kind, notice_type: noticeType,
    publication_date: publicationDate, title, description, buyer_name: buyerName, buyer_identifier: null, buyer_country: 'IRL',
    contract_nature: pick(row, ['Contract Type','Contract Nature','Nature of Contract']), cpv_codes: cpvCodes,
    deadline, award_date: awardDate, winner_names: winners, estimated_value: estimatedValue,
    estimated_value_currency: estimatedValue != null ? currency : null, awarded_value: awardedValue,
    awarded_value_currency: awardedValue != null ? currency : null,
    place_of_performance: pick(row, ['Place of Performance','Location','County']), source_url: sourceUrl, source_updated_at: null,
  };
  return { ...normalized, source_hash: sha256({ ...normalized, raw: row }), raw_source: row };
}
export function normalizeTedNotice(n) {
  const pub = scalar(n['publication-number']);
  const title = scalar(n['notice-title']);
  const noticeType = scalar(n['notice-type']);
  const winnerNames = arrayOfText(n['winner-name']);
  const awardDate = dateOnly(n['winner-decision-date']) || dateOnly(n['contract-conclusion-date']);
  const recordKind = winnerNames.length || /can-|award/i.test(noticeType || '') ? 'award' : (/pin-|prior/i.test(noticeType || '') ? 'prior_information' : 'notice');
  const sourceUrl = pub ? `https://ted.europa.eu/en/notice/-/detail/${pub}` : null;
  const normalized = {
    source: 'ted', source_record_key: pub ? `ted:${pub}` : `ted:${sha256(n).slice(0, 32)}`,
    source_notice_id: pub, source_procedure_id: scalar(n['procedure-identifier']), record_kind: recordKind,
    notice_type: noticeType, publication_date: dateOnly(n['publication-date']), title,
    description: scalar(n['description-proc']), buyer_name: scalar(n['buyer-name']), buyer_identifier: scalar(n['buyer-identifier']),
    buyer_country: scalar(n['buyer-country']) || 'IRL', contract_nature: scalar(n['contract-nature']),
    cpv_codes: arrayOfText(n['classification-cpv']), deadline: timestamp(n['deadline']), award_date: awardDate,
    winner_names: winnerNames, estimated_value: numberValue(n['estimated-value-proc'] ?? n['total-value']),
    estimated_value_currency: scalar(n['estimated-value-cur-proc'] ?? n['total-value-cur']), awarded_value: numberValue(n['total-value']),
    awarded_value_currency: scalar(n['total-value-cur']), place_of_performance: scalar(n['place-of-performance']),
    source_url: sourceUrl, source_updated_at: null,
  };
  return { ...normalized, source_hash: sha256(n), raw_source: n };
}

export async function stageProcurement(client, jobType, record) {
  const workKey = record.source_record_key;
  await client.query(`
    insert into work_items(job_type,work_key,input,result,status,completed_at,updated_at)
    values($1,$2,$3::jsonb,$4::jsonb,'completed',now(),now())
    on conflict(job_type,work_key) do update set
      input=excluded.input,result=excluded.result,status='completed',completed_at=now(),
      applied_at=case when work_items.result is distinct from excluded.result then null else work_items.applied_at end,
      last_error=null,updated_at=now()
  `, [jobType, workKey, JSON.stringify({ source: record.source, source_record_key: record.source_record_key }), JSON.stringify(record)]);
}
