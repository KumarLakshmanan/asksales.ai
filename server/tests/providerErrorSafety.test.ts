import { providerErrorCode, sanitizeProviderError } from '../services/ads/ProviderErrorSafety.js';

describe('provider error safety', () => {
  it('redacts credentials while keeping actionable recovery text', () => {
    const message = sanitizeProviderError('OAuth failed access_token=secret-123 Bearer abc.def.ghi for customer 123');
    expect(message).not.toContain('secret-123');
    expect(message).not.toContain('abc.def.ghi');
    expect(message).toContain('OAuth failed');
    expect(message).toContain('[redacted]');
  });

  it('assigns stable recovery codes', () => {
    expect(providerErrorCode('The live activation confirmation expired')).toBe('ACTIVATION_CONFIRMATION_REQUIRED');
    expect(providerErrorCode('Unable to clean up partial campaign')).toBe('PROVIDER_RECONCILIATION_REQUIRED');
    expect(providerErrorCode('OAuth token expired')).toBe('PROVIDER_AUTHORIZATION_FAILED');
  });
});
