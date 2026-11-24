import { expect, it } from 'vitest';
import { conversationFilterQuery, DEFAULT_CONVERSATION_FILTERS } from '@/components/outreach/conversation-filters';

it('uses Kolkata calendar days for date presets, including the UTC date boundary', () => {
  const query = new URLSearchParams(conversationFilterQuery(
    { ...DEFAULT_CONVERSATION_FILTERS, status: 'unread', date: 'today' },
    new Date('2026-09-22T18:31:00.000Z'),
  ));
  expect(query.get('status')).toBe('unread');
  expect(query.get('dateFrom')).toBe('2026-09-22T18:30:00.000Z');
  expect(query.get('dateTo')).toBe('2026-09-23T18:30:00.000Z');
});

it('supports inclusive custom dates and one-sided ranges', () => {
  const range = new URLSearchParams(conversationFilterQuery({
    status: 'completed', date: 'custom', from: '2026-09-01', to: '2026-09-23',
  }));
  expect(range.get('dateFrom')).toBe('2026-08-31T18:30:00.000Z');
  expect(range.get('dateTo')).toBe('2026-09-23T18:30:00.000Z');
  const oneSided = new URLSearchParams(conversationFilterQuery({
    status: 'all', date: 'custom', from: '', to: '2026-09-23',
  }));
  expect(oneSided.has('dateFrom')).toBe(false);
  expect(oneSided.has('dateTo')).toBe(true);
});
