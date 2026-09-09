import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const AUTHORITY = String(process.env.PROFESSIONAL_AUTHORITY || '').toUpperCase();
const LIMIT = Math.max(1, Math.min(Number(process.env.PROFESSIONAL_WORKER_LIMIT || 300), 500));
const DELAY_MS = Math.max(350, Number(process.env.PROFESSIONAL_WORKER_DELAY_MS || 500));
const EPLAN_BASE_URL = 'https://www.eplanning.ie';
const EPLAN_AUTHORITIES = {
  CARLOW:'CarlowCC', CAVAN:'CavanCC', CLARE:'ClareCC', DONEGAL:'DonegalCC', GALWAYCOCO:'GalwayCC', GALWAYCITY:'GalwayCity',
  KILDARE:'KildareCC', KILKENNY:'KilkennyCC', KERRY:'KerryCC', LAOIS:'LaoisCC', LIMERICK:'LimerickCCC', LEITRIM:'LeitrimCC',
  LONGFORD:'LongfordCC', LOUTH:'LouthCC', MAYO:'MayoCC', MEATH:'MeathCC', MONAGHAN:'MonaghanCC', WATERFORD:'WaterfordCCC',
  OFFALY:'OffalyCC', ROSCOMMON:'RoscommonCC', SLIGO:'SligoCC', TIPPERARY:'TipperaryCC', WESTMEATH:'WestmeathCC', WICKLOW:'WicklowCC',
};
const AGILE_AUTHORITIES = {
  CORKCOCO:{ code:'CORKCOCO', tenant:'corkcoco' }, CORKCITY:{ code:'CORKCITY', tenant:'corkcity' }, WEXFORD:{ code:'WEXFORD', tenant:'wexford' },
  DLR:{ code:'DLR', tenant:'dunlaoghaire' }, FINGAL:{ code:'FG', tenant:'fingal' }, SOUTHDUBLIN:{ code:'SD', tenant:'southdublin' },
  DUBLINCITY:{ code:'DCC', tenant:'dublincity' }, DUBLINCC:{ code:'DCC', tenant:'dublincity' },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function htmlText(value) {
  return String(value || '').replace(/<br\s*\/?>/gi,' | ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/\s+/g,' ').trim();
}
function normalizeName(value) { return htmlText(value).normalize('NFKC').toLowerCase().replace(/[’‘`]/g,"'").replace(/\s+/g,' ').trim(); }
function detailFields(html) {
  const fields = new Map();
  for (const row of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => htmlText(m[1]));
    if (cells.length < 2) continue;
    const label = cells[0].replace(/:$/,'').trim().toLowerCase();
    if (label && !fields.has(label)) fields.set(label, cells.slice(1).join(' | ').trim());
  }
  return fields;
}
function parseEplanAgent(html) {
  const source = String(html || '');
  const markers = [/id=["'][^"']*agent[^"']*["']/i, />\s*Agent Details\s*</i, />\s*Agents\s*</i];
  let start = -1;
  for (const marker of markers) { const m = marker.exec(source); if (m && (start < 0 || m.index < start)) start = m.index; }
  if (start < 0) return [];
  const tail = source.slice(start);
  const endMarkers = [/id=["'][^"']*(submitter|further|company|site|decision|appeal)[^"']*["']/i, />\s*(Submitter Details|Further Information Details|Company Details|Site Location Details|Decision|Appeal)\s*</i];
  let end = tail.length;
  for (const marker of endMarkers) { const m = marker.exec(tail.slice(1)); if (m && m.index + 1 < end) end = m.index + 1; }
  const fields = detailFields(tail.slice(0,end));
  const rawName = fields.get('name') || fields.get('agent name') || null;
  if (!rawName) return [];
  const clean = htmlText(rawName), normalized = normalizeName(clean);
  if (!normalized) return [];
  const payload = {};
  for (const key of ['address','phone','telephone','email','fax']) if (fields.get(key)) payload[key] = fields.get(key);
  return [{ role:'agent', raw_name:clean, raw_name_normalized:normalized, confidence:100, source_payload:payload }];
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
}
async function fetchProfessional(authority, reference) {
  if (AGILE_AUTHORITIES[authority]) {
    const cfg = AGILE_AUTHORITIES[authority];
    const params = new URLSearchParams({ reference:String(reference).trim() });
    try {
      const response = await fetchWithTimeout(`https://planningapi.agileapplications.ie/api/application/search?${params}`, { headers:{ 'User-Agent':'Public records data worker','x-client':cfg.code,'x-product':'CITIZENPORTAL','x-service':'PA' } });
      if (!response.ok) return { ok:false, reason:`http_${response.status}`, source_family:'agile' };
      const data = await response.json();
      const wanted = String(reference || '').replace(/\s+/g,'').toUpperCase();
      const row = (Array.isArray(data?.results) ? data.results : []).find((r) => String(r?.reference || '').replace(/\s+/g,'').toUpperCase() === wanted);
      if (!row) return { ok:false, reason:'reference_not_found', source_family:'agile' };
      const raw = htmlText(row.agentName);
      const source_url = `https://planning.agileapplications.ie/${cfg.tenant}/search-applications/`;
      return { ok:true, reason:raw ? null : 'no_agent', source_family:'agile', source_url, professionals:raw ? [{ role:'agent',raw_name:raw,raw_name_normalized:normalizeName(raw),confidence:100,source_payload:{source_application_id:row.id ?? null} }] : [] };
    } catch (error) { return { ok:false, reason:'fetch_error', error:String(error), source_family:'agile' }; }
  }
  const path = EPLAN_AUTHORITIES[authority];
  if (!path) return { ok:false, reason:'unsupported_authority', source_family:'manual' };
  const ref = String(reference || '').trim().replace(/\s+/g,'').toUpperCase();
  const url = `${EPLAN_BASE_URL}/${path}/AppFileRefDetails/${encodeURIComponent(ref)}/0`;
  try {
    const response = await fetchWithTimeout(url, { headers:{ 'User-Agent':'Public records data worker' } });
    if (response.status === 404) return { ok:false, reason:'not_found', source_family:'eplan', source_url:url };
    if (!response.ok) return { ok:false, reason:`http_${response.status}`, source_family:'eplan', source_url:url };
    const professionals = parseEplanAgent(await response.text());
    return { ok:true, reason:professionals.length ? null : 'no_agent', source_family:'eplan', source_url:url, professionals };
  } catch (error) { return { ok:false, reason:'fetch_error', error:String(error), source_family:'eplan', source_url:url }; }
}

const client = new Client({ connectionString, ssl:{ rejectUnauthorized:false } });
await client.connect();
let completed = 0, deferred = 0;
try {
  const params = [LIMIT];
  let authorityClause = '';
  if (AUTHORITY) { params.push(AUTHORITY); authorityClause = `and input->>'local_authority_code'=$2`; }
  const { rows } = await client.query(`
    select id,input from work_items
    where job_type='planning_professional_backfill' and status='pending' and applied_at is null and available_at<=now()
      ${authorityClause}
    order by (input->>'registration_date')::date desc, id desc
    limit $1
  `, params);
  for (const [index,item] of rows.entries()) {
    await client.query("update work_items set status='running', leased_at=now(), attempts=attempts+1, updated_at=now() where id=$1",[item.id]);
    const result = await fetchProfessional(String(item.input.local_authority_code || '').toUpperCase(), item.input.reference);
    const transient = !result.ok && (result.reason === 'fetch_error' || /^http_(408|425|429|500|502|503|504)$/.test(result.reason || ''));
    if (transient) {
      await client.query("update work_items set status='pending',result=null,available_at=now()+interval '30 minutes',last_error=$2,completed_at=null,updated_at=now() where id=$1",[item.id,String(result.error || result.reason).slice(0,500)]);
      deferred += 1;
    } else {
      await client.query("update work_items set status='completed',result=$2::jsonb,completed_at=now(),last_error=null,updated_at=now() where id=$1",[item.id,JSON.stringify(result)]);
      completed += 1;
    }
    if (index < rows.length - 1) await sleep(DELAY_MS);
  }
  console.log(JSON.stringify({ authority:AUTHORITY || null, selected:rows.length, completed, deferred }, null, 2));
} finally { await client.end().catch(() => {}); }
