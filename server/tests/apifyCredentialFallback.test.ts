import {
  APIFY_ACCOUNTS_UNAVAILABLE_MESSAGE,
  apifyCredentialRefusalNote,
  isApifyAccountWideCapacityError,
  isApifyCredentialCapacityError,
  isRateLimitError,
} from '../services/apiKeyFallbackService.js';

describe('Apify credential fallback classification', () => {
  it.each([
    'Actor execution failed: Too many outstanding invoices',
    'Payment required before starting another actor',
    'Billing account is unavailable',
    'Account is suspended',
    'The Apify actor plan limit prevented execution',
    'Free user run limit exceeded',
    '429 Too Many Requests',
  ])('recognizes a retryable account-capacity failure: %s', message => {
    expect(isApifyCredentialCapacityError(new Error(message))).toBe(true);
  });

  it('does not classify actor input validation as a credential failure', () => {
    expect(isApifyCredentialCapacityError(new Error('Input must include searchStringsArray'))).toBe(false);
  });

  it('keeps billing failures distinct from short-lived rate limits', () => {
    expect(isRateLimitError(new Error('Too many outstanding invoices'))).toBe(false);
  });

  it.each([
    'The Apify actor plan limit prevented execution',
    'Free user call limit reached; upgrade to a paying user',
    'Free user run limit exceeded',
  ])('does not treat an actor-scoped plan limit as account-wide: %s', message => {
    expect(isApifyCredentialCapacityError(new Error(message))).toBe(true);
    expect(isApifyAccountWideCapacityError(new Error(message))).toBe(false);
  });

  it.each([
    'Too many outstanding invoices',
    'Payment required before starting another actor',
    'Billing account is unavailable',
    'Account is suspended',
  ])('recognizes account-wide capacity loss: %s', message => {
    expect(isApifyAccountWideCapacityError(new Error(message))).toBe(true);
  });

  it('keeps the provider reason for admins and an actionable, non-admin message for the searcher', () => {
    expect(apifyCredentialRefusalNote(new Error('Actor execution failed: Too many outstanding invoices')))
      .toBe('Apify refused a run: Too many outstanding invoices. Resolve this in the Apify account (billing or plan), then turn this credential back on.');
    expect(apifyCredentialRefusalNote(new Error(''))).toContain('no reason given');
    expect(APIFY_ACCOUNTS_UNAVAILABLE_MESSAGE).toContain('No leads were saved');
    expect(APIFY_ACCOUNTS_UNAVAILABLE_MESSAGE).not.toMatch(/Admin Integrations|credential/i);
  });
});
