import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { localBusinessFunctions, localBusinessIsolation } from './helpers/localBusinessPostgres.js';

let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, key) => {
    const value = Reflect.get(fixtureDb, key);
    return typeof value === 'function' ? value.bind(fixtureDb) : value;
  },
}) }));
// Only automatic starter provisioning is suppressed; CRUD, locks, audit, RLS and encryption are real.
jest.unstable_mockModule('../services/agents/orchestration/DefaultSupportProvisioningService.js', () => ({
  ensureDefaultSupportConfiguration: async () => undefined,
}));
const controller = await import('../controllers/supportOrchestrationController.js');
const { DEFAULT_SUPPORT_PLAYBOOKS } = await import('../services/agents/orchestration/DefaultSupportConfiguration.js');
const { supportPreviewStore } = await import('../services/agents/orchestration/SupportPreviewStore.js');
const { aiAgentConfigsTable } = await import('../models/aiAgentConfigs/schema.js');
const tables = await import('../models/supportOrchestration/schema.js');
const local = process.env.SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL ? describe : describe.skip;

local('playbook publication and preview audit in isolated PostgreSQL with forced RLS', () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  const app = express();
  app.use(express.json());
  // Synthetic session establishment. This suite does not claim to verify JWT authentication.
  app.use((req, _res, next) => {
    const actor = Number(req.get('X-Audit-User') || 9);
    req.user = { id: actor } as typeof req.user;
    withBusinessScope({ userId: actor, businessProfileId: Number(req.get('X-Audit-Profile') || 91) }, next);
  });
  app.post('/playbooks', controller.createPlaybook);
  app.get('/playbooks/:id', controller.getPlaybook);
  app.put('/playbooks/:id', controller.updatePlaybook);
  app.post('/playbooks/:id/publish', controller.publishPlaybook);
  app.patch('/playbooks/:id/enabled', controller.setPlaybookEnabled);
  app.post('/playbooks/:id/archive', controller.archivePlaybook);
  app.post('/playbooks/:id/assignments', controller.createPlaybookAssignment);
  app.use(controller.supportOrchestrationErrorHandler);
  const graph = DEFAULT_SUPPORT_PLAYBOOKS.find(item => item.key === 'technical-ticket-status-v1')!.graph;
  const inProfile = <T>(profile: number, work: () => T) => withBusinessScope({ userId: 9, businessProfileId: profile }, work);

  beforeAll(async () => {
    const connectionString = process.env.SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL!;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Explicit loopback fixture required');
    process.env.SUPPORT_PII_ENCRYPTION_KEY = 'synthetic-playbook-audit-encryption-key-32-chars';
    schema = `support_playbook_audit_${randomBytes(8).toString('hex')}`;
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},pg_catalog` });
    await localBusinessFunctions(pool);
    await pool.query('CREATE TABLE company_settings(id INTEGER PRIMARY KEY,user_id INTEGER); INSERT INTO company_settings VALUES(91,9),(92,9),(101,10)');
    for (const table of [aiAgentConfigsTable, tables.supportPlaybooksTable, tables.supportPlaybookVersionsTable,
      tables.supportPlaybookAssignmentsTable, tables.supportPlaybookTemplatesTable, tables.supportAdminAuditLogsTable]) {
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
    await pool.query(`CREATE UNIQUE INDEX playbook_versions_unique ON support_playbook_versions(playbook_id,version);
      CREATE UNIQUE INDEX playbook_names_unique ON support_playbooks(business_profile_id,user_id,agent_type,name);
      CREATE TABLE support_preview_sessions(business_profile_id INTEGER DEFAULT app_business_profile_id(),user_id INTEGER,
        conversation_id INTEGER,payload JSONB,expires_at TIMESTAMPTZ,PRIMARY KEY(business_profile_id,user_id,conversation_id))`);
    await localBusinessIsolation(pool, schema, ['ai_agent_configs', 'support_playbooks', 'support_playbook_versions',
      'support_playbook_assignments', 'support_admin_audit_logs', 'support_preview_sessions']);
    fixtureDb = drizzle(createBusinessScopedPool(pool));
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^support_playbook_audit_[a-f0-9]{16}$/.test(schema)) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ai_agent_configs,support_playbooks,support_playbook_versions,support_playbook_assignments,
      support_admin_audit_logs,support_preview_sessions RESTART IDENTITY;
      INSERT INTO ai_agent_configs(business_profile_id,user_id,agent_type,enabled) VALUES(91,9,'tech_support',true),(92,9,'tech_support',true),(101,10,'tech_support',true)`);
  });
  it('publishes immutable version snapshots under concurrent requests and preserves them after draft edits', async () => {
    const created = await request(app).post('/playbooks').send({ name: 'Synthetic ticket flow', graph });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).patch(`/playbooks/${id}/enabled`).send({ enabled: true })).status).toBe(409);
    const publications = await Promise.all([request(app).post(`/playbooks/${id}/publish`), request(app).post(`/playbooks/${id}/publish`)]);
    expect(publications.map(res => res.status)).toEqual([200, 200]);
    expect(publications.map(res => res.body.version).sort()).toEqual([1, 2]);
    const snapshots = (await pool.query('SELECT graph,checksum FROM support_playbook_versions ORDER BY version')).rows;
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect((await request(app).put(`/playbooks/${id}`).send({ name: 'Edited draft', graph: { ...graph, metadata: { ...graph.metadata, label: 'New draft' } } })).status).toBe(200);
    expect((await pool.query('SELECT graph,checksum FROM support_playbook_versions ORDER BY version')).rows).toEqual(snapshots);
    expect((await pool.query("SELECT count(*)::int n FROM support_admin_audit_logs WHERE action='playbook.publish'")).rows[0].n).toBe(2);
  });
  it('hides a playbook from other owners and profiles and archives its assignments atomically', async () => {
    const created = await request(app).post('/playbooks').send({ name: 'Synthetic scope flow', graph });
    const id = created.body.id;
    expect((await request(app).get(`/playbooks/${id}`).set('X-Audit-Profile', '92')).status).toBe(404);
    expect((await request(app).put(`/playbooks/${id}`).set('X-Audit-User', '10').set('X-Audit-Profile', '101').send({ name: 'Foreign' })).status).toBe(404);
    await request(app).post(`/playbooks/${id}/publish`);
    await pool.query("INSERT INTO support_playbook_assignments(business_profile_id,user_id,playbook_id,agent_type,enabled) VALUES(91,9,$1,'tech_support',true)", [id]);
    expect((await request(app).post(`/playbooks/${id}/archive`)).status).toBe(200);
    expect((await pool.query('SELECT enabled FROM support_playbook_assignments')).rows).toEqual([{ enabled: false }]);
    expect((await pool.query('SELECT status FROM support_playbooks')).rows[0].status).toBe('archived');
  });
  it('encrypts preview state, isolates the same preview ID across profiles, and expires it', async () => {
    const snapshot = { graph, run: { id: 0, userId: 9, conversationId: -1900000001, currentNodeId: 'collect', status: 'active',
      state: { fields: { 'ticket.id': { value: 'synthetic-private-ticket', status: 'collected' } } } } };
    await inProfile(91, () => supportPreviewStore.save(9, -1900000001, snapshot as never));
    expect(JSON.stringify((await pool.query('SELECT payload FROM support_preview_sessions')).rows)).not.toContain('synthetic-private-ticket');
    expect(await inProfile(91, () => supportPreviewStore.load(9, -1900000001))).toEqual(snapshot);
    expect(await inProfile(92, () => supportPreviewStore.load(9, -1900000001))).toBeNull();
    await pool.query("UPDATE support_preview_sessions SET expires_at=NOW()-INTERVAL '1 second'");
    expect(await inProfile(91, () => supportPreviewStore.load(9, -1900000001))).toBeNull();
  });
});
