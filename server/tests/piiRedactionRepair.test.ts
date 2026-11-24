import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { planRedactionRepair } = await import('../services/agents/orchestration/PiiRedactionRepair.js');
const { redactPiiWithStableTokens } = await import('../services/agents/orchestration/PrivacyVaultService.js');

const scope = { userId: 9, conversationId: 58 };
const plan = (rawText: string, storedContent: string) => planRedactionRepair({ rawText, storedContent, ...scope });

describe('PII redaction repair plan', () => {
  it('restores text the old name pattern swallowed', () => {
    expect(plan('I am looking for a room for 2 nights', 'I am [NAME_1234] a room for 2 nights')).toEqual({
      action: 'update', content: 'I am looking for a room for 2 nights', piiTypes: [], tokensBefore: 1, tokensAfter: 0,
    });
  });

  it('keeps real PII tokenised while restoring the swallowed words', () => {
    const raw = 'I am Ravi Kumar and my number is 9876543210';
    const result = plan(raw, 'I am [NAME_11] number is [PHONE_22]');
    expect(result.action).toBe('update');
    if (result.action !== 'update') return;
    expect(result.content).toBe(redactPiiWithStableTokens(raw, scope).redactedText);
    expect(result.content).toMatch(/^I am \[NAME_\d+\] and my number is \[PHONE_\d+\]$/);
    expect(result.content).not.toContain('Ravi');
    expect(result.content).not.toContain('9876543210');
  });

  it('skips a message that is already redacted by the current rules', () => {
    const raw = 'call me on +91 98765 43210';
    expect(plan(raw, redactPiiWithStableTokens(raw, scope).redactedText)).toMatchObject({ action: 'skip', reason: 'already_current' });
  });

  it('skips stored text without redaction tokens', () => {
    expect(plan('Hello there', 'Hello there')).toMatchObject({ action: 'skip', reason: 'not_redacted' });
  });

  it.each([
    ['a different message', 'This is urgent please help', 'I am [NAME_1] a room for 2 nights'],
    ['an edited prefix', 'I am looking for a room', 'We are [NAME_1] a room'],
    ['an edited suffix', 'I am looking for a room', 'I am [NAME_1] a suite'],
    ['reordered segments', 'my number is 9876543210 thanks', 'thanks [PHONE_1] my number is '],
  ])('refuses to rewrite when the vault original is %s', (_label, raw, stored) => {
    expect(plan(raw, stored)).toMatchObject({ action: 'skip', reason: 'raw_mismatch' });
  });
});
