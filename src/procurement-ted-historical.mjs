import pg from 'pg'
import { TED_SEARCH_URL, fetchJson, normalizeTedNotice, sha256 } from './procurement-common.mjs'

const { Client } = pg
const connectionString = process.env.WORKER_DATABASE_URL
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required')

const PAGE_LIMIT = Math.max(50, Math.min(Number(process.env.TED_HISTORICAL_PAGE_LIMIT || 250), 250))
const MAX_PAGES_PER_WINDOW = Math.max(1, Math.min(Number(process.env.TED_HISTORICAL_MAX_PAGES_PER_WINDOW || 20), 50))
const PAUSE_MS = Math.max(0, Math.min(Number(process.env.TED_HISTORICAL_PAUSE_MS || 350), 5000))
const RESET_CURSOR = String(process.env.TED_HISTORICAL_RESET_CURSOR || '').toLowerCase() === 'true'
const JOB_KEY = 'procurement_ted_historical_24m_v1'
const NORMALIZATION_VERSION = 'ted-v2-historical-compact-v1'

const fields = [
  'publication-number','publication-date','notice-title','notice-type','procedure-identifier',
  'buyer-name','buyer-identifier','buyer-country','contract-nature','classification-cpv','deadline',
  'description-proc','estimated-value-proc','estimated-value-cur-proc','total-value','total-value-cur',
  'winner-name','winner-identifier','winner-decision-date','contract-conclusion-date','place-of-performance'
]

const sleep = (ms) => ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
const ymd = (date) => date.toISOString().slice(0, 10).replaceAll('-', '')
const isoDay = (date) => date.toISOString().slice(0, 10)

function parseDate(value, fallback) {
  if (!value) return fallback
  const d = new Date(String(value) + (String(value).length === 10 ? 'T00:00:00Z' : ''))
  if (!Number.isFinite(d.getTime())) throw new Error(`Invalid date: ${value}`)
  return d
}
function addMonths(date, months) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  d.setUTCMonth(d.getUTCMonth() + months)
  return d
}
function addDays(date, days) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}
function minDate(a, b) { return a < b ? a : b }
function defaultStart() {
  const d = new Date()
  d.setUTCHours(0,0,0,0)
  d.setUTCMonth(d.getUTCMonth() - 24)
  return d
}
function defaultEnd() {
  const d = new Date()
  d.setUTCHours(0,0,0,0)
  d.setUTCMonth(d.getUTCMonth() - 6)
  return d
}
function compactRaw(raw) {
  const keys = [
    'publication-number',
    'publication-date',
    'notice-type',
    'procedure-identifier',
    'buyer-country',
  ]
  return {
    _historical_compact: true,
    ...Object.fromEntries(keys.flatMap((key) => raw?.[key] == null ? [] : [[key, raw[key]]])),
  }
}
async function setJob(client, cursor, status, error = null, summary = null) {
  await client.query(`
    insert into worker_jobs(job_key,cursor,last_started_at,last_completed_at,last_status,last_error,updated_at)
    values($1,$2::jsonb,now(),case when $3 in ('ready','idle','failed') then now() else null end,$3,$4,now())
    on conflict(job_key) do update set
      cursor=excluded.cursor,
      last_started_at=excluded.last_started_at,
      last_completed_at=coalesce(excluded.last_completed_at,worker_jobs.last_completed_at),
      last_status=excluded.last_status,
      last_error=excluded.last_error,
      updated_at=now()
  `, [JOB_KEY, JSON.stringify({ ...cursor, summary }), status, error])
}
async function stageBatch(client, records, windowStart, windowEnd) {
  if (!records.length) return { staged: 0, changed: 0 }
  const keys = []
  const inputs = []
  const results = []
  for (const record of records) {
    keys.push(record.source_record_key)
    inputs.push(JSON.stringify({
      source: record.source,
      source_record_key: record.source_record_key,
      queue_source: 'ted-historical-24m',
      historical_window_start: windowStart,
      historical_window_end: windowEnd,
    }))
    results.push(JSON.stringify(record))
  }
  const { rows } = await client.query(`
    with incoming as (
      select *
      from unnest($1::text[],$2::text[],$3::text[]) as x(work_key,input_text,result_text)
    ),
    upserted as (
      insert into work_items(job_type,work_key,input,result,status,completed_at,updated_at)
      select 'procurement_ted_notice',work_key,input_text::jsonb,result_text::jsonb,'completed',now(),now()
      from incoming
      on conflict(job_type,work_key) do update set
        input=excluded.input,
        result=excluded.result,
        status='completed',
        completed_at=now(),
        applied_at=case when work_items.result is distinct from excluded.result then null else work_items.applied_at end,
        last_error=null,
        updated_at=now()
      returning (xmax = 0) as inserted
    )
    select count(*)::int as staged,
           count(*) filter(where inserted)::int as inserted
    from upserted
  `, [keys, inputs, results])
  return { staged: rows[0]?.staged || 0, changed: rows[0]?.inserted || 0 }
}

const requestedStart = parseDate(process.env.TED_HISTORICAL_START_DATE, defaultStart())
const requestedEnd = parseDate(process.env.TED_HISTORICAL_END_DATE, defaultEnd())
if (requestedStart > requestedEnd) throw new Error('TED historical start date must be before end date')

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } })
await client.connect()

let totalSeen = 0
let totalStaged = 0
let totalPages = 0
let windowsCompleted = 0

try {
  const existing = await client.query('select cursor,last_status from worker_jobs where job_key=$1', [JOB_KEY])
  const savedCursor = existing.rows[0]?.cursor || {}
  let cursorStart = requestedStart
  if (!RESET_CURSOR && savedCursor.next_start) {
    const saved = parseDate(savedCursor.next_start, requestedStart)
    if (saved > cursorStart) cursorStart = saved
  }

  await setJob(client, {
    requested_start: isoDay(requestedStart),
    requested_end: isoDay(requestedEnd),
    next_start: isoDay(cursorStart),
    normalization: NORMALIZATION_VERSION,
  }, 'running')

  for (let windowStart = cursorStart; windowStart <= requestedEnd;) {
    const nextMonth = addMonths(windowStart, 1)
    const naturalEnd = addDays(nextMonth, -1)
    const windowEnd = minDate(naturalEnd, requestedEnd)
    const startDay = isoDay(windowStart)
    const endDay = isoDay(windowEnd)
    const query = `buyer-country=IRL AND publication-date=(${ymd(windowStart)} <> ${ymd(windowEnd)})`

    let token = null
    let windowSeen = 0
    let windowStaged = 0
    let pages = 0
    do {
      const body = {
        query,
        fields,
        limit: PAGE_LIMIT,
        scope: 'ALL',
        checkQuerySyntax: false,
        paginationMode: 'ITERATION',
        onlyLatestVersions: false,
      }
      if (token) body.iterationNextToken = token
      const payload = await fetchJson(TED_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      }, 90000)
      if (payload?.timedOut) throw new Error(`TED search timed out for ${startDay}..${endDay}`)
      const notices = Array.isArray(payload?.notices) ? payload.notices : []
      pages += 1
      totalPages += 1
      windowSeen += notices.length
      totalSeen += notices.length

      if (notices.length) {
        const records = [...new Map(notices.map((raw) => {
          const record = normalizeTedNotice(raw)
          record.raw_source = compactRaw(raw)
          record.source_hash = sha256({ normalization: NORMALIZATION_VERSION, raw: record.raw_source })
          return [record.source_record_key, record]
        })).values()]
        const staged = await stageBatch(client, records, startDay, endDay)
        windowStaged += staged.staged
        totalStaged += staged.staged
      }

      token = payload?.iterationNextToken || null
      if (!token || notices.length < PAGE_LIMIT) break
      if (pages >= MAX_PAGES_PER_WINDOW) {
        throw new Error(`TED historical window ${startDay}..${endDay} exceeded ${MAX_PAGES_PER_WINDOW} pages; split the window before retrying`)
      }
      await sleep(PAUSE_MS)
    } while (token)

    windowsCompleted += 1
    const nextStart = addDays(windowEnd, 1)
    const cursor = {
      requested_start: isoDay(requestedStart),
      requested_end: isoDay(requestedEnd),
      next_start: isoDay(nextStart),
      last_window_start: startDay,
      last_window_end: endDay,
      normalization: NORMALIZATION_VERSION,
    }
    await setJob(client, cursor, nextStart > requestedEnd ? 'ready' : 'running', null, {
      windows_completed: windowsCompleted,
      pages: totalPages,
      seen: totalSeen,
      staged: totalStaged,
      last_window_seen: windowSeen,
      last_window_staged: windowStaged,
    })
    console.log(JSON.stringify({ window: [startDay,endDay], pages, seen: windowSeen, staged: windowStaged, next_start: isoDay(nextStart) }))
    windowStart = nextStart
    await sleep(PAUSE_MS)
  }

  await client.query(`
    insert into source_state(source_key,fingerprint,state,first_seen_at,last_seen_at,updated_at)
    values($1,$2,$3::jsonb,now(),now(),now())
    on conflict(source_key) do update set fingerprint=excluded.fingerprint,state=excluded.state,last_seen_at=now(),updated_at=now()
  `, [
    'procurement:ted:historical-24m',
    NORMALIZATION_VERSION,
    JSON.stringify({
      status: 'ready',
      requested_start: isoDay(requestedStart),
      requested_end: isoDay(requestedEnd),
      windows_completed: windowsCompleted,
      pages: totalPages,
      seen: totalSeen,
      staged: totalStaged,
      normalization: NORMALIZATION_VERSION,
    }),
  ])
  console.log(JSON.stringify({
    ok: true,
    requested_start: isoDay(requestedStart),
    requested_end: isoDay(requestedEnd),
    windows_completed: windowsCompleted,
    pages: totalPages,
    seen: totalSeen,
    staged: totalStaged,
    normalization: NORMALIZATION_VERSION,
  }, null, 2))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const existing = await client.query('select cursor from worker_jobs where job_key=$1', [JOB_KEY]).catch(() => ({ rows: [] }))
  await setJob(client, existing.rows[0]?.cursor || {
    requested_start: isoDay(requestedStart),
    requested_end: isoDay(requestedEnd),
    next_start: isoDay(requestedStart),
  }, 'failed', message.slice(0, 1000), {
    windows_completed: windowsCompleted,
    pages: totalPages,
    seen: totalSeen,
    staged: totalStaged,
  }).catch(() => {})
  throw error
} finally {
  await client.end().catch(() => {})
}
