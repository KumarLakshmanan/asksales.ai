import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const providerSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const execute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const sender = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const gmailConnected = jest.fn<() => Promise<boolean>>();
// Recipient policy has dedicated PostgreSQL acceptance coverage; this suite isolates the adapter/context contract.
jest.unstable_mockModule('../services/EmailOpenTrackingService.js', () => ({ prepareEmailOpenTracking: async (_userId: number, html: string) => ({ html }), confirmEmailOpenTracking: async () => {} }));
const prepareDesign = jest.fn<(...args: any[]) => Promise<string>>().mockImplementation(async (_userId, body) => body);
jest.unstable_mockModule('../services/EmailDesignService.js', () => ({ prepareDesignedEmail: prepareDesign }));
jest.unstable_mockModule('../services/outreach/RecipientSuppressionService.js',()=>({assertRecipientNotSuppressed:async()=>{}}));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({
  getById: sender,
}));
jest.unstable_mockModule('../services/gmailApiService.js', () => ({ GmailApiService: {
  getInstance: () => ({ isConnected: gmailConnected, sendEmail: providerSend }),
} }));
jest.unstable_mockModule('../services/resendService.js', () => ({
  getVerifiedDomain: async () => ({ name: 'example.test' }),
  isVerifiedDomainForUser: async () => true,
  sendEmail: providerSend,
}));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {} }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { emailService } = await import('../services/emailService.js');
const send = () => emailService.sendEmailWithUserCredentials(12, {
  to: 'recipient@example.test', subject: 'Synthetic', html: '<p>Fixture only</p>',
  idempotencyKey: 'synthetic-reviewed-intent',
}, 7);

describe('Resend adapter acceptance evidence with a mocked provider contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    providerSend.mockResolvedValue({ id: 'fixture-provider-id' });
    sender.mockResolvedValue({ id: 7, type: 'resend', email: 'sender@example.test', isVerified: true });
  });
  it('preserves campaign-owned reply presentation without substituting the support business brand', async () => {
    const html = '<p>Campaign-owned reply</p>';
    const result = await emailService.sendEmailWithUserCredentials(12, { to: 'recipient@example.test', subject: 'Campaign reply', html, preservePresentation: true }, 7);
    expect(result.success).toBe(true);
    expect(prepareDesign).not.toHaveBeenCalled();
    expect(providerSend).toHaveBeenCalledWith(expect.objectContaining({ html }));
  });
  it('stops unresolved HTML-only and subject-only tokens before the provider call', async () => {
    for (const fields of [{ html: '<b>Hi {{First Name}}</b>' }, { subject: 'Hello {{first_name}}' }]) {
      const result = await emailService.sendEmailWithUserCredentials(12, { to: 'recipient@example.test', subject: 'Assessment', html: '<b>Assessment</b>', ...fields }, 7);
      expect(result).toMatchObject({ success: false, deliveryAttempted: false, outcomeUncertain: false });
    }
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each([
    { html: '<b>Hi {{first Name}},</b>' },
    { html: '<span>{{first </span><b>Name}}</b>' },
    { subject: 'Assessment for {{first Name}}' },
    { text: 'Hi {{first Name}},' },
    { text: 'Hi &#123;&#123;first_name&#125;&#125;,' },
  ])('reports unresolved historical-style variables before sender selection: %j', async fields => {
    const result = await emailService.sendEmailWithUserCredentials(12, { to: 'recipient@example.test', subject: 'Assessment', html: '<b>Assessment</b>', ...fields }, 7);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Missing email personalization values:'), deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    expect(sender).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });

  it('preserves definitive no-send evidence when Gmail is disconnected before dispatch', async () => {
    sender.mockResolvedValue({ id: 7, type: 'gmail', email: 'sender@example.test', isVerified: true });
    gmailConnected.mockResolvedValue(false);
    expect(await send()).toMatchObject({ success: false, deliveryAttempted: false, outcomeUncertain: false });
    expect(providerSend).not.toHaveBeenCalled();
  });

  it('returns provider acceptance separately from its local RFC header and forwards the stable key', async () => {
    expect(await send()).toMatchObject({ success: true, providerMessageId: 'fixture-provider-id',
      rfcMessageId: expect.stringMatching(/^<[^<>]+@example\.test>$/), deliveryAttempted: true, outcomeUncertain: false });
    expect(providerSend).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'synthetic-reviewed-intent' }));
  });

  it.each([undefined, null, {}, { id: '' }, { id: ' ' }, { id: 123 }, { id: '<local@example.test>' }])('holds missing/malformed response %j despite a locally generated Message-ID', async response => {
    providerSend.mockResolvedValue(response);
    expect(await send()).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true, retryable: false });
    expect(execute).not.toHaveBeenCalled();
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    { deliveryAttempted: false, outcomeUncertain: false },
    { deliveryAttempted: true, outcomeUncertain: false },
    { deliveryAttempted: true, outcomeUncertain: true },
  ])('preserves structured preflight/rejection/timeout evidence %j', async evidence => {
    providerSend.mockRejectedValue(Object.assign(new Error('Synthetic provider failure'), evidence));
    expect(await send()).toMatchObject({ success: false, ...evidence });
    expect(providerSend).toHaveBeenCalledTimes(1);
  });
});
