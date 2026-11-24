import { describe, expect, it } from '@jest/globals';
import { scanKnowledgeContent } from '../services/knowledge/KnowledgePrivacyService.js';

describe('knowledge payment card detection', () => {
  it('does not quarantine a 16-digit figure that fails the Luhn checksum', () => {
    const scan = scanKnowledgeContent('Booking reference 1234 5678 9012 3456 covers the 2026 season.');
    expect(scan.reasons).not.toContain('secret:payment_card');
    expect(scan.mustQuarantine).toBe(false);
  });
  it('still quarantines a Luhn-valid card number in knowledge content', () => {
    const scan = scanKnowledgeContent('Pay with card 4242 4242 4242 4242 at the front desk.');
    expect(scan.reasons).toContain('secret:payment_card');
    expect(scan.classification).toBe('secret');
    expect(scan.mustQuarantine).toBe(true);
  });
});
