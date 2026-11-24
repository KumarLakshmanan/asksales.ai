import { expect, it } from 'vitest';
import { formatVideoDate } from '@/components/content-cards/VideoCard';

it('formats numeric, legacy string timestamps and ISO dates consistently', () => {
  const timestamp = Date.parse('2026-09-01T12:00:00Z');
  const expected = new Date(timestamp).toLocaleDateString();
  expect(formatVideoDate(timestamp)).toBe(expected);
  expect(formatVideoDate(String(timestamp))).toBe(expected);
  expect(formatVideoDate('2026-09-01T12:00:00Z')).toBe(expected);
});
it('does not expose Invalid Date for missing or malformed legacy dates', () => {
  expect(formatVideoDate('not-a-date')).toBe('Date unavailable');
  expect(formatVideoDate(NaN)).toBe('Date unavailable');
});
