import { describe, expect, it } from '@jest/globals';
import { enforceSmallLeadSuggestionDefaults } from '../controllers/userSuggestionsController.js';

describe('lead-generation suggestion defaults', () => {
  it('reduces cached high-volume lead prompts without changing unrelated counts', () => {
    expect(enforceSmallLeadSuggestionDefaults([
      'Find 500 tech CEOs in San Francisco using LinkedIn and Google Maps',
      'Create 12 LinkedIn posts for next month',
    ])).toEqual([
      'Find exactly 5 tech CEOs in San Francisco using LinkedIn and Google Maps',
      'Create 12 LinkedIn posts for next month',
    ]);
  });
});
