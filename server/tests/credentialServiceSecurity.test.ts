import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execute = jest.fn<any>();

jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { encryptValue } = await import('../services/SecretsManager.js');
const { encryptSensitiveIntegrationConfig } = await import('../utils/integrationSecrets.js');
const { getCredential, saveCredential } = await import('../services/credentialService.js');

describe('per-user credential storage security', () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it('encrypts API secrets and secret-bearing config before database writes', async () => {
    execute.mockResolvedValue({ rows: [] });

    await expect(saveCredential(42, 'google_ads', 'public-client-id', 'client-secret', {
      customerId: '1234567890',
      developerToken: 'developer-token',
      nested: { refreshToken: 'refresh-token' },
    })).resolves.toBe(true);

    const serializedQuery = JSON.stringify(execute.mock.calls[0][0]);
    expect(serializedQuery).toContain('public-client-id');
    expect(serializedQuery).toContain('1234567890');
    expect(serializedQuery).not.toContain('client-secret');
    expect(serializedQuery).not.toContain('developer-token');
    expect(serializedQuery).not.toContain('refresh-token');
    expect(serializedQuery).toContain('enc:v1:');
  });

  it('decrypts encrypted records only at the server-side credential boundary', async () => {
    execute.mockResolvedValue({
      rows: [{
        api_key: 'public-client-id',
        api_secret: `enc:v1:${encryptValue('client-secret')}`,
        config: encryptSensitiveIntegrationConfig({
          customerId: '1234567890',
          developerToken: 'developer-token',
        }),
        is_active: true,
      }],
    });

    const credential = await getCredential(42, 'google_ads');
    expect(credential).toMatchObject({
      apiKey: 'public-client-id',
      apiSecret: 'client-secret',
      config: { customerId: '1234567890', developerToken: 'developer-token' },
    });
  });
});
