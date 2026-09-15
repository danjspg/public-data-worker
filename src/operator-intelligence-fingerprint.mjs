import pg from 'pg';
import { createHash } from 'node:crypto';

const { Client } = pg;
const WORKER_DATABASE_URL = process.env.WORKER_DATABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const MODEL = process.env.OPERATOR_FINGERPRINT_MODEL || 'gpt-5.6-luna';
const VERSION = 'operator-fingerprint-v1';
const LIMIT = Math.max(1, Math.min(Number(process.env.OPERATOR_FINGERPRINT_LIMIT || 50), 250));
const YEARS = Math.max(1, Math.min(Number(process.env.OPERATOR_FINGERPRINT_YEARS || 8), 15));
const DRY_RUN = process.env.OPERATOR_FINGERPRINT_DRY_RUN === 'true';
const BRAND_RE = /\b(lidl|aldi|tesco|dunnes|supervalu|centra|spar|mcdonald'?s?|burger king|circle k|applegreen)\b/i;
const SUPERMARKET_RE = /\b(supermarket|foodstore|food store|discount food|grocery|off[- ]licen[cs]e|trolley bay)\b/i;
const compact = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

const schema = {type:'object',additionalProperties:false,properties:{development_format:{type:['string','null']},features:{type:'object',additionalProperties:false,properties:{gross_floor_area_sqm:{type:['number','null']},net_sales_area_sqm:{type:['number','null']},site_area_ha:{type:['number','null']},parking_spaces:{type:['integer','null']},ev_charging:{type:['boolean','null']},pv_solar:{type:['boolean','null']},trolley_bays:{type:['boolean','null']},off_licence:{type:['boolean','null']},drive_through:{type:['boolean','null']},substation:{type:['boolean','null']},demolition_replacement:{type:['boolean','null']},extension:{type:['boolean','null']},signage:{type:['boolean','null']},servicing_delivery:{type:['boolean','null']},distinctive_terms:{type:'array',items:{type:'string'},maxItems:12}},required:['gross_floor_area_sqm','net_sales_area_sqm','site_area_ha','parking_spaces','ev_charging','pv_solar','trolley_bays','off_licence','drive_through','substation','demolition_replacement','extension','signage','servicing_delivery','distinctive_terms']},evidence:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,properties:{signal:{type:'string'},value:{type:'string'},source_field:{type:'string'}},required:['signal','value','source_field']}}},required:['development_format','features','evidence']};

async function extract(input) {
  const response = await fetch('https://api.openai.com/v1/responses', {method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,store:false,instructions:'Extract a durable commercial development fingerprint from this Irish planning record. Do not infer or guess the operator. Ignore brand/company identity when describing the fingerprint. Only return features directly supported by the supplied fields. Keep distinctive_terms short and useful for comparing development formats.',input:JSON.stringify(input),text:{format:{type:'json_schema',name:'operator_fingerprint',strict:true,schema}}}),signal:AbortSignal.timeout(90000)});
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
  const json = await response.json();
  const text = json.output?.flatMap((o)=>o.content||[]).find((c)=>c.type==='output_text')?.text;
  if (!text) throw new Error('No model output');
  return JSON.parse(text);
}

const db = new Client({connectionString:WORKER_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
try {
  await db.query(`create table if not exists public.operator_intelligence_fingerprints (
    application_key text primary key,
    reference text,
    local_authority_code text,
    registration_date date,
    explicit_operators text[] not null default '{}',
    ground_truth_operator text,
    ground_truth_source text,
    development_format text,
    features jsonb not null default '{}'::jsonb,
    evidence jsonb not null default '[]'::jsonb,
    inference_candidates jsonb not null default '[]'::jsonb,
    inference_confidence text,
    model text,
    fingerprint_version text not null default 'operator-fingerprint-v1',
    input_hash text,
    processed_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await db.query('create index if not exists operator_intelligence_fingerprints_ground_truth_idx on public.operator_intelligence_fingerprints (ground_truth_operator)');

  const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - YEARS);
  const { rows } = await db.query(`select * from public.planning_worker_items where coalesce(registration_date, discovered_at::date) >= $1 order by coalesce(registration_date, discovered_at::date) desc limit 10000`, [cutoff.toISOString().slice(0,10)]);
  const candidates = rows.filter((a)=>SUPERMARKET_RE.test(`${a.proposal||a.development_description||''} ${a.location||a.development_address||''}`)||BRAND_RE.test(`${a.proposal||a.development_description||''} ${a.location||a.development_address||''} ${a.applicant_name||a.applicant||''}`)).slice(0,LIMIT);
  let processed=0, skipped=0, failed=0;
  for (const app of candidates) {
    const proposal=app.proposal||app.development_description||'';
    const location=app.location||app.development_address||'';
    const applicant=app.applicant_name||app.applicant||'';
    const identityText=`${proposal} ${location} ${applicant}`;
    const explicit=(identityText.match(new RegExp(BRAND_RE.source,'ig'))||[]).map((x)=>x.toLowerCase());
    const packet={reference:app.reference||app.application_reference,local_authority_code:app.local_authority_code||app.authority_code,proposal:compact(proposal),location:compact(location),applicant_name:compact(applicant),agent_name:compact(app.agent_name||app.agent),application_type:app.application_type,status:app.status,decision_text:compact(app.decision_text||app.decision)};
    const applicationKey=String(app.id||app.application_id||`${packet.local_authority_code}:${packet.reference}`);
    const inputHash=hash(packet);
    const existing=await db.query('select input_hash,fingerprint_version from public.operator_intelligence_fingerprints where application_key=$1',[applicationKey]);
    if(existing.rows[0]?.input_hash===inputHash&&existing.rows[0]?.fingerprint_version===VERSION){skipped++;continue;}
    try {
      const result=await extract(packet);
      if(!DRY_RUN){const groundTruth=explicit[0]||null;await db.query(`insert into public.operator_intelligence_fingerprints (application_key,reference,local_authority_code,registration_date,explicit_operators,ground_truth_operator,ground_truth_source,development_format,features,evidence,inference_candidates,inference_confidence,model,fingerprint_version,input_hash,processed_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]'::jsonb,null,$11,$12,$13,now(),now()) on conflict (application_key) do update set reference=excluded.reference,local_authority_code=excluded.local_authority_code,registration_date=excluded.registration_date,explicit_operators=excluded.explicit_operators,ground_truth_operator=excluded.ground_truth_operator,ground_truth_source=excluded.ground_truth_source,development_format=excluded.development_format,features=excluded.features,evidence=excluded.evidence,model=excluded.model,fingerprint_version=excluded.fingerprint_version,input_hash=excluded.input_hash,processed_at=now(),updated_at=now()`,[applicationKey,packet.reference,packet.local_authority_code,app.registration_date||null,[...new Set(explicit)],groundTruth,groundTruth?'explicit_record':null,result.development_format,JSON.stringify(result.features),JSON.stringify(result.evidence),MODEL,VERSION,inputHash]);}
      processed++;
    } catch(e){failed++;console.error(packet.reference,e instanceof Error?e.message:String(e));}
  }
  console.log(JSON.stringify({ok:failed===0,model:MODEL,version:VERSION,years:YEARS,candidates:candidates.length,processed,skipped,failed,dry_run:DRY_RUN},null,2));
  if(failed) process.exitCode=1;
} finally { await db.end(); }
