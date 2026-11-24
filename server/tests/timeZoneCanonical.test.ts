import { describe, expect, it } from '@jest/globals';
import { canonicalTimeZone } from '../../shared/timeZones.js';
import { dailyActivitySchema } from '../services/outreach/OutreachTrackingFilters.js';

describe('legacy time zone names', () => {
  it('maps names the production tz database no longer ships', () => {
    expect(canonicalTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalTimeZone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(canonicalTimeZone('US/Eastern')).toBe('America/New_York');
    expect(canonicalTimeZone(' Asia/Kolkata ')).toBe('Asia/Kolkata');
    expect(canonicalTimeZone(undefined)).toBeUndefined();
  });

  it('sends the current name to SQL for outreach day-by-day reads', () => {
    const parsed = dailyActivitySchema.parse({ from: '2026-11-12', to: '2026-11-18', tz: 'Asia/Calcutta' });
    expect(parsed.tz).toBe('Asia/Kolkata');
    expect(() => dailyActivitySchema.parse({ from: '2026-11-12', to: '2026-11-18', tz: 'Not/AZone' })).toThrow();
  });
});
