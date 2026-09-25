import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error('WORKER_DATABASE_URL is required');

const client = new Client({ connectionString, ssl:{ rejectUnauthorized:false } });
await client.connect();

try {
  const { rows: summaryRows } = await client.query(`
    select
      count(*) filter (where status='completed' and applied_at is null)::int as completed_waiting,
      count(*) filter (
        where status='completed' and applied_at is null
          and coalesce(nullif(btrim(result->>'proposal'),''),'') <> ''
      )::int as completed_with_proposal_waiting,
      count(*) filter (
        where status='completed' and applied_at is null
          and coalesce(nullif(btrim(result->>'proposal'),''),'') = ''
      )::int as completed_without_proposal_waiting,
      count(*) filter (where status='failed' and applied_at is null)::int as failed,
      count(*) filter (where status='pending' and applied_at is null)::int as pending,
      count(*) filter (where status='pending' and applied_at is null and available_at<=now())::int as pending_ready,
      count(*) filter (where status='pending' and applied_at is null and available_at>now())::int as pending_deferred
    from work_items
    where job_type='planning_description'
  `);

  const { rows: recentRows } = await client.query(`
    select
      count(*) filter (where completed_at>=now()-interval '60 minutes')::int as completed_last_60m,
      count(*) filter (
        where completed_at>=now()-interval '60 minutes'
          and coalesce(nullif(btrim(result->>'proposal'),''),'') <> ''
      )::int as with_proposal_last_60m,
      count(*) filter (where completed_at>=now()-interval '3 hours')::int as completed_last_3h,
      count(*) filter (
        where completed_at>=now()-interval '3 hours'
          and coalesce(nullif(btrim(result->>'proposal'),''),'') <> ''
      )::int as with_proposal_last_3h
    from work_items
    where job_type='planning_description'
      and status='completed'
  `);

  const { rows: pendingByAuthorityRows } = await client.query(`
    select
      coalesce(nullif(input->>'local_authority_code',''),'unknown') as authority,
      count(*)::int as pending,
      count(*) filter (where available_at<=now())::int as ready,
      count(*) filter (where available_at>now())::int as deferred
    from work_items
    where job_type='planning_description'
      and status='pending'
      and applied_at is null
    group by 1
    order by count(*) desc, authority
  `);

  const { rows: pendingReasonRows } = await client.query(`
    select
      coalesce(nullif(input->>'local_authority_code',''),'unknown') as authority,
      coalesce(nullif(last_error,''),'none') as reason,
      count(*)::int as count
    from work_items
    where job_type='planning_description'
      and status='pending'
      and applied_at is null
      and last_error is not null
    group by 1,2
    order by count(*) desc, authority, reason
    limit 50
  `);

  const { rows: failureRows } = await client.query(`
    select
      coalesce(nullif(input->>'local_authority_code',''),'unknown') as authority,
      coalesce(nullif(last_error,''),'unknown') as reason,
      count(*)::int as count
    from work_items
    where job_type='planning_description'
      and status='failed'
      and applied_at is null
    group by 1,2
    order by count(*) desc, authority, reason
    limit 50
  `);

  const { rows: professionalSummaryRows } = await client.query(`
    select
      count(*) filter (where status='completed' and applied_at is null)::int as completed_waiting,
      count(*) filter (
        where status='completed' and applied_at is null and result->>'ok'='true'
      )::int as source_resolved_waiting,
      count(*) filter (
        where status='completed' and applied_at is null
          and jsonb_typeof(result->'professionals')='array'
          and jsonb_array_length(result->'professionals')>0
      )::int as applications_with_professionals_waiting,
      coalesce(sum(
        case
          when status='completed' and applied_at is null and jsonb_typeof(result->'professionals')='array'
            then jsonb_array_length(result->'professionals')
          else 0
        end
      ),0)::int as professional_records_waiting,
      count(*) filter (
        where status='completed' and applied_at is null and result->>'reason'='no_agent'
      )::int as no_agent_waiting,
      count(*) filter (
        where status='completed' and applied_at is null and result->>'ok'='false'
      )::int as completed_negative_waiting,
      count(*) filter (where status='pending' and applied_at is null)::int as pending,
      count(*) filter (where status='running' and applied_at is null)::int as running,
      count(*) filter (where status='failed' and applied_at is null)::int as failed
    from work_items
    where job_type='planning_professional_backfill'
  `);

  const { rows: agentRecordRows } = await client.query(`
    select count(*)::int as agent_records_waiting
    from work_items w
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(w.result->'professionals')='array' then w.result->'professionals'
        else '[]'::jsonb
      end
    ) p(value)
    where w.job_type='planning_professional_backfill'
      and w.status='completed'
      and w.applied_at is null
      and p.value->>'role'='agent'
  `);

  const { rows: professionalsByAuthorityRows } = await client.query(`
    select
      coalesce(nullif(input->>'local_authority_code',''),'unknown') as authority,
      count(*) filter (where status='completed' and applied_at is null)::int as completed_waiting,
      count(*) filter (
        where status='completed' and applied_at is null
          and jsonb_typeof(result->'professionals')='array'
          and jsonb_array_length(result->'professionals')>0
      )::int as applications_with_professionals_waiting,
      count(*) filter (where status='pending' and applied_at is null)::int as pending
    from work_items
    where job_type='planning_professional_backfill'
    group by 1
    having count(*) filter (where applied_at is null) > 0
    order by applications_with_professionals_waiting desc, completed_waiting desc, authority
  `);

  console.log(JSON.stringify({
    capturedAt:new Date().toISOString(),
    summary:summaryRows[0] || null,
    recentThroughput:recentRows[0] || null,
    pendingByAuthority:pendingByAuthorityRows,
    pendingReasons:pendingReasonRows,
    failuresByAuthority:failureRows,
    professionals:{
      summary:{
        ...(professionalSummaryRows[0] || {}),
        agent_records_waiting:agentRecordRows[0]?.agent_records_waiting || 0,
      },
      byAuthority:professionalsByAuthorityRows,
    },
  },null,2));
} finally {
  await client.end().catch(()=>{});
}
