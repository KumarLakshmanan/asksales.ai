import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
import { createSupportChoiceManifest } from '../services/agents/orchestration/SupportChoiceDelivery.js';

// Exercise the real transport and suppression service with mocked I/O only.
// The DB responses below do not validate PostgreSQL alias matching or RLS.
installReadyCustomerDeliveryMock();
const execute = jest.fn<(query: SQL) => Promise<{ rows: Array<{ destination: string }> }>>();
const mediaBinding = jest.fn<(key: string) => Promise<string | null>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: jest.fn() }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({
  incr: async () => 1, expire: async () => 1, get: mediaBinding,
}) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} }));
const { WhatsAppApiService } = await import('../services/whatsappApiService.js');
const { getSuppressedRecipients } = await import('../services/outreach/RecipientSuppressionService.js');
let service: InstanceType<typeof WhatsAppApiService>;
let provider: jest.SpiedFunction<typeof fetch>;
const owner = 9;
const account = 'fixture-phone';
const recipient = '+91 (99000) 00002';
const normalized = '919900000002';
const contextMessageId = 'wamid.fixture-inbound';
const common = { userId: owner, phoneNumberId: account, to: recipient };
const text = 'Open the approved page: https://example.test/book';
const choice = createSupportChoiceManifest({ runId: 1, nodeId: 'confirm', field: {
  key: 'confirmed', type: 'boolean', required: true, pii: 'none', prompt: 'Continue?',
} })!;
const listChoice = createSupportChoiceManifest({ runId: 1, nodeId: 'menu', field: {
  key: 'option', type: 'single_select', required: true, pii: 'none', prompt: 'Choose a service',
  options: ['One', 'Two', 'Three', 'Four'].map(label => ({ label, value: label })),
} })!;
const fallbackChoice = { ...choice, options: choice.options.map(option => ({ ...option, shortLabel: 'A label longer than the native control limit' })) };
const sendCta = () => service.sendCtaUrl({ ...common, contextMessageId, text, title: 'Open', url: 'https://example.test/book', allowTextFallback: true });
const sends = [
  { name: 'support text', type: 'text', send: () => service.sendText({ ...common, text, contextMessageId }) },
  { name: 'reply buttons', type: 'interactive', send: () => service.sendChoice({ ...common, text: choice.prompt, choice, contextMessageId }) },
  { name: 'list choices', type: 'interactive', send: () => service.sendChoice({ ...common, text: listChoice.prompt, choice: listChoice, contextMessageId }) },
  { name: 'numbered choice fallback', type: 'text', send: () => service.sendChoice({ ...common, text: fallbackChoice.fallbackText, choice: fallbackChoice, contextMessageId }) },
  { name: 'CTA', type: 'interactive', send: sendCta },
  { name: 'template', type: 'template', send: () => service.sendTemplate({ ...common, templateName: 'fixture', language: 'en_US' }) },
  ...(['image', 'document', 'video', 'audio'] as const).map(mediaType => ({ name: mediaType, type: mediaType,
    send: () => service.sendMedia({ ...common, mediaType, mediaId: 'fixture-media' }),
  })),
  { name: 'legacy text wrapper', type: 'text', send: () => service.sendMessage(owner, account, recipient, text) },
];
const blocked = { code: 'RECIPIENT_SUPPRESSED', suppressionCheckFailed: true,
  deliveryAttempted: false, outcomeUncertain: false, retryable: false };
const unavailable = { ...blocked, code: 'SUPPRESSION_UNAVAILABLE', retryable: true };
const dialect = new PgDialect();
const queries = () => execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
const payloads = () => provider.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ rows: [] });
  mediaBinding.mockReset().mockResolvedValue('image');
  service = new WhatsAppApiService();
  jest.spyOn(service, 'resolveCreds').mockResolvedValue({ source: 'channel_credentials', credId: 1,
    accessToken: 'test-only-token', phoneNumberId: account, apiVersion: 'v25.0', isManual: true });
  jest.spyOn(service, 'ensureTokenValidity').mockResolvedValue('test-only-token');
  jest.spyOn(service, 'recordReadiness').mockResolvedValue(undefined);
  // No call in this suite can reach a provider, including the allowed controls.
  provider = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ messages: [{ id: 'wamid.fixture' }] }));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('shared WhatsApp transport suppression', () => {
  it.each(sends)('checks the actual normalized destination for allowed $name', async ({ send, type }) => {
    await expect(send()).resolves.toEqual({ messages: [{ id: 'wamid.fixture' }] });
    expect(queries()).toHaveLength(1);
    expect(queries()[0].params).toEqual([owner, normalized]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0][0]).toBe(`https://graph.facebook.com/v25.0/${account}/messages`);
    expect(payloads()[0]).toMatchObject({ to: recipient, type });
  });

  it.each(sends)('rechecks an opt-out recorded during token preparation for $name', async ({ send }) => {
    jest.mocked(service.ensureTokenValidity).mockImplementation(async () => {
      expect(execute).not.toHaveBeenCalled();
      execute.mockResolvedValue({ rows: [{ destination: normalized }] });
      return 'test-only-token';
    });
    await expect(send()).rejects.toMatchObject(blocked);
    expect(queries().map(query => query.params)).toEqual([[owner, normalized]]);
    expect(provider).not.toHaveBeenCalled();
    expect(service.recordReadiness).not.toHaveBeenCalled();
  });

  it.each(sends)('does not call the provider when the suppression store fails for $name', async ({ send }) => {
    const cause = new Error('Fixture suppression store unavailable');
    execute.mockRejectedValue(cause);
    await expect(send()).rejects.toMatchObject({ ...unavailable, cause });
    expect(provider).not.toHaveBeenCalled();
    expect(service.recordReadiness).not.toHaveBeenCalled();
  });

  it('rechecks after account-scoped template media validation', async () => {
    mediaBinding.mockImplementation(async () => {
      execute.mockResolvedValue({ rows: [{ destination: normalized }] });
      return 'image';
    });
    await expect(service.sendTemplate({ ...common, templateName: 'fixture', language: 'en',
      components: [{ type: 'header', parameters: [{ type: 'image', image: { id: 'fixture-media' } }] }],
    })).rejects.toMatchObject(blocked);
    expect(mediaBinding).toHaveBeenCalledWith(`wa-template-media:${owner}:${account}:fixture-media`);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
  });

  it('preserves destination and reply context through a numbered-choice fallback', async () => {
    await service.sendChoice({ ...common, text: fallbackChoice.fallbackText, choice: fallbackChoice, contextMessageId });
    expect(payloads()).toEqual([{ messaging_product: 'whatsapp', to: recipient, type: 'text',
      text: { body: fallbackChoice.fallbackText, preview_url: false }, context: { message_id: contextMessageId } }]);
    expect(queries()[0].params).toEqual([owner, normalized]);
  });
});

describe('CTA fallback identity and suppression freshness', () => {
  const rejectCta = () => Response.json({ error: { code: 100, message: 'Fixture CTA unsupported' } }, { status: 400 });

  it('keeps the exact destination, account, text and reply context for a permitted fallback', async () => {
    provider.mockResolvedValueOnce(rejectCta());
    await expect(sendCta()).resolves.toEqual({ messages: [{ id: 'wamid.fixture' }] });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(payloads().map(payload => payload.to)).toEqual([recipient, recipient]);
    expect(payloads()[1]).toMatchObject({ type: 'text', text: { body: text }, context: { message_id: contextMessageId } });
    expect(queries().map(query => query.params)).toEqual([[owner, normalized], [owner, normalized]]);
    expect(service.resolveCreds).toHaveBeenNthCalledWith(1, owner, account);
    expect(service.resolveCreds).toHaveBeenNthCalledWith(2, owner, account);
  });

  it.each(['blocked', 'unavailable'])('rechecks suppression before fallback when it becomes %s after CTA rejection', async state => {
    provider.mockImplementationOnce(async () => {
      if (state === 'blocked') execute.mockResolvedValue({ rows: [{ destination: normalized }] });
      else execute.mockRejectedValue(new Error('Fixture suppression store unavailable'));
      return rejectCta();
    });
    await expect(sendCta()).rejects.toMatchObject(state === 'blocked' ? blocked : unavailable);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(payloads()[0].type).toBe('interactive');
    expect(queries().map(query => query.params)).toEqual([[owner, normalized], [owner, normalized]]);
  });

  it.each(['blocked', 'unavailable'])('never enters text fallback after an initial %s suppression check', async state => {
    if (state === 'blocked') execute.mockResolvedValue({ rows: [{ destination: normalized }] });
    else execute.mockRejectedValue(new Error('Fixture suppression store unavailable'));
    const fallback = jest.spyOn(service, 'sendText');
    await expect(sendCta()).rejects.toMatchObject(state === 'blocked' ? blocked : unavailable);
    expect(fallback).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'unknown HTTP 503'])('does not start a second delivery after %s', async failure => {
    if (failure === 'timeout') provider.mockRejectedValueOnce(new Error('Fixture timeout'));
    else provider.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
    const fallback = jest.spyOn(service, 'sendText');
    await expect(sendCta()).rejects.toMatchObject({ deliveryAttempted: true });
    expect(fallback).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsApp destination alias lookup contract', () => {
  it('deduplicates formatted aliases without adding an SMS country-code fallback', async () => {
    execute.mockResolvedValue({ rows: [{ destination: normalized }, { destination: '9900000002' }] });
    expect(await getSuppressedRecipients(owner, 'whatsapp', [recipient, normalized, '99000 00002', '', '---']))
      .toEqual(new Set([normalized, '9900000002']));
    expect(queries()[0].params).toEqual([owner, normalized, '9900000002']);
  });

  it('scopes each alias lookup to the requested owner without reusing a prior result', async () => {
    execute.mockResolvedValueOnce({ rows: [{ destination: normalized }] }).mockResolvedValueOnce({ rows: [] });
    expect(await getSuppressedRecipients(owner, 'whatsapp', [recipient])).toEqual(new Set([normalized]));
    expect(await getSuppressedRecipients(owner + 1, 'whatsapp', [recipient])).toEqual(new Set());
    expect(queries().map(query => query.params)).toEqual([[owner, normalized], [owner + 1, normalized]]);
  });
});
