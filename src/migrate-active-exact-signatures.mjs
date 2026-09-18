import pg from 'pg';
import { activeExactSignature } from './meaningful-source-signature.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

let baselinesSelected = 0;
let baselinesMigrated = 0;
let stagedSelected = 0;
let stagedMigrated = 0;

try {
  const baselineRows = await client.query(`
    select s.application_key,
           wi.result
    from source_sync_state s
    join lateral (
      select w.result
      from work_items w
      where w.job_type='active_planning_exact'
        and w.input->>'application_id'=s.application_key
        and w.applied_at is not null
        and w.result->>'found'='true'
        and w.result ? 'attributes'
        and w.result->>'source_signature'=s.last_applied_signature
      order by w.applied_at desc, w.id desc
      limit 1
    ) wi on true
    where s.job_family='active_planning_exact'
      and s.last_applied_signature is not null
  `);
  baselinesSelected = baselineRows.rowCount || 0;

  const baselineUpdates = baselineRows.rows
    .map((row) => ({
      applicationKey: String(row.application_key),
      signature: activeExactSignature(row.result),
    }))
    .filter((row) => row.signature);

  for (const slice of chunks(baselineUpdates, 500)) {
    const keys = slice.map((row) => row.applicationKey);
    const signatures = slice.map((row) => row.signature);
    const updated = await client.query(`
      update source_sync_state s
      set last_applied_signature=v.signature,
          metadata=coalesce(s.metadata,'{}'::jsonb) || jsonb_build_object('signature_version','exact-v2'),
          updated_at=now()
      from unnest($1::text[],$2::text[]) as v(application_key,signature)
      where s.job_family='active_planning_exact'
        and s.application_key=v.application_key
      returning s.application_key
    `, [keys, signatures]);
    baselinesMigrated += updated.rowCount || 0;
  }

  const staged = await client.query(`
    select id,result
    from work_items
    where job_type='active_planning_exact'
      and result->>'found'='true'
      and result ? 'attributes'
  `);
  stagedSelected = staged.rowCount || 0;

  const stagedUpdates = staged.rows
    .map((row) => ({
      id: Number(row.id),
      signature: activeExactSignature(row.result),
    }))
    .filter((row) => Number.isInteger(row.id) && row.signature);

  for (const slice of chunks(stagedUpdates, 500)) {
    const ids = slice.map((row) => row.id);
    const signatures = slice.map((row) => row.signature);
    const updated = await client.query(`
      update work_items w
      set result=jsonb_set(
            jsonb_set(coalesce(w.result,'{}'::jsonb),'{source_signature}',to_jsonb(v.signature),true),
            '{source_signature_version}',to_jsonb('exact-v2'::text),true
          ),
          updated_at=now()
      from unnest($1::bigint[],$2::text[]) as v(id,signature)
      where w.id=v.id
      returning w.id
    `, [ids, signatures]);
    stagedMigrated += updated.rowCount || 0;
  }

  console.log(JSON.stringify({
    ok:true,
    baselinesSelected,
    baselinesMigrated,
    stagedSelected,
    stagedMigrated,
    signatureVersion:'exact-v2'
  }, null, 2));
} finally {
  await client.end().catch(() => {});
}
