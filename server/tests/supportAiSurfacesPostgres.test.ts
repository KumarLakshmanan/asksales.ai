// @ts-expect-error JavaScript migration
import { up as recoveryMigration } from '../migrations/294_conversation_request_recovery.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';

const localPostgres = process.env.SUPPORT_KNOWLEDGE_LOCAL_QA === '1' ? describe : describe.skip;
jest.setTimeout(30000);
let fixtureDb: ReturnType<typeof drizzle>;
const handle = jest.fn<(...args: any[]) => Promise<any>>();
const finishWidgetCommit = jest.fn<(...args: any[]) => Promise<boolean>>();
jest.unstable_mockModule('../services/agents/orchestration/WidgetCommitRecovery.js', () => ({ finishWidgetCommit, widgetCommitEnvelope: jest.fn() }));
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, property) => (fixtureDb as any)[property].bind(fixtureDb),
}) }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { handle } }));
// This suite isolates session persistence; routing has separate regression coverage.
jest.unstable_mockModule('../services/SupportChatRouting.js', () => ({ requireSupportChatAssistant: async () => {} }));
// This fixture tests persistence; real assignment/freshness guards have dedicated suites.
jest.unstable_mockModule('../services/assistants/AssistantFreshness.js', () => ({
  assistantProvenanceCurrent: async () => true,
  withPublishedAssistant: async (_receipt: unknown, work: () => Promise<unknown>) => work(),
}));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }), privacyVaultService: {},
  encryptRestrictedPayload: jest.fn(), decryptRestrictedPayload: jest.fn(),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
const { ownerSupportChat, getSupportAIReport } = await import('../controllers/ownerSupportAIController.js');
const { generateWidgetToken, getWidgetToken, widgetChat } = await import('../controllers/supportWidgetController.js');
const { supportTeamsTable } = await import('../models/supportTeams/schema.js');
const { teamMembersTable } = await import('../models/teamMembers/schema.js');
const { supportChatSessionsTable } = await import('../models/supportChatSessions/schema.js');
const { supportChatMessagesTable } = await import('../models/supportChatMessages/schema.js');
const { leadsTable } = await import('../models/leads/schema.js');

function response() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

localPostgres('UG-02 support AI surfaces (isolated PostgreSQL schema)', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_ai_qa_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    for (const table of [supportTeamsTable, teamMembersTable, supportChatSessionsTable, supportChatMessagesTable, leadsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`);
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(9),(10),(11),(12)');
    await pool.query('CREATE TABLE outreach_assistants(id TEXT PRIMARY KEY,user_id INTEGER,business_profile_id INTEGER,draft JSONB)');
    await recoveryMigration(pool);
    await pool.query("CREATE TABLE support_tickets(id SERIAL PRIMARY KEY,assigned_member_id INTEGER,status TEXT); CREATE UNIQUE INDEX support_chat_request_unique ON support_chat_messages(session_id,request_id) WHERE request_id IS NOT NULL");
    await pool.query('CREATE UNIQUE INDEX member_email_unique ON team_members(lower(email)) WHERE email IS NOT NULL');
    await pool.query("ALTER TABLE team_members ADD CONSTRAINT team_members_role_check CHECK (role IN ('member', 'lead', 'admin'))");
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_ai_qa_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE conversation_requests,conversation_request_scopes,support_teams, team_members, support_chat_sessions, support_chat_messages, leads RESTART IDENTITY');
    handle.mockReset().mockResolvedValue({ replyText: 'Approved answer.', deliveryOutcome: 'auto_sent', confidence: 1, kbSourcesUsed: [] });
    finishWidgetCommit.mockReset();
  });
  it('creates first chats for two workspaces without a globally duplicated member email', async () => {
    for (const userId of [9, 10]) {
      const res = response();
      await ownerSupportChat({ user: { id: userId }, body: { message: 'What are your hours?', channel: 'email' } } as any, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.assistantMessage.content).toContain('Approved answer.');
    }
    expect((await pool.query('SELECT email, role FROM team_members')).rows).toEqual([
      { email: null, role: 'member' },
      { email: null, role: 'member' },
    ]);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', metadata: expect.objectContaining({ executionMode: 'advisory', conversationKind: 'owner_support' }) }));
  });
  it('replays fresh completed message states when the retry itself finishes a saved widget commit', async () => {
    const token = 'a'.repeat(64);
    await pool.query("INSERT INTO support_teams(id,user_id,is_active,widget_token) VALUES(1,9,true,$1);", [token]);
    await pool.query("INSERT INTO team_members(id,team_id,user_id,is_active) VALUES(1,1,9,true); INSERT INTO support_chat_sessions(id,member_id,public_token,session_expires_at) VALUES(1,1,'session-secret',NOW()+INTERVAL '1 hour');");
    await pool.query("INSERT INTO support_chat_messages(id,session_id,role,request_id,content,processing_status,deferred_commit) VALUES(1,1,'user','retry-widget:user','Hours?','committing',NULL),(2,1,'assistant','retry-widget:assistant','Saved answer','committing','{\"encrypted\":true}'); SELECT setval(pg_get_serial_sequence('support_chat_messages','id'),2)");
    finishWidgetCommit.mockImplementation(async (userId, messageId) => {
      expect([userId,messageId]).toEqual([9,2]);
      await pool.query("UPDATE support_chat_messages SET processing_status='completed',deferred_commit=NULL WHERE session_id=1");
      return true;
    });
    const res = response();
    await widgetChat({body:{token,message:'Hours?',sessionId:1,sessionToken:'session-secret',requestId:'retry-widget'}} as any,res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.userMessage).toMatchObject({id:1,processingStatus:'completed'});
    expect(res.body.data.assistantMessage).toMatchObject({id:2,content:'Saved answer',processingStatus:'completed'});
    expect(res.body.data.assistantMessage).not.toHaveProperty('deferredCommit');
    expect(finishWidgetCommit).toHaveBeenCalledTimes(1); expect(handle).not.toHaveBeenCalled();
  });
  it('rejects invalid session IDs before writing anything and withholds evidence-rejected answers', async () => {
    const invalid = response();
    await ownerSupportChat({ user: { id: 9 }, body: { message: 'Hello', sessionId: 'oops' } } as any, invalid);
    expect(invalid.statusCode).toBe(400);
    expect((await pool.query('SELECT count(*)::int n FROM support_chat_sessions')).rows[0].n).toBe(0);
    handle.mockResolvedValue({ replyText: 'Invented fact', deliveryOutcome: 'auto_sent', answerVerification: { mayDeliver: false } });
    const res = response();
    await ownerSupportChat({ user: { id: 9 }, body: { message: 'Hours?' } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Invented fact');
  });
  it('counts all sessions and messages beyond the detail limit while isolating tenants', async () => {
    await pool.query('INSERT INTO support_teams(id,user_id) VALUES(1,9),(2,10); INSERT INTO team_members(id,team_id,user_id) VALUES(1,1,9),(2,2,10)');
    await pool.query(`INSERT INTO support_chat_sessions(id,member_id,metadata) SELECT n,1,'{"source":"widget"}'::jsonb FROM generate_series(1,125) n;
      INSERT INTO support_chat_sessions(id,member_id,metadata) VALUES(200,2,'{"source":"widget"}');
      INSERT INTO support_chat_messages(session_id,role,content) SELECT id,'user','Hello' FROM support_chat_sessions;
      INSERT INTO leads(id,user_id,source) VALUES(1,9,'support_widget'),(2,10,'support_widget');
      UPDATE support_chat_sessions SET lead_id=2 WHERE id=125`);
    const res = response();
    await getSupportAIReport({ user: { id: 9 } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.stats).toEqual({ totalSessions: 125, widgetSessions: 125, totalMessages: 125, leadsGenerated: 1 });
    expect(res.body.data.sessions).toHaveLength(25);
    expect(res.body.data.sessions[0]).toMatchObject({ id: 125, messageCount: 1, leadInfo: null });
    expect(res.body.data.leads).toHaveLength(1);
  });
  it('retains captured lead totals when there are no support teams', async () => {
    await pool.query("INSERT INTO leads(user_id,source) VALUES(9,'support_widget')");
    const res = response();
    await getSupportAIReport({ user: { id: 9 } } as any, res);
    expect(res.body.data.stats).toEqual({ totalSessions: 0, widgetSessions: 0, totalMessages: 0, leadsGenerated: 1 });
  });
  it('only lists active widget teams and requires an active member before rotating a key', async () => {
    await pool.query("INSERT INTO support_teams(id,user_id,is_active,name,widget_token) VALUES(1,9,true,'Live','original'),(2,9,false,'Inactive','hidden'),(3,10,true,'Foreign','foreign')");
    const listing = response();
    await getWidgetToken({ user: { id: 9 } } as any, listing);
    expect(listing.body.data).toEqual([expect.objectContaining({ teamId: 1, teamName: 'Live', token: 'original' })]);
    const blocked = response();
    await generateWidgetToken({ user: { id: 9 }, body: { teamId: 1 } } as any, blocked);
    expect(blocked.statusCode).toBe(400);
    expect((await pool.query('SELECT widget_token FROM support_teams WHERE id=1')).rows[0].widget_token).toBe('original');
    await pool.query('INSERT INTO team_members(id,team_id,user_id,is_active) VALUES(1,1,9,true)');
    const ready = response();
    await generateWidgetToken({ user: { id: 9 }, body: { teamId: 1 } } as any, ready);
    expect(ready.statusCode).toBe(200);
    expect(ready.body.data.token).toMatch(/^[a-f0-9]{64}$/);
    const foreign = response();
    await generateWidgetToken({ user: { id: 9 }, body: { teamId: 3 } } as any, foreign);
    expect(foreign.statusCode).toBe(404);
  });
});
