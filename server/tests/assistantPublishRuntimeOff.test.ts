import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { emptyAssistantDraft, type AssistantCatalog, type AssistantDraft } from '../../shared/outreachAssistants.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import type { NormalizedMessage } from '../services/agents/pipeline/ChannelGateway.js';

const id = '00000000-0000-4000-8000-000000000001';
const queries: Array<{ sql: string; params: unknown[] }> = [];
let row: Record<string, unknown>;
let catalog: AssistantCatalog;
let platform: { classifier: boolean; privacyVault: boolean };
let bindings: Record<string, unknown>[];
const execute = jest.fn(async (query: SQL) => {
  const compiled = new PgDialect().sqlToQuery(query);
  queries.push(compiled);
  if (compiled.sql.includes('SELECT a.*')) return { rows: [row] };
  if (compiled.sql.includes('SELECT * FROM outreach_assistant_bindings')) return { rows: bindings };
  if (compiled.sql.includes('SELECT channel,surface,account_id')) return { rows: bindings };
  if (compiled.sql.includes('COALESCE(MAX(revision)')) return { rows: [{ n: 0 }] };
  if (compiled.sql.includes('INSERT INTO outreach_assistant_bindings')) {
    const [userId, assistantId, revision, channel, surface, accountId] = compiled.params;
    bindings.push({ id: 1, version: 1, enabled: true, user_id: userId, assistant_id: assistantId,
      revision, channel, surface, account_id: accountId });
  }
  if (compiled.sql.includes('UPDATE outreach_assistants SET published_revision=')) {
    row.published_revision = compiled.params[0]; row.state = 'live'; row.published = row.draft;
  }
  return { rows: [] };
});
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute,
  transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ execute }) } }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({
  assistantCatalog: async () => catalog,
  assistantPlatformReadiness: async () => platform,
  availableAssistantModels: async () => catalog.models,
}));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text }),
}));
const { assistantService } = await import('../services/assistants/AssistantService.js');
const { assertCustomerDeliveryReady } = await import('../services/assistants/CustomerDeliveryGate.js');
const { resolveTurnAssistant } = await import('../services/assistants/AssistantResolver.js');
const { assistantsRuntimeEnabled } = await import('../services/assistants/AssistantContext.js');
const originalFlag = process.env.SUPPORT_ASSISTANTS_ENABLED;
const originalProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
const scoped = <T,>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 1 }, work);
const writes = () => queries.filter(query => /^\s*(UPDATE|INSERT INTO)/.test(query.sql));
const draft = () => row.draft as AssistantDraft;

describe('reviewed assistant publication while delivery runtime is off', () => {
  beforeEach(() => {
    queries.length = 0; bindings = []; platform = { classifier: true, privacyVault: true };
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
    delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
    const configuration = emptyAssistantDraft();
    configuration.name = 'Synthetic support'; configuration.agentType = 'general_service';
    configuration.bindings = [{ channel: 'email', surface: 'private', accountId: 'support@example.invalid' }];
    configuration.replyModel = { provider: 'openai', model: 'fixture-model' };
    for (const key of ['knowledge', 'documents', 'galleries', 'playbooks', 'followUps', 'tools'] as const) configuration[key].mode = 'none';
    catalog = { runtimeEnabled: false,
      accounts: [{ ...configuration.bindings[0], label: 'Synthetic sender', connected: true }],
      presets: [{ agentType: configuration.agentType, name: 'Service', description: '', instructions: '', tools: [], policies: {} }],
      models: [{ ...configuration.replyModel, label: 'Synthetic model', controls: [] }],
      knowledge: [], documents: [], galleries: [], playbooks: [], templates: [], tools: [],
      permissions: { canManage: true, description: 'Owner' } };
    row = { id, user_id: 9, business_profile_id: 1, state: 'draft', draft: configuration,
      draft_version: 2, published_revision: null, published: null, updated_at: '2026-10-27T01:00:00.000Z' };
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = originalFlag;
    if (originalProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES; else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = originalProfiles;
  });

  it('publishes the validated revision and exact reviewed binding without enabling runtime or sending', async () => {
    const result = await scoped(() => assistantService.publish(id, 2));
    expect(result).toMatchObject({ publishedRevision: 1, state: 'needs_attention', enabledBindings: draft().bindings });
    expect(scoped(assistantsRuntimeEnabled)).toBe(false);
    const revision = queries.find(query => query.sql.includes('INSERT INTO outreach_assistant_revisions'))!;
    expect(JSON.parse(revision.params[3] as string)).toEqual(draft());
    const binding = queries.find(query => query.sql.includes('INSERT INTO outreach_assistant_bindings'))!;
    expect(binding.params).toEqual([9, id, 1, 'email', 'private', 'support@example.invalid']);
    expect(queries[0].sql).toContain('pg_advisory_xact_lock');
    expect(queries.some(query => query.sql.includes('INSERT INTO outreach_assistant_audit'))).toBe(true);
    expect(queries.some(query => /INSERT INTO (support_delivery_outbox|outreach_messages|.*follow_up)/.test(query.sql))).toBe(false);
    const afterPublish = queries.length;
    await expect(scoped(() => assertCustomerDeliveryReady({ userId: 9, channel: 'email', accountId: 'support@example.invalid' })))
      .rejects.toMatchObject({ reason: 'runtime_disabled', deliveryAttempted: false, retryable: false });
    await expect(scoped(() => resolveTurnAssistant({ userId: 9, channel: 'email', conversationId: 1,
      metadata: { executionMode: 'customer' } } as NormalizedMessage))).rejects.toThrow('Assistant replies are disabled');
    expect(queries).toHaveLength(afterPublish);
  });

  it('allows preparation for a business excluded by rollout without expanding rollout', async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'true'; process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = '2';
    await expect(scoped(() => assistantService.publish(id, 2))).resolves.toMatchObject({ publishedRevision: 1, state: 'needs_attention' });
    expect(process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES).toBe('2');
    expect(scoped(assistantsRuntimeEnabled)).toBe(false);
  });

  it.each(['classifier', 'privacyVault'] as const)('still rejects missing mandatory %s readiness', async key => {
    platform[key] = false;
    await expect(scoped(() => assistantService.publish(id, 2))).rejects.toMatchObject({ status: 422 });
    expect(writes()).toHaveLength(0);
  });

  it('still rejects stale drafts before publication writes', async () => {
    await expect(scoped(() => assistantService.publish(id, 1))).rejects.toThrow('This draft changed');
    expect(writes()).toHaveLength(0);
  });

  it.each(['disconnected', 'different account', 'different surface'] as const)('requires the exact connected account: %s', async change => {
    if (change === 'disconnected') catalog.accounts[0].connected = false;
    if (change === 'different account') catalog.accounts[0].accountId = 'other@example.invalid';
    if (change === 'different surface') catalog.accounts[0].surface = 'public_comment';
    await expect(scoped(() => assistantService.publish(id, 2))).rejects.toMatchObject({ status: 422 });
    expect(writes()).toHaveLength(0);
  });

  it.each(['unconfigured knowledge', 'unavailable model', 'unsupported collection', 'missing tool approval'] as const)('retains configuration validation: %s', async change => {
    if (change === 'unconfigured knowledge') draft().knowledge.mode = 'unconfigured';
    if (change === 'unavailable model') catalog.models = [];
    if (change === 'unsupported collection') draft().privacy.permittedCollectionFields = ['email'];
    if (change === 'missing tool approval') {
      draft().tools = { mode: 'selected', names: ['high_risk'], approvalRequired: [] };
      catalog.tools = [{ name: 'high_risk', label: 'High risk', approvalRequired: true }];
    }
    await expect(scoped(() => assistantService.publish(id, 2))).rejects.toMatchObject({ status: 422 });
    expect(writes()).toHaveLength(0);
  });

  it('requires explicit reassignment confirmation even while runtime is off', async () => {
    bindings = [{ assistant_id: '00000000-0000-4000-8000-000000000002', ...draft().bindings[0], account_id: draft().bindings[0].accountId }];
    await expect(scoped(() => assistantService.publish(id, 2))).rejects.toMatchObject({ status: 409 });
    expect(writes()).toHaveLength(0);
  });

  it('retains the runtime restriction for rollback and resume', async () => {
    await expect(scoped(() => assistantService.publish(id, 2, false, 1))).rejects.toMatchObject({ status: 409 });
    row.published_revision = 1;
    await expect(scoped(() => assistantService.resume(id))).rejects.toMatchObject({ status: 409 });
    expect(writes()).toHaveLength(0);
  });
});
