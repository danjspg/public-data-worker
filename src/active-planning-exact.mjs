import pg from 'pg';
import { activeExactSignature } from './meaningful-source-signature.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const LIMIT = Math.max(1, Math.min(Number(process.env.ACTIVE_PLANNING_WORKER_LIMIT || 500), 5000));
const BATCH_SIZE = Math.max(1, Math.min(Number(process.env.ACTIVE_PLANNING_SOURCE_BATCH || 150), 200));
const ARC_QUERY = 'https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query';
const RETRYABLE = new Set([408,425,429,500,502,503,504]);
const SOURCE_AUTHORITY_BY_CODE = new Map([
  ['CORKCOCO','Cork County Council'],
  ['CORKCITY','Cork City Council'],
  ['WEXFORD','Wexford County Council'],
  ['DUBLINCITY','Dublin City Council'],
  ['FINGAL','Fingal County Council'],
  ['SOUTHDUBLIN','South Dublin County Council'],
  ['DLR','Dun Laoghaire Rathdown County Council'],
  ['KILDARE','Kildare County Council'],
  ['GALWAYCOCO','Galway County Council'],
  ['GALWAYCITY','Galway City Council'],
  ['MEATH','Meath County Council'],
  ['WICKLOW','Wicklow County Council'],
  ['LIMERICK','Limerick County Council'],
  ['WATERFORD','Waterford City and County Council'],
  ['DONEGAL','Donegal County Council'],
  ['TIPPERARY','Tipperary County Council'],
  ['KERRY','Kerry County Council'],
  ['MAYO','Mayo County Council'],
  ['CLARE','Clare County Council'],
  ['LOUTH','Louth County Council'],
  ['LAOIS','Laois County Council'],
  ['KILKENNY','Kilkenny County Council'],
  ['OFFALY','Offaly County Council'],
  ['CAVAN','Cavan County Council'],
  ['ROSCOMMON','Roscommon County Council'],
  ['WESTMEATH','Westmeath County Council'],
  ['MONAGHAN','Monaghan County Council'],
  ['SLIGO','Sligo County Council'],
  ['CARLOW','Carlow County Council'],
  ['LONGFORD','Longford County Council'],
  ['LEITRIM','Leitrim County Council'],
]);


async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clean(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function escapeSql(value) { return clean(value).replaceAll("'", "''"); }
async function fetchArcgis(params, label) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(ARC_QUERY, {
        method: 'POST',
        headers: {
          'User-Agent': 'Public records data worker',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) {
        const json = await response.json();
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
        return json;
      }
      lastError = new Error(`HTTP ${response.status}`);
      if (!RETRYABLE.has(response.status)) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await sleep(attempt * 750);
  }
  throw new Error(`${label}: ${lastError?.message || 'request failed'}`);
}

function sourceKey(authority, reference) {
  return `${clean(authority).toUpperCase()}|${clean(reference).toUpperCase()}`;
}

async function fetchAuthorityReferences(authorityCode, items) {
  const sourceAuthority = SOURCE_AUTHORITY_BY_CODE.get(authorityCode);
  if (!sourceAuthority) throw new Error(`Unknown source authority ${authorityCode}`);
  const refs = [...new Set(items.map((item) => clean(item.input.reference)).filter(Boolean))];
  if (!refs.length) return new Map();
  const where = [
    `PlanningAuthority = '${escapeSql(sourceAuthority)}'`,
    `ApplicationNumber IN (${refs.map((ref) => `'${escapeSql(ref)}'`).join(',')})`,
  ].join(' AND ');
  const params = new URLSearchParams({
    where,
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
    resultRecordCount: '2000',
  });
  const json = await fetchArcgis(params, `${authorityCode} reference lookup`);
  const byRef = new Map();
  for (const feature of json.features || []) {
    const attrs = feature.attributes || {};
    const key = sourceKey(attrs.PlanningAuthority, attrs.ApplicationNumber);
    if (key !== '|' && !byRef.has(key)) byRef.set(key, attrs);
  }
  return byRef;
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let selected = 0, completed = 0, referenceFallback = 0, missing = 0, failed = 0;
try {
  const { rows } = await client.query(`
    select i.id, i.input, i.attempts,
           case when s.metadata->>'signature_version'='exact-v2' then coalesce(s.metadata->>'last_seen_source_signature',s.last_applied_signature) else null end as previous_source_signature
    from work_items i
    left join source_sync_state s
      on s.job_family='active_planning_exact'
     and s.application_key=i.input->>'application_id'
    where i.job_type='active_planning_exact'
      and i.status='pending'
      and i.applied_at is null
      and i.available_at <= now()
    order by i.id
    limit $1
  `, [LIMIT]);
  selected = rows.length;

  const rowsByAuthority = new Map();
  for (const item of rows) {
    const authorityCode = item.input?.local_authority_code;
    const authorityRows = rowsByAuthority.get(authorityCode) || [];
    authorityRows.push(item);
    rowsByAuthority.set(authorityCode, authorityRows);
  }

  for (const [authorityCode, authorityRows] of rowsByAuthority) {
    const expectedAuthority = SOURCE_AUTHORITY_BY_CODE.get(authorityCode);
    if (!expectedAuthority) {
      const ids = authorityRows.map((item) => item.id);
      const deferredRows = await client.query(`
        update work_items
        set attempts=attempts+1,
            last_error=$2,
            available_at=now() + interval '6 hours',
            updated_at=now()
        where id = any($1::bigint[])
          and status='pending'
          and applied_at is null
        returning id
      `, [ids, `Unknown source authority ${authorityCode}`]);
      failed += deferredRows.rowCount || 0;
      continue;
    }

    for (let offset = 0; offset < authorityRows.length; offset += BATCH_SIZE) {
      const batch = authorityRows.slice(offset, offset + BATCH_SIZE);
      try {
        const byRef = await fetchAuthorityReferences(authorityCode, batch);

        for (const item of batch) {
          const sourceId = Number(item.input.source_application_id);
          const attrs = byRef.get(sourceKey(expectedAuthority, item.input.reference));

          if (!attrs) {
            if (Number(item.attempts || 0) >= 2) {
              const checkedAt = new Date().toISOString();
              await client.query(`
                update work_items
                set status='completed',
                    result=$2::jsonb,
                    applied_at=now(),
                    completed_at=now(),
                    attempts=attempts+1,
                    last_error=null,
                    updated_at=now()
                where id=$1
                  and status='pending'
                  and applied_at is null
              `, [item.id, JSON.stringify({
                ok:true,
                found:false,
                change_detected:false,
                source_check_failed:true,
                terminal_source_miss:true,
                reason:'source_reference_not_found_after_retries',
                checked_at:checkedAt
              })]);
            } else {
              await client.query(`
                update work_items
                set attempts=attempts+1,
                    last_error='source_reference_not_found',
                    available_at=now() + interval '6 hours',
                    updated_at=now()
                where id=$1
                  and status='pending'
                  and applied_at is null
              `, [item.id]);
            }
            missing += 1;
            continue;
          }

          const baseResult={ ok:true, found:true, matched_by:'authority_reference', attributes:attrs };
          const sourceSignature=activeExactSignature(baseResult);
          const previousSignature=item.previous_source_signature || null;
          const hasBaseline=Boolean(previousSignature);
          const unchanged=Boolean(sourceSignature && hasBaseline && sourceSignature===previousSignature);
          const baselineMissing=Boolean(sourceSignature && !hasBaseline);
          const changeDetected=Boolean(sourceSignature && hasBaseline && sourceSignature!==previousSignature);
          const checkedAt=new Date().toISOString();

          await client.query(`
            update work_items
            set status='completed',
                result=$2::jsonb,
                applied_at=case when $3 then now() else null end,
                completed_at=now(),
                last_error=null,
                updated_at=now()
            where id=$1
          `, [item.id, JSON.stringify({
            ...baseResult,
            source_signature:sourceSignature,
            change_detected:changeDetected,
            baseline_missing:baselineMissing,
            requires_prod_baseline_validation:baselineMissing,
            checked_at:checkedAt
          }), unchanged]);

          const currentSourceId = Number(attrs.OBJECTID);
          await client.query(`
            insert into source_sync_state(
              job_family,application_key,last_checked_at,last_seen_change_at,metadata,updated_at
            )
            values(
              'active_planning_exact',
              $1,
              $2::timestamptz,
              case when $3 then $2::timestamptz else null::timestamptz end,
              jsonb_build_object(
                'source_application_id',$4::bigint,
                'signature_version','exact-v2',
                'last_seen_source_signature',$5::text
              )
              || case when $6 then jsonb_build_object('baseline_missing',true,'pending_prod_change',false)
                      when $3 then jsonb_build_object('baseline_missing',false,'pending_prod_change',true)
                      else '{}'::jsonb end,
              now()
            )
            on conflict(job_family,application_key) do update
            set last_checked_at=excluded.last_checked_at,
                last_seen_change_at=case when $3 then excluded.last_checked_at else source_sync_state.last_seen_change_at end,
                metadata=coalesce(source_sync_state.metadata,'{}'::jsonb) || excluded.metadata,
                updated_at=now()
          `,[
            String(item.input.application_id),
            checkedAt,
            changeDetected,
            Number.isInteger(currentSourceId) ? currentSourceId : null,
            sourceSignature,
            baselineMissing
          ]);

          completed += 1;
          referenceFallback += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pendingIds = batch.map((item) => item.id);
        const deferredRows = await client.query(`
          update work_items
          set attempts=attempts+1,
              last_error=$2,
              available_at=now() + interval '30 minutes',
              updated_at=now()
          where id = any($1::bigint[])
            and status='pending'
            and applied_at is null
          returning id
        `, [pendingIds, message.slice(0,500)]);
        failed += deferredRows.rowCount || 0;
        console.warn(JSON.stringify({
          phase:'batch_deferred',
          authority:authorityCode,
          batch_size:batch.length,
          deferred:deferredRows.rowCount || 0,
          error:message.slice(0,200)
        }));
      }
    }
  }

  console.log(JSON.stringify({ selected, completed, referenceFallback, missing, deferred: failed }, null, 2));
} finally {
  await client.end().catch(() => {});
}
