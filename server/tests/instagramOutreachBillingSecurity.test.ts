/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

const findByIdForUser = jest.fn<any>();
const reserveOutreachCredit = jest.fn<any>();
const refundDeduction = jest.fn<any>();
const routeInstagramMessage = jest.fn<any>();
const execute = jest.fn<any>();

jest.unstable_mockModule('../models/leads/functions.js', () => ({
  LeadModel: { findByIdForUser },
}));
jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: { reserveOutreachCredit, refundDeduction },
}));
jest.unstable_mockModule('../services/IdempotencyService.js', () => ({
  idempotencyService: {
    checkAndStore: jest.fn<any>().mockResolvedValue({ status: 'fresh' }),
    storeResponse: jest.fn<any>(),
    forget: jest.fn<any>(),
  },
}));
jest.unstable_mockModule('../services/instagramService', () => ({
  instagramService: {
    hasCredentials: jest.fn<any>().mockReturnValue(false),
    initialize: jest.fn<any>(),
  },
}));
jest.unstable_mockModule('../services/instagramMessageRouter.js', () => ({ routeInstagramMessage }));
jest.unstable_mockModule('../models/db', () => ({
  db: {
    execute,
    select: jest.fn<any>(),
    insert: jest.fn<any>(),
    update: jest.fn<any>(),
  },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { mockAuthRequest, mockResponse } = await import('./helpers/mockHelpers.js');
const controller = await import('../controllers/instagramController.js');
const sendDirectMessage: typeof controller.sendDirectMessage = (req, res) => withBusinessScope({ userId: 42, businessProfileId: 17 }, () => controller.sendDirectMessage(req, res));
const sendBulkDirectMessages: typeof controller.sendBulkDirectMessages = (req, res) => withBusinessScope({ userId: 42, businessProfileId: 17 }, () => controller.sendBulkDirectMessages(req, res));

const ownedLead = {
  id: 7,
  userId: 42,
  name: 'Asha Rao',
  firstName: 'Asha',
  lastName: 'Rao',
  company: 'Example Co',
  role: 'Founder',
  instagramHandle: 'authoritative.handle',
  instagram: null,
  blacklisted: false,
  doNotContact: false,
};

describe('Instagram outreach billing and tenant boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findByIdForUser.mockResolvedValue(ownedLead);
    reserveOutreachCredit.mockResolvedValue({ success: true, transactionId: 91 });
    refundDeduction.mockResolvedValue({ success: true });
    routeInstagramMessage.mockResolvedValue({ success: true, username: 'authoritative.handle', method: 'graph_api' });
    execute.mockResolvedValue({ rows: [] });
  });

  it('does not reserve credits or send when the lead is outside the tenant', async () => {
    findByIdForUser.mockResolvedValue(undefined);
    const req = mockAuthRequest(42, { body: { leadId: 99, username: 'victim', message: 'Hello' } });
    const res = mockResponse();

    await sendDirectMessage(req, res);

    expect(findByIdForUser).toHaveBeenCalledWith(99, 42);
    expect(res._status).toBe(404);
    expect(reserveOutreachCredit).not.toHaveBeenCalled();
    expect(routeInstagramMessage).not.toHaveBeenCalled();
  });

  it('uses the persisted handle and reserves credit before the provider call', async () => {
    const req = mockAuthRequest(42, { body: { leadId: 7, username: 'untrusted.handle', message: 'Hello' } });
    const res = mockResponse();

    await sendDirectMessage(req, res);

    expect(reserveOutreachCredit).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, channel: 'instagram' }));
    expect(routeInstagramMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      leadId: 7,
      recipientUsername: 'authoritative.handle',
      skipCreditDeduction: true,
    }));
    expect(res._status).toBe(200);
  });

  it('does not call the provider when the wallet reservation fails', async () => {
    reserveOutreachCredit.mockResolvedValue({ success: false, error: 'Insufficient credits.' });
    const req = mockAuthRequest(42, { body: { leadId: 7, message: 'Hello' } });
    const res = mockResponse();

    await sendDirectMessage(req, res);

    expect(res._status).toBe(402);
    expect(routeInstagramMessage).not.toHaveBeenCalled();
  });

  it('refunds the exact reservation after a definitive provider failure', async () => {
    routeInstagramMessage.mockResolvedValue({ success: false, error: 'Provider rejected', method: 'graph_api' });
    const req = mockAuthRequest(42, { body: { leadId: 7, message: 'Hello' } });
    const res = mockResponse();

    await sendDirectMessage(req, res);

    expect(refundDeduction).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, transactionId: 91 }));
    expect(res._status).toBe(422);
  });

  it('personalizes bulk sends from tenant-owned records instead of client-supplied lead data', async () => {
    const req = mockAuthRequest(42, {
      body: {
        leads: [{ id: 7, firstName: 'Mallory', instagramHandle: 'untrusted.handle' }],
        message: 'Hi {{first_name}} from {{company}}',
        personalize: true,
      },
    });
    const res = mockResponse();

    await sendBulkDirectMessages(req, res);

    expect(routeInstagramMessage).toHaveBeenCalledWith(expect.objectContaining({
      recipientUsername: 'authoritative.handle',
      message: 'Hi Asha from Example Co',
      skipCreditDeduction: true,
    }));
    expect(res._json.summary).toEqual({ total: 1, sent: 1, failed: 0 });
  });
});
