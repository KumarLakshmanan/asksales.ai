import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { checkpointSupportCommit } from '../services/agents/orchestration/SupportCommitCheckpoint.js';

const connectionString = process.env.SUPPORT_TURN_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `widget_commit_qa_${process.pid}_${Date.now()}`;
let pool: Pool; let admin: Pool; let database: ReturnType<typeof drizzle>;
const commit = jest.fn<(...args: any[]) => Promise<void>>();
let ownership = 'ai-ownership-v1';
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_t,key) => {
  const value = (database as any)[key]; return typeof value === 'function' ? value.bind(database) : value;
} }) }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { commitDeferredDelivery: commit } }));
jest.unstable_mockModule('../services/agents/orchestration/SupportConversationTurn.js', () => ({ currentSupportTurn: () => undefined, SupersededSupportTurn: class extends Error {},
  supportOwnershipSnapshot: async () => ownership }));
jest.unstable_mockModule('../services/agents/orchestration/SupportAdminAuditService.js', () => ({ recordSupportAdminAudit: jest.fn() }));
const recovery = await import('../services/agents/orchestration/WidgetCommitRecovery.js');
const { reconcileConversationRecovery } = await import('../controllers/supportConversationRecoveryController.js');
const oldKey = process.env.SUPPORT_PII_ENCRYPTION_KEY;

suite('saved widget reply recovery with PostgreSQL', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Loopback QA required');
    process.env.SUPPORT_PII_ENCRYPTION_KEY = 'widget-recovery-test-key-at-least-32-chars';
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema},pg_catalog`, max: 5 }); database = drizzle(pool);
    await pool.query(`CREATE TABLE team_members(id INTEGER PRIMARY KEY,user_id INTEGER);
      CREATE TABLE support_chat_sessions(id INTEGER PRIMARY KEY,member_id INTEGER,automation_mode TEXT);
      CREATE TABLE support_chat_messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT,processing_status TEXT,processing_expires_at TIMESTAMPTZ,deferred_commit JSONB,commit_token UUID,metadata JSONB,request_id TEXT);
      CREATE TABLE support_conversation_turns(scope_key TEXT PRIMARY KEY,user_id INTEGER,conversation_id INTEGER,channel TEXT,lease_token UUID,lease_expires_at TIMESTAMPTZ,consumed_revision BIGINT DEFAULT 0,updated_at TIMESTAMPTZ);
      CREATE TABLE support_conversation_turn_runs(id UUID PRIMARY KEY,scope_key TEXT,last_revision BIGINT,status TEXT,message_ids JSONB,updated_at TIMESTAMPTZ);
      CREATE TABLE support_effect_ledger(id INTEGER,user_id INTEGER,conversation_id INTEGER,status TEXT);
      INSERT INTO team_members VALUES(1,1); INSERT INTO support_chat_sessions VALUES(1,1,'ai_active');`);
  });
  beforeEach(async () => { ownership = 'ai-ownership-v1'; commit.mockReset().mockResolvedValue(undefined);
    await pool.query('TRUNCATE support_chat_messages,support_conversation_turns,support_conversation_turn_runs,support_effect_ledger');
    await pool.query("UPDATE support_chat_sessions SET automation_mode='ai_active'");
    const envelope = recovery.widgetCommitEnvelope(1, { sessionId: 1, userMessageIds: [1], inboundId: 'widget:1:request', ownership,
      decision: { replyText: 'Verified reply', escalated: false, confidence: 1, deliveryOutcome: 'ready_for_channel_delivery',
        deferredEffectContext: { userId: 1, conversationId: -1, channel: 'web' } } as any });
    await pool.query("INSERT INTO support_chat_messages(id,session_id,role,processing_status,deferred_commit,request_id) VALUES(1,1,'user','processing',NULL,'request-1:user'),(2,1,'assistant','committing',$1,'request-1:assistant')",[envelope]);
  });
  afterAll(async () => { if (oldKey === undefined) delete process.env.SUPPORT_PII_ENCRYPTION_KEY; else process.env.SUPPORT_PII_ENCRYPTION_KEY = oldKey;
    await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  it('commits a saved decision once and clears the encrypted envelope only after success', async () => {
    expect(await recovery.finishWidgetCommit(1,2)).toBe(true); expect(await recovery.finishWidgetCommit(1,2)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT processing_status,deferred_commit FROM support_chat_messages ORDER BY id')).rows).toEqual([
      { processing_status: 'completed', deferred_commit: null }, { processing_status: 'completed', deferred_commit: null },
    ]);
  });
  it('preserves the decision and blocks replay when effect commit is uncertain', async () => {
    commit.mockRejectedValueOnce(new Error('uncertain effect'));
    await expect(recovery.finishWidgetCommit(1,2)).rejects.toThrow('uncertain effect');
    const rows = (await pool.query('SELECT processing_status,deferred_commit FROM support_chat_messages ORDER BY id')).rows;
    expect(rows[0].processing_status).toBe('reconciliation_required'); expect(rows[1].processing_status).toBe('reconciliation_required'); expect(rows[1].deferred_commit).toBeTruthy();
    expect(await recovery.finishWidgetCommit(1,2)).toBe(false); expect(commit).toHaveBeenCalledTimes(1);
  });
  it('rejects tenant mismatch and a human takeover followed by an AI resume', async () => {
    expect(await recovery.finishWidgetCommit(2,2)).toBe(false); expect(commit).not.toHaveBeenCalled();
    ownership = 'ai-ownership-v2-after-human-resume';
    await expect(recovery.finishWidgetCommit(1,2)).rejects.toThrow('ownership changed'); expect(commit).not.toHaveBeenCalled();
  });
  it('allows a gateway-approved factual ticket reply that explicitly suppresses business effects', async () => {
    await pool.query("UPDATE support_chat_sessions SET automation_mode='human_active'");
    await pool.query('UPDATE support_chat_messages SET deferred_commit=$1 WHERE id=2',[recovery.widgetCommitEnvelope(1,{
      sessionId:1,userMessageIds:[1],inboundId:'widget:1:request',ownership,
      decision:{ replyText:'A verified fact',escalated:false,confidence:1,deliveryOutcome:'ready_for_channel_delivery',
        deferredEffectContext:{userId:1,conversationId:-1,channel:'web',suppressBusinessEffects:true} } as any,
    })]);
    expect(await recovery.finishWidgetCommit(1,2)).toBe(true);
  });
  it('recovers an expired commit after restart while a live claim is left alone', async () => {
    await pool.query("UPDATE support_chat_messages SET processing_expires_at=NOW()+INTERVAL '1 minute' WHERE id=2");
    expect(await recovery.recoverWidgetCommits()).toBe(0);
    await pool.query("UPDATE support_chat_messages SET processing_expires_at=NOW()-INTERVAL '1 minute' WHERE id=2");
    expect(await recovery.recoverWidgetCommits()).toBe(1); expect(commit).toHaveBeenCalledTimes(1);
  });
  it('suppresses concurrent replay while the original commit owns its lease', async () => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    commit.mockImplementation(async () => { entered(); await gate; });
    const first = recovery.finishWidgetCommit(1,2); await started;
    expect(await recovery.finishWidgetCommit(1,2)).toBe(false); release();
    expect(await first).toBe(true); expect(commit).toHaveBeenCalledTimes(1);
  });
  it('checks ownership before the next effect and cannot overwrite another commit owner', async () => {
    commit.mockImplementation(async () => {
      await pool.query("UPDATE support_chat_messages SET commit_token=$1 WHERE id=2",[randomUUID()]);
      await checkpointSupportCommit();
    });
    await expect(recovery.finishWidgetCommit(1,2)).rejects.toThrow('ownership expired');
    expect((await pool.query('SELECT processing_status FROM support_chat_messages WHERE id=2')).rows[0].processing_status).toBe('committing');
  });
  it('reclaims an expired coordinated turn and advances its revision only after commit', async () => {
    const id = randomUUID(); const supportTurn = { id, scopeKey: 'web-scope', revision: 3 };
    await pool.query("INSERT INTO support_conversation_turns(scope_key,user_id,conversation_id,channel) VALUES('web-scope',1,-1,'web')");
    await pool.query("INSERT INTO support_conversation_turn_runs VALUES($1,'web-scope',3,'uncertain','[1]',NOW())",[id]);
    await pool.query('UPDATE support_chat_messages SET deferred_commit=$1 WHERE id=2',[recovery.widgetCommitEnvelope(1,{
      sessionId:1,userMessageIds:[1],inboundId:'turn:'+id,ownership,supportTurn,
      decision:{ replyText:'Saved',escalated:false,confidence:1,deliveryOutcome:'ready_for_channel_delivery',deferredEffectContext:{userId:1,conversationId:-1,channel:'web'} } as any,
    })]);
    expect(await recovery.finishWidgetCommit(1,2)).toBe(true);
    expect((await pool.query('SELECT status FROM support_conversation_turn_runs')).rows[0].status).toBe('completed');
    expect((await pool.query('SELECT consumed_revision,lease_token FROM support_conversation_turns')).rows[0]).toEqual({consumed_revision:'3',lease_token:null});
  });
  it('closes the waiting user message when an owner discards an uncertain reply', async () => {
    await pool.query("UPDATE support_chat_messages SET processing_status='reconciliation_required' WHERE id=2");
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }; const next = jest.fn();
    await reconcileConversationRecovery({user:{id:1},params:{kind:'reply',id:'2'},body:{note:'Verified manual follow-up',outcome:'discard'}} as any,res,next);
    expect(next).not.toHaveBeenCalled(); expect(res.json).toHaveBeenCalledWith({success:true});
    expect((await pool.query('SELECT processing_status FROM support_chat_messages ORDER BY id')).rows.map(r=>r.processing_status)).toEqual(['cancelled','cancelled']);
  });
});
