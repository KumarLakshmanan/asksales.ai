import { describe, expect, it } from '@jest/globals';
import { resolveBookingProviderKind } from '../services/booking/providerConfig.js';

describe('booking availability configuration', () => {
  it('uses managed inventory by default and accepts case-insensitive local selection', () => {
    expect(resolveBookingProviderKind('')).toBe('local');
    expect(resolveBookingProviderKind(' LOCAL ')).toBe('local');
  });
  it.each(['pms', 'unsupported-provider'])('rejects %s before customer availability requests', value => {
    expect(() => resolveBookingProviderKind(value)).toThrow('Set BOOKING_PROVIDER=local');
  });
});
