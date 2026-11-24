/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { emptyInstagramMessage } from '../../shared/instagramAutomations.js';
import { createSupportChoiceManifest } from '../services/agents/orchestration/SupportChoiceDelivery.js';

const execute = jest.fn<(...args: any[]) => Promise<any>>();
const selected: any[] = [];
const resolveAccount = jest.fn<(...args: any[]) => Promise<any>>();
const ready = jest.fn(() => ({ ready: true, checks: [] }));
const redis = { incr: async () => 1, expire: async () => 1 };
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  execute,
  select: () => {
    const rows = selected.shift() || [];
    const chain: any = { then: (resolve: any) => Promise.resolve(rows).then(resolve) };
    for (const key of ['from', 'where', 'orderBy', 'limit']) chain[key] = () => chain;
    return chain;
  },
} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => redis, getRedisSubscriber: () => redis, isRedisAvailable: async () => false }));
jest.unstable_mockModule('../services/credentialService', () => ({ getCredential: jest.fn() }));
jest.unstable_mockModule('../services/instagramAccountSelectionService.js', () => ({ resolveInstagramAccountContext: resolveAccount, resolveInstagramProviderAccountId: jest.fn() }));
jest.unstable_mockModule('../utils/metaApiVersion.js', () => ({ getGraphApiVersion: async () => 'v25.0', getGraphApiBase: () => 'https://graph.facebook.com/v25.0' }));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js', () => ({ assistantCatalog: async () => ({}), assistantPlatformReadiness: async () => ({}) }));
jest.unstable_mockModule('../services/assistants/AssistantConfiguration.js', () => ({
  parseAssistantDraft: (value: any) => value, assistantReadiness: ready, withinAssistantHours: () => true,
}));

const { FacebookMessengerService, sendFacebookDM } = await import('../services/FacebookMessengerService.js');
const { InstagramGraphApiService } = await import('../services/instagramGraphApiService.js');
const { whatsappApiService } = await import('../services/whatsappApiService.js');
const { InstagramAutomationProvider } = await import('../services/instagramAutomations/InstagramAutomationProvider.js');
const { mutateMetaComment, createMetaInsightsClient } = await import('../services/social/MetaInsightsClient.js');
const { assistantDeliveryCurrent, assistantProvenanceCurrent, withPublishedAssistant, withPrivateAssistantForPublicDelivery } = await import('../services/assistants/AssistantFreshness.js');
const { withCustomerDeliveryReceipt } = await import('../services/assistants/CustomerDeliveryGate.js');
const { withAssistantContext } = await import('../services/assistants/AssistantContext.js');
const { sendInstagramCommentReply, sendFacebookCommentReply } = await import('../controllers/webhooksController.js');
const { InstagramService, sendInstagramDM } = await import('../services/instagramService.js');
const { routeInstagramMessage } = await import('../services/instagramMessageRouter.js');
const { socialCommentAction } = await import('../controllers/socialEngagementController.js');

const scope = (work: () => Promise<any>) => withBusinessScope({ userId: 1, businessProfileId: 1 }, work);
const realFetch = globalThis.fetch;
const fetcher = jest.fn<typeof fetch>();
const previousEnabled = process.env.SUPPORT_ASSISTANTS_ENABLED;
const previousProfiles = process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
const uuid = '11111111-1111-4111-8111-111111111111';
const binding = (channel: string, accountId: string, surface = 'private') => ({ channel, surface, accountId });
const configuration = { bindings: [binding('facebook', 'page'), binding('instagram', 'ig'), binding('whatsapp', 'phone'),
  binding('facebook', 'page', 'public_comment'), binding('instagram', 'ig', 'public_comment')], availability: { enabled: false } };
const receipt = (channel: string, accountId: string, surface = 'private') => ({ assistantId: uuid, revision: 1, bindingId: 1,
  bindingVersion: 1, businessProfileId: 1, channel, accountId, surface } as any);
let assigned: boolean;
let suppression: "clear" | "blocked" | "unavailable";
function facebook() {
  const service = new FacebookMessengerService();
  Object.assign(service, { userId: 1, credentials: { pageId: 'page', accessToken: 'test-only-token' } });
  return service;
}
function instagram() {
  const service = new InstagramGraphApiService();
  Object.assign(service, { userId: 1 });
  service.setCredentials({ pageId: 'page', instagramAccountId: 'ig', accessToken: 'test-only-token' });
  return service;
}
function automation() {
  return new InstagramAutomationProvider({ credential: { userId: 1, accountIdentifier: 'ig', accessToken: 'test-only-token',
    sessionData: { useInstagramLogin: true } }, connection: null } as any);
}
const whatsapp = () => whatsappApiService.sendText({ userId: 1, phoneNumberId: 'phone', to: '919900000001', text: 'Hello' });
const choice = createSupportChoiceManifest({ runId: 1, nodeId: 'confirm', field: {
  key: 'confirmed', type: 'boolean', required: true, pii: 'none', prompt: 'Continue?',
} })!;
function publicReply(channel: 'instagram' | 'facebook') {
  selected.length = 0;
  const accountId = channel === 'instagram' ? 'ig' : 'page';
  selected.push([{ userId: 1, accountIdentifier: accountId, accessToken: 'test-only-token' }], []);
  return channel === 'instagram' ? sendInstagramCommentReply(1, 'comment', 'Hello', accountId)
    : sendFacebookCommentReply(1, 'comment', 'Hello', accountId);
}
const sends = [
  { name: 'Facebook text', channel: 'facebook', accountId: 'page', send: () => facebook().sendMessage('recipient', 'Hello'), throws: false },
  { name: 'Facebook attachment', channel: 'facebook', accountId: 'page', send: () => facebook().sendMessageWithAttachment('recipient', 'image', 'https://example.test/image.jpg'), throws: false },
  { name: 'Instagram text', channel: 'instagram', accountId: 'ig', send: () => instagram().sendMessage('recipient', 'Hello'), throws: false },
  { name: 'Instagram attachment', channel: 'instagram', accountId: 'ig', send: () => instagram().sendMessageWithAttachment('recipient', 'image', 'https://example.test/image.jpg'), throws: false },
  { name: 'WhatsApp text', channel: 'whatsapp', accountId: 'phone', send: whatsapp, throws: true },
  { name: 'WhatsApp template', channel: 'whatsapp', accountId: 'phone', send: () => whatsappApiService.sendTemplate({ userId: 1, phoneNumberId: 'phone', to: '919900000001', templateName: 'approved', language: 'en_US' }), throws: true },
  { name: 'WhatsApp choices', channel: 'whatsapp', accountId: 'phone', send: () => whatsappApiService.sendChoice({ userId: 1, phoneNumberId: 'phone', to: '919900000001', text: 'Continue?', choice }), throws: true },
  { name: 'WhatsApp media', channel: 'whatsapp', accountId: 'phone', send: () => whatsappApiService.sendMedia({ userId: 1, phoneNumberId: 'phone', to: '919900000001', mediaType: 'image', mediaId: 'media' }), throws: true },
  { name: 'WhatsApp CTA', channel: 'whatsapp', accountId: 'phone', send: () => whatsappApiService.sendCtaUrl({ userId: 1, phoneNumberId: 'phone', to: '919900000001', text: 'Hello', title: 'Open', url: 'https://example.test/', allowTextFallback: true }), throws: true },
  { name: 'Instagram automation DM', channel: 'instagram', accountId: 'ig', send: () => automation().sendMessage('recipient', { ...emptyInstagramMessage(), text: 'Hello' }), throws: true },
  { name: 'Instagram automation private reply', channel: 'instagram', accountId: 'ig', send: () => automation().sendPrivateReply('comment', 'Hello'), throws: true },
  { name: 'Insights public reply', channel: 'facebook', accountId: 'page', send: () => mutateMetaComment('https://graph.facebook.com/v25.0', 'test-only-token', '123/comments', { message: 'Hello' }, fetcher,
    { userId: 1, channel: 'facebook', accountId: 'page', surface: 'public_comment' }), throws: true },
  { name: 'Instagram public comment', channel: 'instagram', accountId: 'ig', send: () => publicReply('instagram'), throws: false },
  { name: 'Facebook public comment', channel: 'facebook', accountId: 'page', send: () => publicReply('facebook'), throws: false },
];
async function expectBlocked(send: () => Promise<any>, throws: boolean, reason: string) {
  if (throws) await expect(scope(send)).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason,
    deliveryAttempted: false, outcomeUncertain: false, retryable: false });
  else expect(await scope(send)).toMatchObject({ success: false, code: 'ASSISTANT_SETUP_REQUIRED', reason,
    setupUrl: expect.stringContaining('/dashboard/settings/outreach'), deliveryAttempted: false, outcomeUncertain: false, retryable: false });
  expect(fetcher).not.toHaveBeenCalled();
}
beforeEach(() => {
  process.env.SUPPORT_ASSISTANTS_ENABLED = 'true'; delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES;
  suppression = "clear";
  assigned = true; selected.length = 0; jest.clearAllMocks();
  resolveAccount.mockResolvedValue({ credential: { userId: 1, accountIdentifier: 'ig', sessionData: { useInstagramLogin: true } }, connection: null });
  globalThis.fetch = fetcher;
  fetcher.mockReset().mockResolvedValue(Response.json({ message_id: 'ack', recipient_id: 'recipient', id: 'ack', messages: [{ id: 'ack' }] }));
  ready.mockReturnValue({ ready: true, checks: [] });
  execute.mockImplementation(async (query: any) => {
    const compiled = new PgDialect().sqlToQuery(query);
    if (compiled.sql.includes('WITH suppressed_leads')) {
      if (suppression === 'unavailable') throw new Error('Fixture suppression store unavailable');
      return { rows: suppression === 'blocked' ? [{ destination: '919900000001' }] : [] };
    }
    if (!assigned) return { rows: [] };
    if (compiled.sql.includes('SELECT channel,surface,account_id')) return { rows: configuration.bindings.map(b => ({ channel: b.channel, surface: b.surface, account_id: b.accountId })) };
    return { rows: [{ binding_id: 1, version: 1, revision: 1, assistant_id: uuid, enabled: true, state: 'live', published_revision: 1, configuration }] };
  });
  jest.spyOn(whatsappApiService, 'resolveCreds').mockResolvedValue({ source: 'channel_credentials', credId: 1, accessToken: 'test-only-token', phoneNumberId: 'phone', apiVersion: 'v25.0', isManual: true });
  jest.spyOn(whatsappApiService, 'ensureTokenValidity').mockResolvedValue('test-only-token');
  jest.spyOn(whatsappApiService, 'recordReadiness').mockResolvedValue(undefined);
});
afterEach(() => {
  globalThis.fetch = realFetch; jest.restoreAllMocks();
  if (previousEnabled === undefined) delete process.env.SUPPORT_ASSISTANTS_ENABLED; else process.env.SUPPORT_ASSISTANTS_ENABLED = previousEnabled;
  if (previousProfiles === undefined) delete process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES; else process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES = previousProfiles;
});

describe('final social customer delivery boundaries', () => {
  it.each(['runtime_disabled', 'assignment_required'])('keeps public reply API setup failures actionable: %s', async reason => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = reason === 'runtime_disabled' ? 'false' : 'true';
    assigned = false;
    selected.push([{ userId: 1, platform: 'instagram_api', accountIdentifier: 'ig', accessToken: 'test-only-token', sessionData: { useInstagramLogin: true } }]);
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
    await scope(() => socialCommentAction({ user: { id: 1 }, params: { id: '123', commentId: '456' }, body: {
      credentialId: 5, platform: 'instagram', action: 'reply', message: 'Hello', idempotencyKey: 'safe-local-key-00001',
    } } as any, res));
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason, deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql).some(query => query.includes('social_comment_actions'))).toBe(false);
  });
  it.each([
    { name: 'Facebook wrapper', send: () => sendFacebookDM({ userId: 1, recipientId: 'recipient', message: 'Hello', providerAccountId: 'page' }) },
    { name: 'Instagram wrapper', send: () => sendInstagramDM({ userId: 1, recipientId: 'recipient', message: 'Hello', providerAccountId: 'ig' }) },
    { name: 'Instagram outreach router', send: () => routeInstagramMessage({ userId: 1, leadId: 2, recipientUsername: 'recipient', message: 'Hello', providerAccountId: 'ig' }) },
    { name: 'Instagram direct-message service', send: () => new InstagramService().sendDirectMessage('recipient', 'Hello', 1) },
  ])('preserves setup metadata through the $name with zero provider calls', async ({ send }) => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
    await expectBlocked(send, false, 'runtime_disabled');
  });
  it.each(sends)('blocks $name when runtime is disabled without a provider call', async ({ send, throws }) => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'false'; await expectBlocked(send, throws, 'runtime_disabled');
  });
  it.each(sends)('blocks $name when no assistant is assigned without a provider call', async ({ send, throws }) => {
    assigned = false; await expectBlocked(send, throws, 'assignment_required');
  });
  it.each(sends)('blocks $name when a reviewed receipt belongs to another account', async ({ send, throws, channel }) => {
    await expectBlocked(() => withCustomerDeliveryReceipt(receipt(channel, 'other-account'), send), throws, 'assignment_changed');
  });
  it.each(sends)('blocks $name during an internal preview without a provider call', async ({ send, throws, channel, accountId }) => {
    await expectBlocked(() => withAssistantContext({ preview: true, provenance: receipt(channel, accountId), configuration: configuration as any }, send), throws, 'preview_only');
  });
  it.each(sends)('allows $name only after exact-account readiness succeeds', async ({ send }) => {
    await scope(send); expect(fetcher).toHaveBeenCalledTimes(1); expect(ready).toHaveBeenCalled();
  });
  it.each(sends.filter(send => send.channel === 'whatsapp'))('blocks opted-out support/outreach $name at the provider boundary', async ({ send }) => {
    suppression = 'blocked';
    await expect(scope(send)).rejects.toMatchObject({ code: 'RECIPIENT_SUPPRESSED', deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(sends.filter(send => send.channel === 'whatsapp'))('fails closed for $name when suppression cannot be checked', async ({ send }) => {
    suppression = 'unavailable';
    await expect(scope(send)).rejects.toMatchObject({ code: 'SUPPRESSION_UNAVAILABLE', deliveryAttempted: false, outcomeUncertain: false, retryable: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never uses CTA fallback to evade suppression failure', async () => {
    suppression = 'blocked';
    const fallback = jest.spyOn(whatsappApiService, 'sendText');
    await expect(scope(sends.find(send => send.name === 'WhatsApp CTA')!.send)).rejects.toMatchObject({ code: 'RECIPIENT_SUPPRESSED' });
    expect(fallback).not.toHaveBeenCalled();
  });
  it('does not use a CTA text fallback after an assistant setup rejection', async () => {
    assigned = false;
    const fallback = jest.spyOn(whatsappApiService, 'sendText');
    await expectBlocked(sends.find(send => send.name === 'WhatsApp CTA')!.send, true, 'assignment_required');
    expect(fallback).not.toHaveBeenCalled();
  });
  it('requires an explicit account context for the raw exported public-reply mutator', async () => {
    await expect(mutateMetaComment('https://graph.facebook.com/v25.0', 'token', '123/comments', { message: 'Hello' }, fetcher))
      .rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED', reason: 'account_required' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the account from the persisted insights credential for public replies', async () => {
    selected.length = 0;
    selected.push([{ accountIdentifier: 'ig', platform: 'instagram_api', accessToken: 'test-only-token', sessionData: { useInstagramLogin: true } }]);
    const client = await createMetaInsightsClient(1, 5);
    await scope(() => client.mutate('123/replies', { message: 'Hello' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const query = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query)).find(q => q.sql.includes('b.account_id='));
    expect(query?.params).toEqual(expect.arrayContaining(['instagram', 'public_comment', 'ig']));
  });
  it('rechecks the assignment immediately before WhatsApp dispatch after token preparation', async () => {
    jest.spyOn(whatsappApiService, 'ensureTokenValidity').mockImplementation(async () => { assigned = false; return 'test-only-token'; });
    await expectBlocked(whatsapp, true, 'assignment_required');
  });
  it('does not try the alternate Instagram attachment transport after a setup failure', async () => {
    assigned = false;
    await expectBlocked(() => instagram().sendMessageWithAttachment('recipient', 'image', 'https://example.test/image.jpg'), false, 'assignment_required');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('assistant freshness requires provenance for delivery even with rollout off', () => {
  it.each(['true', 'false'])('never treats missing provenance as current with runtime %s', async enabled => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = enabled;
    expect(await assistantDeliveryCurrent(undefined)).toBe(false);
    expect(await assistantProvenanceCurrent(undefined)).toBe(false);
    const work = jest.fn(async () => {});
    await expect(withPublishedAssistant(undefined, work)).rejects.toMatchObject({ code: 'ASSISTANT_SETUP_REQUIRED' });
    expect(await withPrivateAssistantForPublicDelivery(undefined, work)).toBe(false);
    expect(work).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not restore queued published work when runtime is disabled', async () => {
    process.env.SUPPORT_ASSISTANTS_ENABLED = 'false';
    const work = jest.fn(async () => {});
    await expect(withPublishedAssistant(receipt('facebook', 'page'), work)).rejects.toMatchObject({
      code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', deliveryAttempted: false, retryable: false,
    });
    expect(work).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
});
