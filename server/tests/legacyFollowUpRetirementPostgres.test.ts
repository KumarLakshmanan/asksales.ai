import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
// @ts-expect-error The custom migration runner loads JavaScript migrations.
const migration = await import('../migrations/318_retire_legacy_follow_up_enrollments.js');
const local = process.env.FOLLOW_UP_RETIREMENT_LOCAL_QA === '1' ? describe : describe.skip;
local('legacy follow-up retirement in an isolated local schema', () => {
  let admin: Pool, fixture: Pool, schema: string;
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true, quiet: true });
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('Only local PostgreSQL is allowed.');
    const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT || 5432),database:process.env.DB_NAME || process.env.DB_DATABASE,user:process.env.DB_USER,password:process.env.DB_PASSWORD || '',max:1,connectionTimeoutMillis:5000};
    schema=`follow_up_retirement_${randomBytes(8).toString('hex')}`;
    admin=new Pool({...connection,options:'-c search_path=pg_catalog'});
    await admin.query(`CREATE SCHEMA ${schema}`);
    fixture=new Pool({...connection,options:`-c search_path=${schema},pg_catalog`});
    await fixture.query(`CREATE TABLE message_sequences(id integer PRIMARY KEY,user_id integer,business_profile_id integer,name text,is_active boolean,updated_at timestamp);
      CREATE TABLE sequence_executions(id integer PRIMARY KEY,sequence_id integer,user_id integer,business_profile_id integer,status text,next_scheduled_at timestamp,paused_at timestamp,updated_at timestamp,metadata jsonb);
      CREATE TABLE outreach_jobs(id integer PRIMARY KEY,user_id integer,business_profile_id integer,status text,error text,updated_at timestamp,metadata jsonb);
      CREATE TABLE followup_sequences(id integer PRIMARY KEY,completed boolean,updated_at timestamp);
      INSERT INTO message_sequences VALUES(1,9,101,'Agent Follow-Up: support_followup',true,NOW()),(2,9,102,'Customer configured sequence',true,NOW());
      INSERT INTO sequence_executions VALUES(1,1,9,101,'active',NOW(),NULL,NOW(),'{"type":"support_followup"}'),
        (2,2,9,102,'active',NOW(),NULL,NOW(),'{}'),(3,1,9,101,'completed',NULL,NULL,NOW(),'{}');
      INSERT INTO outreach_jobs VALUES(1,9,101,'pending',NULL,NOW(),'{"sequenceExecutionId":1}'),
        (2,9,102,'pending',NULL,NOW(),'{"sequenceExecutionId":1}'),(3,9,101,'sent',NULL,NOW(),'{"sequenceExecutionId":1}'),
        (4,9,101,'processing',NULL,NOW(),'{"sequenceExecutionId":1}');
      INSERT INTO followup_sequences VALUES(1,false,NOW()),(2,true,NOW());`);
    await fixture.query('BEGIN');
    try { await migration.up(fixture); await fixture.query('COMMIT'); }
    catch(error) { await fixture.query('ROLLBACK'); throw error; }
  },30000);
  afterAll(async () => {
    await fixture?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });
  it('pauses unsupported agent enrollments without changing finished or configured sequences', async () => {
    const result=await fixture.query('SELECT id,status,next_scheduled_at,metadata FROM sequence_executions ORDER BY id');
    expect(result.rows[0]).toMatchObject({id:1,status:'paused',next_scheduled_at:null,metadata:{pauseReason:'legacy_follow_up_requires_review',type:'support_followup'}});
    expect(result.rows[1].status).toBe('active'); expect(result.rows[2].status).toBe('completed');
    expect((await fixture.query('SELECT is_active FROM message_sequences ORDER BY id')).rows).toEqual([{is_active:false},{is_active:true}]);
  });
  it('cancels only matching unsent jobs, retaining ambiguous in-flight and sent receipts', async () => {
    const result=await fixture.query('SELECT id,status,metadata FROM outreach_jobs ORDER BY id');
    expect(result.rows[0]).toMatchObject({id:1,status:'cancelled',metadata:{needsReview:true,sequenceExecutionId:1}});
    expect(result.rows.slice(1).map(row => row.status)).toEqual(['pending','sent','processing']);
  });
  it('retains legacy email history as review-required without pretending it completed', async () => {
    const result=await fixture.query('SELECT id,completed,retirement_state,retired_at FROM followup_sequences ORDER BY id');
    expect(result.rows[0]).toMatchObject({id:1,completed:false,retirement_state:'needs_review'});
    expect(result.rows[0].retired_at).not.toBeNull(); expect(result.rows[1].retirement_state).toBeNull();
  });
  it('is idempotent and rollback never reactivates customer sends', async () => {
    await fixture.query('BEGIN');
    try { await migration.up(fixture); await migration.down(fixture); await fixture.query('COMMIT'); }
    catch(error) { await fixture.query('ROLLBACK'); throw error; }
    expect((await fixture.query('SELECT status FROM sequence_executions WHERE id=1')).rows[0].status).toBe('paused');
    expect((await fixture.query('SELECT status FROM outreach_jobs WHERE id=1')).rows[0].status).toBe('cancelled');
    expect((await fixture.query("SELECT current_setting('app.business_system',true) AS value")).rows[0].value).not.toBe('on');
  });
});
