import { describe, expect, it } from '@jest/globals';
import { leadSearchFailureMessage } from '../services/leadSearchFailureMessage.js';

describe('leadSearchFailureMessage', () => {
  it('hides provider credential details from customers', () => {
    const message = leadSearchFailureMessage('Actor execution failed: No Apify API key available. Please add your Apify token in Settings → Integrations → Apify');
    expect(message).toBe('The lead search could not run, so no leads were saved. The lead data provider is not available right now. Please try again later, or contact support if this continues.');
    expect(message).not.toMatch(/apify|actor|linkedin_company_search|token/i);
  });

  it('asks the user to wait when the provider is busy', () => {
    expect(leadSearchFailureMessage('Actor execution failed: 429 Too Many Requests')).toContain('busy');
  });

  it('gives a plain retry message for anything else, including no error text', () => {
    for (const error of [undefined, 'Actor execution failed: Input is not valid: field locations must be array']) {
      const message = leadSearchFailureMessage(error);
      expect(message).toBe('The lead search could not run, so no leads were saved. Please try again. If it keeps failing, contact support.');
    }
  });
});
