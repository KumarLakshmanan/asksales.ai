import { describe, expect, it } from '@jest/globals';
import {
  parseApiPricingUpdate,
  parseCreditPricingUpdates,
  parsePricingNumber,
  parseStoragePricingInput,
} from '../utils/pricingValidation.js';
import { pricingAuditValues } from '../models/pricingAudit/functions.js';

describe('admin pricing validation', () => {
  it('normalizes bounded credit-pricing updates', () => {
    expect(parseCreditPricingUpdates([
      { id: 3, creditsPerUnit: '12.5', isActive: false },
    ])).toEqual([{ id: 3, creditsPerUnit: '12.50', isActive: false }]);
  });

  it('rejects duplicate credit-pricing IDs and unsupported fields', () => {
    expect(() => parseCreditPricingUpdates([
      { id: 3, creditsPerUnit: 1 },
      { id: 3, creditsPerUnit: 2 },
    ])).toThrow('unique positive integers');
    expect(() => parseCreditPricingUpdates([
      { id: 3, creditsPerUnit: 1, eventKey: 'cannot_change_identity' },
    ])).toThrow('unsupported fields');
  });

  it('bounds bulk pricing updates and numeric values', () => {
    expect(() => parseCreditPricingUpdates([])).toThrow('between 1 and 200');
    expect(() => parseCreditPricingUpdates([{ id: 1, creditsPerUnit: -1 }])).toThrow('between 0');
  });

  it('validates API update identity, fields, and decimal ranges', () => {
    expect(parseApiPricingUpdate({ id: 9, marginPercentage: '-25', isActive: true }, true))
      .toEqual({ id: 9, marginPercentage: '-25', isActive: true });
    expect(() => parseApiPricingUpdate({ marginPercentage: -100 }, false)).toThrow('between -99');
    expect(() => parseApiPricingUpdate({ id: 1, pricingKey: 'immutable' }, true)).toThrow('unsupported fields');
    expect(() => parseApiPricingUpdate({ id: 1 }, true)).toThrow('At least one');
  });

  it('accepts zero API prices rather than treating them as missing', () => {
    expect(parsePricingNumber(0, 'creditsPerUnit')).toBe('0');
  });

  it('validates and normalizes new storage pricing', () => {
    expect(parseStoragePricingInput({
      pricingKey: 'standard_storage',
      name: ' Standard ',
      description: ' Per GB ',
      pricePerGbCents: 25,
      currency: 'inr',
      isActive: true,
    })).toEqual({
      value: {
        pricingKey: 'standard_storage',
        name: 'Standard',
        description: 'Per GB',
        pricePerGbCents: 25,
        currency: 'INR',
        isActive: true,
      },
    });
  });

  it('keeps storage pricing keys immutable on updates', () => {
    expect(parseStoragePricingInput({ pricingKey: 'replacement_key' }, true).error)
      .toContain('unsupported');
  });

  it('rejects fractional minor units and invalid currency codes', () => {
    expect(parseStoragePricingInput({
      pricingKey: 'standard_storage', name: 'Standard', pricePerGbCents: 1.5, currency: 'USD',
    }).error).toContain('integer');
    expect(parseStoragePricingInput({
      pricingKey: 'standard_storage', name: 'Standard', pricePerGbCents: 1, currency: 'US',
    }).error).toContain('ISO');
  });

  it('captures an immediately effective before/after audit record', () => {
    const before = { id: 4, creditsPerUnit: '1.00' };
    const after = { id: 4, creditsPerUnit: '2.00' };
    const audit = pricingAuditValues({
      domain: 'credit_pricing', recordId: 4, pricingKey: 'outreach_email', action: 'update',
      adminId: 8, beforeValue: before, afterValue: after,
    });
    expect(audit).toMatchObject({
      domain: 'credit_pricing', recordId: 4, pricingKey: 'outreach_email', action: 'update',
      adminId: 8, beforeValue: before, afterValue: after,
    });
    expect(audit.effectiveAt).toBeInstanceOf(Date);
  });
});
