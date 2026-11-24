import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
// @ts-expect-error JavaScript migration
import { up, down } from '../migrations/293_support_conversation_turns.js';
import {customerCourtesy} from '../services/agents/orchestration/CustomerTurnUnderstanding.js';

const connectionString = process.env.SUPPORT_TURN_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `support_turn_qa_${process.pid}_${Date.now()}`;
let pool: Pool;
let admin: Pool;
let database: NodePgDatabase;
const oldFlag = process.env.SUPPORT_CONVERSATION_TURN_CHANNELS;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get(_target, key) {
    const value = (database as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
const runtime = await import('../services/agents/orchestration/SupportConversationTurn.js');
const { playbookEngine } = await import('../services/agents/orchestration/PlaybookEngine.js');
const { PrivacyStage } = await import('../services/agents/pipeline/stages/PrivacyStage.js');
const { privacyVaultService } = await import('../services/agents/orchestration/PrivacyVaultService.js');
const job = 'process_whatsapp_webhook';
const payload = (id: number, text: string, conversationId = 1) => ({
  userId: 1, conversationId, phoneNumberId: 'business-1', inboundMessageId: id, messageId: `provider-${id}`, inboundText: text,
});
const add = async (id: number, text: string, conversationId = 1) => {
  await pool.query('INSERT INTO outreach_messages(id,user_id,conversation_id,direction) VALUES($1,1,$2,\'inbound\')', [id, conversationId]);
  const input = payload(id, text, conversationId);
  await runtime.registerSupportTurnInput(job, input);
  return input;
};

suite('support conversation turns with independent PostgreSQL connections', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Loopback QA database required');
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema},pg_catalog` });
    database = drizzle(pool);
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);
      CREATE TABLE outreach_conversations(id INTEGER PRIMARY KEY,user_id INTEGER,channel TEXT,provider_account_id TEXT,automation_mode TEXT DEFAULT 'ai_active',metadata JSONB);
      CREATE TABLE outreach_messages(id BIGINT PRIMARY KEY,user_id INTEGER,conversation_id INTEGER,direction TEXT);
      CREATE TABLE support_playbook_runs(business_profile_id INTEGER,id BIGINT PRIMARY KEY,user_id INTEGER,conversation_id INTEGER,current_node_id TEXT,status TEXT,state JSONB,updated_at TIMESTAMPTZ);
      ALTER TABLE support_playbook_runs ADD COLUMN playbook_id INTEGER DEFAULT 1, ADD COLUMN playbook_version INTEGER DEFAULT 1,
        ADD COLUMN run_sequence INTEGER DEFAULT 1, ADD COLUMN variant TEXT, ADD COLUMN compliance_score REAL,
        ADD COLUMN completed_at TIMESTAMP, ADD COLUMN created_at TIMESTAMP DEFAULT NOW();
      CREATE TABLE support_playbook_versions(business_profile_id INTEGER,id SERIAL PRIMARY KEY,playbook_id INTEGER,version INTEGER,graph JSONB,
        checksum TEXT,published_by INTEGER,published_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW());
      CREATE UNIQUE INDEX active_run ON support_playbook_runs(user_id,conversation_id) WHERE status='active';
      CREATE TABLE team_members(id INTEGER PRIMARY KEY,user_id INTEGER);
      CREATE TABLE support_chat_sessions(id INTEGER PRIMARY KEY,member_id INTEGER,automation_mode TEXT DEFAULT 'ai_active',metadata JSONB);
      CREATE TABLE handoff_queue(id INTEGER PRIMARY KEY,user_id INTEGER,conversation_id INTEGER,status TEXT,ai_reply_enabled BOOLEAN);
      CREATE TABLE support_chat_messages(id INTEGER PRIMARY KEY,session_id INTEGER,role TEXT);`);
    await up(pool);
  });
  beforeEach(async () => {
    process.env.SUPPORT_CONVERSATION_TURN_CHANNELS = 'whatsapp,instagram,facebook,web';
    await pool.query(`TRUNCATE support_conversation_turn_runs,support_conversation_turn_inputs,support_conversation_turns,
      support_playbook_runs,support_playbook_versions,outreach_messages,outreach_conversations,team_members,support_chat_sessions,support_chat_messages,handoff_queue;
      INSERT INTO outreach_conversations(id,user_id,channel,provider_account_id) VALUES(1,1,'whatsapp','business-1'),(2,1,'whatsapp','business-1'),(3,1,'instagram','account-3'),(4,2,'whatsapp','business-2');`);
  });
  afterAll(async () => {
    if (oldFlag === undefined) delete process.env.SUPPORT_CONVERSATION_TURN_CHANNELS;
    else process.env.SUPPORT_CONVERSATION_TURN_CHANNELS = oldFlag;
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });

  it('migration is repeatable and can roll back in the isolated schema', async () => {
    await up(pool); await down(pool); await up(pool);
  });
  it('coalesces all persisted pending input and acknowledges stale per-message jobs without replying again', async () => {
    const first = await add(11, '2 adults and 2 kids');
    await add(12, 'Kids 1 year and 7 years');
    const run = jest.fn(async (input: Record<string, unknown>) => {
      expect(input.inboundText).toBe('2 adults and 2 kids\nKids 1 year and 7 years');
      expect(runtime.currentSupportTurn()?.messageIds).toEqual([11, 12]);
      expect(input.messageId).toMatch(/^turn:/);
      expect(runtime.supportTurnProviderReplyId(String(input.messageId))).toBe('provider-12');
      await runtime.sealSupportTurn();
      return { success: true };
    });
    await runtime.runSupportConversationJob(job, first, run);
    expect(await runtime.runSupportConversationJob(job, payload(12, 'Kids 1 year and 7 years'), run)).toMatchObject({ method: 'coalesced' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(runtime.supportTurnProviderReplyId('turn:internal-id')).toBeUndefined();
  });
  it('replaces the slower budget draft with one ordered reply when Thanks arrives during generation', async () => {
    const first = await add(1001, 'Buget not ok');
    const delivered: string[] = [];
    let attempts = 0;
    let entered!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const firstWorker = runtime.runSupportConversationJob(job, first, async input => {
      if (++attempts === 1) {
        entered();
        await gate;
        await runtime.assertSupportTurnFresh();
      }
      const acknowledgement = customerCourtesy(String(input.inboundText));
      expect(input.inboundText).toBe('Buget not ok\nThanks');
      expect(acknowledgement?.closeEnquiry).toBe(true);
      await runtime.sealSupportTurn();
      delivered.push(acknowledgement!.replyText);
      return { success: true };
    });
    await started;
    try {
      // A second worker has its own async context, outside the first turn.
      const later = await add(1002, 'Thanks');
      await expect(runtime.runSupportConversationJob(job, later, async () => ({ success: true }))).rejects.toThrow(runtime.BusySupportTurn);
    } finally { unblock(); await firstWorker; }
    expect(attempts).toBe(2);
    expect(delivered).toHaveLength(1);
    const stale = jest.fn(async () => ({ success: true }));
    expect(await runtime.runSupportConversationJob(job, payload(1002, 'Thanks'), stale)).toMatchObject({ method: 'coalesced' });
    expect(stale).not.toHaveBeenCalled();
  });
  it('suppresses an answer if newer input arrives during generation, then regenerates from both messages', async () => {
    const first = await add(21, '1');
    const sent: string[] = [];
    let attempts = 0;
    await runtime.runSupportConversationJob(job, first, async input => {
      if (++attempts === 1) await add(22, 'No preference');
      await runtime.sealSupportTurn();
      sent.push(input.inboundText);
      return { success: true };
    });
    expect(attempts).toBe(2);
    expect(sent).toEqual(['1\nNo preference']);
    expect((await pool.query("SELECT count(*)::int AS n FROM support_conversation_turn_runs WHERE status='superseded'")).rows[0].n).toBe(1);
  });
  it('allows a different conversation concurrently but rejects a second owner for the same chat', async () => {
    const first = await add(31, 'First');
    const other = await add(32, 'Other', 2);
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const activeRun = runtime.runSupportConversationJob(job, first, async () => { entered(); await gate; return { success: true }; });
    await started;
    try {
      await expect(runtime.runSupportConversationJob(job, first, async () => ({ success: true }))).rejects.toThrow(runtime.BusySupportTurn);
      await expect(runtime.runSupportConversationJob(job, other, async () => ({ success: true }))).resolves.toEqual({ success: true });
    } finally { unblock(); await activeRun; }
  });
  it('finishes an already-authorized send and processes later input as a subsequent contextual turn', async () => {
    const first = await add(41, 'Book 1 room');
    const sent: string[] = [];
    await runtime.runSupportConversationJob(job, first, async input => {
      await runtime.sealSupportTurn();
      if (!sent.length) await add(42, 'Actually 2 rooms');
      await runtime.assertSupportTurnFresh();
      sent.push(input.inboundText);
      return { success: true };
    });
    expect(sent).toEqual(['Book 1 room', 'Actually 2 rooms']);
  });
  it('does not duplicate revision on webhook retries or store arbitrary secrets', async () => {
    const first = await add(51, 'private@example.com');
    await runtime.registerSupportTurnInput(job, { ...first, secret: 'NEVER_STORE', sessionToken: 'NEVER_STORE' });
    const row = (await pool.query('SELECT payload,revision FROM support_conversation_turn_inputs')).rows[0];
    expect(Number(row.revision)).toBe(1);
    expect(JSON.stringify(row.payload)).not.toContain('private@example.com');
    expect(JSON.stringify(row.payload)).not.toContain('NEVER_STORE');
  });
  it('does not overwrite the last CRM message with combined customer text', async () => {
    const first = await add(251, 'First');
    await add(252, 'Second');
    const protect = jest.spyOn(privacyVaultService, 'protectInbound');
    try {
      await runtime.runSupportConversationJob(job, first, async input => {
        await new PrivacyStage().execute({ message: { userId: 1, conversationId: 1, channel: 'whatsapp',
          senderIdentifier: 'test', inboundText: input.inboundText, messageId: input.inboundMessageId,
          metadata: { privacyPreprotected: { vaultId: null, tokenCount: 0, piiTypes: [] } } }, confidence: 0, policyViolations: [],
        });
        expect(protect).not.toHaveBeenCalled();
        return { success: true };
      });
    } finally { protect.mockRestore(); }
  });
  it('keeps message order when preparation finishes out of order', async () => {
    const later = await add(202, 'Kids 1 and 7 years');
    await add(201, '2 adults and 2 kids');
    await runtime.runSupportConversationJob(job, later, async input => {
      expect(input.inboundText).toBe('2 adults and 2 kids\nKids 1 and 7 years');
      expect(input.inboundMessageId).toBe(202);
      await runtime.sealSupportTurn(); return { success: true };
    });
  });
  it('does not overtake an earlier reserved message while its attachment is preparing', async () => {
    await pool.query("INSERT INTO outreach_messages VALUES(261,1,1,'inbound')");
    const earlier = payload(261, 'Preparing attachment');
    await runtime.registerSupportTurnInput(job, earlier, false);
    const later = await add(262, 'Additional details');
    const execute = jest.fn(async () => ({ success: true }));
    await expect(runtime.runSupportConversationJob(job, later, execute)).rejects.toThrow('preparation is still pending');
    expect(execute).not.toHaveBeenCalled();
    await runtime.registerSupportTurnInput(job, { ...earlier, inboundText: 'Prepared attachment' });
    await runtime.runSupportConversationJob(job, later, async input => {
      expect(input.inboundText).toBe('Prepared attachment\nAdditional details');
      await runtime.sealSupportTurn(); return { success: true };
    });
    expect(Number((await pool.query('SELECT revision FROM support_conversation_turns')).rows[0].revision)).toBe(2);
  });
  it.each(['instagram', 'facebook'])('coalesces %s inputs within their connected account', async channel => {
    await pool.query('UPDATE outreach_conversations SET channel=$1 WHERE id=3', [channel]);
    await pool.query("INSERT INTO outreach_messages VALUES(211,1,3,'inbound'),(212,1,3,'inbound')");
    const input = { userId: 1, conversationId: 3, inboundMessageId: 211, providerAccountId: 'account-3', inboundText: 'First', channel };
    await runtime.registerSupportTurnInput(`process_${channel}_webhook`, input);
    await runtime.registerSupportTurnInput(`process_${channel}_webhook`, { ...input, inboundMessageId: 212, inboundText: 'Second' });
    await runtime.runSupportConversationJob(`process_${channel}_webhook`, input, async batch => {
      expect(batch.inboundText).toBe('First\nSecond');
      await runtime.sealSupportTurn(); return { success: true };
    });
  });
  it('rejects cross-owner and connected-account spoofing before processing', async () => {
    await pool.query("INSERT INTO outreach_messages VALUES(61,1,3,'inbound'),(62,2,4,'inbound')");
    await expect(runtime.registerSupportTurnInput('process_instagram_webhook', { userId: 1, conversationId: 3, inboundMessageId: 61, providerAccountId: 'wrong' })).rejects.toThrow('ownership mismatch');
    await expect(runtime.registerSupportTurnInput(job, payload(62, 'stolen', 4))).rejects.toThrow('ownership mismatch');
    const own = await add(63, 'Own');
    await expect(runtime.registerSupportTurnInput(job, { ...own, phoneNumberId: 'wrong' })).rejects.toThrow('ownership mismatch');
  });
  it('fences out an expired lease before delivery', async () => {
    const first = await add(71, 'First');
    await expect(runtime.runSupportConversationJob(job, first, async () => {
      await pool.query("UPDATE support_conversation_turns SET lease_expires_at=NOW()-INTERVAL '1 second'");
      await runtime.sealSupportTurn();
      return { success: true };
    })).rejects.toThrow(runtime.SupersededSupportTurn);
  });
  it('never regenerates after an uncertain external effect', async () => {
    const first = await add(81, 'Send proposal');
    await expect(runtime.runSupportConversationJob(job, first, async () => {
      await runtime.sealSupportTurn(); throw new Error('connection lost after provider dispatch');
    })).rejects.toThrow('connection lost');
    const replay = jest.fn(async () => ({ success: true }));
    await expect(runtime.runSupportConversationJob(job, first, replay)).rejects.toThrow('reconciliation');
    expect(replay).not.toHaveBeenCalled();
  });
  it('supports authenticated widget messages under the same durable protocol', async () => {
    await pool.query("INSERT INTO team_members VALUES(1,1); INSERT INTO support_chat_sessions(id,member_id) VALUES(9,1); INSERT INTO support_chat_messages VALUES(91,9,'user')");
    await runtime.runSupportConversationJob('process_support_widget_turn', { userId: 1, sessionId: 9, widgetMessageId: 91, inboundText: 'Hi' }, async () => {
      expect(runtime.currentSupportTurn()?.conversationId).toBe(-9);
      await runtime.sealSupportTurn(); return { success: true };
    });
  });
  it('restores an uncommitted playbook proposal before regenerating a newer turn', async () => {
    const first = await add(111, '1');
    const original = { fields: { date: '2026-09-26' } };
    await pool.query("INSERT INTO support_playbook_runs(id,user_id,conversation_id,current_node_id,status,state) VALUES(1,1,1,'rooms','active',$1)", [original]);
    let attempts = 0;
    await runtime.runSupportConversationJob(job, first, async () => {
      if (++attempts === 1) {
        await pool.query("UPDATE support_playbook_runs SET state=$1,current_node_id='wrong' WHERE id=1", [{ fields: {}, coordinatedTurnId: runtime.currentSupportTurn()!.id }]);
        await add(112, 'No preference');
      } else {
        const run = (await pool.query('SELECT * FROM support_playbook_runs WHERE id=1')).rows[0];
        expect(run.current_node_id).toBe('rooms'); expect(run.state).toEqual(original);
      }
      await runtime.sealSupportTurn(); return { success: true };
    });
    expect(attempts).toBe(2);
  });
  it('recovers an abandoned proposal after a worker dies before external dispatch', async () => {
    const first = await add(121, '1 room');
    const scope = runtime.supportTurnScope(1, 'whatsapp', 1, 'business-1');
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const baseline = [{ id: 1, current_node_id: 'rooms', status: 'active', state: { fields: { date: '2026-09-26' } } }];
    await pool.query("INSERT INTO support_playbook_runs(id,user_id,conversation_id,current_node_id,status,state) VALUES(1,1,1,'wrong','active',$1)", [{ coordinatedTurnId: id }]);
    await pool.query("INSERT INTO support_conversation_turn_runs(id,scope_key,first_revision,last_revision,message_ids,playbook_baseline) VALUES($1,$2,1,1,'[121]',$3)", [id, scope, JSON.stringify(baseline)]);
    await runtime.runSupportConversationJob(job, first, async () => {
      const run = (await pool.query('SELECT * FROM support_playbook_runs WHERE id=1')).rows[0];
      expect(run.current_node_id).toBe('rooms'); expect(run.state).toEqual(baseline[0].state);
      await runtime.sealSupportTurn(); return { success: true };
    });
  });
  it('invalidates a draft when a support agent takes over before dispatch', async () => {
    const first = await add(131, 'Help');
    let attempts = 0;
    const delivered: string[] = [];
    await runtime.runSupportConversationJob(job, first, async () => {
      if (++attempts === 1) {
        await pool.query("UPDATE outreach_conversations SET automation_mode='human_owned' WHERE id=1");
        await runtime.sealSupportTurn(); delivered.push('outdated AI draft');
      }
      // The actual pipeline's ConversationModeStage now chooses no_op.
      return { success: true, method: 'no_op' };
    });
    expect(attempts).toBe(2); expect(delivered).toEqual([]);
  });
  it('suppresses an old unsent outbox retry after a newer inbound message', async () => {
    const first = await add(101, 'Old');
    let metadata: Record<string, unknown> = {};
    await runtime.runSupportConversationJob(job, first, async () => {
      await runtime.sealSupportTurn(); metadata = runtime.supportTurnDeliveryMetadata(); return { success: true };
    });
    expect(await runtime.supportTurnRetryAllowed(metadata)).toBe(true);
    await add(102, 'New');
    expect(await runtime.supportTurnRetryAllowed(metadata)).toBe(false);
  });
  it('prevents AI generation while an outbox retry owns the conversation', async () => {
    const first = await add(231, 'First');
    let metadata: Record<string, unknown> = {};
    await runtime.runSupportConversationJob(job, first, async () => {
      await runtime.sealSupportTurn(); metadata = runtime.supportTurnDeliveryMetadata(); return { success: true };
    });
    await runtime.withSupportTurnRetryLease(metadata, async () => {
      expect(await runtime.supportTurnRetryAllowed(metadata)).toBe(true);
      const later = await add(232, 'Second');
      await expect(runtime.runSupportConversationJob(job, later, async () => ({ success: true }))).rejects.toThrow(runtime.BusySupportTurn);
      expect(await runtime.supportTurnRetryAllowed(metadata)).toBe(false);
    });
    await runtime.runSupportConversationJob(job, payload(232, 'Second'), async () => ({ success: true }));
  });
  it('suppresses an unsent retry after human takeover', async () => {
    const first = await add(241, 'First');
    let metadata: Record<string, unknown> = {};
    await runtime.runSupportConversationJob(job, first, async () => {
      await runtime.sealSupportTurn(); metadata = runtime.supportTurnDeliveryMetadata(); return { success: true };
    });
    await pool.query("UPDATE outreach_conversations SET automation_mode='human_owned' WHERE id=1");
    expect(await runtime.supportTurnRetryAllowed(metadata)).toBe(false);
  });
  it('waits for already-persisted input whose media/privacy preparation has not registered yet', async () => {
    const first = await add(141, 'First');
    await pool.query("INSERT INTO outreach_messages VALUES(142,1,1,'inbound')");
    await expect(runtime.runSupportConversationJob(job, first, async () => {
      await runtime.sealSupportTurn(); return { success: true };
    })).rejects.toThrow('still being prepared');
    await runtime.registerSupportTurnInput(job, payload(142, 'Prepared caption'));
    await runtime.runSupportConversationJob(job, first, async input => {
      expect(input.inboundText).toBe('First\nPrepared caption');
      await runtime.sealSupportTurn(); return { success: true };
    });
  });
  it('does not consume an input when the processor reports failure', async () => {
    const first = await add(151, 'Help');
    await expect(runtime.runSupportConversationJob(job, first, async () => ({ success: false }))).rejects.toThrow('processing failed');
    expect(Number((await pool.query('SELECT consumed_revision FROM support_conversation_turns')).rows[0].consumed_revision)).toBe(0);
  });
  it('restores a replaced active playbook without violating the active-run constraint', async () => {
    const first = await add(161, 'A new request');
    await pool.query("INSERT INTO support_playbook_runs(id,user_id,conversation_id,current_node_id,status,state) VALUES(1,1,1,'rooms','active','{}')");
    let attempts = 0;
    await runtime.runSupportConversationJob(job, first, async () => {
      if (++attempts === 1) {
        const state = { coordinatedTurnId: runtime.currentSupportTurn()!.id };
        await pool.query("UPDATE support_playbook_runs SET status='superseded',state=$1 WHERE id=1", [state]);
        await pool.query("INSERT INTO support_playbook_runs(id,user_id,conversation_id,current_node_id,status,state) VALUES(2,1,1,'new','active',$1)", [state]);
        await add(162, 'Correction');
      } else {
        expect((await pool.query("SELECT id FROM support_playbook_runs WHERE status='active'")).rows).toEqual([{ id: '1' }]);
      }
      await runtime.sealSupportTurn(); return { success: true };
    });
  });
  it('keeps completed booking facts for a delayed continuation instead of restarting intake', async () => {
    const first = await add(171, 'No preference');
    const state = { agentType: 'hotel', graphVersion: 2, fields: {
      'stay.checkIn': { value: '2026-09-26', status: 'collected', source: 'customer' },
      'stay.adults': { value: 2, status: 'collected', source: 'customer' },
    } };
    await pool.query("INSERT INTO support_playbook_runs(id,user_id,conversation_id,current_node_id,status,state) VALUES(1,1,1,'done','completed',$1)", [state]);
    await pool.query('INSERT INTO support_playbook_versions(playbook_id,version,graph) VALUES(1,1,$1)', [{
      schemaVersion: 2, entryNodeId: 'done', fields: [], nodes: [{ id: 'done', type: 'complete' }], edges: [],
    }]);
    await runtime.runSupportConversationJob(job, first, async input => {
      const directive = await playbookEngine.resolve({ userId: 1, conversationId: 1, channel: 'whatsapp', agentType: 'hotel', inboundText: input.inboundText, eventKey: input.messageId });
      expect(directive).toMatchObject({ runId: 1, nodeId: 'completed-journey-follow-up', readOnlyInformation: true, completedJourneyFollowUp: true });
      expect(JSON.stringify(directive)).toContain('2026-09-26');
      await runtime.sealSupportTurn(); return { success: true };
    });
    expect((await pool.query('SELECT status,state FROM support_playbook_runs')).rows).toEqual([{ status: 'completed', state }]);
  });
  it('commits only the current turn proposal after delivery is authorized', async () => {
    const first = await add(181, 'Confirmed');
    await runtime.runSupportConversationJob(job, first, async input => {
      const id = runtime.currentSupportTurn()!.id;
      await pool.query("INSERT INTO support_playbook_runs(id,user_id,conversation_id,current_node_id,status,state) VALUES(1,1,1,'rooms','active',$1)", [{
        coordinatedTurnId: id, proposedEventKey: input.messageId, proposedNodeId: 'done', proposedCompleted: true,
      }]);
      expect(await playbookEngine.commitProposedTransition(1, 1)).toBe(false);
      await runtime.sealSupportTurn();
      await pool.query("UPDATE support_playbook_runs SET state=jsonb_set(state,'{proposedEventKey}','\"wrong\"') WHERE id=1");
      expect(await playbookEngine.commitProposedTransition(1, 1)).toBe(false);
      await pool.query("UPDATE support_playbook_runs SET state=jsonb_set(state,'{proposedEventKey}',$1) WHERE id=1", [JSON.stringify(input.messageId)]);
      expect(await playbookEngine.commitProposedTransition(1, 1)).toBe(true);
      return { success: true };
    });
    expect((await pool.query('SELECT status FROM support_playbook_runs')).rows[0].status).toBe('completed');
  });
});
