/**
 * Phase 3.15 / TEST-001: SecretsManager encryptValue/decryptValue round-trip tests.
 */

process.env.SECRETS_ENCRYPTION_KEY = 'unit-test-key-32-bytes-padded-okay';

import { encryptValue, decryptValue } from '../services/SecretsManager.js';

describe('SecretsManager.encryptValue / decryptValue', () => {
  it('round-trips a simple ASCII string', () => {
    const plaintext = 'hello-world';
    const ct = encryptValue(plaintext);
    expect(ct).not.toBe(plaintext);
    expect(ct).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(decryptValue(ct)).toBe(plaintext);
  });

  it('round-trips a string with non-ASCII characters', () => {
    const plaintext = 'café 🔐 résumé';
    const ct = encryptValue(plaintext);
    expect(decryptValue(ct)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const plaintext = 'same input';
    const a = encryptValue(plaintext);
    const b = encryptValue(plaintext);
    expect(a).not.toBe(b);
    expect(decryptValue(a)).toBe(plaintext);
    expect(decryptValue(b)).toBe(plaintext);
  });

  it('throws on malformed ciphertext', () => {
    expect(() => decryptValue('not:enough:parts:here')).toThrow(/Invalid encrypted value format/);
  });

  it('throws on ciphertext with too few segments', () => {
    expect(() => decryptValue('only-one-segment')).toThrow(/Invalid encrypted value format/);
    expect(() => decryptValue('two:segments')).toThrow(/Invalid encrypted value format/);
  });
});
