// Catch-up-only Agile v2 worker. Live API traffic is deliberately disabled while Agile blocks access.
// Reads staged work item identifiers; no changes to existing active ingestion or production apply pipeline.
import pg from "pg";

export const AUTHORITY_CODES = Object.freeze(["CORKCITY","DUBLINCITY","FINGAL","WEXFORD","DLR","CORKCOCO","SOUTHDUBLIN"]);
export const BOT_USER_AGENT = "openlist-bot/2.0 (+https://openlist.ie/bot; contact@openlist.ie)";
export const DEFAULT_LIMIT = 5;
export const MIN_DELAY_MS = 120_000;

export function planCatchup(rows, {limit = DEFAULT_LIMIT, authority} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_LIMIT) throw Error("Catch-up limit must be 1..5");
  if (authority && !AUTHORITY_CODES.includes(authority)) throw Error("Unknown authority");
  const seen = new Set();
  return rows.filter(row => {
    const code = row.input?.local_authority_code;
    const ref = row.input?.reference;
    const key = `${code}:${ref}`;
    if (!AUTHORITY_CODES.includes(code) || !ref || (authority && authority !== code) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0,limit).map(row => ({id:row.id,authority:row.input.local_authority_code,reference:row.input.reference}));
}

export async function runCatchup({env = process.env, connect = async url => {
  const db = new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false}});
  await db.connect();return db;
}} = {}) {
  // Deliberate hard stop. Do not remove in order to test whether the upstream block persists.
  if (env.AGILE_ACCESS_BLOCKED !== "false" || env.AGILE_V2_ACCESS_AUTHORISED !== "true") {
    return {status:"blocked",reason:"Agile access restriction remains in force",requested:0};
  }
  // No live transport has been wired: integration requires verified robots policy, durable cache,
  // shared daily request accounting, and explicit upstream authorisation.
  if (env.AGILE_V2_LIVE_ENABLED !== "true") {
    return {status:"dry_run_only",requested:0};
  }
  throw Error("Agile v2 live transport is not configured; refusing network requests");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runCatchup();
  console.log(JSON.stringify({...result,worker:"agile-v2-catchup",userAgent:BOT_USER_AGENT}));
}
