import { describe, expect, it } from '@jest/globals';
import { applyRequestedLeadLimitToBatch, extractRequestedLeadLimit, applyProviderMinimumFetchLimits } from '../mastra/tools/executors/leadRequestConstraints.js';

describe('Lead Generation: reviewed batch budget boundaries', () => {
  it.each([1, 2, 3, 5, 10, 101])('preserves the global save cap of %i while keeping provider fallback coverage', (budget) => {
    for (const size of [1, 2, 3, 7, 12]) {
      const entries = Array.from({ length: size }, (_, index) => ({ platform: `source-${index}`, inputs: { maxItems: 200 } }));
      const original = JSON.stringify(entries);
      const result = applyRequestedLeadLimitToBatch(entries, `Find ${budget} leads`);
      expect(result.length).toBe(Math.min(size, budget));
      expect(result.every(entry => entry.requestedLeadTotal === budget && entry.requestedLeadLimit === budget)).toBe(true);
      expect(result.every(entry => entry.inputs.maxItems === entry.requestedLeadLimit && entry.requestedLeadLimit! >= 1)).toBe(true);
      expect(JSON.stringify(entries)).toBe(original);
    }
  });
  it('handles an empty provider batch', () => {
    expect(applyRequestedLeadLimitToBatch([], 'Find 5 leads')).toEqual([]);
  });
  it.each([undefined, '', 'Find prospects', 'Use a $50 budget in 2026'])('does not invent a lead limit from %s', (input) => {
    expect(extractRequestedLeadLimit(input)).toBeUndefined();
  });
  it('keeps a higher requested fetch limit and leaves input unchanged', () => {
    const input = { maxResults: 25, query: 'dentists' };
    expect(applyProviderMinimumFetchLimits(input, { maxResults: { minimum: 10 } })).toEqual(input);
    expect(input.maxResults).toBe(25);
  });
});
