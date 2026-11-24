import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const selected = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const byAccount = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const byId = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({ ChannelCredentialModel: {
  findByUserAndPlatform: selected, findActiveAccountByIdentifier: byAccount, findActiveAccountById: byId,
} }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../services/integrations/MetaCapabilityRegistry.js', () => ({ getMetaAppReviewPermissions: jest.fn() }));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({
  decryptChannelCredentialSecret: (value: string) => value?.replace(/^sealed:/, '') || '',
  decryptChannelCredentialSession: (value: unknown) => value,
  encryptChannelCredentialSecret: (value: string) => `sealed:${value}`,
  getChannelCredentialEncryptionKeyId: () => 'qa-key',
}));
const { inspectOfficialProviderBinding } = await import('../services/outreach/ProviderBindingService.js');

const credential = () => ({
  id: 31, isActive: true, credentialType: 'api_key', accountIdentifier: 'ABCDEF', accountName: 'MSG91 sender',
  apiSecret: 'sealed:private-auth-key', providerVerifiedAt: new Date(),
  encryptionVersion: 'v1', encryptionKeyId: 'qa-key', encryptedAt: new Date(),
  sessionData: { senderId: 'ABCDEF', flowId: 'template-42', messageVariable: 'message' },
});

describe('MSG91 in the shared provider binding resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selected.mockResolvedValue(credential()); byAccount.mockResolvedValue(credential()); byId.mockResolvedValue(credential());
  });

  it('returns a verified SMS identity without exposing any credentials or template secrets', async () => {
    const result = await inspectOfficialProviderBinding(9, 'sms', { providerAccountId: 'ABCDEF' });
    expect(result).toMatchObject({ ready: true, credentialPlatform: 'msg91_sms', credentialValuesExposed: false,
      binding: { credentialId: 31, platform: 'msg91_sms', providerAccountId: 'ABCDEF', accountName: 'MSG91 sender' } });
    expect(byAccount).toHaveBeenCalledWith(9, 'msg91_sms', 'ABCDEF');
    expect(JSON.stringify(result)).not.toContain('private-auth-key');
  });

  it('keeps a frozen credential bound to the reviewed sender', async () => {
    expect(await inspectOfficialProviderBinding(9, 'sms', { credentialId: 31, providerAccountId: 'ABCDEF' })).toMatchObject({ ready: true });
    expect(byId).toHaveBeenCalledWith(9, 'msg91_sms', 31);
    expect(await inspectOfficialProviderBinding(9, 'sms', { credentialId: 31, providerAccountId: 'OTHERX' })).toMatchObject({ ready: false });
  });

  it('does not select another sender when the conversation’s original account is unavailable', async () => {
    byAccount.mockResolvedValueOnce(null);
    expect(await inspectOfficialProviderBinding(9, 'sms', { providerAccountId: 'ABCDEF' })).toMatchObject({ ready: false, missing: ['sms_connection'] });
    expect(selected).not.toHaveBeenCalled();
  });

  it.each([{ providerVerifiedAt: null }, { isActive: false }, { readinessErrorCode: 'MSG91_AUTH_FAILED' }, { accountIdentifier: 'OTHERX' }])('blocks unusable sender metadata: %j', async changes => {
    selected.mockResolvedValueOnce({ ...credential(), ...changes });
    expect(await inspectOfficialProviderBinding(9, 'sms')).toMatchObject({ ready: false });
  });
});
