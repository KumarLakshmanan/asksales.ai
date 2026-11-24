import { describe, expect, it } from '@jest/globals';
import { canonicalLeadPlatform } from '../mastra/tools/executors/leadSource.js';

describe('lead source projection', () => {
  it('preserves canonical platform metadata', () => {
    expect(canonicalLeadPlatform('linkedin', 'actor-123')).toBe('linkedin');
  });
  it('recovers the actual source from legacy or malformed platform metadata', () => {
    expect(canonicalLeadPlatform('place', 'google_maps')).toBe('google_maps');
    expect(canonicalLeadPlatform('profile', 'yelp')).toBe('yelp');
  });
  it('does not mislabel unknown sources as a known platform', () => {
    expect(canonicalLeadPlatform('place', 'apify')).toBe('place');
  });
});
