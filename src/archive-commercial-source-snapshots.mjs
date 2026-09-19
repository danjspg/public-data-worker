import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { gzipSync } from "node:zlib"
import { createHash } from "node:crypto"

const { Client } = pg
const workerUrl=process.env.WORKER_DATABASE_URL
const supabaseUrl=process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY
if(!workerUrl || !supabaseUrl || !serviceKey) throw new Error("WORKER_DATABASE_URL and Supabase credentials are required")

const BUCKET="commercial-source-snapshots"
const LIMIT=Math.max(1,Math.min(Number(process.env.SOURCE_SNAPSHOT_ARCHIVE_LIMIT||500),2000))
const db=new Client({connectionString:workerUrl,ssl:{rejectUnauthorized:false}})
const supabase=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}})

const safe=v=>String(v??"").toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,120)||"unknown"
const sha=v=>createHash("sha256").update(String(v)).digest("hex")

await db.connect()
let archived=0,duplicate=0,failed=0,bytesRaw=0,bytesGzip=0
try{
  const {rows}=await db.query(`
    select id,work_key,input,result
    from work_items
    where job_type='commercial_source_snapshot_archive'
      and status='completed'
      and applied_at is null
      and result ? 'snapshot'
    order by id
    limit $1
  `,[LIMIT])

  for(const item of rows){
    try{
      const input=item.input||{}
      const snapshot=item.result?.snapshot
      if(!snapshot) throw new Error("snapshot payload missing")
      const json=JSON.stringify(snapshot)
      const gz=gzipSync(Buffer.from(json,"utf8"),{level:9})
      bytesRaw+=Buffer.byteLength(json)
      bytesGzip+=gz.length

      const year=String(input.registration_date||snapshot?.canonical?.registration_date||"unknown").slice(0,4)
      const authority=safe(input.local_authority_code||snapshot.local_authority_code)
      const appKey=safe(input.application_id || sha(`${authority}:${input.reference||snapshot.reference||item.work_key}`).slice(0,24))
      const hash=safe(input.content_hash||item.result?.content_hash||sha(json))
      const version=safe(input.snapshot_version||snapshot.snapshot_version||"commercial-source-snapshot-v1")
      const path=`${version}/${authority}/${safe(year)}/${appKey}/${hash}.json.gz`

      const canonical=snapshot.canonical||{}
      const authoritative=snapshot.authoritative||{}
      const metadata={
        application_id:String(input.application_id||snapshot.application_id||""),
        reference:String(input.reference||snapshot.reference||""),
        local_authority_code:String(input.local_authority_code||snapshot.local_authority_code||""),
        source_kind:String(input.source_kind||snapshot.source_kind||""),
        content_hash:hash,
        snapshot_version:version,
        captured_at:String(snapshot.captured_at||""),
        has_agent:Boolean(canonical.agent_name),
        has_applicant:Boolean(canonical.applicant_name),
        has_decision:Boolean(canonical.decision_text||canonical.decision_date),
        has_source_status:Boolean(canonical.source_status),
        has_registration_source:Boolean(canonical.registration_date_source),
        has_authoritative_payload:Boolean(Object.keys(authoritative).length),
        proposal_length:String(canonical.proposal||"").length
      }
      const {error}=await supabase.storage.from(BUCKET).upload(path,gz,{
        contentType:"application/gzip",
        cacheControl:"31536000",
        upsert:false,
        metadata
      })
      if(error){
        const message=String(error.message||error)
        if(!/already exists|duplicate|asset already exists/i.test(message)) throw error
        duplicate++
      }else{
        archived++
      }

      await db.query(
        "delete from work_items where id=$1 and job_type='commercial_source_snapshot_archive'",
        [item.id]
      )
    }catch(error){
      failed++
      await db.query(`
        update work_items
        set last_error=$2,
            updated_at=now()
        where id=$1
      `,[item.id,String(error instanceof Error?error.message:error).slice(0,500)])
      console.error(item.work_key,error instanceof Error?error.message:String(error))
    }
  }

  console.log(JSON.stringify({
    ok:failed===0,
    selected:rows.length,
    archived,
    duplicate,
    failed,
    raw_bytes:bytesRaw,
    gzip_bytes:bytesGzip,
    compression_ratio:bytesRaw?Number((bytesGzip/bytesRaw).toFixed(3)):null,
    bucket:BUCKET
  },null,2))
  if(failed) process.exitCode=1
}finally{
  await db.end().catch(()=>{})
}
