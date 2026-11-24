import { beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));

let validateRecommendationTransition: typeof import('../services/ads/AdRecommendationLifecycle.js').validateRecommendationTransition;
let recommendationOutcomeWindows: typeof import('../services/ads/AdRecommendationLifecycle.js').recommendationOutcomeWindows;

beforeAll(async () => {
  ({ validateRecommendationTransition, recommendationOutcomeWindows } = await import('../services/ads/AdRecommendationLifecycle.js'));
});

describe('ad recommendation lifecycle policy', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  it('requires explicit decision evidence', () => {
    expect(() => validateRecommendationTransition('open', 'dismissed', {}, now)).toThrow('dismissal reason');
    expect(() => validateRecommendationTransition('open', 'snoozed', {}, now)).toThrow('snooze date');
    expect(() => validateRecommendationTransition('accepted', 'implemented', {}, now)).toThrow('Describe the change');
  });

  it('rejects invalid transitions and excessive snoozes', () => {
    expect(() => validateRecommendationTransition('open', 'outcome_measured', {}, now)).toThrow('cannot move');
    expect(() => validateRecommendationTransition('open', 'snoozed', { snoozedUntil: '2027-01-01T00:00:00.000Z' }, now)).toThrow('within the next 90 days');
  });

  it('builds non-overlapping matched seven-day outcome windows', () => {
    expect(recommendationOutcomeWindows(new Date('2026-09-15T18:42:00.000Z'))).toEqual({
      before: { start: '2026-09-08', end: '2026-09-14' },
      after: { start: '2026-09-16', end: '2026-09-22' },
      availableAfter: '2026-09-23T00:00:00.000Z',
    });
  });
});
