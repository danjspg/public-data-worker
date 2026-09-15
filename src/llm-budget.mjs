const DEFAULT_DAILY_LIMIT = 2300000;

function londonDayKey(date=new Date()) {
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(date);
  const get=(type)=>parts.find(p=>p.type===type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function reserveLlmTokens(client, {
  estimatedTokens,
  dailyLimit=Number(process.env.OPENLIST_LLM_DAILY_TOKEN_LIMIT || DEFAULT_DAILY_LIMIT),
  workload='unknown'
}) {
  const estimate=Math.max(1,Math.ceil(Number(estimatedTokens)||0));
  const limit=Math.max(1000,Math.floor(Number(dailyLimit)||DEFAULT_DAILY_LIMIT));
  const day=londonDayKey();

  await client.query(`
    insert into work_items(job_type,work_key,input,result,status,attempts,available_at,completed_at,updated_at)
    values(
      'llm_daily_budget',$1,
      jsonb_build_object('day',$1::text,'timezone','Europe/London'),
      jsonb_build_object('limit_tokens',$2::bigint,'reserved_tokens',0,'actual_tokens',0,'calls',0),
      'completed',0,now(),now(),now()
    )
    on conflict(job_type,work_key) do nothing
  `,[day,limit]);

  const {rows}=await client.query(`
    update work_items
    set result=jsonb_set(
          jsonb_set(result,'{reserved_tokens}',
            to_jsonb(coalesce((result->>'reserved_tokens')::bigint,0)+$2::bigint),true),
          '{last_workload}',to_jsonb($4::text),true
        ),
        updated_at=now()
    where job_type='llm_daily_budget'
      and work_key=$1::text
      and (
        coalesce((result->>'actual_tokens')::bigint,0)
        + coalesce((result->>'reserved_tokens')::bigint,0)
        + $2::bigint
      ) <= $3::bigint
    returning
      coalesce((result->>'actual_tokens')::bigint,0) as actual_tokens,
      coalesce((result->>'reserved_tokens')::bigint,0) as reserved_tokens,
      coalesce((result->>'limit_tokens')::bigint,$3::bigint) as limit_tokens
  `,[day,estimate,limit,workload]);

  if(!rows.length) {
    const {rows:state}=await client.query(`
      select result from work_items
      where job_type='llm_daily_budget' and work_key=$1::text
    `,[day]);
    return {ok:false,day,estimated_tokens:estimate,state:state[0]?.result||null};
  }
  return {ok:true,day,estimated_tokens:estimate,...rows[0]};
}

export async function settleLlmTokens(client, reservation, actualTokens) {
  if(!reservation?.ok) return;
  const actual=Math.max(0,Math.ceil(Number(actualTokens)||0));
  await client.query(`
    update work_items
    set result=jsonb_set(
          jsonb_set(
            jsonb_set(result,'{reserved_tokens}',
              to_jsonb(greatest(0,coalesce((result->>'reserved_tokens')::bigint,0)-$2::bigint)),true),
            '{actual_tokens}',
              to_jsonb(coalesce((result->>'actual_tokens')::bigint,0)+$3::bigint),true),
          '{calls}',
            to_jsonb(coalesce((result->>'calls')::bigint,0)+1),true),
        updated_at=now()
    where job_type='llm_daily_budget' and work_key=$1::text
  `,[reservation.day,reservation.estimated_tokens,actual]);
}

export async function releaseLlmReservation(client, reservation) {
  if(!reservation?.ok) return;
  await client.query(`
    update work_items
    set result=jsonb_set(
          result,'{reserved_tokens}',
          to_jsonb(greatest(0,coalesce((result->>'reserved_tokens')::bigint,0)-$2::bigint)),true
        ),
        updated_at=now()
    where job_type='llm_daily_budget' and work_key=$1::text
  `,[reservation.day,reservation.estimated_tokens]);
}

export async function readLlmBudget(client, day=londonDayKey()) {
  const {rows}=await client.query(`
    select result from work_items
    where job_type='llm_daily_budget' and work_key=$1::text
  `,[day]);
  return {day,...(rows[0]?.result||{limit_tokens:DEFAULT_DAILY_LIMIT,reserved_tokens:0,actual_tokens:0,calls:0})};
}
