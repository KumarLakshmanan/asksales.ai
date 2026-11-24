import { normalizeSmsMessage, SMS_MESSAGE_LIMIT } from '../services/content/SmsContentNormalizer.js';

describe('SMS content normalization', () => {
  it('uses a complete sentence when long copy leaves room for the exact CTA', () => {
    const result = normalizeSmsMessage('Meet NimbusFlow. It helps small teams keep prospect conversations organized across their sales workflow. More detail here.', { maxLength: 80, exactCta: 'Book a demo—no pressure.', requireOptOut: true });
    expect(result).toBe('Meet NimbusFlow. Book a demo—no pressure. Reply STOP to opt out.');
  });
  it('marks a shortened fragment visibly without cutting the CTA or opt-out', () => {
    const result = normalizeSmsMessage('Meet NimbusFlow, a sales follow-up automation tool that helps small B2B teams keep prospect conversations organized and ready for follow-up.', { exactCta: 'Book a demo—no pressure.', requireOptOut: true });
    expect(result).toContain('... Book a demo—no pressure. Reply STOP to opt out.');
    expect(result.length).toBeLessThanOrEqual(160);
  });
  it('compacts long promotional copy and preserves opt-out language', () => {
    const result = normalizeSmsMessage('A'.repeat(240), { requireOptOut: true });
    expect(result.length).toBeLessThanOrEqual(SMS_MESSAGE_LIMIT);
    expect(result).toMatch(/Reply STOP to opt out\.$/);
  });

  it('normalizes whitespace and avoids duplicate opt-out language', () => {
    const result = normalizeSmsMessage('Hello   there. Reply STOP to opt out.', { requireOptOut: true });
    expect(result).toBe('Hello there. Reply STOP to opt out.');
  });

  it('reserves room for the exact reviewed CTA and opt-out when shortening copy', () => {
    const exactCta = 'Book a demo—no pressure.';
    const result = normalizeSmsMessage('A useful workflow for small sales teams. '.repeat(8), { requireOptOut: true, exactCta });
    expect(result.length).toBeLessThanOrEqual(SMS_MESSAGE_LIMIT);
    expect(result).toContain(exactCta);
    expect(result).toMatch(/Reply STOP to opt out\.$/);
  });

  it('does not duplicate an exact CTA already returned by the model', () => {
    expect(normalizeSmsMessage('Meet NimbusFlow. Book a demo.', { exactCta: 'Book a demo.' })).toBe('Meet NimbusFlow. Book a demo.');
  });

  it('rejects a CTA that cannot fit instead of silently altering it', () => {
    expect(() => normalizeSmsMessage('Brief', { exactCta: 'X'.repeat(160), requireOptOut: true })).toThrow(/Shorten the CTA/);
  });
});
