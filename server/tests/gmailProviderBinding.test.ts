import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getCredential = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateCredential = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getClient = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getTokenInfo = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getProfile = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let row: Record<string, unknown>;

jest.unstable_mockModule('../models/db.js', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [row] }) }) }) }),
} }));
jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({ ChannelCredentialModel: {
  findActiveAccountById: getCredential,
  findActiveAccountByIdentifier: getCredential,
  findByUserAndPlatform: getCredential,
  updateAccount: updateCredential,
} }));
jest.unstable_mockModule('../controllers/gmailOAuthController.js', () => ({ getGmailClientForUser: getClient }));
jest.unstable_mockModule('googleapis', () => ({ google: {
  gmail: () => ({ users: { getProfile } }),
} }));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({
  decryptChannelCredentialSecret: (value: string) => value,
  decryptChannelCredentialSession: (value: unknown) => value,
  encryptChannelCredentialSecret: (value: string) => `encrypted:${value}`,
  encryptChannelCredentialSession: (value: unknown) => value,
  getChannelCredentialEncryptionKeyId: () => 'test-key',
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('../services/integrations/MetaCapabilityRegistry.js', () => ({ getMetaAppReviewPermissions: async () => ({}) }));

const { inspectOfficialProviderBinding } = await import('../services/outreach/ProviderBindingService.js');

beforeEach(() => {
  jest.clearAllMocks();
  row = {
    id: 14, credentialType: 'oauth', hasCredentialMaterial: true,
    tokenExpiry: new Date(Date.now() + 3600_000), accountIdentifier: 'sales@example.com',
    accountName: 'Sales', encryptionVersion: null, encryptionKeyId: null, encryptedAt: null,
    grantedScopes: [], providerApprovalStatus: 'unknown', providerApiVersion: null,
    providerVerifiedAt: null, readinessErrorCode: null,
  };
  getCredential.mockImplementation(async () => ({ ...row, userId: 9, accessToken: 'access', refreshToken: 'refresh' }));
  getClient.mockResolvedValue({ client: {
    credentials: { access_token: 'access', refresh_token: 'refresh' }, getTokenInfo,
  }, credential: { accessToken: 'access', refreshToken: 'refresh' } });
  getTokenInfo.mockResolvedValue({ scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'] });
  getProfile.mockResolvedValue({ data: { emailAddress: 'sales@example.com' } });
  updateCredential.mockImplementation(async (_userId, _platform, _id, updates) => { row = { ...row, ...(updates as Record<string, unknown>) }; });
});

describe('Gmail outreach binding', () => {
  const sendScopes = ['https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'];

  it.each(sendScopes)('repairs an exact verified legacy mailbox using actual send-capable scope %s', async scope => {
    // getProfile needs a profile-capable grant in addition to send-only.
    const actualScopes = scope.endsWith('/gmail.send')
      ? [scope, 'https://www.googleapis.com/auth/gmail.readonly'] : [scope];
    getTokenInfo.mockResolvedValue({ scopes: actualScopes });
    const result = await inspectOfficialProviderBinding(9, 'email', { providerVariant: 'gmail', credentialId: 14 });
    expect(result).toMatchObject({ ready: true, binding: { credentialId: 14, providerAccountId: 'sales@example.com' } });
    expect(getClient).toHaveBeenCalledWith(9, { credentialId: 14, accountIdentifier: 'sales@example.com' });
    expect(updateCredential).toHaveBeenCalledWith(9, 'gmail_api', 14, expect.objectContaining({
      encryptionVersion: 'secrets-manager-v1',
      grantedScopes: actualScopes,
      providerApprovalStatus: 'approved',
    }));
  });

  it('fails legacy identity repair closed when a send-only grant cannot read the provider profile', async () => {
    getTokenInfo.mockResolvedValue({ scopes: ['https://www.googleapis.com/auth/gmail.send'] });
    getProfile.mockRejectedValue(new Error('Synthetic getProfile scope denied'));
    expect(await inspectOfficialProviderBinding(9, 'email', { providerVariant: 'gmail', credentialId: 14 }))
      .toMatchObject({ ready: false });
    expect(updateCredential).not.toHaveBeenCalled();
  });

  it.each(sendScopes)('accepts a verified %s grant without repair, fabricated scopes or token changes', async scope => {
    row = { ...row, encryptionVersion: 'secrets-manager-v1', encryptionKeyId: 'test-key', encryptedAt: new Date(),
      grantedScopes: [scope], providerApprovalStatus: 'approved', providerVerifiedAt: new Date() };
    expect(await inspectOfficialProviderBinding(9, 'email', { providerVariant: 'gmail', credentialId: 14 }))
      .toMatchObject({ ready: true, binding: { credentialId: 14, providerAccountId: 'sales@example.com' } });
    expect(getClient).not.toHaveBeenCalled();
    expect(getTokenInfo).not.toHaveBeenCalled();
    expect(getProfile).not.toHaveBeenCalled();
    expect(updateCredential).not.toHaveBeenCalled();
    expect(row.grantedScopes).toEqual([scope]);
  });

  it('does not bind a mailbox whose provider identity differs from the selected sender', async () => {
    getProfile.mockResolvedValue({ data: { emailAddress: 'other@example.com' } });
    const result = await inspectOfficialProviderBinding(9, 'email', { providerVariant: 'gmail', credentialId: 14 });
    expect(result.ready).toBe(false);
    expect(updateCredential).not.toHaveBeenCalled();
  });

  it('does not enable outreach without the Gmail send scope', async () => {
    getTokenInfo.mockResolvedValue({ scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    const result = await inspectOfficialProviderBinding(9, 'email', { providerVariant: 'gmail', credentialId: 14 });
    expect(result.ready).toBe(false);
    expect(updateCredential).not.toHaveBeenCalled();
  });
});
