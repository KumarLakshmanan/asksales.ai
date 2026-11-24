import { describe, expect, it } from '@jest/globals';

process.env.SECRETS_ENCRYPTION_KEY ||= 'channel-credential-test-key';

const {
  decryptChannelCredentialSecret,
  decryptChannelCredentialSession,
  encryptChannelCredentialSecret,
  encryptChannelCredentialSession,
  getChannelCredentialEncryptionKeyId,
} = await import('../utils/channelCredentialSecrets.js');

describe('channel credential secret compatibility', () => {
  it('encrypts new values and decrypts bare and prefixed ciphertext', () => {
    const encrypted = encryptChannelCredentialSecret('provider-token');
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain('provider-token');
    expect(decryptChannelCredentialSecret(encrypted)).toBe('provider-token');
    expect(decryptChannelCredentialSecret(`enc:v1:${encrypted}`)).toBe('provider-token');
  });

  it('protects and restores nested token-bearing session metadata', () => {
    const encrypted = encryptChannelCredentialSession({
      accountId: 'account-1',
      credentials: { accessToken: 'access-token', clientSecret: 'client-secret' },
    });
    expect(JSON.stringify(encrypted)).not.toContain('access-token');
    expect(JSON.stringify(encrypted)).not.toContain('client-secret');
    expect(decryptChannelCredentialSession(encrypted)).toEqual({
      accountId: 'account-1',
      credentials: { accessToken: 'access-token', clientSecret: 'client-secret' },
    });
  });

  it('returns an auditable key identifier without exposing key material', () => {
    const previousId = process.env.SECRETS_ENCRYPTION_KEY_ID;
    delete process.env.SECRETS_ENCRYPTION_KEY_ID;
    const derived = getChannelCredentialEncryptionKeyId();
    expect(derived).toMatch(/^local-shared:[a-f0-9]{16}$/);
    expect(derived).not.toContain(process.env.SECRETS_ENCRYPTION_KEY!);

    process.env.SECRETS_ENCRYPTION_KEY_ID = 'kms/channel-credentials/current';
    expect(getChannelCredentialEncryptionKeyId()).toBe('kms/channel-credentials/current');
    if (previousId === undefined) delete process.env.SECRETS_ENCRYPTION_KEY_ID;
    else process.env.SECRETS_ENCRYPTION_KEY_ID = previousId;
  });
});
