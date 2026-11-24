import { describe, expect, it } from 'vitest';
import { shouldRetrySupportQueue, parseSupportQueueFilters, supportQueueCanonicalHref } from '@/lib/support-queue-query';

describe('support queue API limits', () => {
  it('canonicalizes a page rejected by the API without discarding unrelated query or hash', () => {
    expect(supportQueueCanonicalHref('/support/tickets', 'origin=notification&page=100001', 'http://localhost/support/tickets?origin=notification&page=100001#queue')).toBe('/support/tickets?origin=notification#queue');
    expect(parseSupportQueueFilters(new URLSearchParams('page=100000')).page).toBe(100000);
  });
  it('canonicalizes assignee IDs outside the now-published PostgreSQL int4 contract', () => {
    expect(parseSupportQueueFilters(new URLSearchParams('assignee=2147483648')).assignee).toBe('all');
    expect(parseSupportQueueFilters(new URLSearchParams('assignee=2147483647')).assignee).toBe('2147483647');
  });
  it('preserves the API-supported web channel in shared links', () => {
    expect(parseSupportQueueFilters(new URLSearchParams('channel=web')).channel).toBe('web');
  });
  it('does not retry validation/auth errors but retains bounded transient retries', () => {
    for (const status of [400,401,403,409,422]) expect(shouldRetrySupportQueue(0, { status })).toBe(false);
    expect(shouldRetrySupportQueue(0, { status: 503 })).toBe(true);
    expect(shouldRetrySupportQueue(1, { status: 503 })).toBe(false);
    expect(shouldRetrySupportQueue(0, new Error('Network unavailable'))).toBe(true);
  });
});
