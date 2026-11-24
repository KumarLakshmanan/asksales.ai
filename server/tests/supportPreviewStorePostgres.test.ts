import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, property) => (fixtureDb as any)[property].bind(fixtureDb),
}) }));
const { supportPreviewStore } = await import('../services/agents/orchestration/SupportPreviewStore.js');
const { DEFAULT_SUPPORT_PLAYBOOKS } = await import('../services/agents/orchestration/DefaultSupportConfiguration.js');
const local = process.env.SUPPORT_KNOWLEDGE_LOCAL_QA === '1' ? describe : describe.skip;
local('encrypted preview state (isolated local PostgreSQL)', () => {
  let pool: Pool; let admin: Pool; let schema: string;
  const priorKey = process.env.SUPPORT_PII_ENCRYPTION_KEY;
  beforeAll(async () => {
    dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('QA requires local PostgreSQL');
    process.env.SUPPORT_PII_ENCRYPTION_KEY = 'preview-fixture-encryption-key-at-least-32-chars';
    const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '', connectionTimeoutMillis: 5000 };
    schema = `support_preview_qa_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ ...config, max: 1 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 2, options: `-c search_path=${schema},pg_catalog` });
    fixtureDb = drizzle(pool);
    await pool.query('CREATE TABLE support_preview_sessions(business_profile_id integer NOT NULL DEFAULT 91,user_id integer,conversation_id integer,payload jsonb,expires_at timestamptz,PRIMARY KEY(business_profile_id,user_id,conversation_id))');
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_preview_qa_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    if (priorKey === undefined) delete process.env.SUPPORT_PII_ENCRYPTION_KEY; else process.env.SUPPORT_PII_ENCRYPTION_KEY = priorKey;
  });
  it('persists protected collected fields across turns, isolates tenants, and expires', async () => {
    const graph = DEFAULT_SUPPORT_PLAYBOOKS.find(item => item.key === 'technical-ticket-status-v1')!.graph;
    const snapshot: any = { graph, run: { id: 0, userId: 9, conversationId: -190, currentNodeId: 'collect', status: 'active',
      state: { fields: { 'ticket.id': { value: 'secret-ticket-id', status: 'collected' } } } } };
    await supportPreviewStore.save(9, -190, snapshot);
    expect(JSON.stringify((await pool.query('SELECT payload FROM support_preview_sessions')).rows)).not.toContain('secret-ticket-id');
    expect(await supportPreviewStore.load(9, -190)).toEqual(snapshot);
    expect(await supportPreviewStore.load(10, -190)).toBeNull();
    await pool.query('UPDATE support_preview_sessions SET expires_at=NOW()-INTERVAL \'1 second\'');
    expect(await supportPreviewStore.load(9, -190)).toBeNull();
  });
  it('only commits the matching turn and completes a successful capability immediately', async () => {
    const graph = DEFAULT_SUPPORT_PLAYBOOKS.find(item => item.key === 'technical-ticket-status-v1')!.graph;
    const capability = graph.nodes.find(node => node.type === 'capability')!;
    const snapshot: any = { graph, run: { id: 0, userId: 9, conversationId: -191, currentNodeId: 'collect', status: 'active',
      state: { agentType: 'tech_support', proposedNodeId: capability.id, proposedEventKey: 'turn-2' } } };
    await supportPreviewStore.save(9, -191, snapshot);
    const outcome = { capabilityName: 'ticket.status', capabilityStatus: 'success' };
    await supportPreviewStore.commit(9, -191, outcome, 'turn-1');
    expect((await supportPreviewStore.load(9, -191))?.run.currentNodeId).toBe('collect');
    await supportPreviewStore.commit(9, -191, outcome, 'turn-2');
    expect((await supportPreviewStore.load(9, -191))?.run.status).toBe('completed');
    expect((await supportPreviewStore.load(9, -191))?.run.state.lastEventKey).toBe('turn-2');
  });
});
