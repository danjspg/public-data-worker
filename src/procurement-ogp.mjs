import pg from 'pg';
import { OGP_CSV_URL, fetchText, parseCsv, normalizeOgpRow, stageProcurement, sha256 } from './procurement-common.mjs';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');
const MODE = (process.env.PROCUREMENT_OGP_MODE || 'backfill').toLowerCase();
const BATCH = Math.max(100, Math.min(Number(process.env.PROCUREMENT_OGP_BATCH || 1000), 5000));
const RECENT_DAYS = Math.max(60, Math.min(Number(process.env.PROCUREMENT_OGP_RECENT_DAYS || 210), 730));

function withStableKey(row, index) {
  return normalizeOgpRow(row, index);
}
async function setJob(client, jobKey, cursor, status, error = null) {
  await client.query(`insert into worker_jobs(job_key,cursor,last_started_at,last_completed_at,last_status,last_error,updated_at)
    values($1,$2::jsonb,now(),case when $3 in ('ready','idle','failed') then now() else null end,$3,$4,now())
    on conflict(job_key) do update set cursor=excluded.cursor,last_started_at=excluded.last_started_at,
      last_completed_at=coalesce(excluded.last_completed_at,worker_jobs.last_completed_at),last_status=excluded.last_status,last_error=excluded.last_error,updated_at=now()`,
    [jobKey, JSON.stringify(cursor), status, error]);
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const text = await fetchText(OGP_CSV_URL, 120000);
  const fileHash = sha256(text);
  const rows = parseCsv(text);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  let staged = 0, unchanged = 0, start = 0, end = 0;

  if (MODE === 'incremental') {
    const cutoff = new Date(); cutoff.setUTCDate(cutoff.getUTCDate() - RECENT_DAYS);
    const cutoffText = cutoff.toISOString().slice(0, 10);
    const candidates = rows.map((row, index) => ({ row, index, record: withStableKey(row, index) }))
      .filter(({ record }) => Math.max(record.publication_date || '', record.award_date || '') >= cutoffText)
      .slice(-BATCH);
    for (const { record } of candidates) {
      const stateKey = `procurement:ogp:${record.source_record_key}`;
      const prior = await client.query('select fingerprint from source_state where source_key=$1', [stateKey]);
      if (prior.rows[0]?.fingerprint === record.source_hash) { unchanged += 1; continue; }
      await stageProcurement(client, 'procurement_ogp_record', record);
      await client.query(`insert into source_state(source_key,fingerprint,state,first_seen_at,last_seen_at,updated_at)
        values($1,$2,$3::jsonb,now(),now(),now()) on conflict(source_key) do update set fingerprint=excluded.fingerprint,state=excluded.state,last_seen_at=now(),updated_at=now()`,
        [stateKey, record.source_hash, JSON.stringify({ publication_date: record.publication_date, award_date: record.award_date, source_record_key: record.source_record_key })]);
      staged += 1;
    }
    start = Math.max(0, rows.length - candidates.length); end = rows.length;
    await setJob(client, 'procurement-ogp-incremental', { file_hash: fileHash, row_count: rows.length, cutoff: cutoffText }, 'ready');
  } else {
    const state = await client.query("select cursor from worker_jobs where job_key='procurement-ogp-backfill'");
    start = Math.max(0, Number(state.rows[0]?.cursor?.row || 0));
    if (start > rows.length) start = 0;
    end = Math.min(rows.length, start + BATCH);
    await setJob(client, 'procurement-ogp-backfill', { row: start, row_count: rows.length, file_hash: fileHash }, 'running');
    for (let index = start; index < end; index += 1) {
      await stageProcurement(client, 'procurement_ogp_record', withStableKey(rows[index], index));
      staged += 1;
    }
    await setJob(client, 'procurement-ogp-backfill', { row: end, row_count: rows.length, file_hash: fileHash, complete: end >= rows.length }, end >= rows.length ? 'idle' : 'ready');
  }

  await client.query(`insert into source_state(source_key,fingerprint,state,first_seen_at,last_seen_at,updated_at)
    values('procurement:ogp_etenders',$1,$2::jsonb,now(),now(),now()) on conflict(source_key) do update set fingerprint=excluded.fingerprint,state=excluded.state,last_seen_at=now(),updated_at=now()`,
    [fileHash, JSON.stringify({ source: 'ogp_etenders', mode: MODE, rows: rows.length, start, end, staged, unchanged, headers })]);
  console.log(JSON.stringify({ mode: MODE, rows: rows.length, start, end, staged, unchanged, headers }, null, 2));
} catch (error) {
  await setJob(client, `procurement-ogp-${MODE}`, { failed_at: new Date().toISOString() }, 'failed', String(error).slice(0, 500)).catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
