import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';

const runPostgres = process.env.SUPPORT_EMAIL_LOCAL_QA === '1' ? describe : describe.skip;
jest.setTimeout(30000);
let fixtureDb: any;
const proxy = new Proxy({}, { get: (_target, key) => (...args: any[]) => fixtureDb[key](...args) });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { publish: jest.fn() } }));
jest.unstable_mockModule('../models/outreachConversations/functions.js', () => ({}));
jest.unstable_mockModule('../services/SentimentAnalysisService.js', () => ({ sentimentAnalysisService: {} }));
jest.unstable_mockModule('../utils/emailTemplates.js', () => ({
  getBrandInfo: async () => ({ companyName: 'QA', logoUrl: null, primaryColor: '#123456' }),
  renderBrandedEmail: () => '<p>Ticket created</p>',
}));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  privacyVaultService: {}, redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
const { persistInboundEmailRecords, routeReplyToActiveTicket, findOriginalMessage, resolveUserId } = await import('../services/InboundEmailService.js');
const { leadsTable } = await import('../models/leads/schema.js');
const { outreachConversationsTable, outreachMessagesTable } = await import('../models/outreachConversations/schema.js');
const { sentMessagesTable } = await import('../models/sentMessages/schema.js');
const { supportTicketsTable } = await import('../models/supportTickets/schema.js');
const { supportTicketMessagesTable } = await import('../models/supportTicketMessages/schema.js');
const { supportTeamsTable } = await import('../models/supportTeams/schema.js');
const { teamMembersTable } = await import('../models/teamMembers/schema.js');
const { supportDeliveryOutboxTable } = await import('../models/supportOrchestration/schema.js');

runPostgres('inbound email persistence (isolated local PostgreSQL schema)', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  const input = { userId: 9, leadId: 12, conversationId: 68, provider: 'gmail' as const,
    externalId: '<provider-message@example.test>', body: 'Customer reply', subject: 'Help', leadName: 'QA' };

  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env.development'), override: true, quiet: true } as any);
    dotenv.config({ path: resolve(process.cwd(), '.env'), override: true, quiet: true } as any);
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Email QA requires local PostgreSQL');
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_email_persistence_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 3, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    // Actual application column names/types/defaults, with external FKs omitted
    // so the test cannot require or reach any application tenant data.
    for (const table of [leadsTable, outreachConversationsTable, outreachMessagesTable, sentMessagesTable,
      supportTicketsTable, supportTicketMessagesTable, supportTeamsTable, teamMembersTable, supportDeliveryOutboxTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map((column) => {
        const value = column.default;
        const defaultSql = value instanceof SQL ? new PgDialect().sqlToQuery(value).sql
          : value === undefined ? undefined : typeof value === 'number' || typeof value === 'boolean' ? String(value)
            : `'${(typeof value === 'string' ? value : JSON.stringify(value)).replace(/'/g, "''")}'`;
        return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}`;
      });
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(', ')})`);
    }
    await pool.query('CREATE UNIQUE INDEX delivery_key_uq ON support_delivery_outbox(decision_key)');
    await pool.query(`CREATE TABLE users(id int PRIMARY KEY,email text);
      CREATE TABLE email_senders(user_id int,email text,is_verified boolean);
      CREATE TABLE resend_domains(user_id int,name text,status text);
      CREATE TABLE channel_credentials(user_id int,platform text,account_identifier text,is_active boolean);
      CREATE TABLE crm_contacts(id int,user_id int,deleted_at timestamp);
      CREATE TABLE support_member_presence_sessions(user_id int,member_id int,ended_at timestamp,last_seen_at timestamp,end_reason text,updated_at timestamp);
      CREATE TABLE support_capacity_settings(user_id int,handling_minutes_per_ticket int,social_fallback_sla_minutes int,email_fallback_sla_minutes int)`);
    await pool.query(`CREATE FUNCTION reject_fixture_native() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.content = 'FAIL_NATIVE' THEN RAISE EXCEPTION 'fixture native rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_native BEFORE INSERT ON outreach_messages FOR EACH ROW EXECUTE FUNCTION reject_fixture_native();
      CREATE FUNCTION reject_fixture_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF current_setting('support_fixture.reject_outbox', true) = 'yes' THEN RAISE EXCEPTION 'fixture outbox rejection'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_outbox BEFORE INSERT ON support_delivery_outbox FOR EACH ROW EXECUTE FUNCTION reject_fixture_outbox()`);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_email_persistence_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE leads,outreach_conversations,outreach_messages,sent_messages,support_tickets,support_ticket_messages,support_teams,team_members,support_delivery_outbox,users,email_senders,resend_domains,channel_credentials RESTART IDENTITY');
    await pool.query("INSERT INTO users(id,email) VALUES(9,'owner@example.test'),(10,'other@another.test')");
    await pool.query("INSERT INTO leads(id,user_id,email,status) VALUES(12,9,'qa@example.test','new')");
    await pool.query("INSERT INTO outreach_conversations(id,user_id,lead_id,channel,integration_provider,lead_email,external_thread_id) VALUES(68,9,12,'gmail','gmail','qa@example.test','thread-A')");
  });

  async function ticket(id = 59, conversationId = 68, deleted = false) {
    await pool.query("INSERT INTO support_tickets(id,user_id,lead_id,outreach_conversation_id,ticket_number,subject,status,deleted_at) VALUES($1,9,12,$2,$3,'Help','waiting_on_customer',$4)",
      [id, conversationId, `TKT-${id}`, deleted ? new Date() : null]);
  }

  it('deduplicates eight concurrent provider deliveries and increments both message/engagement counters once', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => persistInboundEmailRecords(input)));
    expect(new Set(results.map((result) => result.inboundMsg.id)).size).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int n FROM sent_messages')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM outreach_messages')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT total_messages,unread_count FROM outreach_conversations')).rows[0]).toEqual({ total_messages: 1, unread_count: 1 });
    expect((await pool.query('SELECT replied_emails FROM leads')).rows[0].replied_emails).toBe(1);
  });

  it('rolls back the legacy receipt when native insertion fails, then succeeds cleanly on retry', async () => {
    await expect(persistInboundEmailRecords({ ...input, body: 'FAIL_NATIVE' })).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int n FROM sent_messages')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT replied_emails FROM leads')).rows[0].replied_emails).toBe(0);
    expect((await persistInboundEmailRecords(input)).duplicate).toBe(false);
  });

  it('repairs a legacy sent-only gap without duplicating its row or its previous engagement count', async () => {
    await pool.query("INSERT INTO sent_messages(id,user_id,lead_id,lead_name,channel,message,is_reply,message_id) VALUES(91,9,12,'QA','gmail','Customer reply',true,$1)", [input.externalId]);
    await pool.query('UPDATE leads SET replied_emails=1 WHERE id=12');
    const result = await persistInboundEmailRecords(input);
    expect(result.recovered).toBe(true);
    expect(result.exactSentMessageId).toBe(91);
    expect((await pool.query('SELECT count(*)::int n FROM sent_messages')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT replied_emails FROM leads')).rows[0].replied_emails).toBe(1);
  });

  it('routes concurrent copies to the exact ticket once, excluding newer foreign-thread and deleted tickets', async () => {
    const persisted = await persistInboundEmailRecords(input);
    await ticket(); await ticket(60, 70); await ticket(61, 68, true);
    const results = await Promise.all(Array.from({ length: 8 }, () => routeReplyToActiveTicket(9, 12, 68, persisted.inboundMsg.id, input.body, '[QA]')));
    expect(results.every((result) => result === 'routed')).toBe(true);
    expect((await pool.query('SELECT ticket_id FROM support_ticket_messages')).rows).toEqual([{ ticket_id: 59 }]);
    expect((await pool.query('SELECT total_messages,unread_count,status FROM support_tickets WHERE id=59')).rows[0])
      .toEqual({ total_messages: 1, unread_count: 1, status: 'in_progress' });
    await pool.query('UPDATE support_tickets SET deleted_at=NOW() WHERE id=59');
    expect(await routeReplyToActiveTicket(9, 12, 68, persisted.inboundMsg.id, input.body, '[QA]')).toBe('routed');
    expect((await pool.query('SELECT count(*)::int n FROM support_ticket_messages')).rows[0].n).toBe(1);
  });

  it('does not let a foreign Message-ID or a mismatched sender select a different tenant/contact', async () => {
    await pool.query("INSERT INTO leads(id,user_id,email,name,status) VALUES(13,10,'foreign@example.test','Foreign','new')");
    await pool.query("INSERT INTO sent_messages(user_id,lead_id,lead_name,channel,message,subject,is_reply,message_id) VALUES(10,13,'Foreign','email','secret','Help',false,'<foreign@example.test>')");
    expect(await findOriginalMessage(9, '<foreign@example.test>', 'foreign@example.test', 'foreign@example.test')).toBeNull();
    await pool.query("INSERT INTO sent_messages(user_id,lead_id,lead_name,channel,message,subject,is_reply,message_id) VALUES(9,12,'QA','email','reply','Help',false,'<mine@example.test>')");
    expect(await findOriginalMessage(9, '<mine@example.test>', 'attacker@example.test', 'attacker@example.test')).toBeNull();
    expect((await findOriginalMessage(9, '<mine@example.test>', 'qa@example.test', 'qa@example.test'))?.lead_id).toBe(12);
  });

  it('fails closed on conflicting configured inbox owners rather than recipient ordering', async () => {
    expect(await resolveUserId(['owner@example.test'])).toBe(9);
    await pool.query("INSERT INTO email_senders(user_id,email,is_verified) VALUES(10,'owner@example.test',true)");
    expect(await resolveUserId(['owner@example.test'])).toBeUndefined();
    expect(await resolveUserId(['owner@example.test', 'other@another.test'])).toBeUndefined();
  });
});
