import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { gzipSync } from "node:zlib"

const { Client } = pg
const workerUrl=process.env.WORKER_DATABASE_URL
const supabaseUrl=process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY
if(!workerUrl || !supabaseUrl || !serviceKey) throw new Error("WORKER_DATABASE_URL and Supabase credentials are required")

const BUCKET="commercial-model-artifacts"
const LIMIT=Math.max(1,Math.min(Number(process.env.MODEL_ARTIFACT_ARCHIVE_LIMIT||1000),5000))
const db=new Client({connectionString:workerUrl,ssl:{rejectUnauthorized:false}})
const supabase=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}})
const safe=v=>String(v??"").toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,140)||"unknown"

await db.connect()
let archived=0,duplicate=0,failed=0,bytesRaw=0,bytesGzip=0
try{
  const {rows}=await db.query(`
    select id,work_key,input,result
    from work_items
    where job_type='commercial_model_artifact_archive'
      and status='completed'
      and applied_at is null
      and result ? 'artifact'
    order by id
    limit $1
  `,[LIMIT])

  for(const item of rows){
    try{
      const input=item.input||{}
      const artifact=item.result?.artifact
      if(!artifact) throw new Error("artifact payload missing")
      const json=JSON.stringify(artifact)
      const gz=gzipSync(Buffer.from(json,"utf8"),{level:9})
      bytesRaw+=Buffer.byteLength(json)
      bytesGzip+=gz.length

      const year=String(input.registration_date||artifact.registration_date||"unknown").slice(0,4)
      const authority=safe(input.local_authority_code||artifact.local_authority_code)
      const appKey=safe(input.application_id||artifact.application_id||input.reference||artifact.reference)
      const taxonomy=safe(input.taxonomy_version||artifact.taxonomy_version)
      const semantic=safe(input.semantic_version||artifact.semantic_version||"none")
      const model=safe(input.model||artifact.model)
      const version=safe(input.artifact_version||artifact.artifact_version||"commercial-model-artifact-v1")
      const runHash=safe(input.run_hash||item.result?.run_hash)
      const path=`${version}/${authority}/${safe(year)}/${appKey}/${taxonomy}/${semantic}/${model}/${runHash}.json.gz`

      const {error}=await supabase.storage.from(BUCKET).upload(path,gz,{
        contentType:"application/gzip",
        cacheControl:"31536000",
        upsert:false,
        metadata:{
          application_id:String(input.application_id||artifact.application_id||""),
          reference:String(input.reference||artifact.reference||""),
          local_authority_code:String(input.local_authority_code||artifact.local_authority_code||""),
          taxonomy_version:String(input.taxonomy_version||artifact.taxonomy_version||""),
          semantic_version:String(input.semantic_version||artifact.semantic_version||""),
          model:String(input.model||artifact.model||""),
          source_content_hash:String(input.source_content_hash||artifact.source_content_hash||""),
          run_hash:runHash,
          artifact_version:version,
          confidence:String(artifact.result?.confidence||""),
          opportunity_type:String(artifact.result?.opportunity_type||""),
          default_alert_eligible:Boolean(artifact.result?.default_alert_eligible),
          category_count:Array.isArray(artifact.result?.commercial_categories)?artifact.result.commercial_categories.length:0,
          operator_count:Array.isArray(artifact.result?.operators)?artifact.result.operators.length:0,
          commercial_relevance:String(artifact.result?.commercial_relevance||"")
        }
      })
      if(error){
        const message=String(error.message||error)
        if(!/already exists|duplicate|asset already exists/i.test(message)) throw error
        duplicate++
      }else archived++

      await db.query(
        "delete from work_items where id=$1 and job_type='commercial_model_artifact_archive'",
        [item.id]
      )
    }catch(error){
      failed++
      await db.query("update work_items set last_error=$2,updated_at=now() where id=$1",[
        item.id,String(error instanceof Error?error.message:error).slice(0,500)
      ])
      console.error(item.work_key,error instanceof Error?error.message:String(error))
    }
  }

  console.log(JSON.stringify({
    ok:failed===0,selected:rows.length,archived,duplicate,failed,
    raw_bytes:bytesRaw,gzip_bytes:bytesGzip,
    compression_ratio:bytesRaw?Number((bytesGzip/bytesRaw).toFixed(3)):null,
    bucket:BUCKET
  },null,2))
  if(failed) process.exitCode=1
}finally{await db.end().catch(()=>{})}
