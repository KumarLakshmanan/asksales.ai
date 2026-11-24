import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const recordDelivery = jest.fn<any>();
const execute = jest.fn<any>();
const publish = jest.fn<any>();
const secretBytes = Buffer.from('outreach-delivery-test-secret');
const secret = `whsec_${secretBytes.toString('base64')}`;
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: async () => ({ config: { webhookSecret: secret } }) }));
jest.unstable_mockModule('../services/InboundEmailService.js', () => ({
  updateEmailDeliveryStatus: recordDelivery, publishEmailStatusEvent: publish,
  processInboundEmail: jest.fn(), recordEmailClick: jest.fn(), extractEmailFromUnknown: jest.fn().mockReturnValue(''),
  extractNameFromUnknown: jest.fn(), extractEmailsFromUnknown: jest.fn().mockReturnValue([]), isLikelyEmail: jest.fn(),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { handleResendWebhook } = await import('../controllers/resendWebhookController.js');

function request(type: string, validSignature = true): Request {
  const body = { type, data: { email_id: 'provider-receipt' } };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = 'signed-test-event';
  const signature = crypto.createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return { body, rawBody, headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${validSignature ? signature : 'invalid'}` } } as unknown as Request;
}
function response() {
  const res = { status: jest.fn<any>(), json: jest.fn<any>() };
  res.status.mockReturnValue(res);
  return res;
}

describe('verified email receipt acknowledgement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordDelivery.mockResolvedValue(undefined);
    execute.mockResolvedValue({ rows: [{ user_id: 9, business_profile_id: 17 }] });
    publish.mockResolvedValue(undefined);
  });

  it.each(['email.delivered', 'email.bounced', 'email.opened'])('asks the provider to retry %s when durable reconciliation fails', async (type) => {
    recordDelivery.mockRejectedValue(new Error('Fake persistence failure'));
    const res = response();
    await handleResendWebhook(request(type), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).not.toHaveBeenCalledWith({ received: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it('acknowledges only after the delivery receipt was recorded', async () => {
    const res = response();
    await handleResendWebhook(request('email.delivered'), res as unknown as Response);
    expect(recordDelivery).toHaveBeenCalledWith('provider-receipt', 'delivered', {});
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(res.status).not.toHaveBeenCalledWith(503);
  });

  it('does not persist an unverified callback', async () => {
    const res = response();
    await handleResendWebhook(request('email.delivered', false), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(recordDelivery).not.toHaveBeenCalled();
  });
});
