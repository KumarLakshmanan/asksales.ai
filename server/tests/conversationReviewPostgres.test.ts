import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const connectionString = process.env.CONVERSATION_REVIEW_QA_DATABASE_URL;
const postgres = connectionString ? describe : describe.skip;
const schema = `conversation_review_qa_${process.pid}_${Date.now()}`;
let admin: Pool; let pool: Pool; let database: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_target, key) => {
  const value = database[key as keyof typeof database];
  return typeof value === 'function' ? value.bind(database) : value;
} }) }));
const { WidgetStateModel } = await import('../models/widgetStates/functions.js');
const { ConversationToolApprovalModel } = await import('../models/conversationToolApprovals/functions.js');
const { projectMessageApprovalDecisions } = await import('../models/chatMessages/approvalProjection.js');

postgres('concurrent conversation review receipts on independent PostgreSQL connections', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Disposable loopback QA required');
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},pg_catalog` }); database = drizzle(pool);
    await pool.query(`CREATE FUNCTION app_business_profile_id() RETURNS INTEGER LANGUAGE sql AS 'SELECT 1';
      CREATE TABLE widget_states (
        id SERIAL PRIMARY KEY,business_profile_id INTEGER DEFAULT 1,user_id INTEGER,thread_id INTEGER,message_id INTEGER,
        tool_name TEXT,widget_type TEXT,run_id TEXT,action_id TEXT,idempotency_key TEXT,form_values JSONB DEFAULT '{}',
        status TEXT DEFAULT 'active',submitted_at TIMESTAMP,submitted_values JSONB,execution_result JSONB,execution_error TEXT,
        execution_started_at TIMESTAMP,execution_completed_at TIMESTAMP,execution_lease_token TEXT,execution_lease_expires_at TIMESTAMP,
        execution_attempt_count INTEGER DEFAULT 0,agent_type TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(business_profile_id,user_id,idempotency_key)
      );
      CREATE TABLE conversation_tool_approvals (
        id BIGSERIAL PRIMARY KEY,business_profile_id INTEGER DEFAULT 1,user_id INTEGER,thread_id INTEGER,request_id TEXT,tool_name TEXT,
        tool_args JSONB DEFAULT '{}',run_id TEXT,action_id TEXT,resource_type TEXT,resource_id TEXT,resource_revision INTEGER,overrides JSONB,
        decision TEXT,status TEXT,execution_result JSONB,execution_error TEXT,started_at TIMESTAMP,completed_at TIMESTAMP,lease_token TEXT,
        lease_expires_at TIMESTAMP,attempt_count INTEGER DEFAULT 1,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(business_profile_id,user_id,thread_id,request_id,tool_name)
      )`);
  });
  beforeEach(async () => { await pool.query('TRUNCATE widget_states,conversation_tool_approvals RESTART IDENTITY'); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  const review = () => ({ userId: 7, threadId: 42, requestId: 'review-v1', toolName: 'execute_lead_workflow',
    toolArgs: { leadInputSetRevision: 1 }, approved: true, resourceRevision: 1 });

  it('claims a duplicated approval once and replays the same immutable decision and revision', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ConversationToolApprovalModel.claim(review())));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(new Set(results.map(result => result.approval.id)).size).toBe(1);
    const repeated = await ConversationToolApprovalModel.claim({ ...review(), approved: false, resourceRevision: 2 });
    expect(repeated).toMatchObject({ claimed: false, approval: { decision: 'approve', resourceRevision: 1 } });
    expect(await ConversationToolApprovalModel.findByRequest(8,42,'review-v1','execute_lead_workflow')).toBeUndefined();
  });

  it('projects only the exact recorded review and rejects a completion without its current lease', async () => {
    const claimed = await ConversationToolApprovalModel.claim(review());
    expect(await ConversationToolApprovalModel.complete(claimed.approval.id,'stale-lease',true,{})).toBeUndefined();
    const receipt = await ConversationToolApprovalModel.complete(claimed.approval.id,claimed.approval.leaseToken!,true,{ success: true });
    expect(receipt?.status).toBe('succeeded');
    const message = (requestId: string) => ({ metadata: { actionButtons: [
      { id: `approve-${requestId}`, action: 'approve_tool', data: { requestId, toolName: review().toolName } },
    ] } });
    const projected = await projectMessageApprovalDecisions(7,42,[message('review-v1'),message('review-v2')]);
    expect(projected[0].metadata).toMatchObject({ actionResolution: { selectedButtonId: 'approve-review-v1', outcome: 'approved' } });
    expect(projected[1].metadata).not.toHaveProperty('actionResolution');
  });

  it('claims a widget once across tabs and cannot claim a superseded review', async () => {
    await pool.query("INSERT INTO widget_states(user_id,thread_id,tool_name,widget_type) VALUES(7,42,'generate_image','image_generation')");
    const results = await Promise.all(Array.from({ length: 6 }, () => WidgetStateModel.claimSubmissionForUser(1,7,{ prompt: 'Reviewed image' })));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect((await pool.query('SELECT execution_attempt_count FROM widget_states')).rows[0].execution_attempt_count).toBe(1);
    expect((await WidgetStateModel.claimSubmissionForUser(1,8,{})).widget).toBeUndefined();
    await pool.query("INSERT INTO widget_states(user_id,thread_id,tool_name,widget_type,status) VALUES(7,42,'generate_image','image_generation','active')");
    const revised = await WidgetStateModel.replacePendingReviewForUser(2,{userId:7,threadId:42,toolName:'generate_image',widgetType:'image_generation',formValues:{prompt:'New review'},idempotencyKey:'new-review'});
    expect(revised.id).not.toBe(2);
    expect((await WidgetStateModel.claimSubmissionForUser(2,7,{prompt:'Stale review'})).claimed).toBe(false);
  });
});
