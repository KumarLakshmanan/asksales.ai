import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const findDefault = jest.fn<(...args: any[]) => Promise<any>>();
const updateDefault = jest.fn();
const deactivateDefault = jest.fn();
const selected = jest.fn<(...args: any[]) => Promise<any>>();
const where = jest.fn();
const updateWhere = jest.fn<(...args: any[]) => Promise<any>>();
const set = jest.fn();
const refresh = jest.fn<(...args: any[]) => Promise<any>>();
const setCredentials = jest.fn();
const transaction = async (work: any) => work(fixtureDb);
const fixtureDb: any = { transaction, execute: async () => ({ rows: [] }),
  select: () => ({ from: () => ({ where: (value: SQL) => { where(value); return { limit: (...args: any[]) => Object.assign(selected(...args), { for: () => selected(...args) }) }; } }) }),
  update: () => ({ set: (value: any) => { set(value); return { where: updateWhere }; } }),
};
jest.unstable_mockModule('../services/EmailOpenTrackingService.js', () => ({ prepareEmailOpenTracking: async (_userId: number, html: string) => ({ html }), confirmEmailOpenTracking: async () => {} }));
jest.unstable_mockModule('../models/db.js', () => ({ db: fixtureDb }));
jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({ ChannelCredentialModel: {
  findByUserAndPlatform: findDefault, update: updateDefault, deactivate: deactivateDefault,
} }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getActiveAdminCredential: async () => ({ apiKey: 'qa-client', apiSecret: 'qa-secret' }) }));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({
  getChannelCredentialEncryptionKeyId: () => 'local-key',
  decryptChannelCredentialSecret: (value: string) => value,
  decryptChannelCredentialSession: (value: any) => value,
  encryptChannelCredentialSecret: (value: string) => `encrypted:${value}`,
  encryptChannelCredentialSession: (value: any) => value,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('googleapis', () => ({ google: { auth: { OAuth2: class {
  transporter = { interceptors: { request: { add: jest.fn() } } };
  setCredentials = setCredentials;
  refreshAccessToken = refresh;
} } } }));
const { getGmailClientForUser } = await import('../controllers/gmailOAuthController.js');
const parse = (value: SQL) => new PgDialect().sqlToQuery(value);
const credential = () => ({ id: 31, userId: 9, accountIdentifier: 'owner@example.test', accessToken: 'qa-access', refreshToken: 'qa-refresh', tokenExpiry: new Date('2020-01-01') });
const binding = { credentialId: 31, accountIdentifier: ' Owner@Example.Test ' };
beforeEach(() => {
  jest.clearAllMocks();
  findDefault.mockReset().mockResolvedValue(null);
  selected.mockReset().mockResolvedValue([credential()]);
  updateWhere.mockReset().mockResolvedValue([]);
  refresh.mockReset().mockResolvedValue({ credentials: { access_token: 'new-access', refresh_token: 'new-refresh', expiry_date: Date.now() + 3600000 } });
});
describe('exact Gmail OAuth account binding', () => {
  it('uses a still-valid bound token during the SDK early refresh window', async () => {
    const current = { ...credential(), tokenExpiry: new Date(Date.now() + 180_000) };
    selected.mockResolvedValueOnce([current]);
    const result = await getGmailClientForUser(9, binding);
    expect(result?.client.eagerRefreshThresholdMillis).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(setCredentials).toHaveBeenCalledWith({ access_token: 'qa-access', expiry_date: current.tokenExpiry.getTime() });
  });
  it('loads and refreshes only the active tenant/account credential requested by the webhook', async () => {
    expect(await getGmailClientForUser(9, binding)).not.toBeNull();
    expect(parse(where.mock.calls[0][0] as SQL).params).toEqual([31, 9, 'gmail_api', true, 'owner@example.test']);
    expect(parse(updateWhere.mock.calls[0][0]).params).toEqual([31, 9, 'gmail_api', true, 'owner@example.test']);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'encrypted:new-access', refreshToken: 'encrypted:new-refresh' }));
    expect(updateDefault).not.toHaveBeenCalled();
    expect(findDefault).toHaveBeenCalledWith(9, 'gmail_config');
    expect(findDefault).not.toHaveBeenCalledWith(9, 'gmail_api');
  });
  it('does not fall back to the selected account when the exact credential is missing or unauthorized', async () => {
    selected.mockResolvedValueOnce([]);
    expect(await getGmailClientForUser(9, binding)).toBeNull();
    expect(findDefault).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('deactivates only the revoked bound credential, never every Gmail account', async () => {
    refresh.mockRejectedValueOnce({ response: { data: { error: 'invalid_grant' } } });
    expect(await getGmailClientForUser(9, binding)).toBeNull();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
    expect(parse(updateWhere.mock.calls[0][0]).params).toEqual([31, 9, 'gmail_api', true, 'owner@example.test']);
    expect(deactivateDefault).not.toHaveBeenCalled();
  });
  it('preserves selected-account lookup for existing unbound callers', async () => {
    findDefault.mockResolvedValueOnce({ ...credential(), tokenExpiry: new Date(Date.now() + 3600000) });
    expect(await getGmailClientForUser(9)).not.toBeNull();
    expect(findDefault).toHaveBeenCalledWith(9, 'gmail_api');
    expect(selected).not.toHaveBeenCalled();
  });
  it('refreshes only the selected account for unbound callers', async () => {
    findDefault.mockResolvedValueOnce(credential());
    expect(await getGmailClientForUser(9)).not.toBeNull();
    expect(parse(updateWhere.mock.calls[0][0]).params).toEqual([31, 9, 'gmail_api', true, 'owner@example.test']);
    expect(updateDefault).not.toHaveBeenCalled();
  });
  it('keeps other accounts connected when the selected account token is revoked', async () => {
    findDefault.mockResolvedValueOnce(credential());
    refresh.mockRejectedValueOnce({ response: { data: { error: 'invalid_grant' } } });
    expect(await getGmailClientForUser(9)).toBeNull();
    expect(parse(updateWhere.mock.calls[0][0]).params).toEqual([31, 9, 'gmail_api', true, 'owner@example.test']);
    expect(deactivateDefault).not.toHaveBeenCalled();
  });
});
