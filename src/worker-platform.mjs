import crypto from 'node:crypto';

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

export function retryableReason(reason) {
  const value = String(reason || '');
  if (value === 'fetch_error' || value === 'timeout' || value === 'network_error') return true;
  const match = value.match(/^http_(\d{3})$/);
  return Boolean(match && RETRYABLE_HTTP.has(Number(match[1])));
}

export function parseStatusCode(reason) {
  const match = String(reason || '').match(/^http_(\d{3})$/);
  return match ? Number(match[1]) : null;
}

export async function readSourcePolicy(client, sourceFamily, authority, baseDelayMs = 500) {
  const sourceKey = `health:${sourceFamily}:${authority || 'global'}`;
  const { rows } = await client.query('select state from source_state where source_key=$1', [sourceKey]);
  const state = rows[0]?.state || {};
  const consecutiveFailures = Number(state.consecutive_failures || 0);
  const recent429 = Number(state.http_429 || 0);
  const recentSuccess = Number(state.successes || 0);
  const observed = recent429 + recentSuccess;
  const throttleRatio = observed > 0 ? recent429 / observed : 0;
  const multiplier = Math.min(8, Math.max(1, 1 + consecutiveFailures + Math.round(throttleRatio * 4)));
  return {
    sourceKey,
    delayMs: Math.min(30_000, Math.max(baseDelayMs, Math.round(baseDelayMs * multiplier))),
    consecutiveFailures,
    throttleRatio,
  };
}

export async function recordSourceOutcome(client, { sourceFamily, authority, ok, reason = null, latencyMs = null }) {
  const sourceKey = `health:${sourceFamily}:${authority || 'global'}`;
  const { rows } = await client.query('select state from source_state where source_key=$1', [sourceKey]);
  const previous = rows[0]?.state || {};
  const statusCode = parseStatusCode(reason);
  const totalLatency = Number(previous.total_latency_ms || 0) + (Number.isFinite(latencyMs) ? Number(latencyMs) : 0);
  const latencySamples = Number(previous.latency_samples || 0) + (Number.isFinite(latencyMs) ? 1 : 0);
  const state = {
    ...previous,
    successes: Number(previous.successes || 0) + (ok ? 1 : 0),
    failures: Number(previous.failures || 0) + (ok ? 0 : 1),
    consecutive_failures: ok ? 0 : Number(previous.consecutive_failures || 0) + 1,
    http_429: Number(previous.http_429 || 0) + (statusCode === 429 ? 1 : 0),
    total_latency_ms: totalLatency,
    latency_samples: latencySamples,
    average_latency_ms: latencySamples ? Math.round(totalLatency / latencySamples) : null,
    last_reason: reason || null,
    last_ok_at: ok ? new Date().toISOString() : previous.last_ok_at || null,
    last_failure_at: ok ? previous.last_failure_at || null : new Date().toISOString(),
  };
  await client.query(`
    insert into source_state(source_key,fingerprint,state,first_seen_at,last_seen_at,updated_at)
    values($1,'health-v1',$2::jsonb,now(),now(),now())
    on conflict(source_key) do update set state=excluded.state,last_seen_at=now(),updated_at=now()
  `, [sourceKey, JSON.stringify(state)]);
  return state;
}

export async function storeSourceFingerprint(client, sourceKey, payload, state = {}) {
  const fingerprint = stableFingerprint(payload);
  const { rows } = await client.query('select fingerprint,state from source_state where source_key=$1', [sourceKey]);
  const previous = rows[0] || null;
  await client.query(`
    insert into source_state(source_key,fingerprint,state,first_seen_at,last_seen_at,updated_at)
    values($1,$2,$3::jsonb,now(),now(),now())
    on conflict(source_key) do update set fingerprint=excluded.fingerprint,state=excluded.state,last_seen_at=now(),updated_at=now()
  `, [sourceKey, fingerprint, JSON.stringify(state)]);
  return { changed: !previous || previous.fingerprint !== fingerprint, fingerprint, previousState: previous?.state || null };
}

export async function deferOrDeadLetter(client, item, error, { maxAttempts = 8, baseMinutes = 5 } = {}) {
  const attempts = Math.max(1, Number(item.attempts || 0));
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  if (attempts >= maxAttempts) {
    await client.query(`
      update work_items set status='failed',last_error=$2,completed_at=now(),updated_at=now() where id=$1
    `, [item.id, `dead_letter:${message}`]);
    return { deadLettered: true, delayMinutes: null };
  }
  const delayMinutes = Math.min(360, Math.round(baseMinutes * (2 ** Math.min(attempts - 1, 6))));
  await client.query(`
    update work_items
    set status='pending',result=null,available_at=now()+($2 || ' minutes')::interval,last_error=$3,completed_at=null,updated_at=now()
    where id=$1
  `, [item.id, String(delayMinutes), `retryable:${message}`]);
  return { deadLettered: false, delayMinutes };
}

export async function recoverStaleLeases(client, minutes = 120) {
  const { rowCount } = await client.query(`
    update work_items
    set status='pending',available_at=now(),last_error=coalesce(last_error,'') || ' | recovered_stale_lease',updated_at=now()
    where status='running' and applied_at is null and leased_at < now()-($1 || ' minutes')::interval
  `, [String(minutes)]);
  return rowCount || 0;
}

export async function getCampaignCursor(client, jobKey, fallback = {}) {
  const { rows } = await client.query('select cursor from worker_jobs where job_key=$1', [jobKey]);
  return rows[0]?.cursor || fallback;
}

export async function saveCampaignCursor(client, jobKey, cursor, status = 'ok', error = null) {
  await client.query(`
    insert into worker_jobs(job_key,cursor,last_started_at,last_completed_at,last_status,last_error,updated_at)
    values($1,$2::jsonb,now(),now(),$3,$4,now())
    on conflict(job_key) do update set cursor=excluded.cursor,last_completed_at=now(),last_status=excluded.last_status,last_error=excluded.last_error,updated_at=now()
  `, [jobKey, JSON.stringify(cursor), status, error ? String(error).slice(0, 1000) : null]);
}
