import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isHttpsUrl,
  isIanaTimezone,
  isOptionalEmail,
  isOptionalFiveFieldCron,
  latestBestTimesByAccount,
  validateAnalyticsWindow,
} from '@/lib/socialAnalyticsValidation';

describe('social analytics form validation', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z')); });
  afterEach(() => vi.useRealTimers());

  it('accepts a closed provider window and a real IANA timezone', () => {
    expect(validateAnalyticsWindow('2026-07-29', '2026-08-27', 'Asia/Kolkata')).toBeNull();
    expect(isIanaTimezone('UTC')).toBe(true);
  });

  it('blocks rollover dates, reversed/future windows, oversized ranges, and timezone labels', () => {
    expect(validateAnalyticsWindow('2026-02-30', '2026-03-02', 'UTC')).toMatch(/valid/);
    expect(validateAnalyticsWindow('2026-08-27', '2026-07-29', 'UTC')).toMatch(/Start date/);
    expect(validateAnalyticsWindow('2026-08-27', '2026-08-29', 'UTC')).toMatch(/future/);
    expect(validateAnalyticsWindow('2025-01-01', '2026-08-27', 'UTC')).toMatch(/366/);
    expect(validateAnalyticsWindow('2026-07-29', '2026-08-27', 'IST')).toMatch(/IANA/);
  });

  it('requires HTTPS evidence URLs and validates optional delivery fields', () => {
    expect(isHttpsUrl('https://example.com/public-export')).toBe(true);
    expect(isHttpsUrl('http://example.com')).toBe(false);
    expect(isOptionalEmail('')).toBe(true);
    expect(isOptionalEmail('owner@example.com')).toBe(true);
    expect(isOptionalEmail('owner@')).toBe(false);
    expect(isOptionalFiveFieldCron('0 9 * * 1')).toBe(true);
    expect(isOptionalFiveFieldCron('0 9 * *')).toBe(false);
  });

  it('shows only the latest best-time recommendation for each provider account', () => {
    const recommendations = [
      { id: 'new', platform: 'instagram', account_identifier: 'account-1' },
      { id: 'old', platform: 'instagram', account_identifier: 'account-1' },
      { id: 'other', platform: 'facebook', account_identifier: 'account-1' },
    ];
    expect(latestBestTimesByAccount(recommendations).map(item => item.id)).toEqual(['new', 'other']);
  });
});
