import { describe, expect, it } from 'vitest';
import { describeLastChecked } from '@/lib/last-checked';

const now = Date.parse('2026-11-16T12:00:00Z');

describe('describeLastChecked', () => {
  it('marks a recent check as fresh and says how old it is', () => {
    const result = describeLastChecked('2026-11-16T09:00:00Z', now);
    expect(result.stale).toBe(false);
    expect(result.text).toMatch(/\(3 hours ago\)$/);
  });

  it('marks a check older than a day as stale', () => {
    const result = describeLastChecked('2026-11-08T13:22:04Z', now);
    expect(result.stale).toBe(true);
    expect(result.text).toMatch(/\(7 days ago\)$/);
  });

  it('treats an unreadable time as stale instead of showing "Invalid Date"', () => {
    expect(describeLastChecked('not a date', now)).toEqual({ text: 'Last check time unknown', stale: true });
  });
});
