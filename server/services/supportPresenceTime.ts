export interface PresenceIntervalInput {
  id: number;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string;
  endReason: unknown;
}

export interface DailyPresenceInterval extends PresenceIntervalInput {
  /** True when a source session crossed a local-day boundary. */
  clippedToDay: boolean;
}

export interface DailyPresenceSummary {
  date: string;
  activeMinutes: number;
  firstLogin: string;
  lastActive: string;
  intervals: DailyPresenceInterval[];
  replies: number;
}

const HOUR_MS = 60 * 60 * 1000;

export function validTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return 'UTC';
  }
}

export function localDateKey(value: Date | number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(typeof value === 'number' ? new Date(value) : value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Find the first UTC millisecond belonging to the next local calendar day.
 * This remains correct across non-hour offsets and daylight-saving changes. */
function nextLocalDayBoundary(timestamp: number, timezone: string): number {
  const currentDate = localDateKey(timestamp, timezone);
  let lower = timestamp;
  let upper = timestamp + HOUR_MS;
  const searchLimit = timestamp + 48 * HOUR_MS;
  while (upper < searchLimit && localDateKey(upper, timezone) === currentDate) {
    lower = upper;
    upper += HOUR_MS;
  }
  if (localDateKey(upper, timezone) === currentDate) return searchLimit;
  while (upper - lower > 1) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (localDateKey(middle, timezone) === currentDate) lower = middle;
    else upper = middle;
  }
  return upper;
}

function mergedDurationMs(intervals: Array<{ startedAt: number; endedAt: number }>): number {
  const merged = intervals
    .filter((interval) => interval.endedAt > interval.startedAt)
    .sort((a, b) => a.startedAt - b.startedAt)
    .reduce<Array<{ startedAt: number; endedAt: number }>>((result, interval) => {
      const previous = result.at(-1);
      if (previous && interval.startedAt <= previous.endedAt) {
        previous.endedAt = Math.max(previous.endedAt, interval.endedAt);
      } else {
        result.push({ ...interval });
      }
      return result;
    }, []);
  return merged.reduce((total, interval) => total + interval.endedAt - interval.startedAt, 0);
}

/** Split every immutable login session into local-calendar-day segments while
 * retaining the source session identity. Overlapping browser tabs are shown as
 * separate intervals, but their active minutes are unioned to avoid double
 * counting. */
export function splitPresenceIntervalsByLocalDay(
  sourceIntervals: PresenceIntervalInput[],
  timezone: string,
): Map<string, DailyPresenceSummary> {
  const normalizedTimezone = validTimezone(timezone);
  const daily = new Map<string, DailyPresenceSummary>();

  for (const source of sourceIntervals) {
    const originalStart = Date.parse(source.startedAt);
    const originalEnd = Date.parse(source.endedAt);
    const originalLastSeen = Date.parse(source.lastSeenAt);
    if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd) || originalEnd <= originalStart) continue;

    let cursor = originalStart;
    while (cursor < originalEnd) {
      const boundary = nextLocalDayBoundary(cursor, normalizedTimezone);
      const segmentEnd = Math.min(originalEnd, boundary);
      const date = localDateKey(cursor, normalizedTimezone);
      const startedAt = new Date(cursor).toISOString();
      const endedAt = new Date(segmentEnd).toISOString();
      const lastSeenAt = new Date(Math.min(segmentEnd, Math.max(cursor, originalLastSeen))).toISOString();
      const interval: DailyPresenceInterval = {
        ...source,
        startedAt,
        lastSeenAt,
        endedAt,
        clippedToDay: cursor !== originalStart || segmentEnd !== originalEnd,
      };
      const item = daily.get(date) || {
        date,
        activeMinutes: 0,
        firstLogin: startedAt,
        lastActive: endedAt,
        intervals: [],
        replies: 0,
      };
      if (startedAt < item.firstLogin) item.firstLogin = startedAt;
      if (endedAt > item.lastActive) item.lastActive = endedAt;
      item.intervals.push(interval);
      daily.set(date, item);
      cursor = segmentEnd;
    }
  }

  for (const item of daily.values()) {
    const durationMs = mergedDurationMs(item.intervals.map((interval) => ({
      startedAt: Date.parse(interval.startedAt),
      endedAt: Date.parse(interval.endedAt),
    })));
    item.activeMinutes = Math.ceil(durationMs / 60_000);
    item.intervals.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  return daily;
}
