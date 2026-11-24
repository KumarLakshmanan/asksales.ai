import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const providerSend = jest.fn<(...args: unknown[]) => Promise<any>>();
const constructor = jest.fn().mockImplementation(() => ({ emails: { send: providerSend } }));
jest.unstable_mockModule('resend', () => ({ Resend: constructor }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: async () => ({ apiKey: 'synthetic-key' }), decryptAdminCredential: (v: unknown) => v }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { sendEmail } = await import('../services/resendService.js');

describe('direct Resend template variable guard', () => {
  beforeEach(() => { jest.clearAllMocks(); providerSend.mockResolvedValue({ data: { id: 'synthetic-receipt' }, error: null }); });
  it.each(['{{first_name}}', '&#123;&#123;company_name&#125;&#125;', '<span>{{first_</span><b>name}}</b>'])('stops visible %s before creating a provider client', async html => {
    await expect(sendEmail({ from: 'sender@example.test', to: 'recipient@example.test', subject: 'Update', html })).rejects.toMatchObject({ code: 'EMAIL_PERSONALIZATION_UNRESOLVED', deliveryAttempted: false, outcomeUncertain: false });
    expect(constructor).not.toHaveBeenCalled(); expect(providerSend).not.toHaveBeenCalled();
  });
  it.each([
    { subject: 'Assessment for {{first Name}}' },
    { html: '<p>Hi {{first Name}},</p>' },
    { text: 'Hi {{first Name}},' },
  ])('blocks the reported variable in every delivery field: %j', async fields => {
    await expect(sendEmail({ from: 'sender@example.test', to: 'recipient@example.test', subject: 'Assessment', html: '<p>Resolved body</p>', ...fields })).rejects.toMatchObject({ message: expect.stringContaining('Missing email personalization values:'), code: 'EMAIL_PERSONALIZATION_UNRESOLVED', unresolvedTokens: expect.any(Array), deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    expect(constructor).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('passes resolved HTML and text to the provider unchanged', async () => {
    await expect(sendEmail({ from: 'sender@example.test', to: 'recipient@example.test', subject: 'Update', html: '<b>Hi Uma</b>', text: 'Hi Uma' })).resolves.toMatchObject({ id: 'synthetic-receipt' });
    expect(providerSend).toHaveBeenCalledWith(expect.objectContaining({ html: '<b>Hi Uma</b>', text: 'Hi Uma' }), undefined);
  });
});
