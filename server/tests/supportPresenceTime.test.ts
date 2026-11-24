import { describe, expect, it } from '@jest/globals';
import {
  localDateKey,
  splitPresenceIntervalsByLocalDay,
  validTimezone,
} from '../services/supportPresenceTime.js';

describe('support presence local-day reporting', () => {
  it('clips a session at the member local midnight', () => {
    const daily = splitPresenceIntervalsByLocalDay([{
      id: 7,
      startedAt: '2026-08-28T18:25:00.000Z', // 23:55 Asia/Kolkata
      lastSeenAt: '2026-08-28T18:35:00.000Z',
      endedAt: '2026-08-28T18:40:00.000Z', // 00:10 the next day
      endReason: 'inactivity',
    }], 'Asia/Kolkata');

    expect([...daily.keys()]).toEqual(['2026-08-28', '2026-08-29']);
    expect(daily.get('2026-08-28')).toMatchObject({
      activeMinutes: 5,
      firstLogin: '2026-08-28T18:25:00.000Z',
      lastActive: '2026-08-28T18:30:00.000Z',
    });
    expect(daily.get('2026-08-28')?.intervals[0]).toMatchObject({
      startedAt: '2026-08-28T18:25:00.000Z',
      endedAt: '2026-08-28T18:30:00.000Z',
      clippedToDay: true,
    });
    expect(daily.get('2026-08-29')).toMatchObject({
      activeMinutes: 10,
      firstLogin: '2026-08-28T18:30:00.000Z',
      lastActive: '2026-08-28T18:40:00.000Z',
    });
  });

  it('retains multiple-tab intervals without double-counting overlapping active minutes', () => {
    const daily = splitPresenceIntervalsByLocalDay([
      {
        id: 1,
        startedAt: '2026-08-28T10:00:00.000Z',
        lastSeenAt: '2026-08-28T10:05:00.000Z',
        endedAt: '2026-08-28T10:10:00.000Z',
        endReason: 'inactivity',
      },
      {
        id: 2,
        startedAt: '2026-08-28T10:05:00.000Z',
        lastSeenAt: '2026-08-28T10:10:00.000Z',
        endedAt: '2026-08-28T10:15:00.000Z',
        endReason: 'logout',
      },
    ], 'UTC');

    expect(daily.get('2026-08-28')?.activeMinutes).toBe(15);
    expect(daily.get('2026-08-28')?.intervals).toHaveLength(2);
  });

  it('uses real timezone boundaries and safely normalizes invalid timezones', () => {
    expect(localDateKey(new Date('2026-08-28T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-08-29');
    expect(validTimezone('Not/A_Timezone')).toBe('UTC');
    expect(localDateKey(new Date('2026-08-28T23:59:00.000Z'), 'Not/A_Timezone')).toBe('2026-08-28');
  });
});
