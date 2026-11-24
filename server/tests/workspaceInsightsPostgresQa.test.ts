import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

const connectionString = process.env.OUTREACH_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
let businessProfileId = 11;
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: (...args: Parameters<NodePgDatabase['execute']>) => database.execute(...args) } }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({
  requireBusinessScope: () => ({ userId: 7, actorUserId: 7, businessProfileId }),
  withSystemScope: async (_reason: string, work: () => Promise<unknown>) => work(),
}));
jest.unstable_mockModule('../tenancy/billingContext.js', () => ({ currentBillingScope: () => ({ organizationId: 23 }) }));
jest.unstable_mockModule('../services/billing/organizations.js', () => ({ requireBillingRole: async () => ({}) }));
jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess: async () => ['billing', 'outreach', 'support', 'crm'].map(key => ({ key, enabled: true })) }));
jest.unstable_mockModule('../services/insights/RuntimeService.js', () => ({ getInsightsRuntime: async () => ({ enabled: true, instrumentationStartedAt: '2026-01-01T00:00:00Z' }) }));
const { parseInsightsQuery, getWorkspaceInsights, getInsightsDetails } = await import('../services/insights/QueryService.js');

suite('Workspace Insights actual PostgreSQL queries', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit local QA database required');
    client = new Client({ connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA insights_qa_${process.pid}; SET search_path TO insights_qa_${process.pid},pg_catalog`);
    database = drizzle(client);
    await client.query(`
      CREATE TABLE ai_usage_events(id INTEGER, business_profile_id INTEGER,kind TEXT,process TEXT,provider TEXT,model TEXT,channel TEXT,conversation_kind TEXT,conversation_id INTEGER,contact_id INTEGER,status TEXT,input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,cached_tokens INTEGER,reasoning_tokens INTEGER,duration_ms INTEGER,units NUMERIC,occurred_at TIMESTAMPTZ);
      CREATE TABLE outreach_conversations(id INTEGER,business_profile_id INTEGER,crm_contact_id INTEGER,channel TEXT);
      CREATE TABLE outreach_messages(id INTEGER,business_profile_id INTEGER,conversation_id INTEGER,direction TEXT,status TEXT,message_kind TEXT,message_type TEXT,sent_at TIMESTAMP,created_at TIMESTAMP,provider_message_id TEXT,external_message_id TEXT);
      CREATE TABLE support_chat_sessions(id INTEGER,business_profile_id INTEGER);
      CREATE TABLE support_chat_messages(id INTEGER,business_profile_id INTEGER,session_id INTEGER,role TEXT,processing_status TEXT,metadata JSONB,created_at TIMESTAMP);
      CREATE TABLE sales_outcome_events(id INTEGER,business_profile_id INTEGER,kind TEXT,contact_id INTEGER,booking_id INTEGER,conversation_kind TEXT,conversation_id INTEGER,channel TEXT,amount NUMERIC,currency TEXT,evidence TEXT,payment_id TEXT,verified BOOLEAN,occurred_at TIMESTAMPTZ);
      CREATE TABLE crm_contacts(id INTEGER,business_profile_id INTEGER,merged_into_contact_id INTEGER,first_name TEXT,last_name TEXT,company TEXT);
      CREATE TABLE wallet_transactions(id INTEGER,organization_id INTEGER,billing_business_profile_id INTEGER,type TEXT,amount NUMERIC,created_at TIMESTAMP,metadata JSONB,category TEXT,reference_type TEXT,reference_id TEXT);
      CREATE TABLE tool_approvals(business_profile_id INTEGER,status TEXT,created_at TIMESTAMP);
    `);
    const at = new Date().toISOString();
    await client.query(`INSERT INTO ai_usage_events(id,business_profile_id,kind,process,provider,model,channel,status,total_tokens,occurred_at) VALUES(1,11,'text','support','fixture','fixture','email','success',5,$1),(2,12,'text','support','fixture','fixture','email','success',99,$1)`, [at]);
    await client.query(`INSERT INTO outreach_conversations VALUES(1,11,1,'email'); INSERT INTO crm_contacts VALUES(1,11,NULL,'Fixture','Contact','Synthetic')`);
    await client.query(`INSERT INTO outreach_messages(id,business_profile_id,conversation_id,direction,status,message_kind,message_type,created_at) VALUES(1,11,1,'inbound','received','reply','text',$1::timestamptz AT TIME ZONE 'UTC')`, [at]);
    await client.query(`INSERT INTO wallet_transactions VALUES(1,23,11,'deduction',-2,$1::timestamptz AT TIME ZONE 'UTC','{}','support',NULL,NULL)`, [at]);
  });
  afterAll(async () => {
    if (client) { await client.query(`DROP SCHEMA IF EXISTS insights_qa_${process.pid} CASCADE`); await client.end(); }
  });
  it('loads the default range repeatedly and isolates another selected business', async () => {
    const query = parseInsightsQuery({}, 'UTC');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await getWorkspaceInsights(query);
      expect(result.performance.calls).toBe(1);
      expect(result.performance.totalTokens).toBe(5);
      expect(result.messages.incoming).toBe(1);
      expect(result.costs.net.credits).toBe('2.00');
    }
    for (const kind of ['usage', 'tools', 'sales', 'conversations', 'charges'] as const) {
      await expect(getInsightsDetails(query, kind, 2147483647, 25)).resolves.toHaveProperty('items');
    }
    businessProfileId = 12;
    const other = await getWorkspaceInsights(query);
    expect(other.performance.totalTokens).toBe(99);
    expect(other.messages.incoming).toBe(0);
    expect(other.costs.net.credits).toBe('0.00');
  });
});
