import { describe, expect, it, jest } from '@jest/globals';

let saved: Record<string, unknown> | null = null;
const db = {
  insert: () => ({ values: (values: Record<string, unknown>) => {
    saved = values;
    return { returning: async () => [{ id: 1, ...values }] };
  } }),
};
jest.unstable_mockModule('../models/db.js', () => ({ db }));
jest.unstable_mockModule('../services/SecretsManager.js', () => ({
  encryptValue: (value: string) => `encrypted:${value}`,
  decryptValue: (value: string) => value.replace(/^encrypted:/, ''),
}));
jest.unstable_mockModule('../utils/integrationSecrets.js', () => ({
  encryptSensitiveIntegrationConfig: (config: unknown) => config,
  decryptSensitiveIntegrationConfig: (config: unknown) => config,
}));
const { createClassifierCredential, sortClassifierCredentials } = await import('../models/intentClassifierCredentials/functions.js');

describe('classifier credential store', () => {
  it('encrypts the key and secret before persistence and returns decrypted values only to trusted callers', async () => {
    const credential = await createClassifierCredential({ platform: 'openrouter', name: 'Jev', apiKey: 'private-key',
      apiSecret: 'private-secret', config: { model: 'typesafe/jev-1.13' }, priority: 'high' });
    expect(saved).toMatchObject({ apiKey: 'encrypted:private-key', apiSecret: 'encrypted:private-secret', isEncrypted: true });
    expect(credential.apiKey).toBe('private-key');
    expect(credential.apiSecret).toBe('private-secret');
  });
  it('selects only active credentials in priority order', () => {
    const rows = [
      { id: 1, priority: 'fallback', isActive: true },
      { id: 2, priority: 'high', isActive: false },
      { id: 3, priority: 'normal', isActive: true },
      { id: 4, priority: 'high', isActive: true },
    ];
    expect(sortClassifierCredentials(rows).map(row => row.id)).toEqual([4, 3, 1]);
  });
});
