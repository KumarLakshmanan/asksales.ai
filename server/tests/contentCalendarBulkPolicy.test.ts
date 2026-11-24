import { assertNoBulkScheduleConflicts, editorialCalendarStatus, expandCalendarAssetFamily } from '../controllers/contentCalendarController.js';

describe('bulk calendar scheduling policy', () => {
  it('never presents editorial plans as confirmed provider schedules or publications', () => {
    expect(editorialCalendarStatus('scheduled')).toBe('planned');
    expect(editorialCalendarStatus('published')).toBe('planned');
    expect(editorialCalendarStatus(undefined)).toBe('planned');
    expect(editorialCalendarStatus('draft')).toBe('draft');
    expect(editorialCalendarStatus('cancelled')).toBe('cancelled');
  });
  it('allows one item per platform at a target time', () => {
    expect(() => assertNoBulkScheduleConflicts([
      { id: 1, publishPlatform: 'instagram' },
      { id: 2, publishPlatform: 'facebook' },
      { id: 3, publishPlatform: 'youtube' },
    ])).not.toThrow();
  });

  it('rejects a batch that creates a same-platform delivery collision', () => {
    expect(() => assertNoBulkScheduleConflicts([
      { id: 1, publishPlatform: 'instagram' },
      { id: 2, publishPlatform: 'instagram' },
    ])).toThrow(/Only one instagram item/);
  });

  it('includes cross-post descendants when a parent is moved in bulk', () => {
    expect(expandCalendarAssetFamily([10], [
      { id: 10, parentAssetId: null },
      { id: 11, parentAssetId: 10 },
      { id: 12, parentAssetId: 11 },
      { id: 13, parentAssetId: null },
    ]).map(asset => asset.id)).toEqual([10, 11, 12]);
  });
});
