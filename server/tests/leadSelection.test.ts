import { describe, expect, it } from '@jest/globals';
import { extractExplicitLeadIds } from '../mastra/leadSelection.js';

describe('explicit lead selection', () => {
  it('preserves exact lead IDs in user order and removes duplicates', () => {
    expect(extractExplicitLeadIds('Prepare outreach for exact lead IDs: 1154, 1155 and 1154.')).toEqual([1154, 1155]);
  });

  it('preserves the final ID in an Oxford-comma list', () => {
    expect(extractExplicitLeadIds(
      'Use exactly lead IDs 854, 855, 856, 857, 858, and 859. Do not send messages.',
    )).toEqual([854, 855, 856, 857, 858, 859]);
  });

  it('accepts a single labelled lead ID', () => {
    expect(extractExplicitLeadIds('Send an email to lead id #42')).toEqual([42]);
  });

  it('does not interpret budgets, years, or counts as lead IDs', () => {
    expect(extractExplicitLeadIds('Use a $50 budget in 2026 for 2 leads')).toEqual([]);
  });
});
