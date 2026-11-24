/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { emptyAssistantDraft } from '../../shared/outreachAssistants.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const providerSend = jest.fn<(...args: any[]) => Promise<any>>();
const sender = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('resend', () => ({ Resend: class { emails = { send: providerSend }; } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: async () => ({ apiKey: 'synthetic-test-key' }), decryptAdminCredential: (v: any) => v }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({ getById: sender, getDefault: sender }));
jest.unstable_mockModule('../services/InboundContactResolver.js', () => ({ inboundContactResolver: {} }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ privacyVaultService: {}, redactPiiWithStableTokens: (text: string) => ({ redactedText: text }) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
let catalog: any;
let platform: any;
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({ assistantCatalog: async () => catalog, assistantPlatformReadiness: async () => platform }));
const { assertCustomerDeliveryReady, customerDeliveryReadiness, deliverySetupFailure, withCustomerDeliveryReceipt } = await import('../services/assistants/CustomerDeliveryGate.js');
const { admitCustomerDeliveryJob, runCustomerDeliveryJob, holdCustomerDeliveryJob } = await import('../services/assistants/CustomerDeliveryJobs.js');
const { sendEmail, sendBroadcast } = await import('../services/resendService.js');
const { withInternalEmailDelivery } = await import('../services/InternalEmailDelivery.js');
const { currentAssistant } = await import('../services/assistants/AssistantContext.js');
const { sendSMS } = await import('../services/smsService.js');
const { sendTwitterDM } = await import('../services/TwitterApiService.js');
const { sendLinkedInDM } = await import('../services/LinkedInApiService.js');
const previousRuntime = process.env.SUPPORT_ASSISTANTS_ENABLED;
const previousProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
const id = '11111111-1111-4111-8111-111111111111';
const account = 'sales@example.test';
const scope = <T>(work: () => T, businessProfileId = 7) => withBusinessScope({ userId: 9, businessProfileId }, work);
const input = () => ({ userId: 9, channel: 'email', accountId: account });
const email = { from: `Sales <${account}>`, to: 'customer@example.test', subject: 'Original campaign offer', html: '<p>Reviewed campaign facts.</p>' };
let assigned: boolean;
let row: any;
let configuration: any;
let quotaCredentials: any[];
let managedModels: any[];
let betweenPreparationAndSend: (() => void) | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPPORT_ASSISTANTS_ENABLED = 'true';
  delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
  configuration = { ...emptyAssistantDraft(), name: 'Reviewed sales account', agentType: 'general_service', replyModel: { provider: 'test', model: 'approved' },
    bindings: [{ channel: 'email', surface: 'private', accountId: account }],
    knowledge: { mode: 'none', ids: [] }, documents: { mode: 'none', ids: [] }, galleries: { mode: 'none', ids: [] },
    playbooks: { mode: 'none', assignments: [] }, followUps: { mode: 'none', sequences: [] }, tools: { mode: 'none', names: [], approvalRequired: [] } };
  row = { binding_id: 4, version: 2, revision: 3, assistant_id: id, enabled: true, state: 'live', published_revision: 3, configuration };
  assigned = true;
  catalog = { runtimeEnabled: true, presets: [{ agentType: 'general_service' }], accounts: [{ channel: 'email', surface: 'private', accountId: account, connected: true }],
    models: [{ provider: 'test', model: 'approved', controls: [] }], knowledge: [], documents: [], galleries: [], playbooks: [], templates: [], tools: [] };
  platform = { classifier: true, privacyVault: true };
  quotaCredentials = [];
  managedModels = [];
  betweenPreparationAndSend = undefined;
  sender.mockReset().mockResolvedValue({ id: 12, email: account, type: 'resend', isVerified: true });
  providerSend.mockReset().mockImplementation(async () => {
    expect(currentAssistant()).toBeUndefined();
    return { data: { id: 'mock-acceptance' }, error: null };
  });
  execute.mockReset().mockImplementation(async (query: any) => {
    const compiled = new PgDialect().sqlToQuery(query);
    if (compiled.sql.includes("deactivation_reason = 'quota_exceeded'")) return { rows: quotaCredentials };
    if (compiled.sql.includes('FROM assistant_model_catalog')) return { rows: managedModels };
    if (compiled.sql.startsWith('UPDATE outreach_messages')) return { rows: [] };
    if (compiled.sql.includes('SELECT channel,surface,account_id')) {
      betweenPreparationAndSend?.();
      return { rows: configuration.bindings.map((b: any) => ({ channel: b.channel, surface: b.surface, account_id: b.accountId })) };
    }
    // Model tenant/account filtering rather than returning the same assignment for every request.
    const matches = JSON.stringify(compiled.params) === JSON.stringify([9, 7, 'email', 'private', account]);
    return { rows: assigned && matches ? [structuredClone(row)] : [] };
  });
});
afterEach(() => {
  if (previousRuntime === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = previousRuntime;
  if (previousProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES; else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = previousProfiles;
});

describe('mandatory customer assistant readiness at actual email dispatch', () => {
  it.each(['false', undefined])('blocks runtime %s before any provider or assignment lookup', async enabled => {
    if (enabled === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = enabled;
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', deliveryAttempted: false, outcomeUncertain: false });
    expect(execute).not.toHaveBeenCalled(); expect(providerSend).not.toHaveBeenCalled();
  });
  it('blocks an unconfigured account even with a connected email provider', async () => {
    assigned = false;
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ reason: 'assignment_required' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each(['draft', 'paused', 'needs_attention'])('blocks assigned state %s', async state => {
    row.state = state;
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ reason: 'assistant_not_live' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each([null, 0])('blocks unpublished revision %s', async revision => {
    row.published_revision = revision;
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ reason: 'assistant_not_live' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('blocks disabled bindings and stale published revisions', async () => {
    row.enabled = false;
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ reason: 'assistant_not_live' });
    row.enabled = true; row.published_revision = 4;
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ reason: 'stale_assignment' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each([
    { channel: 'email', accountId: 'other@example.test' },
    { channel: 'facebook', accountId: account },
    { channel: 'email', accountId: account, surface: 'public_comment' as const },
  ])('does not borrow another account/channel/surface assignment: %j', async value => {
    await expect(scope(() => assertCustomerDeliveryReady({ userId: 9, ...value }))).rejects.toMatchObject({ reason: 'assignment_required' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('does not borrow another business assignment or trust the UI business', async () => {
    await expect(scope(() => sendEmail(email), 8)).rejects.toMatchObject({ reason: 'assignment_required' });
    await expect(assertCustomerDeliveryReady(input())).rejects.toMatchObject({ reason: 'business_scope_required' });
    await expect(scope(() => assertCustomerDeliveryReady({ ...input(), userId: 10 }))).rejects.toMatchObject({ reason: 'business_scope_required' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each(['model', 'privacy', 'configuration', 'resource'])('rechecks current %s validity', async failure => {
    if (failure === 'model') catalog.models = [];
    if (failure === 'privacy') platform.privacyVault = false;
    if (failure === 'configuration') row.configuration = {};
    if (failure === 'resource') configuration.knowledge = row.configuration.knowledge = { mode: 'selected', ids: [91] };
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each([
    { configuredModel: 'openai/gpt-6-luna', managedEnabled: undefined, showsQuota: true },
    { configuredModel: 'openai/another-model', managedEnabled: undefined, showsQuota: false },
    { configuredModel: 'openai/gpt-6-luna', managedEnabled: false, showsQuota: false },
    { configuredModel: 'openai/another-model', managedEnabled: true, showsQuota: true },
  ])('explains the quota block only for an affected published model (%j)', async ({ configuredModel, managedEnabled, showsQuota }) => {
    const model = { provider: 'openrouter', model: 'openai/gpt-6-luna' };
    configuration.replyModel = model;
    catalog.models = [];
    quotaCredentials = [{ id: 28, platform: 'openrouter', config: { model: configuredModel } }];
    if (managedEnabled !== undefined) {
      managedModels = [{ ...model, id: 1, enabled: managedEnabled, credentialId: 28, label: model.model, order: 0 }];
    }

    await expect(scope(() => customerDeliveryReadiness(input()))).resolves.toMatchObject({
      ready: false,
      code: 'ASSISTANT_SETUP_REQUIRED',
      error: expect.stringContaining(showsQuota
        ? 'OpenRouter reported insufficient provider credits or a quota limit on the AskSales side.'
        : 'The assigned assistant needs setup: Reply and fallback models.'),
    });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('sends an approved template when only the AI model is unavailable', async () => {
    catalog.models = [];
    await expect(scope(() => assertCustomerDeliveryReady(input()))).rejects.toMatchObject({ reason: 'configuration_not_ready' });
    await expect(scope(() => assertCustomerDeliveryReady({ ...input(), approvedTemplate: true }))).resolves.toMatchObject({ assistantId: id, revision: 3 });
    await expect(scope(() => customerDeliveryReadiness({ ...input(), approvedTemplate: true }))).resolves.toMatchObject({ ready: true });
  });
  it.each(['privacy', 'account', 'state'])('still blocks an approved template when %s is not ready', async failure => {
    catalog.models = [];
    if (failure === 'privacy') platform.privacyVault = false;
    if (failure === 'account') catalog.accounts[0].connected = false;
    if (failure === 'state') row.state = 'paused';
    await expect(scope(() => assertCustomerDeliveryReady({ ...input(), approvedTemplate: true }))).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED' });
  });
  it('rechecks runtime immediately before provider mutation', async () => {
    betweenPreparationAndSend = () => { process.env.SUPPORT_ASSISTANTS_ENABLED = 'false'; };
    await expect(scope(() => sendEmail(email))).rejects.toMatchObject({ reason: 'runtime_disabled' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('permits one mock provider call for a current published assignment without installing its persona', async () => {
    expect(await scope(() => sendEmail(email))).toEqual({ id: 'mock-acceptance' });
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(providerSend.mock.calls[0][0]).toMatchObject({ subject: email.subject, html: email.html });
  });
  it.each(['email','whatsapp'])('does not let a disconnected sibling %s account block this connected account',async channel=>{
    const sibling={channel,surface:'private',accountId:channel==='email'?'disconnected@example.test':'other-phone-id'};
    configuration.bindings.push(sibling);
    catalog.accounts.push({...sibling,connected:false});
    await expect(scope(()=>sendEmail(email))).resolves.toEqual({id:'mock-acceptance'});
    expect(providerSend).toHaveBeenCalledTimes(1);
  });
  it('still blocks the exact sending account when it disconnects',async()=>{
    catalog.accounts[0].connected=false;
    await expect(scope(()=>sendEmail(email))).rejects.toMatchObject({reason:'configuration_not_ready'});
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('keeps operator reports outside the customer-assistant requirement through a code-only context', async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
    await expect(withInternalEmailDelivery('operator_report', () => sendEmail(email))).resolves.toEqual({ id: 'mock-acceptance' });
    expect(execute).not.toHaveBeenCalled(); expect(providerSend).toHaveBeenCalledTimes(1);
  });
  it.each(['sms', 'twitter', 'linkedin', 'youtube'])('fails closed for unsupported channel %s', async channel => {
    await expect(scope(() => assertCustomerDeliveryReady({ ...input(), channel }))).rejects.toMatchObject({ reason: 'unsupported_channel', deliveryAttempted: false });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('blocks broadcast bypass without an exact reviewed assistant account', async () => {
    await expect(sendBroadcast('mock-broadcast')).rejects.toMatchObject({ reason: 'broadcast_assignment_unsupported' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each(['sms', 'twitter', 'linkedin'])('blocks the real %s adapter before any network transport or account lookup', async channel => {
    const fetcher = jest.spyOn(globalThis, 'fetch');
    try {
      const result = await scope(() => channel === 'sms' ? sendSMS(9, '919876543210', 'Mock only')
        : channel === 'twitter' ? sendTwitterDM({ userId: 9, recipientId: 'synthetic', message: 'Mock only' })
        : sendLinkedInDM({ userId: 9, recipientUrn: 'synthetic', message: 'Mock only' }));
      expect(result).toMatchObject({ success: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'unsupported_channel', deliveryAttempted: false, retryable: false });
      expect(fetcher).not.toHaveBeenCalled(); expect(providerSend).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
});

describe('durable queue admission and dispatch receipts', () => {
  const payload = () => ({ userId: 9, businessProfileId: 7, leadId: 21, to: 'customer@example.test', senderId: 12, channel: 'email' });
  it.each(['runtime_off','assignment_missing'])('blocks campaign-manual admission with %s and zero provider calls', async failure => {
    if(failure==='runtime_off')process.env.SUPPORT_ASSISTANTS_ENABLED='false';else assigned=false;
    await expect(scope(()=>admitCustomerDeliveryJob('send_outreach_message',{...payload(),campaignManualReviewId:'immutable-manual-review',followUpOriginMessageId:100,message:'HR reviewed follow-up'})))
      .rejects.toMatchObject({code:'ASSISTANT_SETUP_REQUIRED'});
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each(['runtime_off','assignment_missing'])('blocks campaign-manual dispatch with %s and zero provider calls', async failure => {
    const admitted=await scope(()=>admitCustomerDeliveryJob('send_outreach_message',{...payload(),campaignManualReviewId:'immutable-manual-review',followUpOriginMessageId:100,message:'HR reviewed follow-up'}));
    if(failure==='runtime_off')process.env.SUPPORT_ASSISTANTS_ENABLED='false';else assigned=false;
    const work=jest.fn(async()=>sendEmail(email));
    await expect(scope(()=>runCustomerDeliveryJob('send_outreach_message',admitted,work))).rejects.toMatchObject({code:'ASSISTANT_SETUP_REQUIRED'});
    expect(work).not.toHaveBeenCalled();expect(providerSend).not.toHaveBeenCalled();
  });
  it('rejects admission when setup is missing and never reaches work or provider', async () => {
    assigned = false;
    await expect(scope(() => admitCustomerDeliveryJob('send_email', payload()))).rejects.toMatchObject({ reason: 'assignment_required' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('persists the exact receipt at admission and revalidates before dispatch', async () => {
    const admitted = await scope(() => admitCustomerDeliveryJob('send_email', payload()));
    expect((admitted as any).customerDeliveryAssistant).toMatchObject({ assistantId: id, bindingId: 4, bindingVersion: 2, revision: 3, businessProfileId: 7, accountId: account });
    await expect(scope(() => runCustomerDeliveryJob('send_email', admitted, () => sendEmail(email)))).resolves.toEqual({ id: 'mock-acceptance' });
    expect(providerSend).toHaveBeenCalledTimes(1);
  });
  it.each(['version', 'assistant', 'revision', 'paused', 'runtime'])('holds an assignment changed after queue: %s', async change => {
    const admitted = await scope(() => admitCustomerDeliveryJob('send_email', payload()));
    if (change === 'version') row.version++;
    if (change === 'assistant') row.assistant_id = '22222222-2222-4222-8222-222222222222';
    if (change === 'revision') { row.revision++; row.published_revision++; }
    if (change === 'paused') row.state = 'paused';
    if (change === 'runtime') process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
    const work = jest.fn(async () => sendEmail(email));
    await expect(scope(() => runCustomerDeliveryJob('send_email', admitted, work))).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED' });
    expect(work).not.toHaveBeenCalled(); expect(providerSend).not.toHaveBeenCalled();
  });
  it('never upgrades legacy queued work into a newly configured assignment', async () => {
    const work = jest.fn(async () => sendEmail(email));
    await expect(scope(() => runCustomerDeliveryJob('send_email', payload(), work))).rejects.toMatchObject({ reason: 'queued_setup_review_required' });
    expect(work).not.toHaveBeenCalled(); expect(providerSend).not.toHaveBeenCalled();
  });
  it('does not release an explicitly held receipt merely because setup later becomes ready', async () => {
    const admitted = await scope(() => admitCustomerDeliveryJob('send_email', payload()));
    const work = jest.fn(async () => sendEmail(email));
    await expect(scope(() => runCustomerDeliveryJob('send_email', { ...admitted, customerDeliveryStatus: 'setup_required' }, work))).rejects.toMatchObject({ reason: 'queued_setup_review_required' });
    expect(work).not.toHaveBeenCalled(); expect(providerSend).not.toHaveBeenCalled();
  });
  it('carries the receipt through nested provider boundaries without assistant persona context', async () => {
    const receipt = await scope(() => assertCustomerDeliveryReady(input()));
    row.version++;
    await expect(scope(() => withCustomerDeliveryReceipt(receipt, () => sendEmail(email)))).rejects.toMatchObject({ reason: 'assignment_changed' });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('provides setup information and holds only unstarted, undelivered work', async () => {
    assigned = false;
    const readiness = await scope(() => customerDeliveryReadiness(input()));
    expect(readiness).toMatchObject({ ready: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'assignment_required', setupUrl: '/dashboard/settings/outreach' });
    try { await scope(() => assertCustomerDeliveryReady(input())); } catch (error) {
      expect(deliverySetupFailure(error)).toMatchObject({ deliveryAttempted: false, outcomeUncertain: false, retryable: false });
      await scope(() => holdCustomerDeliveryJob({ userId: 9, messageId: 15 }, error));
    }
    const update = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query)).find(q => q.sql.startsWith('UPDATE outreach_messages'))!;
    expect(update.sql).toContain("status='setup_required'");
    expect(update.sql).toContain("COALESCE(provider_call_state,'not_started')='not_started'");
    expect(update.sql).not.toMatch(/status IN \([^)]*'sent'/);
    expect(providerSend).not.toHaveBeenCalled();
  });
});
