import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueuePlanningCategorySweep, ZERO_CURSOR, CATEGORY_SWEEP_TYPE } from '../src/planning-category-sweep.mjs';

function fake({ complete = false, outstanding = null, after = ZERO_CURSOR, collision = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('select cursor,last_status')) return { rows: [{ cursor: { after, complete, scanned: 0 } }] };
      if (sql.includes('select id,status,attempts')) return { rows: outstanding ? [outstanding] : [] };
      if (sql.includes('returning id')) return { rows: collision ? [] : [{ id: 44 }] };
      return { rows: [] };
    }
  };
}

test('producer schedules only one bounded private-consumer tranche', async () => {
  const db = fake();
  const result = await enqueuePlanningCategorySweep(db);
  assert.equal(result.queued, true);
  assert.equal(result.recordsMax, 5000);
  const insert = db.calls.find(({ sql }) => sql.includes('insert into work_items'));
  assert.equal(insert.args[0], CATEGORY_SWEEP_TYPE);
  assert.deepEqual(JSON.parse(insert.args[2]), { after: ZERO_CURSOR, batchSize: 250, maxBatches: 20 });
  assert.ok(!db.calls.some(({ sql }) => /supabase|planning_applications|planning_seo_notable/i.test(sql)));
});

test('completed campaign cannot enqueue more work', async () => {
  const db = fake({ complete: true });
  assert.equal((await enqueuePlanningCategorySweep(db)).reason, 'complete');
  assert.ok(!db.calls.some(({ sql }) => sql.includes('insert into work_items')));
});

test('outstanding, even failed, work blocks new jobs', async () => {
  const db = fake({ outstanding: { id: 9, status: 'failed' } });
  assert.equal((await enqueuePlanningCategorySweep(db)).reason, 'outstanding');
  assert.ok(!db.calls.some(({ sql }) => sql.includes('insert into work_items')));
});

test('corrupt cursors fail closed', async () => {
  const db = fake({ after: 'corrupt' });
  await assert.rejects(enqueuePlanningCategorySweep(db), /Invalid persisted/);
  assert.ok(db.calls.some(({ sql }) => sql === 'rollback'));
});

test('duplicate cursor cannot silently advance a campaign', async () => {
  const db = fake({ collision: true });
  await assert.rejects(enqueuePlanningCategorySweep(db), /Duplicate category-corpus/);
});
