import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.js';

const localPostgres = process.env.SUPPORT_KNOWLEDGE_LOCAL_QA === '1' ? describe : describe.skip;
let fixtureDb: ReturnType<typeof drizzle>;
const sendWhatsApp = jest.fn<(...args: unknown[]) => Promise<unknown>>()
  .mockResolvedValue({ messages: [{ id: 'test-whatsapp-receipt' }] });
const sendInstagram = jest.fn<(...args: unknown[]) => Promise<unknown>>()
  .mockResolvedValue({ success: true, externalMessageId: 'test-instagram-receipt' });
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { sendText: sendWhatsApp } }));
jest.unstable_mockModule('../services/instagramService.js', () => ({ sendInstagramDM: sendInstagram }));
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, property) => (fixtureDb as any)[property].bind(fixtureDb),
}) }));
jest.unstable_mockModule('../services/agents/orchestration/DefaultSupportProvisioningService.js', () => ({
  ensureDefaultSupportConfiguration: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
const { activateAgentForUser, updateAgentConfig } = await import('../controllers/aiAgentConfigController.js');
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: { emit: jest.fn() } }));
const { outreachConversationsTable, outreachMessagesTable } = await import('../models/outreachConversations/schema.js');
const { agentAuditLogsTable } = await import('../models/agentAuditLogs/schema.js');
const { aiAgentConfigsTable } = await import('../models/aiAgentConfigs/schema.js');
const { toolApprovalsTable } = await import('../models/toolApprovals/schema.js');
const { supportAdminAuditLogsTable, supportPlaybooksTable, supportPlaybookRunsTable, supportDeliveryOutboxTable } = await import('../models/supportOrchestration/schema.js');
const { AgentConfigurationStage } = await import('../services/agents/pipeline/stages/AgentConfigurationStage.js');
const { deliveryOutboxService } = await import('../services/agents/orchestration/DeliveryOutboxService.js');

function response() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

localPostgres('outreach agent settings in isolated PostgreSQL', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  const priorRuntime = process.env.SUPPORT_ASSISTANTS_ENABLED;
  beforeAll(async () => {
    dotenv.config({ path: '.env', quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `agent_settings_qa_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 3, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    for (const table of [aiAgentConfigsTable, toolApprovalsTable, supportAdminAuditLogsTable, supportPlaybooksTable, supportPlaybookRunsTable, supportDeliveryOutboxTable, outreachConversationsTable, outreachMessagesTable, agentAuditLogsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`);
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query('ALTER TABLE ai_agent_configs ALTER COLUMN business_profile_id SET DEFAULT 91');
    await pool.query('CREATE UNIQUE INDEX draft_delivery_unique ON outreach_messages(delivery_action_id) WHERE delivery_action_id IS NOT NULL');
    await pool.query('CREATE UNIQUE INDEX one_active_agent ON ai_agent_configs(user_id) WHERE enabled = TRUE');
    await pool.query('CREATE UNIQUE INDEX agent_type_unique ON ai_agent_configs(business_profile_id,user_id,agent_type)');
    await pool.query('CREATE UNIQUE INDEX delivery_key_unique ON support_delivery_outbox(decision_key)');
    await pool.query('ALTER TABLE support_delivery_outbox ALTER COLUMN attempt_count SET DEFAULT 0, ALTER COLUMN max_attempts SET DEFAULT 5');
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^agent_settings_qa_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    if (priorRuntime === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = priorRuntime;
  });
  beforeEach(async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
    sendWhatsApp.mockClear();
    sendInstagram.mockClear();
    await pool.query('TRUNCATE ai_agent_configs, tool_approvals, support_admin_audit_logs, support_playbooks, support_playbook_runs, support_delivery_outbox, outreach_conversations, outreach_messages, agent_audit_logs RESTART IDENTITY');
    await pool.query("INSERT INTO outreach_conversations(id,user_id,business_profile_id,channel,provider_account_id) VALUES(44,9,91,'instagram','ig')");
    await pool.query(`INSERT INTO ai_agent_configs(user_id,agent_type,enabled,metadata,channel_scope,escalation_rules,tools_enabled,template_mode)
      VALUES(9,'hotel_sales',true,'{}','[]','{}','[]','custom'),(9,'tech_support',false,'{}','[]','{}','[]','custom'),(10,'hotel_sales',true,'{}','[]','{}','[]','custom')`);
  });

  it('reproduces the untyped PostgreSQL parameter failure and switches agents with the corrected query', async () => {
    await expect(pool.query("SELECT jsonb_build_object('supersededByAgentType', $1)", ['tech_support'])).rejects.toMatchObject({ code: '42P18' });
    await pool.query("INSERT INTO support_playbooks(id,user_id,agent_type) VALUES(1,9,'hotel_sales'),(2,10,'hotel_sales')");
    await pool.query("INSERT INTO support_playbook_runs(user_id,playbook_id,status,state) VALUES(9,1,'active','{}'),(10,2,'active','{}')");
    await pool.query("INSERT INTO tool_approvals(user_id,agent_type,status) VALUES(9,'hotel_sales','approved'),(10,'hotel_sales','pending')");
    expect(await activateAgentForUser(9, 'tech_support')).toMatchObject({ agentType: 'tech_support', enabled: true });
    expect((await pool.query('SELECT user_id,agent_type FROM ai_agent_configs WHERE enabled ORDER BY user_id')).rows).toEqual([
      { user_id: 9, agent_type: 'tech_support' }, { user_id: 10, agent_type: 'hotel_sales' },
    ]);
    expect((await pool.query('SELECT status,state FROM support_playbook_runs WHERE user_id=9')).rows[0]).toMatchObject({ status: 'superseded', state: { supersededByAgentType: 'tech_support' } });
    expect((await pool.query('SELECT status FROM support_playbook_runs WHERE user_id=10')).rows[0].status).toBe('active');
    expect((await pool.query('SELECT status,resume_status FROM tool_approvals WHERE user_id=9')).rows[0]).toEqual({ status: 'expired', resume_status: 'cancelled' });
    expect((await pool.query('SELECT count(*)::int n FROM support_admin_audit_logs WHERE user_id=9')).rows[0].n).toBe(2);
    await activateAgentForUser(9, 'hotel_sales');
    expect((await pool.query('SELECT agent_type FROM ai_agent_configs WHERE user_id=9 AND enabled')).rows[0].agent_type).toBe('hotel_sales');
  });

  it('serializes concurrent activation requests while preserving exactly one active agent', async () => {
    await Promise.all([activateAgentForUser(9, 'tech_support'), activateAgentForUser(9, 'hotel_sales')]);
    expect((await pool.query('SELECT count(*)::int n FROM ai_agent_configs WHERE user_id=9 AND enabled')).rows[0].n).toBe(1);
    await expect(activateAgentForUser(9, 'unsupported')).rejects.toMatchObject({ status: 400 });
  });

  it('validates legacy platform settings without activating an unassigned assistant', async () => {
    const res = response();
    await updateAgentConfig({ user: { id: 9 }, params: { type: 'hotel_sales' }, body: {
      metadata: { platformAutoReplies: { instagram: false, facebook: false, email: false, whatsapp: false, web: false } },
    } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.metadata.platformAutoReplies.email).toBe(false);
    for (const channel of ['email', 'web']) {
      await expect(new AgentConfigurationStage().execute({
        message: { userId: 9, channel }, confidence: 1, policyViolations: [],
        agentResult: { replyText: 'Prebuilt acknowledgement', escalated: false, confidence: 1 },
        metadata: { skipAgentGeneration: true },
      } as any)).rejects.toMatchObject({ outcome: 'no_op', reason: 'No explicitly assigned assistant is available for this receiving account.' });
    }
    expect((await pool.query('SELECT metadata FROM ai_agent_configs WHERE user_id=10')).rows[0].metadata).toEqual({});
    const invalid = response();
    await updateAgentConfig({ user: { id: 9 }, params: { type: 'hotel_sales' }, body: { metadata: { platformAutoReplies: { email: 'false' } } } } as any, invalid);
    expect(invalid.statusCode).toBe(400);
    const reenabled = response();
    await updateAgentConfig({ user: { id: 9 }, params: { type: 'hotel_sales' }, body: {
      metadata: { ...res.body.metadata, platformAutoReplies: { ...res.body.metadata.platformAutoReplies, email: true } },
    } } as any, reenabled);
    expect(reenabled.statusCode).toBe(200);
    for (const channel of ['email','web','instagram','instagram_comment','facebook','facebook_comment','whatsapp']) {
      await expect(new AgentConfigurationStage().execute({ message: { userId: 9, channel },
        confidence: 1, policyViolations: [], metadata: {} } as any)).rejects.toMatchObject({
        outcome: 'no_op', reason: 'No explicitly assigned assistant is available for this receiving account.',
      });
    }
  });

  it('saves platform changes without rejecting or deleting unchanged legacy metadata', async () => {
    const legacyMetadata = {
      platformAutoReplies: { instagram: true, whatsapp: false },
      trainingConversations: [{ userMessage: 'Question', agentReply: 'Answer' }],
      handoffPolicy: { enabled: true, route: 'owner' },
      handoffPolicyChange: { source: 'legacy-settings' },
    };
    await pool.query(
      'UPDATE ai_agent_configs SET metadata = $1::jsonb WHERE user_id = 9 AND agent_type = $2',
      [JSON.stringify(legacyMetadata), 'hotel_sales'],
    );

    // Also exercise the previous client shape: it resubmitted the full
    // metadata object, including unchanged fields the current schema no
    // longer recognizes.
    const res = response();
    await updateAgentConfig({ user: { id: 9 }, params: { type: 'hotel_sales' }, body: {
      metadata: {
        ...legacyMetadata,
        platformAutoReplies: { ...legacyMetadata.platformAutoReplies, instagram: false },
      },
    } } as any, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.metadata).toMatchObject({
      platformAutoReplies: { instagram: false, whatsapp: false },
      trainingConversations: legacyMetadata.trainingConversations,
      handoffPolicy: legacyMetadata.handoffPolicy,
      handoffPolicyChange: legacyMetadata.handoffPolicyChange,
    });

    const reenabled = response();
    await updateAgentConfig({ user: { id: 9 }, params: { type: 'hotel_sales' }, body: {
      metadata: { platformAutoReplies: { instagram: true } },
    } } as any, reenabled);
    expect(reenabled.statusCode).toBe(200);
    expect(reenabled.body.metadata.platformAutoReplies).toEqual({ instagram: true, whatsapp: false });
    expect(reenabled.body.metadata.handoffPolicy).toEqual(legacyMetadata.handoffPolicy);
  });

  it('holds legacy queued sends and requires assistant setup for new automatic and manual replies', async () => {
    await pool.query(`INSERT INTO support_delivery_outbox(id,user_id,conversation_id,channel,decision_key,status,payload)
      VALUES(1,9,44,'instagram','legacy-send','pending',$1::jsonb)`, [JSON.stringify({
      text: 'Legacy queued reply', recipient: 'test-recipient', metadata: { dispatchKind: 'pipeline_message' },
    })]);
    await deliveryOutboxService.processAction(1);
    expect((await pool.query('SELECT status,next_attempt_at FROM support_delivery_outbox WHERE id=1')).rows)
      .toEqual([{ status: 'setup_required', next_attempt_at: null }]);
    for (const dispatchKind of ['pipeline_message', 'manual_support_reply']) {
      await expect(withBusinessScope({ userId: 9, businessProfileId: 91 }, () => deliveryOutboxService.claim({
        userId: 9, conversationId: 44, channel: 'instagram', inboundProviderMessageId: dispatchKind,
      }, { text: 'Reply', recipient: 'test-recipient', metadata: { dispatchKind } })))
        .rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled' });
    }
    expect(sendWhatsApp).not.toHaveBeenCalled(); expect(sendInstagram).not.toHaveBeenCalled();
  });
});
