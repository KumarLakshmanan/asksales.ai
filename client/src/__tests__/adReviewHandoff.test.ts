import { describe, expect, it } from 'vitest';
import { adReviewHandoff } from '@/lib/ad-review-handoff';

describe('saved ad selection to conversational review', () => {
  it('preserves exact IDs and displayed revisions without authorizing activation', () => {
    const prompt = adReviewHandoff([{ id: 'db-115', version: 3 }, { id: 'db-114', version: 2 }]);
    expect(prompt).toContain('[{"assetId":115,"displayedRevision":3},{"assetId":114,"displayedRevision":2}]');
    expect(prompt).toContain('Verify the current saved creative revisions');
    expect(prompt).toContain('Do not substitute other assets, publish, activate, or begin spend');
    expect(prompt).toContain('Wait for my explicit approval');
  });
  it('does not invent revision one for legacy records', () => {
    expect(adReviewHandoff([{ id: 'db-114' }])).toContain('"displayedRevision":null');
  });
  it.each([
    { selection: [], error: 'Select at least one' },
    { selection: [{ id: 'unsaved-1' }], error: 'Save every selected' },
    { selection: [{ id: 'db-0' }], error: 'Save every selected' },
    { selection: [{ id: 'db-9007199254740992' }], error: 'Invalid saved creative ID' },
    { selection: [{ id: 'db-1' }, { id: 'db-1' }], error: 'Select each creative only once' },
  ])('rejects unavailable or ambiguous saved selections: $error', ({ selection, error }) => {
    expect(() => adReviewHandoff(selection)).toThrow(error);
  });
});
