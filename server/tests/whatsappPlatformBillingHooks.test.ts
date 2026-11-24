import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';

/**
 * The two places WhatsApp platform billing hooks into existing code: the
 * single send path (WhatsAppApiService.dispatch) and the delivery-status
 * webhook. The billing service itself is mocked; its behaviour is covered by
 * whatsappPlatformBilling.test.ts.
 */
installReadyCustomerDeliveryMock();
const execute = jest.fn<(query: unknown) => Promise<{ rows: unknown[] }>>();
const transaction = jest.fn(async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => callback({ execute }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: jest.fn() }));
jest.unstable_mockModule('../infrastructure/redis.js', () => ({ getRedisConnection: () => ({ incr: async () => 1, expire: async () => 1, get: async () => null }) }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../services/automations/AutomationReceipts.js', () => ({
  recordAutomationReceipt: async () => 0, notifyAutomationReceiptUpdate: async () => undefined,
}));

const charge = { id: 42, userId: 9, credits: 1.15 };
const reserveWhatsAppSend = jest.fn<(...args: unknown[]) => Promise<typeof charge | null>>();
const markWhatsAppSendAccepted = jest.fn<(...args: unknown[]) => Promise<void>>();
const markWhatsAppSendFailed = jest.fn<(...args: unknown[]) => Promise<void>>();
const settleWhatsAppChargeFromStatus = jest.fn<(...args: unknown[]) => Promise<string>>();
jest.unstable_mockModule('../services/whatsapp/WhatsAppBillingService.js', () => ({
  reserveWhatsAppSend, markWhatsAppSendAccepted, markWhatsAppSendFailed, settleWhatsAppChargeFromStatus,
}));

const { WhatsAppApiService } = await import('../services/whatsappApiService.js');
const { processWhatsAppStatus } = await import('../controllers/webhooks/whatsapp.js');

const account = 'fixture-phone';
const send = (service: InstanceType<typeof WhatsAppApiService>) =>
  service.sendTemplate({ userId: 9, phoneNumberId: account, to: '919900000002', templateName: 'order_update', language: 'en' });
let service: InstanceType<typeof WhatsAppApiService>;
let provider: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [] });
  reserveWhatsAppSend.mockResolvedValue(charge);
  settleWhatsAppChargeFromStatus.mockResolvedValue('settled');
  service = new WhatsAppApiService();
  jest.spyOn(service, 'resolveCreds').mockResolvedValue({ source: 'channel_credentials', credId: 1, accessToken: 'test-only-token',
    phoneNumberId: account, businessAccountId: 'waba-1', apiVersion: 'v25.0', isManual: false });
  jest.spyOn(service, 'ensureTokenValidity').mockResolvedValue('test-only-token');
  jest.spyOn(service, 'recordReadiness').mockResolvedValue(undefined);
  provider = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ messages: [{ id: 'wamid.fixture' }] }));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('billing around the WhatsApp send path', () => {
  it('reserves for the sending WABA, then binds the wamid Meta returns', async () => {
    await expect(send(service)).resolves.toEqual({ messages: [{ id: 'wamid.fixture' }] });
    expect(reserveWhatsAppSend).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9, wabaId: 'waba-1', phoneNumberId: account, payload: expect.objectContaining({ type: 'template' }),
    }));
    expect(markWhatsAppSendAccepted).toHaveBeenCalledWith(charge, 'wamid.fixture');
    expect(markWhatsAppSendFailed).not.toHaveBeenCalled();
  });

  it('never calls Meta when the message cannot be reserved', async () => {
    reserveWhatsAppSend.mockRejectedValue(Object.assign(new Error('Insufficient credits.'), { code: 'INSUFFICIENT_CREDITS', outcomeUncertain: false }));
    await expect(send(service)).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS', deliveryAttempted: false });
    expect(provider).not.toHaveBeenCalled();
  });

  it('reports a definitive Meta rejection as certain', async () => {
    provider.mockResolvedValue(Response.json({ error: { code: 131026, message: 'Fixture undeliverable' } }, { status: 400 }));
    await expect(send(service)).rejects.toThrow('Fixture undeliverable');
    expect(markWhatsAppSendFailed).toHaveBeenCalledWith(charge, expect.objectContaining({ outcomeUncertain: false }));
  });

  it('reports a timeout as uncertain', async () => {
    provider.mockRejectedValue(new Error('Fixture timeout'));
    await expect(send(service)).rejects.toThrow('Fixture timeout');
    const [, error] = markWhatsAppSendFailed.mock.calls[0] as [unknown, { outcomeUncertain?: boolean }];
    expect(error.outcomeUncertain).toBeUndefined();
  });

  it('changes nothing for an account that is not platform billed', async () => {
    reserveWhatsAppSend.mockResolvedValue(null);
    await expect(send(service)).resolves.toEqual({ messages: [{ id: 'wamid.fixture' }] });
    expect(markWhatsAppSendAccepted).not.toHaveBeenCalled();
  });
});

describe('billing from the delivery webhook', () => {
  const pricing = { billable: true, pricing_model: 'PMP', type: 'regular', category: 'utility' };

  it('passes the phone number, wamid, status and Meta pricing to settlement after the status commits', async () => {
    await processWhatsAppStatus(9, { id: 'wamid.fixture', status: 'delivered', timestamp: '1763450000', recipient_id: '919900000002', pricing },
      { phone_number_id: account });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(settleWhatsAppChargeFromStatus).toHaveBeenCalledWith({ phoneNumberId: account, wamid: 'wamid.fixture', status: 'delivered', pricing, errors: null });
  });

  it("passes Meta's failure errors so a payment problem can be flagged", async () => {
    const errors = [{ code: 131042, title: 'Business eligibility payment issue' }];
    await processWhatsAppStatus(9, { id: 'wamid.fixture', status: 'failed', timestamp: '1763450000', recipient_id: '919900000002', errors },
      { phone_number_id: account });
    expect(settleWhatsAppChargeFromStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errors }));
  });

  it("saves WhatsApp's failure code beside the error text it explains", async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    await processWhatsAppStatus(9, { id: 'wamid.fixture', status: 'failed', timestamp: '1763450000', recipient_id: '919900000002',
      errors: [{ code: 131026, message: 'Message undeliverable' }] }, { phone_number_id: account });
    const update = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query as never))
      .find(query => /UPDATE outreach_messages/.test(query.sql))!;
    expect(update.sql).toContain("'providerFailure',jsonb_build_object('code'");
    expect(update.params).toEqual(expect.arrayContaining(['131026', 'Message undeliverable']));
  });

  it('fails the webhook so Meta retries when settlement fails', async () => {
    settleWhatsAppChargeFromStatus.mockRejectedValue(new Error('Fixture wallet unavailable'));
    await expect(processWhatsAppStatus(9, { id: 'wamid.fixture', status: 'delivered', timestamp: '1763450000', pricing },
      { phone_number_id: account })).rejects.toThrow('Fixture wallet unavailable');
  });
});
