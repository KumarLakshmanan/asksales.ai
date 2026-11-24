import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import type { AdminApiCredentialRecord } from '../models/adminApiCredentials/schema.js';
import { mockAdminRequest, mockResponse } from './helpers/mockHelpers.js';
// @ts-expect-error JS migration has no TS declarations.
import { up } from '../migrations/327_assistant_model_catalog.js';
// @ts-expect-error JS migration has no TS declarations.
import { up as registerScope, down as unregisterScope } from '../migrations/328_assistant_model_catalog_scope.js';

const target = process.env.ASSISTANT_MODEL_QA_DATABASE_URL;
const suite = target ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
const schema = `model_catalog_${randomUUID().replaceAll('-', '')}`;
const credentials = [
  { id: 1, platform: 'openai', name: 'Primary', apiKey: 'never-expose-fixture-secret', isActive: true, config: { model: 'fixture-old' } },
  { id: 2, platform: 'openrouter', name: 'Router', apiKey: 'never-expose-router-secret', isActive: true, config: {} },
  { id: 3, platform: 'openai', name: 'Offline', apiKey: 'never-expose-offline-secret', isActive: false, config: {} },
];
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get: (_target, name) => {
  const value = database[name as keyof NodePgDatabase];
  return typeof value === 'function' ? value.bind(database) : value;
} }) }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  LLM_ADMIN_PLATFORMS: ['openai', 'openrouter', 'gemini', 'vertex_ai', 'custom_ai'],
  getAdminCredentialsByPlatform: async (platform: string) => credentials.filter(item => item.platform === platform) as unknown as AdminApiCredentialRecord[],
  sortActiveCredentials: (rows: AdminApiCredentialRecord[]) => rows.filter(item => item.isActive),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const { getAdminAssistantModels, saveAdminAssistantModel } = await import('../controllers/adminAssistantModelsController.js');
const { resolveAssistantModelCredential } = await import('../services/assistants/AssistantModelCatalogService.js');
const input = { provider: 'openai', credentialId: 1, model: 'fixture-old', label: 'Customer GPT', description: 'Customer replies', enabled: true, order: 2, expectedVersion: 0 };
async function save(body: Record<string, unknown>, id?: number) {
  const response = mockResponse();
  await saveAdminAssistantModel(mockAdminRequest(1, { params: id ? { id: String(id) } : {}, body }), response);
  return response;
}
let entryId: number;

suite('admin model catalog persisted and enforced in isolated PostgreSQL', () => {
  beforeAll(async () => {
    if (!target || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) throw new Error('Explicit local QA database required');
    client = new Client({ connectionString: target }); await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}",pg_catalog;
      DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salesmarketing_business_runtime') THEN CREATE ROLE salesmarketing_business_runtime NOLOGIN; END IF; END $$;
      GRANT USAGE ON SCHEMA "${schema}" TO salesmarketing_business_runtime;
      CREATE TABLE admins(id integer PRIMARY KEY);
      CREATE TABLE admin_api_credentials(id integer PRIMARY KEY);
      CREATE TABLE business_scope_accounts(table_name text PRIMARY KEY);
      CREATE TABLE admin_credential_audit(id serial PRIMARY KEY,credential_id integer,platform text,action text,admin_id integer REFERENCES admins(id) CHECK(admin_id<>999),changed_fields jsonb,message text);
      INSERT INTO admins VALUES(1),(999); INSERT INTO admin_api_credentials VALUES(1),(2),(3);
      SELECT set_config('app.business_system','on',false);`);
    await up(client);
    await registerScope(client);
    database = drizzle(client);
  });
  afterAll(async () => { if (client) { await client.query(`RESET ROLE; DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); } });

  it('imports legacy model choices into the read view without exposing secrets', async () => {
    const response = mockResponse();
    await getAdminAssistantModels(mockAdminRequest(1, { user: { id: 1, role: 'super_admin' } }), response);
    expect(response._json.models[0]).toMatchObject({ id: null, model: 'fixture-old', label: 'fixture-old' });
    expect(response._json.canManage).toBe(true);
    expect(JSON.stringify(response._json)).not.toMatch(/never-expose|apiKey|apiSecret|allowedModels/);
  });
  it('saves a friendly label over the existing identity, with an audit row', async () => {
    const response = await save(input);
    expect(response._status).toBe(201); entryId = response._json.id;
    expect((await client.query('SELECT label,version FROM assistant_model_catalog WHERE id=$1', [entryId])).rows[0]).toEqual({ label: 'Customer GPT', version: 1 });
    expect((await client.query('SELECT count(*)::int AS count FROM admin_credential_audit')).rows[0].count).toBe(1);
    expect((await resolveAssistantModelCredential({ provider: 'openai', model: 'fixture-old' }, credentials))?.id).toBe(1);
  });
  it('blocks a disabled model even when legacy integration configuration still contains it', async () => {
    expect((await save({ ...input, enabled: false, expectedVersion: 1 }, entryId))._status).toBe(200);
    expect(await resolveAssistantModelCredential({ provider: 'openai', model: 'fixture-old' }, credentials)).toBeUndefined();
    expect((await save({ ...input, expectedVersion: 1 }, entryId))._status).toBe(409);
  });
  it('supports a newly configured model and exact connection without requiring it in legacy settings', async () => {
    const response = await save({ ...input, provider: 'openrouter', credentialId: 2, model: 'fixture/new-model', label: 'Customer Gemini', expectedVersion: 2 }, entryId);
    expect(response._status).toBe(200);
    expect(await resolveAssistantModelCredential({ provider: 'openai', model: 'fixture-old' }, credentials)).toBeUndefined();
    expect((await resolveAssistantModelCredential({ provider: 'openrouter', model: 'fixture/new-model' }, credentials))?.id).toBe(2);
    expect((await save({ ...input, provider: 'openrouter', credentialId: 2, model: 'fixture/new-model' }))._status).toBe(409);
  });
  it('rejects mismatched connections, offline connections, and malformed model entries', async () => {
    expect((await save({ ...input, provider: 'openrouter', credentialId: 1 }))._status).toBe(400);
    expect((await save({ ...input, credentialId: 3 }))._status).toBe(400);
    expect((await save({ ...input, order: -1 }))._status).toBe(400);
    expect((await save({ ...input, model: 'contains spaces' }))._status).toBe(400);
  });
  it('rolls back the model when its audit write fails', async () => {
    const response = mockResponse();
    await saveAdminAssistantModel(mockAdminRequest(999, { body: { ...input, model: 'rollback-fixture', label: 'Rollback GPT' } }), response);
    expect(response._status).toBe(500);
    expect((await client.query("SELECT count(*)::int AS count FROM assistant_model_catalog WHERE model='rollback-fixture'")).rows[0].count).toBe(0);
  });
  it('allows business reads while database policy rejects business writes', async () => {
    await client.query("SELECT set_config('app.business_system','off',false); SET ROLE salesmarketing_business_runtime");
    expect((await client.query('SELECT count(*)::int AS count FROM assistant_model_catalog')).rows[0].count).toBe(2);
    expect((await client.query("UPDATE assistant_model_catalog SET enabled=true")).rowCount).toBe(0);
    await expect(client.query("INSERT INTO assistant_model_catalog(provider,model,label) VALUES('openai','unauthorized','Unauthorized')")).rejects.toThrow();
    await client.query("RESET ROLE; SELECT set_config('app.business_system','on',false)");
  });
  it('retires an imported legacy identity when its provider or model ID is edited', async () => {
    credentials[0].config = { model: 'legacy-second' };
    const response = await save({ ...input, provider: 'openrouter', credentialId: 2, model: 'fixture/imported-new', label: 'Imported replacement', original: { provider: 'openai', model: 'legacy-second' } });
    expect(response._status).toBe(201);
    expect(await resolveAssistantModelCredential({ provider: 'openai', model: 'legacy-second' }, credentials)).toBeUndefined();
    expect((await resolveAssistantModelCredential({ provider: 'openrouter', model: 'fixture/imported-new' }, credentials))?.id).toBe(2);
  });
  it('registers the shared catalog for startup validation without changing its RLS', async () => {
    await unregisterScope(client);
    expect((await client.query('SELECT * FROM business_scope_accounts')).rows).toEqual([]);
    await registerScope(client);
    await registerScope(client);
    expect((await client.query('SELECT table_name FROM business_scope_accounts')).rows).toEqual([{ table_name: 'assistant_model_catalog' }]);
    expect((await client.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='assistant_model_catalog'::regclass")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await client.query("SELECT count(*)::int AS count FROM pg_policy WHERE polrelid='assistant_model_catalog'::regclass")).rows[0].count).toBe(2);
  });
});
