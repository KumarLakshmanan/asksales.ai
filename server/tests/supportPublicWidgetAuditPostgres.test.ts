import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { chromium } from 'playwright-core';

const local = process.env.SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL ? describe : describe.skip;
let fixtureDb: ReturnType<typeof drizzle>;
const handle = jest.fn<(...args: unknown[]) => Promise<{ deliveryOutcome: string; replyText?: string }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, key) => {
    const value = Reflect.get(fixtureDb, key);
    return typeof value === 'function' ? value.bind(fixtureDb) : value;
  },
}) }));
// No model, messaging, or approval provider can run in this public-adapter suite.
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { handle } }));
jest.unstable_mockModule('../models/companySettings/functions.js', () => ({
  getBusinessProfileContextByUserId: async () => ({ id: 91, companyName: 'Synthetic help' }),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: Object.fromEntries(
  ['error', 'warn', 'info', 'debug'].map(key => [key, jest.fn()]),
) }));
const controller = await import('../controllers/supportWidgetController.js');
const { widgetBusinessScope } = await import('../middleware/publicBusinessScope.js');
const { publicWidgetRateLimiter, publicWidgetReadRateLimiter } = await import('../middleware/rateLimiter.js');
const { closeRedisConnections, getRedisConnection } = await import('../infrastructure/redis.js');
const { privacyVaultService } = await import('../services/agents/orchestration/PrivacyVaultService.js');
const { supportTeamsTable } = await import('../models/supportTeams/schema.js');
const { teamMembersTable } = await import('../models/teamMembers/schema.js');
const { supportChatSessionsTable } = await import('../models/supportChatSessions/schema.js');
const { supportChatMessagesTable } = await import('../models/supportChatMessages/schema.js');
const { supportTicketsTable } = await import('../models/supportTickets/schema.js');
const { supportTicketMessagesTable } = await import('../models/supportTicketMessages/schema.js');
const { outreachMessagesTable } = await import('../models/outreachConversations/schema.js');
const { supportPrivacyVaultTable, supportPrivacyAccessLogsTable } = await import('../models/supportOrchestration/schema.js');
const token = 'a'.repeat(64);
const otherToken = 'b'.repeat(64);

local('public widget audit through HTTP and disposable PostgreSQL/Redis', () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let server: Server;
  let failHistoryOnce = false;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:55880');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.get('/api/support-widget/config', widgetBusinessScope, controller.getWidgetConfig);
  app.post('/api/support-widget/chat', publicWidgetRateLimiter, widgetBusinessScope, controller.widgetChat);
  app.get('/api/support-widget/session/:sessionId/messages', publicWidgetReadRateLimiter, widgetBusinessScope, (req, res) => {
    if (failHistoryOnce) { failHistoryOnce = false; return res.status(503).json({ error: 'Synthetic transient outage' }); }
    return controller.getWidgetSessionMessages(req, res);
  });
  app.post('/api/support-widget/session/:sessionId/feedback', publicWidgetRateLimiter, widgetBusinessScope, controller.submitWidgetFeedback);
  app.post('/api/support-widget/installed', publicWidgetRateLimiter, widgetBusinessScope, controller.recordWidgetInstallation);
  app.get('/api/support-widget/embed.js', widgetBusinessScope, controller.getEmbedScript);

  beforeAll(async () => {
    const connectionString = process.env.SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL!;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit loopback fixture required');
    if (process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '56379') throw new Error('Explicit disposable Redis required');
    process.env.SUPPORT_PII_ENCRYPTION_KEY = 'synthetic-widget-audit-encryption-key-32-chars';
    process.env.SUPPORT_CONVERSATION_TURN_CHANNELS = '';
    schema = `public_widget_audit_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    await pool.query("CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE SQL AS 'SELECT 91'");
    for (const table of [supportTeamsTable, teamMembersTable, supportChatSessionsTable, supportChatMessagesTable,
      supportTicketsTable, supportTicketMessagesTable, outreachMessagesTable, supportPrivacyVaultTable, supportPrivacyAccessLogsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const value = column.default;
        const defaultSql = value instanceof SQL ? new PgDialect().sqlToQuery(value).sql
          : value === undefined ? undefined : typeof value === 'number' || typeof value === 'boolean' ? String(value)
            : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''")}'`;
        return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}`;
      });
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query(`CREATE UNIQUE INDEX widget_session_identity ON support_chat_sessions(client_session_key);
      CREATE UNIQUE INDEX widget_message_identity ON support_chat_messages(session_id,request_id) WHERE request_id IS NOT NULL;
      CREATE UNIQUE INDEX widget_vault_identity ON support_privacy_vault(business_profile_id,user_id,channel,provider_message_id);
      CREATE TABLE handoff_queue(id SERIAL,user_id INTEGER,conversation_id INTEGER,status TEXT,ai_reply_enabled BOOLEAN,support_ticket_id INTEGER,created_at TIMESTAMP DEFAULT NOW());`);
    await getRedisConnection().ping();
    if (process.env.SUPPORT_PUBLIC_WIDGET_QA_BROWSER === '1') {
      server = await new Promise<Server>(resolve => { const listener = app.listen(55881, '127.0.0.1', () => resolve(listener)); });
    }
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeRedisConnections();
    await pool?.end();
    if (admin && /^public_widget_audit_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    failHistoryOnce = false;
    // Redis is a dedicated container created solely for this suite.
    await getRedisConnection().flushdb();
    await pool.query(`TRUNCATE support_teams,team_members,support_chat_sessions,support_chat_messages,
      support_tickets,support_ticket_messages,outreach_messages,support_privacy_vault,support_privacy_access_logs,handoff_queue RESTART IDENTITY`);
    await pool.query("INSERT INTO support_teams(id,user_id,name,is_active,widget_token) VALUES(1,9,'Synthetic help',true,$1),(2,10,'Other help',true,$2)", [token, otherToken]);
    await pool.query('INSERT INTO team_members(id,team_id,user_id,is_active) VALUES(1,1,9,true),(2,2,10,true)');
    handle.mockReset().mockResolvedValue({ deliveryOutcome: 'no_op', replyText: '' });
  });
  const chat = (body: object) => request(app).post('/api/support-widget/chat').set('Origin', 'http://127.0.0.1:55880').send({ token, message: 'Hours?', requestId: 'audit-request-1', ...body });
  const history = (id: string, credential = 'session-secret', widgetToken = token) => request(app)
    .get(`/api/support-widget/session/${id}/messages`).query({ token: widgetToken, sessionToken: credential });
  async function seedSession() {
    await pool.query(`INSERT INTO support_chat_sessions(id,member_id,public_token,session_expires_at,metadata)
      VALUES(1,1,'session-secret',NOW()+INTERVAL '1 hour','{"source":"widget","widgetOrigin":"http://127.0.0.1:55880"}');
      SELECT setval(pg_get_serial_sequence('support_chat_sessions','id'),1);
      INSERT INTO support_chat_messages(session_id,role,content,processing_status) VALUES(1,'assistant','Synthetic answer','completed')`);
  }
  it.each(['garbage', '', '0', 0, -1, '1junk', '1.5', 1.5, true, false, {}, [], '1e0', ' 1 ', 2147483648, '9007199254740993'])(
    'rejects malformed supplied chat session identity %p without a write or model invocation', async sessionId => {
      await seedSession();
      const result = await chat({ sessionId, sessionToken: 'session-secret' });
      expect(result.status).toBe(400);
      expect((await pool.query('SELECT count(*)::int n FROM support_chat_sessions')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int n FROM support_chat_messages')).rows[0].n).toBe(1);
      expect(handle).not.toHaveBeenCalled();
    },
  );
  it.each(['1junk', '1.5', '-1', '2147483648', '9007199254740993'])(
    'rejects malformed history identity %s instead of aliasing a session', async id => {
      await seedSession();
      expect((await history(id)).status).toBe(400);
    },
  );
  it('accepts numeric/string IDs and separates session credentials and widget teams', async () => {
    await seedSession();
    expect((await history('1')).body.data[0].content).toBe('Synthetic answer');
    expect((await history('1', 'wrong-secret')).status).toBe(403);
    expect((await history('1', 'session-secret', otherToken)).status).toBe(403);
    expect((await chat({ sessionId: '1', sessionToken: 'wrong-secret' })).status).toBe(403);
    expect((await chat({ token: otherToken, sessionId: 1, sessionToken: 'session-secret' })).status).toBe(403);
    await pool.query("UPDATE support_chat_sessions SET session_expires_at=NOW()-INTERVAL '1 second'");
    expect((await history('1')).status).toBe(440);
    expect((await chat({ sessionId: 1, sessionToken: 'session-secret' })).status).toBe(440);
  });
  it('persists encrypted PII, isolates reveal bindings and redacts public history', async () => {
    const raw = 'My email is synthetic@example.test';
    const sent = await chat({ message: raw, clientSessionKey: 'audit-session-pii' });
    expect(sent.status).toBe(200);
    const id = sent.body.data.sessionId;
    expect(JSON.stringify(sent.body)).not.toContain('synthetic@example.test');
    const vault = (await pool.query('SELECT * FROM support_privacy_vault')).rows[0];
    expect(vault).toBeDefined();
    expect(JSON.stringify(vault)).not.toContain('synthetic@example.test');
    expect(await privacyVaultService.reveal(10, vault.id, { conversationId: -id, actor: 'test', purpose: 'fixture' })).toBeNull();
    expect(await privacyVaultService.reveal(9, vault.id, { conversationId: -999, actor: 'test', purpose: 'fixture' })).toBeNull();
    expect(await privacyVaultService.reveal(9, vault.id, { conversationId: -id, actor: 'test', purpose: 'fixture' })).toMatchObject({ rawText: raw });
    expect((await pool.query('SELECT count(*)::int n FROM support_privacy_access_logs')).rows[0].n).toBe(1);
    const loaded = await history(String(id), sent.body.data.sessionToken);
    expect(JSON.stringify(loaded.body)).not.toContain('synthetic@example.test');
    await pool.query("UPDATE support_privacy_vault SET expires_at=NOW()-INTERVAL '1 second'");
    expect(await privacyVaultService.reveal(9, vault.id, { conversationId: -id, actor: 'test', purpose: 'fixture' })).toBeNull();
    expect(await privacyVaultService.purgeExpired()).toBe(1);
  });
  it('keeps the read budget independent from writes and rejects the eleventh public action', async () => {
    await seedSession();
    for (let index = 0; index < 15; index++) expect((await history('1')).status).toBe(200);
    for (let index = 0; index < 10; index++) expect((await chat({ token: 'c'.repeat(64) })).status).toBe(404);
    expect((await chat({ token: 'c'.repeat(64) })).status).toBe(429);
  });
  it('deduplicates simultaneous first messages and rejects reuse with different content', async () => {
    let started!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    const providerPending = new Promise<void>(resolve => { release = resolve; });
    handle.mockImplementationOnce(async () => { started(); await providerPending; return { deliveryOutcome: 'no_op' }; });
    const first = chat({ clientSessionKey: 'concurrent-first' }).then(response => response);
    await providerStarted;
    const duplicate = await chat({ clientSessionKey: 'concurrent-first' });
    release();
    const responses = [await first, duplicate];
    expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
    expect(responses.find(res => res.status === 409)?.body.error).toBe('This message is still being processed. Retry shortly.');
    expect((await pool.query('SELECT count(*)::int n FROM support_chat_sessions')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM support_chat_messages')).rows[0].n).toBe(1);
    expect(handle).toHaveBeenCalledTimes(1);
    const conflict = await chat({ clientSessionKey: 'concurrent-first', message: 'Different content' });
    expect(conflict.status).toBe(409);
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it('replays a completed no-op after a lost response without claiming it is still processing', async () => {
    const first = await chat({ clientSessionKey: 'completed-no-op' });
    expect(first.status).toBe(200);
    expect(first.body.data.userMessage.processingStatus).toBe('completed');
    const { sessionId, sessionToken } = first.body.data;
    expect((await pool.query('SELECT processing_status FROM support_chat_messages')).rows[0].processing_status).toBe('completed');
    const replay = await chat({ sessionId, sessionToken });
    expect(replay.status).toBe(202);
    expect(replay.body.data).toMatchObject({ sessionId, sessionToken, processingStatus: 'completed', assistantMessage: null });
    expect(handle).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT count(*)::int n FROM support_chat_messages')).rows[0].n).toBe(1);
  });
  it('requires the session credential even with ambient account cookies and invalidates old widget keys', async () => {
    await seedSession();
    const anonymous = await request(app).get('/api/support-widget/session/1/messages').query({ token })
      .set('Cookie', 'token=synthetic-owner-cookie; support_token=synthetic-staff-cookie');
    expect(anonymous.status).toBe(401);
    await pool.query('UPDATE support_teams SET widget_token=$1 WHERE id=1', ['c'.repeat(64)]);
    expect((await history('1')).status).toBe(404);
    expect((await history('1', 'session-secret', 'c'.repeat(64))).status).toBe(200);
    await pool.query('UPDATE support_teams SET widget_token=NULL WHERE id=1');
    expect((await history('1', 'session-secret', 'c'.repeat(64))).status).toBe(404);
  });
  it('binds feedback to the same team, credential and creation origin and redacts comments', async () => {
    await seedSession();
    const feedback = (origin: string, credential = 'session-secret', widgetToken = token) => request(app)
      .post('/api/support-widget/session/1/feedback').set('Origin', origin)
      .send({ token: widgetToken, sessionToken: credential, rating: 'not_helpful', comment: 'Email synthetic@example.test' });
    expect((await feedback('http://other.example')).status).toBe(403);
    expect((await feedback('http://127.0.0.1:55880', 'wrong-secret')).status).toBe(403);
    expect((await feedback('http://127.0.0.1:55880', 'session-secret', otherToken)).status).toBe(403);
    const saved = await feedback('http://127.0.0.1:55880');
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain('synthetic@example.test');
    expect(JSON.stringify((await pool.query('SELECT metadata FROM support_chat_sessions')).rows)).not.toContain('synthetic@example.test');
  });
  (process.env.SUPPORT_PUBLIC_WIDGET_QA_BROWSER === '1' ? it : it.skip)('browser starts a new PostgreSQL session after an expired uncertain first message', async () => {
    await pool.query(`INSERT INTO support_chat_sessions(id,member_id,public_token,session_expires_at,client_session_key,metadata)
      VALUES(1,1,'expired-secret',NOW()-INTERVAL '1 hour','widget:9:1:retry-session','{"source":"widget"}');
      SELECT setval(pg_get_serial_sequence('support_chat_sessions','id'),1)`);
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await page.addInitScript(({ widgetToken }) => {
        if (localStorage.getItem(`sw_session_${widgetToken}`)) return;
        sessionStorage.setItem(`conversation-attempt:anonymous:widget:${widgetToken}:new`, JSON.stringify({
          requestId: 'retry-old-request', clientSessionKey: 'retry-session', text: 'Hours?', fingerprint: JSON.stringify(['Hours?', null]),
        }));
      }, { widgetToken: token });
      const bodies: Record<string, unknown>[] = [];
      page.on('request', req => { if (req.url().endsWith('/api/support-widget/chat')) bodies.push(req.postDataJSON()); });
      await page.goto(`http://127.0.0.1:55880/support-widget/${token}`);
      const input = page.getByRole('textbox', { name: 'Message to support' });
      await input.waitFor();
      await input.press('Enter');
      await page.getByText(/This conversation has expired/).waitFor();
      await page.getByRole('button', { name: 'New chat' }).click();
      await input.fill('Hours?');
      const reply = page.waitForResponse(res => res.url().endsWith('/api/support-widget/chat'));
      await input.press('Enter');
      await reply;
      expect(bodies).toHaveLength(2);
      expect(bodies[1].clientSessionKey).not.toBe('retry-session');
      expect((await pool.query('SELECT count(*)::int n FROM support_chat_sessions WHERE session_expires_at>NOW()')).rows[0].n).toBe(1);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
        expect(await page.evaluate<number>('devicePixelRatio')).toBe(1);
      }
      await page.reload();
      await page.getByRole('log').getByText('Hours?', { exact: true }).waitFor();
      expect(await input.inputValue()).toBe('');
      const credential = await page.evaluate<string>('localStorage.getItem("sw_session_" + location.pathname.split("/").at(-1) + "_token")');
      failHistoryOnce = true;
      await page.reload();
      await page.getByRole('log').getByText('Hours?', { exact: true }).waitFor();
      expect(await page.evaluate<string>('localStorage.getItem("sw_session_" + location.pathname.split("/").at(-1) + "_token")')).toBe(credential);
      await page.screenshot({ path: '../audit/support-ai-2026-10-23/public-widget-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: '../audit/support-ai-2026-10-23/public-widget-mobile.png' });
    } finally { await browser.close(); }
  }, 120000);
});
